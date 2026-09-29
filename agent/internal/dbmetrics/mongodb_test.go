package dbmetrics

import (
	"strings"
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func TestRedactShape_KeepsStructureDropsEveryValue(t *testing.T) {
	cmd := bson.D{
		{Key: "find", Value: "orders"},
		{Key: "filter", Value: bson.D{
			{Key: "customer.email", Value: "alice@example.com"},
			{Key: "total", Value: bson.D{{Key: "$gt", Value: 1500}}},
			{Key: "status", Value: bson.D{{Key: "$in", Value: bson.A{"paid", "shipped"}}}},
		}},
		{Key: "limit", Value: int32(20)},
		{Key: "lsid", Value: bson.D{{Key: "id", Value: "session-uuid"}}},
		{Key: "$db", Value: "shop"},
	}
	got := redactShape(cmd)
	want := `{"find":"?","filter":{"customer.email":"?","total":{"$gt":"?"},"status":{"$in":["?","…"]}},"limit":"?"}`
	if got != want {
		t.Fatalf("got  %s\nwant %s", got, want)
	}
	for _, secret := range []string{"alice", "1500", "paid", "orders", "session-uuid", "shop"} {
		if strings.Contains(got, secret) {
			t.Fatalf("shape %s leaks %q", got, secret)
		}
	}
}

func TestRedactShape_SameShapeWhateverTheValues(t *testing.T) {
	insert := func(docs ...any) bson.D {
		return bson.D{{Key: "insert", Value: "events"}, {Key: "documents", Value: bson.A(docs)}}
	}
	one := redactShape(insert(bson.D{{Key: "type", Value: "click"}, {Key: "at", Value: 1}}))
	many := redactShape(insert(bson.D{{Key: "type", Value: "view"}, {Key: "at", Value: 2}}, bson.D{{Key: "type", Value: "x"}}))
	if one != `{"insert":"?","documents":[{"type":"?","at":"?"}]}` {
		t.Fatalf("unexpected shape %s", one)
	}
	if many != `{"insert":"?","documents":[{"type":"?","at":"?"},"…"]}` {
		t.Fatalf("unexpected shape %s", many)
	}
}

func TestRedactShape_MasksKeysThatAreData(t *testing.T) {
	got := redactShape(bson.D{{Key: "update", Value: "u"}, {Key: "u", Value: bson.D{{Key: "prefs.alice@example.com", Value: true}, {Key: "tags.a b", Value: 1}}}})
	if strings.Contains(got, "alice") || strings.Contains(got, "a b") {
		t.Fatalf("data-like keys must be masked: %s", got)
	}
}

func TestNumber_AcceptsEveryBSONNumberType(t *testing.T) {
	doc := bson.M{"a": int32(1), "b": bson.D{{Key: "c", Value: int64(2)}}, "d": bson.M{"e": 3.5}, "s": "x"}
	for path, want := range map[string]float64{"a": 1, "b.c": 2, "d.e": 3.5} {
		got, ok := number(doc, strings.Split(path, ".")...)
		if !ok || got != want {
			t.Errorf("number(%s) = %v, %v; want %v", path, got, ok, want)
		}
	}
	if _, ok := number(doc, "s"); ok {
		t.Error("a string is not a number")
	}
	if _, ok := number(doc, "missing", "x"); ok {
		t.Error("a missing path is not a number")
	}
}
