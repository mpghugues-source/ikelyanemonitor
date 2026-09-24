// Package remediation runs remediation scripts sent by the platform — but only those this host's LOCAL
// policy (internal/config Remediation) allows. The platform is never trusted alone:
//
//   - mode "disabled" (the default) refuses everything;
//   - mode "allowlist" runs only scripts whose SHA-256 the host owner listed in the agent's config, so
//     even a compromised platform cannot make this host run anything new;
//   - mode "any" runs whatever an administrator of the organization wrote.
//
// Every script also has to match the SHA-256 the platform announced for it, runs in a clean
// environment (never the agent's own, which holds its HMAC secret and database DSNs), with a timeout
// that kills its whole process group, and with its output capped.
package remediation

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strings"
	"time"

	"ikelyane-agent/internal/config"
)

// Job is one execution handed out by GET /api/v1/remediation/next.
type Job struct {
	ID         string            `json:"id"`
	Runtime    string            `json:"runtime"` // bash | powershell | python
	Script     string            `json:"script"`
	Sha256     string            `json:"sha256"`
	Args       map[string]string `json:"args"`
	TimeoutSec int               `json:"timeoutSec"`
	IncidentID *string           `json:"incidentId"`
}

// Result is POSTed to /api/v1/remediation/result. Reason uses the platform's stable codes
// (src/modules/remediation/constants.ts STATUS_REASONS).
type Result struct {
	ExecutionID string `json:"executionId"`
	Status      string `json:"status"` // succeeded | failed | timed_out | skipped
	Reason      string `json:"reason,omitempty"`
	ExitCode    *int   `json:"exitCode,omitempty"`
	DurationMs  int64  `json:"durationMs"`
	Stdout      string `json:"stdout,omitempty"`
	Stderr      string `json:"stderr,omitempty"`
}

// MaxOutputBytes caps stdout and stderr each (the platform stores the same amount).
const MaxOutputBytes = 64 * 1024

const maxTimeout = time.Hour

