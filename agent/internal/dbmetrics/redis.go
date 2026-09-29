package dbmetrics

import (
	"context"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	"ikelyane-agent/internal/telemetry"
)

// newRedisClient builds a client from a redis:// or rediss:// (TLS) URL — user, password and
// database index included. It does not connect: the first command does, and a failure then is a
// normal "unreachable" sample, never an agent startup failure.
func newRedisClient(dsn string) (*redis.Client, error) {
	opt, err := redis.ParseURL(dsn)
	if err != nil {
		return nil, err
	}
	// Named so that the agent's own commands can be told apart in the SLOWLOG (and in CLIENT LIST) —
	// best-effort: go-redis's ClientName option fails the whole connection when the monitoring ACL
	// user lacks +client|setname, which would turn a missing nicety into an "unreachable" instance.
	opt.OnConnect = func(ctx context.Context, cn *redis.Conn) error {
		_ = cn.ClientSetName(ctx, agentClientName).Err()
		return nil
	}
	opt.PoolSize = 2
	opt.MinIdleConns = 0
	opt.ConnMaxLifetime = 10 * time.Minute
	opt.DialTimeout = 5 * time.Second
	opt.ReadTimeout = 5 * time.Second
	opt.WriteTimeout = 5 * time.Second
	opt.MaxRetries = 0 // a failed poll is reported as such; the next cycle is the retry
	return redis.NewClient(opt), nil
}

// parseRedisInfo turns the INFO text ("# Section\r\nkey:value\r\n…") into a flat map.
func parseRedisInfo(text string) map[string]string {
	fields := make(map[string]string)
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if key, value, ok := strings.Cut(line, ":"); ok {
			fields[key] = value
		}
	}
	return fields
}

func infoUint(fields map[string]string, key string) (uint64, bool) {
	v, err := strconv.ParseUint(fields[key], 10, 64)
	return v, err == nil
}

// collectRedis reads INFO (one round trip for nearly everything), maxclients from CONFIG GET (often
// denied to a monitoring ACL user — then simply not reported) and the SLOWLOG.
//
// Redis is an in-memory store: "storage used" is used_memory, and the quota is maxmemory when set.
// Deadlocks do not exist there and are never reported. There is no time-based replication lag in
// INFO (only byte offsets), so none is invented: a replica is flagged, its lag left empty.
func (m *Monitor) collectRedis(ctx context.Context, now time.Time, info *telemetry.DatabaseInstanceInfo) (telemetry.DatabaseMetrics, []telemetry.SlowQuery, error) {
	var metrics telemetry.DatabaseMetrics

	text, err := m.redis.Info(ctx, "server", "clients", "memory", "stats", "replication").Result()
	if err != nil {
		return metrics, nil, err
	}
	fields := parseRedisInfo(text)
	info.Version = fields["redis_version"]
	if v := fields["valkey_version"]; v != "" {
		info.Version = "valkey " + v
	}

	isReplica := fields["role"] == "slave"
	info.IsReplica = &isReplica

	if cfg, err := m.redis.ConfigGet(ctx, "maxclients").Result(); err == nil {
		if n, err := strconv.Atoi(cfg["maxclients"]); err == nil && n > 0 && n <= 10_000_000 {
			info.MaxConnections = &n
		}
	}
	if clients, ok := infoUint(fields, "connected_clients"); ok {
		n := int(clients)
		metrics.ActiveConnections = &n
		if info.MaxConnections != nil {
			pct := min(float64(n)/float64(*info.MaxConnections)*100, 100)
			metrics.ConnectionUsagePercent = &pct
		}
	}

	if used, ok := infoUint(fields, "used_memory"); ok {
		metrics.StorageUsedBytes = &used
	}
	if quota, ok := infoUint(fields, "maxmemory"); ok && quota > 0 {
		info.StorageQuotaBytes = &quota
	}

	hits, okHits := infoUint(fields, "keyspace_hits")
	misses, okMisses := infoUint(fields, "keyspace_misses")
	if okHits && okMisses && hits+misses > 0 {
		ratio := float64(hits) / float64(hits+misses)
		metrics.CacheHitRatio = &ratio
	}

	if commands, ok := infoUint(fields, "total_commands_processed"); ok {
		metrics.QPS = m.ratePerSecond(commands, m.prevTxns, now)
		m.prevTxns = commands
	}

	slowQueries, perMin := m.redisSlowlog(ctx, now)
	metrics.SlowQueriesPerMin = perMin
	return metrics, slowQueries, nil
}

// agentClientName identifies the agent's own connections on the monitored server (Redis client
// name, MongoDB appName), so its monitoring commands are never reported as the application's.
const agentClientName = "ikelyane-agent"

