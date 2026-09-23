package dbmetrics

import (
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"ikelyane-agent/internal/config"
)

func newTestMonitor(thresholdMs int) *Monitor {
	return &Monitor{
		target:      config.Database{Name: "t", Engine: "postgresql", SlowQueryThresholdMs: thresholdMs},
		prevQueries: make(map[string]queryStats),
	}
}

func TestSlowQueryDeltas_FirstSightingOnlySeeds(t *testing.T) {
	m := newTestMonitor(100)
	now := time.Unix(1_758_000_000, 0)
	out, perMin := m.slowQueryDeltas([]queryStats{{id: "q1", calls: 10, totalMs: 5000}}, now)
	if len(out) != 0 || perMin != nil {
		t.Fatalf("first poll must report nothing, got %d queries, perMin=%v", len(out), perMin)
	}
}

func TestSlowQueryDeltas_UsesIntervalAverageNotLifetime(t *testing.T) {
	m := newTestMonitor(100)
	t0 := time.Unix(1_758_000_000, 0)
	// Lifetime: 1000 fast calls at 10 ms.
	m.slowQueryDeltas([]queryStats{{id: "q1", calls: 1000, totalMs: 10_000, rowsReturned: 1000, rowsExamined: -1}}, t0)
	m.prevAt = t0

	// Then 2 calls totalling 600 ms: lifetime average ~10.6 ms, interval average 300 ms.
	t1 := t0.Add(60 * time.Second)
	out, perMin := m.slowQueryDeltas([]queryStats{{id: "q1", text: "SELECT $1", calls: 1002, totalMs: 10_600, rowsReturned: 1010, rowsExamined: -1}}, t1)
	if len(out) != 1 {
		t.Fatalf("got %d slow queries, want 1", len(out))
	}
	q := out[0]
	if q.DurationMs != 300 {
		t.Errorf("DurationMs = %v, want the interval average 300", q.DurationMs)
	}
	if q.Calls == nil || *q.Calls != 2 {
		t.Errorf("Calls = %v, want 2 (the delta, not the lifetime total)", q.Calls)
	}
	if q.RowsReturned == nil || *q.RowsReturned != 10 {
		t.Errorf("RowsReturned = %v, want 10 (the delta)", q.RowsReturned)
	}
	if q.RowsExamined != nil {
		t.Errorf("RowsExamined = %v, want nil when the engine does not expose it", *q.RowsExamined)
	}
	if perMin == nil || *perMin != 2 {
		t.Errorf("perMin = %v, want 2 slow executions over one minute", perMin)
	}
}

func TestSlowQueryDeltas_FastIntervalNotReported(t *testing.T) {
	m := newTestMonitor(100)
	t0 := time.Unix(1_758_000_000, 0)
	// Historically slow (lifetime avg 500 ms) but the new calls are fast.
	m.slowQueryDeltas([]queryStats{{id: "q1", calls: 10, totalMs: 5000}}, t0)
	m.prevAt = t0
	out, perMin := m.slowQueryDeltas([]queryStats{{id: "q1", calls: 20, totalMs: 5100}}, t0.Add(time.Minute))
	if len(out) != 0 {
		t.Fatalf("interval average 10 ms is under the 100 ms threshold, got %+v", out)
	}
	if perMin == nil || *perMin != 0 {
		t.Errorf("perMin = %v, want 0", perMin)
	}
}

func TestSlowQueryDeltas_StatsResetAndEvictionReseed(t *testing.T) {
	m := newTestMonitor(100)
	t0 := time.Unix(1_758_000_000, 0)
	m.slowQueryDeltas([]queryStats{{id: "q1", calls: 50, totalMs: 50_000}, {id: "q2", calls: 5, totalMs: 5000}}, t0)
	m.prevAt = t0

	// pg_stat_statements_reset(): q1's counter went backwards. q2 was evicted.
	out, _ := m.slowQueryDeltas([]queryStats{{id: "q1", calls: 3, totalMs: 3000}}, t0.Add(time.Minute))
	if len(out) != 0 {
		t.Fatalf("a counter that went backwards must not produce a report, got %+v", out)
	}
	if _, ok := m.prevQueries["q2"]; ok {
		t.Error("an evicted statement must be forgotten")
	}

	// Next poll measures from the reset baseline.
	out, _ = m.slowQueryDeltas([]queryStats{{id: "q1", calls: 4, totalMs: 4000}}, t0.Add(2*time.Minute))
	if len(out) != 1 || out[0].DurationMs != 1000 {
		t.Fatalf("got %+v, want one report at 1000 ms measured from the new baseline", out)
	}
}

func TestSlowQueryDeltas_BoundsForTheServer(t *testing.T) {
	m := newTestMonitor(1)
	t0 := time.Unix(1_758_000_000, 0)
	long := strings.Repeat("é", 3000) // 6000 bytes
	m.slowQueryDeltas([]queryStats{{id: "q1", calls: 1, totalMs: 10}, {id: strings.Repeat("x", 129), calls: 1, totalMs: 10}}, t0)
	m.prevAt = t0
	out, _ := m.slowQueryDeltas([]queryStats{
		{id: "q1", text: long, calls: 2, totalMs: 20},
		{id: strings.Repeat("x", 129), calls: 2, totalMs: 20},
	}, t0.Add(time.Minute))
	if len(out) != 1 {
		t.Fatalf("a fingerprint over 128 characters must be dropped (the server would reject the whole payload), got %d", len(out))
	}
	if len(out[0].QueryText) > maxQueryTextBytes || !utf8.ValidString(out[0].QueryText) {
		t.Errorf("QueryText is %d bytes / valid UTF-8 = %v", len(out[0].QueryText), utf8.ValidString(out[0].QueryText))
	}
}

func TestTruncateUTF8(t *testing.T) {
	cases := []struct {
		in   string
		max  int
		want string
	}{
		{"hello", 10, "hello"},
		{"hello", 3, "hel"},
		{"aé", 2, "a"}, // é is 2 bytes: cutting at 2 would split it
		{"€€", 4, "€"}, // € is 3 bytes
	}
	for _, c := range cases {
		if got := truncateUTF8(c.in, c.max); got != c.want {
			t.Errorf("truncateUTF8(%q, %d) = %q, want %q", c.in, c.max, got, c.want)
		}
	}
}
