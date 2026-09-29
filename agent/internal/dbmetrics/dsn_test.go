package dbmetrics

import "testing"

func TestSafeEndpoint_Postgres(t *testing.T) {
	cases := []struct {
		name string
		dsn  string
		want string
	}{
		{"URL form", "postgres://myuser:s3cret@db.example.com:5432/main?sslmode=disable", "db.example.com:5432"},
		{"keyword form", "host=db.example.com port=5432 user=myuser password=s3cret dbname=main", "db.example.com:5432"},
		{"default port", "postgres://myuser:s3cret@db.example.com/main", "db.example.com:5432"}, // pgx fills in 5432
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := safeEndpoint("postgresql", c.dsn)
			if err != nil {
				t.Fatalf("safeEndpoint() error: %v", err)
			}
			if got != c.want {
				t.Errorf("got %q, want %q", got, c.want)
			}
			assertNoCredentials(t, got, "myuser", "s3cret")
		})
	}
}

func TestSafeEndpoint_MySQL(t *testing.T) {
	got, err := safeEndpoint("mysql", "myuser:s3cret@tcp(db.example.com:3306)/main")
	if err != nil {
		t.Fatalf("safeEndpoint() error: %v", err)
	}
	if got != "db.example.com:3306" {
		t.Errorf("got %q, want %q", got, "db.example.com:3306")
	}
	assertNoCredentials(t, got, "myuser", "s3cret")

	// mariadb uses the exact same wire protocol/DSN format as mysql.
	got, err = safeEndpoint("mariadb", "myuser:s3cret@tcp(db.example.com:3306)/main")
	if err != nil {
		t.Fatalf("safeEndpoint() error: %v", err)
	}
	if got != "db.example.com:3306" {
		t.Errorf("got %q, want %q", got, "db.example.com:3306")
	}
}

func TestSafeEndpoint_InvalidDSN(t *testing.T) {
	if _, err := safeEndpoint("postgresql", "not a valid dsn at all ::::"); err == nil {
		t.Error("expected an error for a malformed postgresql DSN")
	}
	if _, err := safeEndpoint("unsupported-engine", "whatever"); err == nil {
		t.Error("expected an error for an unsupported engine")
	}
}

func assertNoCredentials(t *testing.T, endpoint, user, password string) {
	t.Helper()
	if contains(endpoint, user) || contains(endpoint, password) {
		t.Fatalf("endpoint %q leaks a credential — this must never happen (the server also rejects any endpoint containing \"@\")", endpoint)
	}
}

func contains(s, substr string) bool {
	for i := 0; i+len(substr) <= len(s); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}

func TestSafeEndpoint_MongoDB(t *testing.T) {
	cases := []struct {
		name string
		dsn  string
		want string
	}{
		{"single host", "mongodb://myuser:s3cret@db.example.com:27017/?authSource=admin", "db.example.com:27017"},
		{"replica set", "mongodb://myuser:s3cret@a.example.com:27017,b.example.com:27017/app?replicaSet=rs0", "a.example.com:27017,b.example.com:27017"},
		{"srv, no DNS lookup", "mongodb+srv://myuser:s3cret@cluster0.example.net/?retryWrites=true", "cluster0.example.net"},
		{"encoded @ in password", "mongodb://myuser:s3cret%40x@db.example.com", "db.example.com"},
		{"no credentials", "mongodb://127.0.0.1:27017", "127.0.0.1:27017"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := safeEndpoint("mongodb", c.dsn)
			if err != nil {
				t.Fatalf("safeEndpoint() error: %v", err)
			}
			if got != c.want {
				t.Errorf("got %q, want %q", got, c.want)
			}
			assertNoCredentials(t, got, "myuser", "s3cret")
		})
	}
	if _, err := safeEndpoint("mongodb", "http://db.example.com"); err == nil {
		t.Error("a non-mongodb URI must be rejected")
	}
}

func TestSafeEndpoint_Redis(t *testing.T) {
	for dsn, want := range map[string]string{
		"redis://myuser:s3cret@cache.example.com:6380/2": "cache.example.com:6380",
		"rediss://:s3cret@cache.example.com":             "cache.example.com:6379",
	} {
		got, err := safeEndpoint("redis", dsn)
		if err != nil {
			t.Fatalf("safeEndpoint(%q) error: %v", dsn, err)
		}
		if got != want {
			t.Errorf("got %q, want %q", got, want)
		}
		assertNoCredentials(t, got, "myuser", "s3cret")
	}
}