// redisSlowlogFetch is how many of the most recent SLOWLOG entries are read per poll (the server
// keeps slowlog-max-len, 128 by default).
const redisSlowlogFetch = 128

// redisSlowlog reports the SLOWLOG entries logged since the previous poll. Arguments are NEVER
// sent — they are the application's keys and values. Entries are grouped by command name (plus the
// subcommand of container commands, "CONFIG GET"), which is the only "shape" a Redis command has.
// SLOWLOG access denied (ACL) is not a poll failure: just no slow queries.
func (m *Monitor) redisSlowlog(ctx context.Context, now time.Time) ([]telemetry.SlowQuery, *float64) {
	entries, err := m.redis.SlowLogGet(ctx, redisSlowlogFetch).Result()
	if err != nil {
		return nil, nil
	}
	events := make([]slowlogEvent, 0, len(entries))
	for _, e := range entries {
		command := redisCommandName(e.Args)
		if e.ClientName == agentClientName {
			// The agent's own INFO/SLOWLOG calls are not the application's slow commands — but they
			// still advance the cursor, or a window holding only them would look like a SLOWLOG RESET.
			command = ""
		}
		events = append(events, slowlogEvent{id: e.ID, durationMs: float64(e.Duration.Microseconds()) / 1000, command: command})
	}
	return m.slowlogDeltas(events, now)
}

type slowlogEvent struct {
	id         int64
	durationMs float64
	command    string
}

// slowlogDeltas aggregates the events newer than the cursor, per command, keeping those whose
// average duration reaches the threshold. The first poll only seeds the cursor. A cursor AHEAD of
// every id (SLOWLOG RESET, server restart) is re-seeded rather than trusted. Callers hold m.mu.
func (m *Monitor) slowlogDeltas(events []slowlogEvent, now time.Time) ([]telemetry.SlowQuery, *float64) {
	var maxID int64 = -1
	for _, e := range events {
		maxID = max(maxID, e.id)
	}
	last := m.slowlogLastID
	m.slowlogLastID = &maxID
	if last == nil || maxID < *last {
		return nil, nil
	}

	type agg struct {
		calls   int64
		totalMs float64
	}
	byCommand := make(map[string]*agg)
	var slowCalls int64
	for _, e := range events {
		if e.id <= *last || e.command == "" {
			continue
		}
		a := byCommand[e.command]
		if a == nil {
			a = &agg{}
			byCommand[e.command] = a
		}
		a.calls++
		a.totalMs += e.durationMs
	}

	threshold := float64(m.target.SlowQueryThresholdMs)
	capturedAt := now.Format(time.RFC3339)
	var out []telemetry.SlowQuery
	for command, a := range byCommand {
		avg := a.totalMs / float64(a.calls)
		if avg < threshold {
			continue
		}
		slowCalls += a.calls
		out = append(out, telemetry.SlowQuery{
			CapturedAt: capturedAt, Fingerprint: "redis:" + command, QueryText: command + " …", DurationMs: avg, Calls: clampCalls(a.calls),
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].DurationMs > out[j].DurationMs })

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

// Container commands whose first argument is a subcommand worth keeping ("CONFIG SET" and
// "CONFIG GET" are very different operations); the subcommand is a fixed keyword, never user data.
var redisContainerCommands = map[string]bool{
	"ACL": true, "CLIENT": true, "CLUSTER": true, "COMMAND": true, "CONFIG": true, "DEBUG": true, "FUNCTION": true,
	"LATENCY": true, "MEMORY": true, "MODULE": true, "OBJECT": true, "PUBSUB": true, "SCRIPT": true, "SLOWLOG": true,
	"XGROUP": true, "XINFO": true,
}

// redisCommandName returns the command (and subcommand) of a SLOWLOG entry, never its arguments.
// Anything that does not look like a command keyword is dropped rather than risk leaking data.
func redisCommandName(args []string) string {
	if len(args) == 0 {
		return ""
	}
	name := strings.ToUpper(args[0])
	if !isKeyword(name) {
		return ""
	}
	if redisContainerCommands[name] && len(args) > 1 {
		if sub := strings.ToUpper(args[1]); isKeyword(sub) {
			return fmt.Sprintf("%s %s", name, sub)
		}
	}
	return name
}

func isKeyword(s string) bool {
	if s == "" || len(s) > 32 {
		return false
	}
	for _, r := range s {
		if (r < 'A' || r > 'Z') && (r < '0' || r > '9') && r != '_' && r != '-' && r != '.' && r != '|' {
			return false
		}
	}
	return true
}
