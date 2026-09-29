package dbmetrics

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"ikelyane-agent/internal/telemetry"
)

// newMongoClient builds a client from a mongodb:// or mongodb+srv:// URI. mongo.Connect does not
// dial: an unreachable server shows up as reachable=false on the first poll, like the SQL engines.
//
// A URI naming ONE host is monitored as that node (direct connection): otherwise the driver would
// discover the replica set and silently report the primary's figures for a secondary's config
// entry. Several hosts or an SRV name keep the driver's normal discovery (the primary is watched).
func newMongoClient(dsn string) (*mongo.Client, error) {
	opts := options.Client().ApplyURI(dsn).
		SetAppName(agentClientName).
		SetMaxPoolSize(2).
		SetMinPoolSize(0).
		SetConnectTimeout(5 * time.Second).
		SetServerSelectionTimeout(5 * time.Second)
	if hosts, err := mongoHosts(dsn); err == nil && strings.HasPrefix(dsn, "mongodb://") && !strings.Contains(hosts, ",") && !strings.Contains(dsn, "directConnection=") {
		opts.SetDirect(true)
	}
	return mongo.Connect(opts)
}

// number reads a numeric field at path from a decoded document, whatever BSON number type the
// server chose (int32, int64 or double vary across versions and magnitudes).
func number(doc bson.M, path ...string) (float64, bool) {
	var cur any = doc
	for _, key := range path {
		m, ok := asMap(cur)
		if !ok {
			return 0, false
		}
		cur = m[key]
	}
	switch v := cur.(type) {
	case int32:
		return float64(v), true
	case int64:
		return float64(v), true
	case float64:
		return v, true
	}
	return 0, false
}

func asMap(v any) (bson.M, bool) {
	switch d := v.(type) {
	case bson.M:
		return d, true
	case bson.D:
		m := make(bson.M, len(d))
		for _, e := range d {
			m[e.Key] = e.Value
		}
		return m, true
	}
	return nil, false
}

// collectMongo needs the built-in clusterMonitor role (serverStatus, replSetGetStatus,
// listDatabases); reading slow operations additionally needs read access to system.profile.
func (m *Monitor) collectMongo(ctx context.Context, now time.Time, info *telemetry.DatabaseInstanceInfo) (telemetry.DatabaseMetrics, []telemetry.SlowQuery, error) {
	var metrics telemetry.DatabaseMetrics
	admin := m.mongo.Database("admin")

	var status bson.M
	if err := admin.RunCommand(ctx, bson.D{{Key: "serverStatus", Value: 1}}).Decode(&status); err != nil {
		return metrics, nil, err
	}
	info.Version, _ = status["version"].(string)

	if current, ok := number(status, "connections", "current"); ok {
		n := int(current)
		metrics.ActiveConnections = &n
		if available, ok := number(status, "connections", "available"); ok && current+available > 0 {
			limit := int(min(current+available, 10_000_000))
			info.MaxConnections = &limit
			pct := min(current/(current+available)*100, 100)
			metrics.ConnectionUsagePercent = &pct
		}
	}

	var ops float64
	for _, op := range []string{"insert", "query", "update", "delete", "getmore", "command"} {
		if v, ok := number(status, "opcounters", op); ok {
			ops += v
		}
	}
	if ops >= 0 {
		metrics.QPS = m.ratePerSecond(uint64(ops), m.prevTxns, now)
		m.prevTxns = uint64(ops)
	}

	// WiredTiger cache: share of page requests served without reading from disk.
	requested, okReq := number(status, "wiredTiger", "cache", "pages requested from the cache")
	readIn, okRead := number(status, "wiredTiger", "cache", "pages read into cache")
	if okReq && okRead && requested > 0 {
		ratio := min(max(1-readIn/requested, 0), 1)
		metrics.CacheHitRatio = &ratio
	}

	isReplica := false
	if repl, ok := asMap(status["repl"]); ok {
		isReplica, _ = repl["secondary"].(bool)
	}
	info.IsReplica = &isReplica
	if isReplica {
		metrics.ReplicationLagSeconds = m.mongoReplicationLag(ctx)
	}

	var names []string
	if dbs, err := m.mongo.ListDatabases(ctx, bson.D{}); err == nil {
		if dbs.TotalSize >= 0 {
			size := uint64(dbs.TotalSize)
			metrics.StorageUsedBytes = &size
		}
		for _, db := range dbs.Databases {
			names = append(names, db.Name)
		}
	}

	slowQueries, perMin := m.mongoSlowOps(ctx, now, names)
	metrics.SlowQueriesPerMin = perMin
	return metrics, slowQueries, nil
}

