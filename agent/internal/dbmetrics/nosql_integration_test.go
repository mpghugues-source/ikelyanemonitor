package dbmetrics

// Integration tests against REAL MongoDB and Redis servers — skipped unless MONGO_TEST_URI /
// REDIS_TEST_URL are set (same convention as SNMP_TEST_TARGET and the app's DATABASE_URL tests).
//
// Procedure used to verify them (throwaway containers bound to 127.0.0.1 only; remove them after):
//
//	docker run -d --name ikm-test-mongo -p 127.0.0.1:27117:27017 -e MONGO_INITDB_ROOT_USERNAME=root -e MONGO_INITDB_ROOT_PASSWORD=$PW mongo:8
//	docker run -d --name ikm-test-redis -p 127.0.0.1:6479:6379 redis:8 redis-server --requirepass $PW
//	# monitoring accounts with the privileges documented in agent/README.md:
//	#   mongosh: db.getSiblingDB("admin").createUser({user: "ikelyane_agent", pwd: …, roles: [
//	#     {role: "clusterMonitor", db: "admin"}, <read on each profiled database's system.profile>]})
//	#            db.getSiblingDB("shop").setProfilingLevel(1, {slowms: 0})
//	#   redis-cli: ACL SETUSER ikelyane_agent on >… -@all +info +ping +slowlog +config|get +hello +client|setinfo +client|setname
//	#              CONFIG SET slowlog-log-slower-than 0
//	MONGO_TEST_URI='mongodb://ikelyane_agent:…@127.0.0.1:27117/?authSource=admin' MONGO_TEST_ADMIN_URI='mongodb://root:…@127.0.0.1:27117/?authSource=admin' \
//	REDIS_TEST_URL='redis://ikelyane_agent:…@127.0.0.1:6479/0' REDIS_TEST_ADMIN_URL='redis://:…@127.0.0.1:6479/0' \
//	TMPDIR=/root/.gotmp go test ./internal/dbmetrics -run Integration -v

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"ikelyane-agent/internal/config"
)

func TestIntegration_MongoDB(t *testing.T) {
	uri, adminURI := os.Getenv("MONGO_TEST_URI"), os.Getenv("MONGO_TEST_ADMIN_URI")
	if uri == "" || adminURI == "" {
		t.Skip("MONGO_TEST_URI / MONGO_TEST_ADMIN_URI not set")
	}
	ctx := context.Background()
	m, err := New(config.Database{Name: "docs", Engine: "mongodb", DSN: uri, SlowQueryThresholdMs: 0})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()

	t0 := time.Now()
	first := m.Collect(ctx, t0)
	if !first.Reachable {
		t.Fatal("mongodb should be reachable")
	}
	in := first.Instance
	if !strings.HasPrefix(in.Version, "8.") || in.Endpoint != "127.0.0.1:27117" || in.IsReplica == nil || *in.IsReplica || in.MaxConnections == nil {
		t.Fatalf("unexpected instance info: %+v", in)
	}
	if strings.Contains(in.Endpoint, "ikelyane_agent") {
		t.Fatal("endpoint leaks the user name")
	}
	if first.Metrics.ActiveConnections == nil || first.Metrics.StorageUsedBytes == nil || first.Metrics.CacheHitRatio == nil {
		t.Fatalf("missing metrics: %+v", first.Metrics)
	}
	if first.Metrics.QPS != nil || len(first.SlowQueries) != 0 {
		t.Fatal("first poll: rates and slow operations only start on the second sample")
	}

	// Real traffic, with literal values that must never reach the payload.
	admin, err := mongo.Connect(options.Client().ApplyURI(adminURI))
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Disconnect(ctx)
	orders := admin.Database("shop").Collection("orders")
	for range 3 {
		if err := orders.FindOne(ctx, bson.D{{Key: "email", Value: "alice@example.com"}, {Key: "total", Value: bson.D{{Key: "$gt", Value: 1234}}}}).Err(); err != nil && err != mongo.ErrNoDocuments {
			t.Fatal(err)
		}
	}

	second := m.Collect(ctx, t0.Add(30*time.Second))
	if !second.Reachable || second.Metrics.QPS == nil {
		t.Fatalf("second poll must report QPS: %+v", second.Metrics)
	}
	var found bool
	for _, q := range second.SlowQueries {
		t.Logf("slow op: %s calls=%d avg=%.1fms examined=%d", q.QueryText, *q.Calls, q.DurationMs, *q.RowsExamined)
		for _, secret := range []string{"alice", "1234", "ikelyane_agent"} {
			if strings.Contains(q.QueryText, secret) {
				t.Fatalf("slow query %q leaks %q", q.QueryText, secret)
			}
		}
		if strings.HasPrefix(q.QueryText, "shop.orders query ") && strings.Contains(q.QueryText, `"email":"?"`) && strings.Contains(q.QueryText, `"$gt":"?"`) {
			found = true
			if q.DatabaseName != "shop" || q.Calls == nil || *q.Calls != 3 || !strings.HasPrefix(q.Fingerprint, "mongo:") {
				t.Fatalf("unexpected slow query: %+v", q)
			}
		}
	}
	if !found {
		t.Fatalf("the profiled find was not reported: %+v", second.SlowQueries)
	}
	t.Logf("mongodb: version=%s conns=%d storage=%d qps=%.2f slow=%d", in.Version, *first.Metrics.ActiveConnections, *first.Metrics.StorageUsedBytes, *second.Metrics.QPS, len(second.SlowQueries))
}

