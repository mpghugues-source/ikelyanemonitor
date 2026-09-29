package dbmetrics

import (
	"fmt"
	"strings"

	"github.com/go-sql-driver/mysql"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/redis/go-redis/v9"
)

// safeEndpoint returns "host:port" parsed out of dsn for display purposes — NEVER the DSN itself,
// which carries credentials. Using each driver's own parser (rather than a hand-rolled regex)
// handles every format that driver accepts (Postgres: URL or keyword/space-separated; MySQL:
// "user:pass@tcp(host:port)/db" or unix sockets) instead of just the common case.
//
// The server independently rejects any endpoint value containing "@" (schemas.ts) as a second
// layer of defense against ever storing a raw DSN by mistake.
func safeEndpoint(engine, dsn string) (string, error) {
	switch engine {
	case "postgresql":
		cfg, err := pgconn.ParseConfig(dsn)
		if err != nil {
			return "", fmt.Errorf("parsing postgresql DSN: %w", err)
		}
		if cfg.Port == 0 {
			return cfg.Host, nil
		}
		return fmt.Sprintf("%s:%d", cfg.Host, cfg.Port), nil
	case "mysql", "mariadb":
		cfg, err := mysql.ParseDSN(dsn)
		if err != nil {
			return "", fmt.Errorf("parsing %s DSN: %w", engine, err)
		}
		return cfg.Addr, nil
	case "mongodb":
		return mongoHosts(dsn)
	case "redis":
		opt, err := redis.ParseURL(dsn)
		if err != nil {
			return "", fmt.Errorf("parsing redis URL: %w", err)
		}
		return opt.Addr, nil
	default:
		return "", fmt.Errorf("unsupported engine %q", engine)
	}
}

// mongoHosts extracts the host list of a mongodb:// or mongodb+srv:// URI ("h1:27017,h2:27017", or
// the SRV name) by hand: the driver's own parser resolves SRV records over DNS, which a display
// helper must not do. Userinfo is everything up to the LAST "@" of the authority (the driver
// requires "@" inside a password to be percent-encoded, so that is unambiguous).
func mongoHosts(dsn string) (string, error) {
	rest, ok := strings.CutPrefix(dsn, "mongodb://")
	if !ok {
		if rest, ok = strings.CutPrefix(dsn, "mongodb+srv://"); !ok {
			return "", fmt.Errorf("mongodb URI must start with mongodb:// or mongodb+srv://")
		}
	}
	if i := strings.IndexAny(rest, "/?"); i >= 0 {
		rest = rest[:i]
	}
	if i := strings.LastIndex(rest, "@"); i >= 0 {
		rest = rest[i+1:]
	}
	if rest == "" {
		return "", fmt.Errorf("mongodb URI has no host")
	}
	return rest, nil
}
