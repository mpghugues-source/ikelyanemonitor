package dbmetrics

import (
	"context"
	"database/sql"
	"time"

	"ikelyane-agent/internal/telemetry"
)

// collectPostgres fills info's version/isReplica/maxConnections in place (fields this engine can
// answer) and returns the metrics/slow-queries. Every query here is best-effort in the sense that a
// missing privilege or extension degrades that one field to nil/empty rather than failing the whole
// poll — pg_stat_statements in particular is an optional extension.
func (m *Monitor) collectPostgres(ctx context.Context, now time.Time, info *telemetry.DatabaseInstanceInfo) (telemetry.DatabaseMetrics, []telemetry.SlowQuery, error) {
	var metrics telemetry.DatabaseMetrics

	// server_version ("17.2 (Debian 17.2-1.pgdg120+1)"), not version(): the latter appends the
	// platform and compiler and routinely exceeds the server's 64-character limit.
	if err := m.db.QueryRowContext(ctx, "SHOW server_version").Scan(&info.Version); err != nil {
		return metrics, nil, err
	}

	var maxConn int
	if err := m.db.QueryRowContext(ctx, "SHOW max_connections").Scan(&maxConn); err == nil {
		info.MaxConnections = &maxConn
	}

	var isReplica bool
	if err := m.db.QueryRowContext(ctx, "SELECT pg_is_in_recovery()").Scan(&isReplica); err == nil {
		info.IsReplica = &isReplica
	}

	var activeConnections int
	if err := m.db.QueryRowContext(ctx, "SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'client backend'").Scan(&activeConnections); err == nil {
		metrics.ActiveConnections = &activeConnections
		if info.MaxConnections != nil && *info.MaxConnections > 0 {
			pct := float64(activeConnections) / float64(*info.MaxConnections) * 100
			metrics.ConnectionUsagePercent = &pct
		}
	}

	var blksHit, blksRead, xactTotal, deadlocks uint64
	err := m.db.QueryRowContext(ctx, `SELECT
			coalesce(sum(blks_hit), 0), coalesce(sum(blks_read), 0),
			coalesce(sum(xact_commit + xact_rollback), 0), coalesce(sum(deadlocks), 0)
		FROM pg_stat_database`).Scan(&blksHit, &blksRead, &xactTotal, &deadlocks)
	if err != nil {
		return metrics, nil, err
	}
	if total := blksHit + blksRead; total > 0 {
		ratio := float64(blksHit) / float64(total) // 0..1, as the server expects
		metrics.CacheHitRatio = &ratio
	}
	metrics.DeadlocksTotal = &deadlocks
	if qps := m.ratePerSecond(xactTotal, m.prevTxns, now); qps != nil {
		metrics.QPS = qps
	}
	if perMin := m.rate(deadlocks, m.prevDeadlocks, now); perMin != nil {
		metrics.DeadlocksPerMin = perMin
	}
	m.prevTxns, m.prevDeadlocks = xactTotal, deadlocks

	var storageBytes uint64
	if err := m.db.QueryRowContext(ctx, "SELECT coalesce(sum(pg_database_size(datname)), 0) FROM pg_database").Scan(&storageBytes); err == nil {
		metrics.StorageUsedBytes = &storageBytes
	}

	if isReplica {
		var lagSeconds sql.NullFloat64
		q := "SELECT extract(epoch FROM (now() - pg_last_xact_replay_timestamp()))"
		if err := m.db.QueryRowContext(ctx, q).Scan(&lagSeconds); err == nil && lagSeconds.Valid {
			metrics.ReplicationLagSeconds = &lagSeconds.Float64
		}
	}

	slowQueries, slowPerMin := m.postgresSlowQueries(ctx, now)
	metrics.SlowQueriesPerMin = slowPerMin
	return metrics, slowQueries, nil
}

// postgresSlowQueries reads pg_stat_statements, which is silently absent (not installed, or not
// loaded via shared_preload_libraries) on plenty of Postgres instances — that is not an error for
// the rest of the poll, just an empty result. The view returns queries already normalized (literals
// replaced with $1, $2, ...) by Postgres itself, so there is no literal-stripping to get wrong here.
//
// The same queryid appears once per (user, database) pair, hence the GROUP BY. total_exec_time is
// PostgreSQL 13+; older servers (total_time) simply report no slow queries.
func (m *Monitor) postgresSlowQueries(ctx context.Context, now time.Time) ([]telemetry.SlowQuery, *float64) {
	rows, err := m.db.QueryContext(ctx, `SELECT queryid::text, min(query), sum(calls), sum(total_exec_time), sum(rows)
		FROM pg_stat_statements
		WHERE queryid IS NOT NULL AND query <> '<insufficient privilege>'
		GROUP BY queryid
		HAVING sum(calls) > 0 AND sum(total_exec_time) / sum(calls) >= $1
		ORDER BY sum(total_exec_time) / sum(calls) DESC LIMIT 25`, float64(m.target.SlowQueryThresholdMs))
	if err != nil {
		return nil, nil // extension not installed, or no privilege — not a poll failure
	}
	defer rows.Close()

	var current []queryStats
	for rows.Next() {
		q := queryStats{rowsExamined: -1}
		if err := rows.Scan(&q.id, &q.text, &q.calls, &q.totalMs, &q.rowsReturned); err != nil {
			continue
		}
		current = append(current, q)
	}
	if rows.Err() != nil {
		return nil, nil
	}
	return m.slowQueryDeltas(current, now)
}
