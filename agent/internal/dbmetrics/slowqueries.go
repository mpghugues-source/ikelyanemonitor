package dbmetrics

import (
	"time"
	"unicode/utf8"

	"ikelyane-agent/internal/telemetry"
)

// Server-side bounds from src/lib/telemetry/schemas.ts. A value over any of them makes the server
// reject the WHOLE request (host metrics included), so they are enforced here, not hoped for.
const (
	maxQueryTextBytes = 4000 // schemas.ts caps at 4000 UTF-16 units; UTF-8 bytes >= UTF-16 units, so this is safe
	maxVersionBytes   = 64
	maxFingerprintLen = 128
)

// queryStats is one normalized statement's CUMULATIVE counters as the engine reports them
// (pg_stat_statements / performance_schema digests), aggregated across databases and users.
type queryStats struct {
	id           string
	text         string
	calls        int64
	totalMs      float64
	rowsReturned int64
	rowsExamined int64 // -1 when the engine does not expose it (Postgres)
}

// slowQueryDeltas turns this poll's cumulative per-statement counters into what happened SINCE THE
// PREVIOUS POLL: a statement is reported when it ran again and its average duration over the
// interval (not over its whole lifetime, which a long-idle fast history would dilute) is at or above
// the threshold. The first sighting of a statement only seeds state. Statements absent from current
// (evicted by the engine, or no longer among the slowest) are forgotten.
//
// Returns the slow queries and the rate of slow executions per minute (nil on the first poll).
// Callers hold m.mu.
func (m *Monitor) slowQueryDeltas(current []queryStats, now time.Time) ([]telemetry.SlowQuery, *float64) {
	thresholdMs := float64(m.target.SlowQueryThresholdMs)
	capturedAt := now.Format(time.RFC3339)
	next := make(map[string]queryStats, len(current))

	var out []telemetry.SlowQuery
	var slowCalls int64
	for _, cur := range current {
		if cur.id == "" || len(cur.id) > maxFingerprintLen {
			continue
		}
		next[cur.id] = cur
		prev, known := m.prevQueries[cur.id]
		if !known || cur.calls <= prev.calls {
			continue // first sighting, no new executions, or the engine's stats were reset
		}
		calls := cur.calls - prev.calls
		avgMs := (cur.totalMs - prev.totalMs) / float64(calls)
		if avgMs < thresholdMs || avgMs < 0 {
			continue
		}
		slowCalls += calls

		q := telemetry.SlowQuery{
			CapturedAt: capturedAt, Fingerprint: cur.id, QueryText: truncateUTF8(cur.text, maxQueryTextBytes),
			DurationMs: avgMs, Calls: clampCalls(calls),
		}
		if returned := cur.rowsReturned - prev.rowsReturned; returned >= 0 {
			v := uint64(returned)
			q.RowsReturned = &v
		}
		if cur.rowsExamined >= 0 && prev.rowsExamined >= 0 && cur.rowsExamined >= prev.rowsExamined {
			v := uint64(cur.rowsExamined - prev.rowsExamined)
			q.RowsExamined = &v
		}
		out = append(out, q)
	}
	m.prevQueries = next

	if m.prevAt.IsZero() {
		return out, nil
	}
	seconds := now.Sub(m.prevAt).Seconds()
	if seconds <= 0 {
		return out, nil
	}
	perMin := float64(slowCalls) / seconds * 60
	return out, &perMin
}

// clampCalls keeps calls within the server's accepted 1..1e9 range.
func clampCalls(n int64) *int {
	if n > 1_000_000_000 {
		n = 1_000_000_000
	}
	v := int(n)
	return &v
}

// truncateUTF8 cuts s to at most maxBytes without splitting a multi-byte character.
func truncateUTF8(s string, maxBytes int) string {
	if len(s) <= maxBytes {
		return s
	}
	cut := maxBytes
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut]
}
