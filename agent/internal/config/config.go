// Package config loads the agent's configuration, from a JSON file (--config) or from environment
// variables (the default, matching a systemd EnvironmentFile — the deployment pattern already used
// for this app's other services on this host).
package config

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	envServerURL          = "IKELYANE_SERVER_URL"
	envKeyID              = "IKELYANE_KEY_ID"
	envSecret             = "IKELYANE_SECRET"
	envInterval           = "IKELYANE_INTERVAL_SECONDS"
	envBufferDir          = "IKELYANE_BUFFER_DIR"
	envDatabasesJSON      = "IKELYANE_DATABASES_JSON"
	envRemediationMode    = "IKELYANE_REMEDIATION_MODE"
	envRemediationAllowed = "IKELYANE_REMEDIATION_ALLOWED_SHA256"
	envRemediationWorkDir = "IKELYANE_REMEDIATION_WORK_DIR"

	DefaultIntervalSeconds = 60
	DefaultBufferDir       = "/var/lib/ikelyane-agent/buffer"
	DefaultRemediationDir  = "/var/lib/ikelyane-agent/remediation"
)

// Remediation modes. The DEFAULT is disabled: running scripts sent by the platform is something the
// owner of THIS host must opt into, here, in the agent's own configuration — never from the web UI.
const (
	RemediationDisabled  = "disabled"
	RemediationAllowlist = "allowlist" // only scripts whose SHA-256 is listed below
	RemediationAny       = "any"       // any script an administrator of the organization writes
)

// Remediation is this host's local policy for remediation scripts sent by the platform.
type Remediation struct {
	Mode string `json:"mode,omitempty"`
	// Lower-case hex SHA-256 of each script allowed in "allowlist" mode (shown next to each action in
	// the web UI). Even a compromised platform cannot make this host run anything else.
	AllowedSha256 []string `json:"allowedSha256,omitempty"`
	// Where scripts are written just before running (created 0700). Default DefaultRemediationDir.
	WorkDir string `json:"workDir,omitempty"`
}

// Database is one database instance to monitor. Configured ONLY here, on the agent — never on the
// server: DatabaseInstance rows there are auto-discovered from telemetry the agent already sent,
// and the schema is explicit that credentials must never reach the server (see
// prisma/schema.prisma DatabaseInstance.endpoint's comment in the main app).
type Database struct {
	// Stable identifier, unique per host+engine (e.g. "main:5432") — see
	// telemetry.DatabaseInstanceInfo.Name's doc comment for why it must never change.
	Name string `json:"name"`
	// postgresql | mysql | mariadb.
	Engine string `json:"engine"`
	// Driver-native connection string — postgres://user:pass@host:port/db?sslmode=disable for
	// postgresql, user:pass@tcp(host:port)/db for mysql/mariadb. Never logged, never sent anywhere:
	// internal/dbmetrics derives only a credential-free "host:port" from it for display.
	DSN string `json:"dsn"`
	// Slow queries at or above this are reported. Optional, default 1000 (matches the server's own default).
	SlowQueryThresholdMs int `json:"slowQueryThresholdMs,omitempty"`
}

// Config holds everything the agent needs to run. Secret is the HMAC secret from `npm run
// provision:host` (or the "Register a server" UI) — treat it like a password: never log it.
type Config struct {
	ServerURL   string        `json:"serverUrl"`
	KeyID       string        `json:"keyId"`
	Secret      string        `json:"secret"`
	Interval    time.Duration `json:"-"`
	BufferDir   string        `json:"bufferDir,omitempty"`
	Databases   []Database    `json:"databases,omitempty"`
	Remediation Remediation   `json:"remediation,omitempty"`

	// IntervalSeconds is the JSON-file representation of Interval (time.Duration doesn't round-trip
	// through JSON as a plain number of seconds, which is what a human hand-editing the file expects).
	IntervalSeconds int `json:"intervalSeconds,omitempty"`
}