var argName = regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,63}$`)
var safeID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

func sha256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

// Refusal returns why this host must NOT run job (a platform reason code and a human message for
// stderr), or "" when it may. Pure: no side effects, see remediation_test.go.
func Refusal(policy config.Remediation, job Job) (reason, message string) {
	if !safeID.MatchString(job.ID) {
		return "refused_by_agent_policy", "malformed execution id"
	}
	actual := sha256Hex(job.Script)
	if actual != job.Sha256 {
		return "refused_by_agent_policy", fmt.Sprintf("script does not match its announced SHA-256 (got %s)", actual)
	}
	switch policy.Mode {
	case config.RemediationAny:
	case config.RemediationAllowlist:
		if !slices.Contains(policy.AllowedSha256, actual) {
			return "refused_by_agent_policy", fmt.Sprintf("script %s is not in this host's remediation allowlist", actual)
		}
	default:
		return "refused_by_agent_policy", "remediation is disabled in this host's agent configuration"
	}
	if job.TimeoutSec <= 0 || time.Duration(job.TimeoutSec)*time.Second > maxTimeout {
		return "refused_by_agent_policy", fmt.Sprintf("timeout %ds is outside 1s..1h", job.TimeoutSec)
	}
	for name := range job.Args {
		if !argName.MatchString(name) {
			return "refused_by_agent_policy", fmt.Sprintf("invalid argument name %q", name)
		}
	}
	return "", ""
}

// interpreter resolves how to run a script of this runtime here: executable, arguments before the
// script path, and the script file extension. The script is passed as a FILE to the interpreter, so
// it works on a noexec work directory too.
func interpreter(rt string) (path string, args []string, ext string, reason string) {
	var candidates []string
	switch rt {
	case "bash":
		if runtime.GOOS == "windows" {
			return "", nil, "", "unsupported_runtime"
		}
		candidates, args, ext = []string{"bash"}, []string{"--noprofile", "--norc"}, ".sh"
	case "powershell":
		candidates, args, ext = []string{"pwsh", "powershell"}, []string{"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"}, ".ps1"
	case "python":
		// -I: isolated mode — ignores PYTHON* variables and the user site directory.
		candidates, args, ext = []string{"python3", "python"}, []string{"-I"}, ".py"
	default:
		return "", nil, "", "unsupported_runtime"
	}
	for _, name := range candidates {
		if p, err := exec.LookPath(name); err == nil {
			return p, args, ext, ""
		}
	}
	return "", nil, "", "interpreter_not_found"
}

// cleanEnv is the ENTIRE environment a script gets: a fixed PATH, a few essentials, and its own
// arguments. Nothing from the agent's environment leaks in (IKELYANE_SECRET, database DSNs…).
func cleanEnv(job Job, workDir string) []string {
	env := []string{"IKELYANE_EXECUTION_ID=" + job.ID}
	if job.IncidentID != nil {
		env = append(env, "IKELYANE_INCIDENT_ID="+*job.IncidentID)
	}
	if runtime.GOOS == "windows" {
		for _, name := range []string{"SystemRoot", "windir", "PATH", "PATHEXT", "COMSPEC", "TEMP", "TMP"} {
			if v, ok := os.LookupEnv(name); ok {
				env = append(env, name+"="+v)
			}
		}
	} else {
		env = append(env, "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "LANG=C.UTF-8", "HOME="+workDir)
	}
	for name, value := range job.Args {
		env = append(env, "IKELYANE_ARG_"+name+"="+value)
	}
	return env
}

// cappedBuffer keeps the first MaxOutputBytes written and silently discards the rest (the process
// must never block on a full pipe because we stopped reading).
type cappedBuffer struct {
	buf       bytes.Buffer
	truncated bool
}

func (c *cappedBuffer) Write(p []byte) (int, error) {
	if room := MaxOutputBytes - c.buf.Len(); room > 0 {
		if len(p) > room {
			c.buf.Write(p[:room])
			c.truncated = true
		} else {
			c.buf.Write(p)
		}
	} else if len(p) > 0 {
		c.truncated = true
	}
	return len(p), nil
}

func (c *cappedBuffer) String() string {
	s := c.buf.String()
	if c.truncated {
		// The cut may have split a multi-byte character: drop the broken tail.
		s = strings.ToValidUTF8(s, "") + "\n[output truncated]"
	}
	return s
}

// Run executes job if the local policy allows it and always returns a Result to report.
func Run(ctx context.Context, policy config.Remediation, job Job) Result {
	started := time.Now()
	result := Result{ExecutionID: job.ID}
	skip := func(reason, message string) Result {
		result.Status, result.Reason, result.Stderr = "skipped", reason, message
		result.DurationMs = time.Since(started).Milliseconds()
		return result
	}

	if reason, message := Refusal(policy, job); reason != "" {
		return skip(reason, message)
	}
	path, args, ext, reason := interpreter(job.Runtime)
	if reason != "" {
		return skip(reason, fmt.Sprintf("cannot run %q scripts on this host", job.Runtime))
	}

	if err := os.MkdirAll(policy.WorkDir, 0o700); err != nil {
		return skip("start_failed", "cannot create the remediation work directory: "+err.Error())
	}
	file := filepath.Join(policy.WorkDir, job.ID+ext)
	if err := os.WriteFile(file, []byte(job.Script), 0o600); err != nil {
		return skip("start_failed", "cannot write the script: "+err.Error())
	}
	defer os.Remove(file)

	runCtx, cancel := context.WithTimeout(ctx, time.Duration(job.TimeoutSec)*time.Second)
	defer cancel()
	cmd := exec.CommandContext(runCtx, path, append(args, file)...)
	cmd.Dir = policy.WorkDir
	cmd.Env = cleanEnv(job, policy.WorkDir)
	cmd.Stdin = nil
	var stdout, stderr cappedBuffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	killProcessGroupOnCancel(cmd)
	cmd.WaitDelay = 5 * time.Second

	if err := cmd.Start(); err != nil {
		return skip("start_failed", err.Error())
	}
	err := cmd.Wait()
	result.DurationMs = time.Since(started).Milliseconds()
	result.Stdout, result.Stderr = stdout.String(), stderr.String()

	var exitErr *exec.ExitError
	switch {
	case errors.Is(runCtx.Err(), context.DeadlineExceeded):
		result.Status = "timed_out"
	case err == nil:
		code := 0
		result.Status, result.ExitCode = "succeeded", &code
	case errors.As(err, &exitErr):
		code := exitErr.ExitCode()
		result.Status, result.ExitCode = "failed", &code
	default:
		result.Status = "failed"
		result.Stderr += "\n" + err.Error()
	}
	return result
}