func TestIntegration_Redis(t *testing.T) {
	url, adminURL := os.Getenv("REDIS_TEST_URL"), os.Getenv("REDIS_TEST_ADMIN_URL")
	if url == "" || adminURL == "" {
		t.Skip("REDIS_TEST_URL / REDIS_TEST_ADMIN_URL not set")
	}
	ctx := context.Background()
	m, err := New(config.Database{Name: "cache", Engine: "redis", DSN: url, SlowQueryThresholdMs: 0})
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()

	t0 := time.Now()
	first := m.Collect(ctx, t0)
	if !first.Reachable {
		t.Fatal("redis should be reachable")
	}
	in := first.Instance
	if !strings.HasPrefix(in.Version, "8.") || in.Endpoint != "127.0.0.1:6479" || in.IsReplica == nil || *in.IsReplica || in.MaxConnections == nil {
		t.Fatalf("unexpected instance info: %+v", in)
	}
	if first.Metrics.ActiveConnections == nil || first.Metrics.StorageUsedBytes == nil {
		t.Fatalf("missing metrics: %+v", first.Metrics)
	}

	opt, _ := redis.ParseURL(adminURL)
	admin := redis.NewClient(opt)
	defer admin.Close()
	admin.Set(ctx, "session:alice", "secret-token-value", time.Minute)
	for range 3 {
		admin.HGetAll(ctx, "user:42:profile")
	}

	second := m.Collect(ctx, t0.Add(30*time.Second))
	if second.Metrics.QPS == nil || second.Metrics.CacheHitRatio == nil {
		t.Fatalf("second poll must report QPS and cache ratio: %+v", second.Metrics)
	}
	byCommand := map[string]int{}
	for _, q := range second.SlowQueries {
		for _, secret := range []string{"alice", "secret-token", "user:42"} {
			if strings.Contains(q.QueryText, secret) || strings.Contains(q.Fingerprint, secret) {
				t.Fatalf("slow query %+v leaks %q", q, secret)
			}
		}
		byCommand[q.Fingerprint] = *q.Calls
	}
	if byCommand["redis:HGETALL"] != 3 || byCommand["redis:SET"] != 1 || byCommand["redis:INFO"] != 0 || byCommand["redis:SLOWLOG GET"] != 0 {
		t.Fatalf("unexpected slowlog grouping: %v", byCommand)
	}
	t.Logf("redis: version=%s clients=%d memory=%d qps=%.2f hit=%.2f slow=%v", in.Version, *first.Metrics.ActiveConnections, *first.Metrics.StorageUsedBytes, *second.Metrics.QPS, *second.Metrics.CacheHitRatio, byCommand)
}