// Load reads the config file at path if non-empty, otherwise from environment variables.
func Load(path string) (*Config, error) {
	var cfg Config
	if path != "" {
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("reading config file: %w", err)
		}
		if err := json.Unmarshal(data, &cfg); err != nil {
			return nil, fmt.Errorf("parsing config file: %w", err)
		}
		if cfg.IntervalSeconds > 0 {
			cfg.Interval = time.Duration(cfg.IntervalSeconds) * time.Second
		}
	} else {
		cfg.ServerURL = os.Getenv(envServerURL)
		cfg.KeyID = os.Getenv(envKeyID)
		cfg.Secret = os.Getenv(envSecret)
		cfg.BufferDir = os.Getenv(envBufferDir)
		if raw := os.Getenv(envInterval); raw != "" {
			seconds, err := strconv.Atoi(raw)
			if err != nil {
				return nil, fmt.Errorf("%s must be a whole number of seconds: %w", envInterval, err)
			}
			cfg.Interval = time.Duration(seconds) * time.Second
		}
		cfg.Remediation.Mode = os.Getenv(envRemediationMode)
		cfg.Remediation.WorkDir = os.Getenv(envRemediationWorkDir)
		if raw := os.Getenv(envRemediationAllowed); raw != "" {
			for _, sha := range strings.Split(raw, ",") {
				if sha = strings.TrimSpace(sha); sha != "" {
					cfg.Remediation.AllowedSha256 = append(cfg.Remediation.AllowedSha256, sha)
				}
			}
		}
		if raw := os.Getenv(envDatabasesJSON); raw != "" {
			if err := json.Unmarshal([]byte(raw), &cfg.Databases); err != nil {
				return nil, fmt.Errorf("%s must be a JSON array of {name, engine, dsn}: %w", envDatabasesJSON, err)
			}
		}
	}

	if cfg.Interval <= 0 {
		cfg.Interval = DefaultIntervalSeconds * time.Second
	}
	if cfg.BufferDir == "" {
		cfg.BufferDir = DefaultBufferDir
	}
	if cfg.Remediation.Mode == "" {
		cfg.Remediation.Mode = RemediationDisabled
	}
	if cfg.Remediation.WorkDir == "" {
		cfg.Remediation.WorkDir = DefaultRemediationDir
	}
	for i, sha := range cfg.Remediation.AllowedSha256 {
		cfg.Remediation.AllowedSha256[i] = strings.ToLower(strings.TrimSpace(sha))
	}
	for i := range cfg.Databases {
		if cfg.Databases[i].SlowQueryThresholdMs <= 0 {
			cfg.Databases[i].SlowQueryThresholdMs = 1000
		}
	}

	if err := cfg.validate(); err != nil {
		return nil, err
	}
	return &cfg, nil
}

var supportedDatabaseEngines = map[string]bool{"postgresql": true, "mysql": true, "mariadb": true}

func (c *Config) validate() error {
	var missing []string
	if c.ServerURL == "" {
		missing = append(missing, "server URL ("+envServerURL+")")
	}
	if c.KeyID == "" {
		missing = append(missing, "key id ("+envKeyID+")")
	}
	if c.Secret == "" {
		missing = append(missing, "secret ("+envSecret+")")
	}
	if len(missing) > 0 {
		return fmt.Errorf("missing required configuration: %v — see README.md", missing)
	}
	if c.Interval < 10*time.Second {
		return fmt.Errorf("interval must be at least 10s, got %s", c.Interval)
	}

	switch c.Remediation.Mode {
	case RemediationDisabled, RemediationAny:
	case RemediationAllowlist:
		if len(c.Remediation.AllowedSha256) == 0 {
			return fmt.Errorf("remediation mode %q needs at least one entry in allowedSha256", RemediationAllowlist)
		}
	default:
		return fmt.Errorf("remediation mode must be %q, %q or %q, got %q", RemediationDisabled, RemediationAllowlist, RemediationAny, c.Remediation.Mode)
	}
	for _, sha := range c.Remediation.AllowedSha256 {
		if len(sha) != 64 || strings.Trim(sha, "0123456789abcdef") != "" {
			return fmt.Errorf("remediation allowedSha256 entries must be 64 hex characters, got %q", sha)
		}
	}

	seenNames := make(map[string]bool, len(c.Databases))
	for _, db := range c.Databases {
		if db.Name == "" || db.Engine == "" || db.DSN == "" {
			return fmt.Errorf("each entry in databases needs name, engine and dsn — got %+v", db)
		}
		if !supportedDatabaseEngines[db.Engine] {
			return fmt.Errorf("database %q: unsupported engine %q (this agent supports postgresql, mysql, mariadb)", db.Name, db.Engine)
		}
		if seenNames[db.Name] {
			return fmt.Errorf("database %q is configured twice — names must be unique", db.Name)
		}
		seenNames[db.Name] = true
	}
	return nil
}
