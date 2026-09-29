package dbmetrics

import (
	"testing"
	"time"

	"ikelyane-agent/internal/config"
)

func TestParseRedisInfo(t *testing.T) {
	fields := parseRedisInfo("# Server\r\nredis_version:7.4.1\r\n\r\n# Clients\r\nconnected_clients:12\r\n# Replication\r\nrole:master\r\n")
	if fields["redis_version"] != "7.4.1" || fields["connected_clients"] != "12" || fields["role"] != "master" {
		t.Fatalf("unexpected fields: %v", fields)
	}
	if _, ok := fields["# Server"]; ok {
		t.Fatal("section headers must be skipped")
	}
}

func TestRedisCommandName_NeverKeepsArguments(t *testing.T) {
	cases := map[string][]string{
		"HGETALL":    {"hgetall", "user:42:profile"},
		"CONFIG GET": {"config", "get", "maxmemory"},
		"SET":        {"SET", "session:abc", "secret-token-value", "EX", "60"},
		"":           {"not a command!", "x"},
		"CLIENT":     {"client", "some value with spaces"},
	}
	for want, args := range cases {
		if got := redisCommandName(args); got != want {
			t.Errorf("redisCommandName(%q) = %q, want %q", args, got, want)
		}
	}
	if redisCommandName(nil) != "" {
		t.Error("an empty entry has no command")
	}
}

func newRedisTestMonitor(thresholdMs int) *Monitor {
	return &Monitor{target: config.Database{Name: "cache", Engine: "redis", SlowQueryThresholdMs: thresholdMs}}
}

func TestSlowlogDeltas(t *testing.T) {
	m := newRedisTestMonitor(10)
	t0 := time.Unix(1_758_000_000, 0)

	// First poll: history is only a starting point.
	if out, perMin := m.slowlogDeltas([]slowlogEvent{{id: 5, durationMs: 50, command: "KEYS"}}, t0); out != nil || perMin != nil {
		t.Fatalf("first poll must only seed, got %v", out)
	}
	m.prevAt = t0

	t1 := t0.Add(time.Minute)
	events := []slowlogEvent{
		{id: 9, durationMs: 30, command: "KEYS"},
		{id: 8, durationMs: 10, command: "KEYS"},
		{id: 7, durationMs: 4, command: "GET"},   // average under the threshold: not slow
		{id: 5, durationMs: 50, command: "KEYS"}, // already reported before
	}
	out, perMin := m.slowlogDeltas(events, t1)
	if len(out) != 1 || out[0].Fingerprint != "redis:KEYS" || out[0].QueryText != "KEYS …" || out[0].DurationMs != 20 || *out[0].Calls != 2 {
		t.Fatalf("unexpected slow queries: %+v", out)
	}
	if perMin == nil || *perMin != 2 {
		t.Fatalf("perMin = %v, want 2", perMin)
	}
	m.prevAt = t1

	// SLOWLOG RESET / restart: ids go backwards — re-seed, never report stale or negative figures.
	if out, _ := m.slowlogDeltas([]slowlogEvent{{id: 1, durationMs: 99, command: "KEYS"}}, t1.Add(time.Minute)); out != nil {
		t.Fatalf("a reset slowlog must re-seed, got %v", out)
	}
	out, _ = m.slowlogDeltas([]slowlogEvent{{id: 2, durationMs: 99, command: "SORT"}, {id: 1, durationMs: 99, command: "KEYS"}}, t1.Add(2*time.Minute))
	if len(out) != 1 || out[0].Fingerprint != "redis:SORT" {
		t.Fatalf("after re-seeding only newer entries count, got %+v", out)
	}

	// A window holding only the agent's own entries (command "") still advances the cursor: it must
	// not be mistaken for a reset, which would re-seed and then replay id 2 on the next poll.
	if out, _ := m.slowlogDeltas([]slowlogEvent{{id: 4, durationMs: 99}, {id: 3, durationMs: 99}}, t1.Add(3*time.Minute)); out != nil {
		t.Fatalf("the agent's own entries are never reported, got %+v", out)
	}
	if *m.slowlogLastID != 4 {
		t.Fatalf("cursor = %d, want 4", *m.slowlogLastID)
	}
}
