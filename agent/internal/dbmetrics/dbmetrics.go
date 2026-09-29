// Package dbmetrics monitors PostgreSQL, MySQL/MariaDB, MongoDB and Redis instances configured
// locally on the agent (internal/config) and shapes the result into telemetry.DatabaseMetric.
//
// Credentials never reach the server: only safeEndpoint's "host:port" (dsn.go) is ever sent, and
// slow-query text comes back from the engine ITSELF already normalized (Postgres's
// pg_stat_statements, MySQL/MariaDB's performance_schema digest both aggregate by normalized query
// shape — the agent never has to strip literals by hand, which would be easy to get subtly wrong
// across SQL dialects). MongoDB and Redis have no such normalized view: for them the agent keeps the
// STRUCTURE only and drops every value itself (mongodb.go's redactShape, redis.go's command names).
package dbmetrics

import (
	"context"
	"database/sql"
	"fmt"
	"sync"
	"time"

	_ "github.com/go-sql-driver/mysql" // registers the "mysql" database/sql driver
	_ "github.com/jackc/pgx/v5/stdlib" // registers the "pgx" database/sql driver

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"ikelyane-agent/internal/config"
	"ikelyane-agent/internal/telemetry"
)

// sqlDriverName maps the SQL engines to the database/sql driver that handles them ("" otherwise).
func sqlDriverName(engine string) string {
	switch engine {
	case "postgresql":
		return "pgx"
	case "mysql", "mariadb":
		return "mysql"
	default:
		return ""
	}
}

// Monitor polls one configured database instance across its lifetime. It owns a persistent
// connection pool (reused every cycle — reconnecting fresh each time would be wasteful and, on a
// slow/loaded server, could itself distort the metrics it's trying to measure) and whatever
// cumulative-counter state its engine's rate metrics (QPS, deadlocks/min) need between polls.
type Monitor struct {
	target   config.Database
	endpoint string // credential-free "host:port", see dsn.go

	// Exactly one client is set, depending on the engine.
	db    *sql.DB       // postgresql, mysql, mariadb
	mongo *mongo.Client // mongodb
	redis *redis.Client // redis

	// mu guards the fields below. A single Monitor is meant to be polled by one goroutine per
	// cycle, but the mutex is cheap insurance against a slow cycle overlapping the next one —
	// same defensive stance as snmp.Poller.
	mu            sync.Mutex
	prevAt        time.Time
	prevTxns      uint64 // Postgres: sum(xact_commit+xact_rollback); MySQL: Questions; MongoDB: opcounters; Redis: total_commands_processed
	prevDeadlocks uint64
	prevQueries   map[string]queryStats // digest/queryid -> cumulative counters, see slowqueries.go

	// Event-log cursors (MongoDB system.profile per database, Redis SLOWLOG): only entries newer than
	// these are reported. Unset until the first poll, which only seeds them — history is not replayed.
	profileSeen   map[string]time.Time
	slowlogLastID *int64
}

// New opens (but does not yet use) the connection pool for target. Connection FAILURES are not
// returned here — Collect reports them as reachable=false, same as a failure on any later poll,
// so a database that is briefly down when the agent starts does not stop the agent.
func New(target config.Database) (*Monitor, error) {
	endpoint, err := safeEndpoint(target.Engine, target.DSN)
	if err != nil {
		return nil, fmt.Errorf("database %q: %w", target.Name, err)
	}
	m := &Monitor{target: target, endpoint: truncateUTF8(endpoint, maxEndpointBytes), prevQueries: make(map[string]queryStats), profileSeen: make(map[string]time.Time)}

	// Every client is capped at two connections: a monitoring agent must stay a negligible load on
	// the server it watches, and must not linger across the target's own restarts/failovers.
	switch target.Engine {
	case "mongodb":
		m.mongo, err = newMongoClient(target.DSN)
	case "redis":
		m.redis, err = newRedisClient(target.DSN)
	default:
		driver := sqlDriverName(target.Engine)
		if driver == "" {
			return nil, fmt.Errorf("database %q: unsupported engine %q", target.Name, target.Engine)
		}
		m.db, err = sql.Open(driver, target.DSN)
		if err == nil {
			m.db.SetMaxOpenConns(2)
			m.db.SetConnMaxLifetime(10 * time.Minute)
		}
	}
	if err != nil {
		return nil, fmt.Errorf("database %q: %w", target.Name, err)
	}
	return m, nil
}

func (m *Monitor) Close() error {
	switch {
	case m.mongo != nil:
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return m.mongo.Disconnect(ctx)
	case m.redis != nil:
		return m.redis.Close()
	default:
		return m.db.Close()
	}
}

func (m *Monitor) ping(ctx context.Context) error {
	switch {
	case m.mongo != nil:
		return m.mongo.Ping(ctx, nil)
	case m.redis != nil:
		return m.redis.Ping(ctx).Err()
	default:
		return m.db.PingContext(ctx)
	}
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
	if err := m.ping(pingCtx); err != nil {
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
	case "mongodb":
		metrics, slowQueries, err = m.collectMongo(ctx, now, &info)
	case "redis":
		metrics, slowQueries, err = m.collectRedis(ctx, now, &info)
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
