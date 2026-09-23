package dbmetrics

import (
	"fmt"

	"github.com/go-sql-driver/mysql"
	"github.com/jackc/pgx/v5/pgconn"
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
	default:
		return "", fmt.Errorf("unsupported engine %q", engine)
	}
}
