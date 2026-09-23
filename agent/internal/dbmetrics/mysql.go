package dbmetrics

import (
	"context"
	"database/sql"
	"strconv"
	"time"

	"ikelyane-agent/internal/telemetry"
)

// collectMySQL is the MySQL/MariaDB counterpart of collectPostgres — same shape, same best-effort
// contract for anything that needs an optional privilege or component (performance_schema for slow
// queries here, in place of Postgres's pg_stat_statements).
func (m *Monitor) collectMySQL(ctx context.Context, now time.Time, info *telemetry.DatabaseInstanceInfo) (telemetry.DatabaseMetrics, []telemetry.SlowQuery, error) {
	var metrics telemetry.DatabaseMetrics

	if err := m.db.QueryRowContext(ctx, "SELECT VERSION()").Scan(&info.Version); err != nil {
		return metrics, nil, err
	}

	var maxConn int
	if err := m.db.QueryRowContext(ctx, "SELECT @@max_connections").Scan(&maxConn); err == nil {
		info.MaxConnections = &maxConn
	}

	isReplica, lagSeconds := m.mysqlReplicaStatus(ctx)
	info.IsReplica = &isReplica
	if isReplica {
		metrics.ReplicationLagSeconds = lagSeconds
	}

	status, err := m.mysqlGlobalStatus(ctx)
	if err != nil {
		return metrics, nil, err
	}
	if v, ok := status["Threads_connected"]; ok {
		n := int(v)
		metrics.ActiveConnections = &n
		if maxConn > 0 {
			pct := min(v/float64(maxConn)*100, 100)
			metrics.ConnectionUsagePercent = &pct
		}
	}
	if requests, reads := status["Innodb_buffer_pool_read_requests"], status["Innodb_buffer_pool_reads"]; requests > 0 && reads <= requests {
		// Reads that had to go to disk are a subset of read_requests. 0..1, as the server expects.
		ratio := (requests - reads) / requests
		metrics.CacheHitRatio = &ratio
	}
	// Innodb_deadlocks exists on MariaDB but NOT on MySQL 8 (there it lives in INNODB_METRICS,
	// disabled by default): report nothing rather than a made-up zero.
	if v, ok := status["Innodb_deadlocks"]; ok {
		deadlocks := uint64(v)
		metrics.DeadlocksTotal = &deadlocks
		if perMin := m.rate(deadlocks, m.prevDeadlocks, now); perMin != nil {
			metrics.DeadlocksPerMin = perMin
		}
		m.prevDeadlocks = deadlocks
	}
	questions := uint64(status["Questions"])
	if qps := m.ratePerSecond(questions, m.prevTxns, now); qps != nil {
		metrics.QPS = qps
	}
	m.prevTxns = questions

	var storageBytes sql.NullInt64
	q := `SELECT SUM(data_length + index_length) FROM information_schema.tables
		WHERE table_schema NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys')`
	if err := m.db.QueryRowContext(ctx, q).Scan(&storageBytes); err == nil && storageBytes.Valid {
		v := uint64(storageBytes.Int64)
		metrics.StorageUsedBytes = &v
	}

	slowQueries, slowPerMin := m.mysqlSlowQueries(ctx, now)
	metrics.SlowQueriesPerMin = slowPerMin
	return metrics, slowQueries, nil
}

// mysqlGlobalStatus returns every numeric SHOW GLOBAL STATUS counter, keyed by name. No WHERE
// clause with placeholders: SHOW statements are not reliably preparable across MySQL/MariaDB
// versions, and the full list is only a few hundred short rows. A name absent from the result
// (renamed or removed across versions) is simply missing from the map, not an error.
func (m *Monitor) mysqlGlobalStatus(ctx context.Context) (map[string]float64, error) {
	rows, err := m.db.QueryContext(ctx, "SHOW GLOBAL STATUS")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make(map[string]float64)
	for rows.Next() {
		var name, value string
		if err := rows.Scan(&name, &value); err != nil {
			continue
		}
		if f, err := strconv.ParseFloat(value, 64); err == nil {
			out[name] = f
		}
	}
	return out, rows.Err()
}

// mysqlReplicaStatus tries the MySQL 8.0.22+ syntax first, falling back to the older/MariaDB one
// that both engines still accept. A statement that errors (unknown syntax on this version/engine)
// just means "try the next one", not a poll failure.
func (m *Monitor) mysqlReplicaStatus(ctx context.Context) (bool, *float64) {
	for _, stmt := range []string{"SHOW REPLICA STATUS", "SHOW SLAVE STATUS"} {
		rows, err := m.db.QueryContext(ctx, stmt)
		if err != nil {
			continue
		}
		lag, isReplica := scanReplicaLag(rows)
		rows.Close()
		if isReplica {
			return true, lag
		}
	}
	return false, nil
}

func scanReplicaLag(rows *sql.Rows) (*float64, bool) {
	cols, err := rows.Columns()
	if err != nil || !rows.Next() {
		return nil, false
	}
	vals := make([]sql.RawBytes, len(cols))
	ptrs := make([]any, len(cols))
	for i := range vals {
		ptrs[i] = &vals[i]
	}
	if err := rows.Scan(ptrs...); err != nil {
		return nil, true // a row exists (it IS a replica), just couldn't read the lag column
	}
	for i, col := range cols {
		if col != "Seconds_Behind_Master" && col != "Seconds_Behind_Source" {
			continue
		}
		if vals[i] == nil {
			return nil, true // replication stopped/broken: replica, but no lag figure available
		}
		if f, err := strconv.ParseFloat(string(vals[i]), 64); err == nil {
			return &f, true
		}
	}
	return nil, true
}

// mysqlSlowQueries mirrors postgresSlowQueries but reads performance_schema's digest summary,
// which — like pg_stat_statements — hands back already-normalized query text (literals replaced
// with '?') as a side effect of aggregating by query shape. The table has one row per
// (schema, digest), hence the GROUP BY; timers are in picoseconds.
func (m *Monitor) mysqlSlowQueries(ctx context.Context, now time.Time) ([]telemetry.SlowQuery, *float64) {
	q := `SELECT DIGEST, MIN(DIGEST_TEXT), SUM(COUNT_STAR), SUM(SUM_TIMER_WAIT) / 1000000000,
			SUM(SUM_ROWS_SENT), SUM(SUM_ROWS_EXAMINED)
		FROM performance_schema.events_statements_summary_by_digest
		WHERE DIGEST IS NOT NULL
		GROUP BY DIGEST
		HAVING SUM(COUNT_STAR) > 0 AND SUM(SUM_TIMER_WAIT) / SUM(COUNT_STAR) / 1000000000 >= ?
		ORDER BY SUM(SUM_TIMER_WAIT) / SUM(COUNT_STAR) DESC LIMIT 25`
	rows, err := m.db.QueryContext(ctx, q, float64(m.target.SlowQueryThresholdMs))
	if err != nil {
		return nil, nil // performance_schema off, or no privilege on it — not a poll failure
	}
	defer rows.Close()

	var current []queryStats
	for rows.Next() {
		var s queryStats
		var text sql.NullString
		if err := rows.Scan(&s.id, &text, &s.calls, &s.totalMs, &s.rowsReturned, &s.rowsExamined); err != nil {
			continue
		}
		s.text = text.String
		current = append(current, s)
	}
	if rows.Err() != nil {
		return nil, nil
	}
	return m.slowQueryDeltas(current, now)
}