// mongoReplicationLag is how far this secondary's last applied operation is behind the primary's,
// from replSetGetStatus. Nil when the primary is unknown (election, split) — never a guess.
func (m *Monitor) mongoReplicationLag(ctx context.Context) *float64 {
	var rs struct {
		Members []struct {
			StateStr   string    `bson:"stateStr"`
			OptimeDate time.Time `bson:"optimeDate"`
			Self       bool      `bson:"self"`
		} `bson:"members"`
	}
	if err := m.mongo.Database("admin").RunCommand(ctx, bson.D{{Key: "replSetGetStatus", Value: 1}}).Decode(&rs); err != nil {
		return nil
	}
	var primary, self time.Time
	for _, member := range rs.Members {
		if member.StateStr == "PRIMARY" {
			primary = member.OptimeDate
		}
		if member.Self {
			self = member.OptimeDate
		}
	}
	if primary.IsZero() || self.IsZero() {
		return nil
	}
	lag := max(primary.Sub(self).Seconds(), 0)
	return &lag
}

// Profiled databases read per poll, and entries per database: bounds on the agent's own load.
const (
	mongoProfileMaxDatabases = 50
	mongoProfileMaxEntries   = 200
)

type profileEntry struct {
	Op           string    `bson:"op"`
	Ns           string    `bson:"ns"`
	Command      bson.D    `bson:"command"`
	Millis       float64   `bson:"millis"`
	DocsExamined int64     `bson:"docsExamined"`
	NReturned    int64     `bson:"nreturned"`
	Ts           time.Time `bson:"ts"`
}

