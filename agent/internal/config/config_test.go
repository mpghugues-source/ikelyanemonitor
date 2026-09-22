package config

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func clearEnv(t *testing.T) {
	t.Helper()
	for _, name := range []string{envServerURL, envKeyID, envSecret, envInterval, envBufferDir} {
		t.Setenv(name, "")
		os.Unsetenv(name)
	}
}

func TestLoad_FromEnvironment(t *testing.T) {
	clearEnv(t)
	t.Setenv(envServerURL, "https://monitor.example.com")
	t.Setenv(envKeyID, "ikm_abc")
	t.Setenv(envSecret, "s3cret")
	t.Setenv(envInterval, "30")

	cfg, err := Load("")
	if err != nil {
		t.Fatalf("Load() error: %v", err)
	}
	if cfg.ServerURL != "https://monitor.example.com" || cfg.KeyID != "ikm_abc" || cfg.Secret != "s3cret" {
		t.Fatalf("got %+v", cfg)
	}
	if cfg.Interval != 30*time.Second {
		t.Errorf("Interval = %v, want 30s", cfg.Interval)
	}
}

func TestLoad_DefaultsWhenUnset(t *testing.T) {
	clearEnv(t)
	t.Setenv(envServerURL, "https://monitor.example.com")
	t.Setenv(envKeyID, "ikm_abc")
	t.Setenv(envSecret, "s3cret")

	cfg, err := Load("")
	if err != nil {
		t.Fatalf("Load() error: %v", err)
	}
	if cfg.Interval != DefaultIntervalSeconds*time.Second {
		t.Errorf("Interval = %v, want the default", cfg.Interval)
	}
	if cfg.BufferDir != DefaultBufferDir {
		t.Errorf("BufferDir = %q, want the default", cfg.BufferDir)
	}
}

func TestLoad_MissingRequiredFields(t *testing.T) {
	clearEnv(t)
	if _, err := Load(""); err == nil {
		t.Fatal("expected an error when no credentials are configured at all")
	}
	t.Setenv(envServerURL, "https://monitor.example.com")
	if _, err := Load(""); err == nil {
		t.Fatal("expected an error when key id and secret are still missing")
	}
}

func TestLoad_IntervalTooShortIsRejected(t *testing.T) {
	clearEnv(t)
	t.Setenv(envServerURL, "https://monitor.example.com")
	t.Setenv(envKeyID, "ikm_abc")
	t.Setenv(envSecret, "s3cret")
	t.Setenv(envInterval, "5")

	if _, err := Load(""); err == nil {
		t.Fatal("an interval below the 10s floor must be rejected, not silently accepted")
	}
}

func TestLoad_InvalidIntervalValue(t *testing.T) {
	clearEnv(t)
	t.Setenv(envServerURL, "https://monitor.example.com")
	t.Setenv(envKeyID, "ikm_abc")
	t.Setenv(envSecret, "s3cret")
	t.Setenv(envInterval, "not-a-number")

	if _, err := Load(""); err == nil {
		t.Fatal("a non-numeric interval must be rejected")
	}
}

func TestLoad_FromFile(t *testing.T) {
	clearEnv(t)
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	body := `{
		"serverUrl": "https://monitor.example.com",
		"keyId": "ikm_from_file",
		"secret": "file-secret",
		"intervalSeconds": 45,
		"bufferDir": "` + filepath.ToSlash(dir) + `/buf"
	}`
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load() error: %v", err)
	}
	if cfg.KeyID != "ikm_from_file" || cfg.Secret != "file-secret" {
		t.Fatalf("got %+v", cfg)
	}
	if cfg.Interval != 45*time.Second {
		t.Errorf("Interval = %v, want 45s", cfg.Interval)
	}

	// Environment variables must NOT leak into a file-based config: the file is authoritative once given.
	t.Setenv(envKeyID, "ikm_from_env_should_be_ignored")
	cfg2, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg2.KeyID != "ikm_from_file" {
		t.Errorf("KeyID = %q, want the file's value to win over the environment", cfg2.KeyID)
	}
}

func TestLoad_FileNotFound(t *testing.T) {
	if _, err := Load("/does/not/exist.json"); err == nil {
		t.Fatal("expected an error for a missing config file")
	}
}

func TestLoad_FileNotJSON(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	if err := os.WriteFile(path, []byte("not json at all"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(path); err == nil {
		t.Fatal("expected an error for a config file that is not valid JSON")
	}
}
