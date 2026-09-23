// Package dbmetrics monitors PostgreSQL and MySQL/MariaDB instances configured locally on the
// agent (internal/config) and shapes the result into telemetry.DatabaseMetric.
//
// Credentials never reach the server: only safeEndpoint's "host:port" (dsn.go) is ever sent, and
// slow-query text comes back from the engine ITSELF already normalized (Postgres's
// pg_stat_statements, MySQL/MariaDB's performance_schema digest both aggregate by normalized query
// shape — the agent never has to strip literals by hand, which would be easy to get subtly wrong
// across SQL dialects).
package dbmetrics

import (
	"context"
	"database/sql"
	"fmt"
	"sync"
	"time"

	_ "github.com/go-sql-driver/mysql" // registers the "mysql" database/sql driver
	_ "github.com/jackc/pgx/v5/stdlib" // registers the "pgx" database/sql driver

	"ikelyane-agent/internal/config"
	"ikelyane-agent/internal/telemetry"
)

// driverName maps our engine strings to the database/sql driver name that handles them.
func driverName(engine string) (string, error) {
	switch engine {
	case "postgresql":
		return "pgx", nil
	case "mysql", "mariadb":
		return "mysql", nil
	default:
		return "", fmt.Errorf("unsupported engine %q", engine)
	}
}

// Monitor polls one configured database instance across its lifetime. It owns a persistent
// connection pool (reused every cycle — reconnecting fresh each time would be wasteful and, on a
// slow/loaded server, could itself distort the metrics it's trying to measure) and whatever
// cumulative-counter state its engine's rate metrics (QPS, deadlocks/min) need between polls.
type Monitor struct {
	target   config.Database
	endpoint string // credential-free "host:port", see dsn.go
	db       *sql.DB

	// mu guards the fields below. A single Monitor is meant to be polled by one goroutine per
	// cycle, but the mutex is cheap insurance against a slow cycle overlapping the next one —
	// same defensive stance as snmp.Poller.
	mu            sync.Mutex
	prevAt        time.Time
	prevTxns      uint64 // Postgres: sum(xact_commit+xact_rollback); MySQL: Questions
	prevDeadlocks uint64
	prevQueries   map[string]queryStats // digest/queryid -> cumulative counters, see slowqueries.go
}

// New opens (but does not yet use) the connection pool for target. Connection FAILURES are not
// returned here — Collect reports them as reachable=false, same as a failure on any later poll,
// so a database that is briefly down when the agent starts does not stop the agent.
func New(target config.Database) (*Monitor, error) {
	driver, err := driverName(target.Engine)
	if err != nil {
		return nil, err
	}
	endpoint, err := safeEndpoint(target.Engine, target.DSN)
	if err != nil {
		return nil, fmt.Errorf("database %q: %w", target.Name, err)
	}
	db, err := sql.Open(driver, target.DSN)
	if err != nil {
		return nil, fmt.Errorf("database %q: %w", target.Name, err)
	}
	// A monitoring connection should never hold many connections open on the target server, and
	// should not linger indefinitely across the target's own restarts/failovers.
	db.SetMaxOpenConns(2)
	db.SetConnMaxLifetime(10 * time.Minute)

	return &Monitor{target: target, endpoint: endpoint, db: db, prevQueries: make(map[string]queryStats)}, nil
}

func (m *Monitor) Close() error {
	return m.db.Close()
}

// Target returns the configuration this Monitor was built from (e.g. for logging its name).
func (m *Monitor) Target() config.Database {
	return m.target
}

// Collect gathers one sample. Like snmp.Poller.Poll, it never returns an error: an unreachable
// database is a normal, expected outcome (reachable=false marks it DOWN server-side), not a
// collection failure the caller needs to handle specially.
func (m *Monitor) Collect(ctx context.Context, now time.Time) telemetry.DatabaseMetric {
	m.mu.Lock()
	defer m.mu.Unlock()

	collectedAt := now.Format(time.RFC3339)
	threshold := m.target.SlowQueryThresholdMs
	info := telemetry.DatabaseInstanceInfo{
		Name: m.target.Name, Engine: m.target.Engine, Endpoint: m.endpoint, SlowQueryThresholdMs: &threshold,
	}

	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := m.db.PingContext(pingCtx); err != nil {
		return telemetry.DatabaseMetric{CollectedAt: collectedAt, Instance: info, Reachable: false}
	}

	var (
		metrics     telemetry.DatabaseMetrics
		slowQueries []telemetry.SlowQuery
		err         error
	)
	switch m.target.Engine {
	case "postgresql":
		metrics, slowQueries, err = m.collectPostgres(ctx, now, &info)
	case "mysql", "mariadb":
		metrics, slowQueries, err = m.collectMySQL(ctx, now, &info)
	}
	info.Version = truncateUTF8(info.Version, maxVersionBytes)
	if err != nil {
		return telemetry.DatabaseMetric{CollectedAt: collectedAt, Instance: info, Reachable: false}
	}

	m.prevAt = now
	return telemetry.DatabaseMetric{CollectedAt: collectedAt, Instance: info, Reachable: true, Metrics: metrics, SlowQueries: slowQueries}
}

// rate computes a per-minute rate from a cumulative counter delta — nil on the first poll (no
// previous sample) or if the counter went backwards (a restart reset it), same convention as the
// host/SNMP collectors' byte/packet counters.
func (m *Monitor) rate(cur, prev uint64, now time.Time) *float64 {
	perSecond := m.ratePerSecond(cur, prev, now)
	if perSecond == nil {
		return nil
	}
	perMinute := *perSecond * 60
	return &perMinute
}

// ratePerSecond is rate's per-second counterpart, used for QPS.
func (m *Monitor) ratePerSecond(cur, prev uint64, now time.Time) *float64 {
	if m.prevAt.IsZero() || cur < prev {
		return nil
	}
	seconds := now.Sub(m.prevAt).Seconds()
	if seconds <= 0 {
		return nil
	}
	v := float64(cur-prev) / seconds
	return &v
}