// mongoSlowOps reads each database's profiler collection (system.profile — filled only where the
// operator enabled profiling, e.g. db.setProfilingLevel(1, { slowms: 500 })). Entries are single
// executions WITH their literal values, so each is reduced to its shape (redactShape) before being
// grouped; nothing else of the command leaves the agent. The first poll only seeds each database's
// cursor, so the profiler's history is not replayed as if it had just happened.
func (m *Monitor) mongoSlowOps(ctx context.Context, now time.Time, databases []string) ([]telemetry.SlowQuery, *float64) {
	sort.Strings(databases)
	type agg struct {
		database, text     string
		calls              int64
		totalMs            float64
		examined, returned int64
	}
	groups := make(map[string]*agg)
	polled := 0
	for _, name := range databases {
		if name == "local" || name == "config" || polled >= mongoProfileMaxDatabases {
			continue
		}
		polled++
		profile := m.mongo.Database(name).Collection("system.profile")
		last, seeded := m.profileSeen[name]
		if !seeded {
			var newest struct {
				Ts time.Time `bson:"ts"`
			}
			err := profile.FindOne(ctx, bson.D{}, options.FindOne().SetSort(bson.D{{Key: "ts", Value: -1}}).SetProjection(bson.D{{Key: "ts", Value: 1}})).Decode(&newest)
			if err == nil || err == mongo.ErrNoDocuments {
				m.profileSeen[name] = newest.Ts
			}
			continue
		}

		filter := bson.D{
			{Key: "ts", Value: bson.D{{Key: "$gt", Value: last}}},
			{Key: "millis", Value: bson.D{{Key: "$gte", Value: m.target.SlowQueryThresholdMs}}},
			{Key: "appName", Value: bson.D{{Key: "$ne", Value: agentClientName}}}, // not the agent's own reads
		}
		cursor, err := profile.Find(ctx, filter, options.Find().SetSort(bson.D{{Key: "ts", Value: 1}}).SetLimit(mongoProfileMaxEntries))
		if err != nil {
			continue // no privilege on this database: skip it, not the poll
		}
		var entries []profileEntry
		if err := cursor.All(ctx, &entries); err != nil {
			continue
		}
		for _, e := range entries {
			if e.Ts.After(last) {
				last = e.Ts
			}
			text := truncateUTF8(fmt.Sprintf("%s %s %s", e.Ns, e.Op, redactShape(e.Command)), maxQueryTextBytes)
			sum := sha256.Sum256([]byte(text))
			id := "mongo:" + hex.EncodeToString(sum[:16])
			g := groups[id]
			if g == nil {
				g = &agg{database: name, text: text}
				groups[id] = g
			}
			g.calls++
			g.totalMs += e.Millis
			g.examined += max(e.DocsExamined, 0)
			g.returned += max(e.NReturned, 0)
		}
		m.profileSeen[name] = last
	}

	capturedAt := now.Format(time.RFC3339)
	var out []telemetry.SlowQuery
	var slowCalls int64
	for id, g := range groups {
		slowCalls += g.calls
		examined, returned := uint64(g.examined), uint64(g.returned)
		out = append(out, telemetry.SlowQuery{
			CapturedAt: capturedAt, Fingerprint: id, QueryText: g.text, DatabaseName: truncateUTF8(g.database, 128),
			DurationMs: g.totalMs / float64(g.calls), Calls: clampCalls(g.calls), RowsExamined: &examined, RowsReturned: &returned,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].DurationMs > out[j].DurationMs })
	if len(out) > 25 {
		out = out[:25]
	}

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

// Session/transport fields of a profiled command: noise for a query shape, and some (lsid,
// $clusterTime) are unique per call so would split one shape into thousands.
var mongoIgnoredFields = map[string]bool{
	"lsid": true, "$clusterTime": true, "$db": true, "$readPreference": true, "txnNumber": true, "autocommit": true,
	"startTransaction": true, "comment": true, "maxTimeMS": true, "writeConcern": true, "readConcern": true,
	"apiVersion": true, "apiStrict": true, "apiDeprecationErrors": true, "shardVersion": true, "databaseVersion": true,
	"$audit": true, "$client": true, "mayBypassWriteBlocking": true, "cursor": true,
}

// redactShape renders a command document as JSON-like text keeping its STRUCTURE — field names and
// operators — and replacing every value by "?". Arrays keep the shape of their first element only
// ([{"a":"?"}, …]), so an insert of 1 or 1000 documents has the same shape. Field names that do not
// look like identifiers (maps keyed by user data) are masked too.
func redactShape(doc bson.D) string {
	var b strings.Builder
	writeShape(&b, doc, 0, true)
	return b.String()
}

const maxShapeDepth = 12

func writeShape(b *strings.Builder, v any, depth int, top bool) {
	if depth > maxShapeDepth {
		b.WriteString(`"…"`)
		return
	}
	switch d := v.(type) {
	case bson.D:
		b.WriteByte('{')
		first := true
		for _, e := range d {
			if top && mongoIgnoredFields[e.Key] {
				continue
			}
			if !first {
				b.WriteByte(',')
			}
			first = false
			key := e.Key
			if !isFieldName(key) {
				key = "?"
			}
			b.WriteString(strconv.Quote(key))
			b.WriteByte(':')
			writeShape(b, e.Value, depth+1, false)
		}
		b.WriteByte('}')
	case bson.M:
		keys := make([]string, 0, len(d))
		for k := range d {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		ordered := make(bson.D, 0, len(d))
		for _, k := range keys {
			ordered = append(ordered, bson.E{Key: k, Value: d[k]})
		}
		writeShape(b, ordered, depth, top)
	case bson.A:
		writeArray(b, []any(d), depth)
	case []any:
		writeArray(b, d, depth)
	default:
		b.WriteString(`"?"`)
	}
}

func writeArray(b *strings.Builder, items []any, depth int) {
	if len(items) == 0 {
		b.WriteString("[]")
		return
	}
	b.WriteByte('[')
	writeShape(b, items[0], depth+1, false)
	if len(items) > 1 {
		b.WriteString(`,"…"`)
	}
	b.WriteByte(']')
}

// isFieldName accepts identifier-like keys, dotted paths and operators ("$gt", "items.sku").
func isFieldName(s string) bool {
	if s == "" || len(s) > 64 {
		return false
	}
	for _, r := range s {
		if !(r == '_' || r == '$' || r == '.' || r == '-' || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9')) {
			return false
		}
	}
	return true
}
