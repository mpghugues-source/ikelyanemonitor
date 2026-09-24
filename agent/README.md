# ikelyane-agent

The IkelyaneMonitor agent: collects host metrics (CPU, memory, disks, network, temperature,
uptime, process count), polls SNMP network devices assigned to it in the web UI (routers,
switches, firewalls, APs, UPSes, BMCs — v1/v2c/v3) and monitors PostgreSQL / MySQL / MariaDB
instances configured locally, and — only if this host's owner opts in — runs remediation scripts sent
by the platform. Everything goes over the signed HTTP protocol described in
[`docs/telemetry.md`](../docs/telemetry.md).

## SNMP

A device polled by this agent is configured entirely in the web UI (Network page: register the
device, set its SNMP credentials, and pick "polled by" this host) — not in the agent's own config.
On every collection cycle the agent:

1. Fetches its assigned device list from `GET /api/v1/poller-config` (credentials included,
   decrypted for this one response — see docs/telemetry.md "Discovering SNMP targets"), cached and
   refreshed every 5 minutes so adding/removing a device in the UI is picked up without a restart.
2. Polls each device (standard MIB-II/IF-MIB: sysDescr/sysName/sysUpTime, the interface table with
   64-bit counters when available, EtherLike-MIB CRC errors on a best-effort basis), several
   devices at once (bounded concurrency) so a handful of unreachable ones cannot stall a whole
   cycle.
3. Includes the results in the same request as the host sample.

Vendor/model/serial number (ENTITY-MIB) and hardware temperature/power have no portable OID and
are not collected; neither is packet loss (would need ICMP, which this agent does not do). A
device that fails to respond is still reported, with `reachable: false` — the server then marks it
DOWN rather than leaving it stale.

## Databases

Unlike SNMP devices, databases are configured **only in the agent's own config** (`databases`, see
[Configure](#configure)) — database credentials never leave the host. The server auto-discovers each
instance from the first sample that mentions it, keyed on its `name` (keep it stable: renaming creates
a second instance). Supported engines: `postgresql`, `mysql`, `mariadb`.

Every cycle, for each instance (up to 5 polled at once, one small connection pool per instance kept
for the agent's lifetime):

| Metric | PostgreSQL | MySQL / MariaDB |
|---|---|---|
| version, max connections | `server_version`, `max_connections` | `VERSION()`, `@@max_connections` |
| active connections / usage % | client backends in `pg_stat_activity` | `Threads_connected` |
| QPS | Δ(`xact_commit`+`xact_rollback`) — transactions/s | Δ`Questions`/s |
| cache hit ratio | `blks_hit` / (`blks_hit`+`blks_read`) | InnoDB buffer pool read requests vs disk reads |
| deadlocks (total, /min) | `pg_stat_database.deadlocks` | `Innodb_deadlocks` (MariaDB only — absent on MySQL 8, so not reported there) |
| replication | `pg_is_in_recovery()`, replay lag | `SHOW REPLICA STATUS` / `SHOW SLAVE STATUS` |
| storage used | `pg_database_size` of every database | `information_schema.tables` (data + index) |
| slow queries | `pg_stat_statements` (PostgreSQL 13+) | `performance_schema` statement digests |

Rates (QPS, deadlocks/min, slow queries/min) appear from the second sample onwards. An unreachable
instance is still reported, with `reachable: false`, and the server marks it DOWN.

**Slow queries** are statement *shapes* already normalized by the engine itself (`SELECT … WHERE id =
$1` / `?`) — the agent never sees or sends literal values. A shape is reported when it ran again since
the previous cycle and its average duration **over that interval** is at or above
`slowQueryThresholdMs` (default 1000); `calls` is the number of executions in the interval. Without
`pg_stat_statements` (`shared_preload_libraries = 'pg_stat_statements'` + `CREATE EXTENSION
pg_stat_statements`) or `performance_schema = ON`, everything else is still collected — just no slow
queries.

### Monitoring user

Give the agent a dedicated, read-only monitoring account — never an application or admin account:

```sql
-- PostgreSQL 10+
CREATE ROLE ikelyane_agent LOGIN PASSWORD '…';
GRANT pg_monitor TO ikelyane_agent;          -- stats views, pg_stat_statements for every user

-- MySQL 8 / MariaDB 10.5+
CREATE USER 'ikelyane_agent'@'localhost' IDENTIFIED BY '…';
GRANT PROCESS, REPLICATION CLIENT ON *.* TO 'ikelyane_agent'@'localhost';  -- MariaDB 10.5+: REPLICA MONITOR
GRANT SELECT ON performance_schema.* TO 'ikelyane_agent'@'localhost';
```

On MySQL/MariaDB, `information_schema.tables` only lists tables the account has some privilege on:
with the grants above, **storage used is not reported**. Add `GRANT SELECT ON <schema>.* …` for the
schemas whose size you want counted (this also lets the account read their data — your call).

## Remediation

The platform can ask agents to run **remediation scripts** (by hand, or when an alert fires). That is
remote code execution by design, so this host decides — here, in its own configuration, never from the
web UI — whether and what it runs:

| `remediation.mode` | What runs |
|---|---|
| `disabled` (**default**) | Nothing. The agent does not even ask for jobs. |
| `allowlist` | Only scripts whose SHA-256 is listed in `remediation.allowedSha256` (shown next to each action on the Auto-remediation page). **Even a compromised platform cannot make this host run anything else.** Changing a script means updating this list. |
| `any` | Any script an administrator of your IkelyaneMonitor organization writes. Convenient; trusts the platform and its administrators with this host. |

The agent reports its mode (and allowlist) with every sample, so the platform only queues what the host
accepts and the UI shows why a run was refused — but the agent enforces its policy itself regardless.
For every job it also:

- refuses it unless the platform's response is signed with this host's secret (`X-Ikelyane-Signature`,
  verified before anything is parsed) and the script matches the SHA-256 announced for it;
- writes the script to `remediation.workDir` (default `/var/lib/ikelyane-agent/remediation`, created
  `0700`) and hands it to the interpreter — `bash --noprofile --norc`, `pwsh`/`powershell -NoProfile
  -NonInteractive`, or `python3 -I` — then deletes it;
- runs it in a **clean environment**: a fixed `PATH`, `LANG`, `HOME`=work dir, `IKELYANE_EXECUTION_ID`,
  `IKELYANE_INCIDENT_ID` (alert runs) and one `IKELYANE_ARG_<NAME>` per argument. Nothing from the
  agent's own environment (its HMAC secret, database DSNs…) is visible to scripts. Arguments are only
  ever environment variables, never pasted into the script text;
- kills the script's whole process group at its timeout (Unix; on Windows only the process itself);
- keeps at most 64 KiB of stdout and of stderr, and runs one job at a time.

Jobs are polled every 10 seconds (only when the mode is not `disabled`).

### Privileges

Scripts run as the agent's user. With the provided systemd unit that is the unprivileged
`ikelyane-agent` user, on a read-only system (`ProtectSystem=strict`) with `NoNewPrivileges=true` —
so `sudo` cannot work, by design. Grant exactly what your scripts need instead, e.g. letting the agent
restart one service through polkit (works under `NoNewPrivileges`, no setuid involved):

```js
// /etc/polkit-1/rules.d/50-ikelyane-agent.rules
polkit.addRule(function (action, subject) {
  if (action.id == "org.freedesktop.systemd1.manage-units" && subject.user == "ikelyane-agent" &&
      action.lookup("unit") == "nginx.service" && action.lookup("verb") == "restart") {
    return polkit.Result.YES;
  }
});
```

Loosening the unit itself (`ReadWritePaths=`, dropping `NoNewPrivileges`, `User=root`) is possible in
a drop-in (`systemctl edit ikelyane-agent`), at the cost of giving every allowed script those rights.

## Build

Requires Go 1.25+.

```bash
cd agent
go build -o ikelyane-agent ./cmd/ikelyane-agent
```

For a specific target platform (the agent is a single static binary — nothing else to install on
the target host):

```bash
GOOS=linux   GOARCH=amd64 go build -o ikelyane-agent-linux-amd64   ./cmd/ikelyane-agent
GOOS=linux   GOARCH=arm64 go build -o ikelyane-agent-linux-arm64   ./cmd/ikelyane-agent
GOOS=windows GOARCH=amd64 go build -o ikelyane-agent-windows.exe   ./cmd/ikelyane-agent
GOOS=darwin  GOARCH=arm64 go build -o ikelyane-agent-macos-arm64   ./cmd/ikelyane-agent
```

To stamp the version reported in the payload's `agent.version` field:

```bash
go build -ldflags "-X main.Version=1.2.3" -o ikelyane-agent ./cmd/ikelyane-agent
```

## Register a host

Before running the agent, register the host in IkelyaneMonitor (Settings > Servers > Register a
server in the web UI, or `npm run provision:host -- --org <slug> --hostname <name>` from the main
app's repo root). Registration prints a key id (`ikm_…`) and a secret — the secret is shown **once**
and cannot be recovered later, only rotated.

## Configure

Two ways, in order of precedence:

1. **`--config <path>`** — a JSON file:

   ```json
   {
     "serverUrl": "https://monitor.example.com",
     "keyId": "ikm_xxxxxxxxxxxxxxxxxxxxxxxx",
     "secret": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
     "intervalSeconds": 60,
     "bufferDir": "/var/lib/ikelyane-agent/buffer",
     "remediation": { "mode": "allowlist", "allowedSha256": ["<sha-256 shown in the web UI>"] },
     "databases": [
       { "name": "main:5432", "engine": "postgresql",
         "dsn": "postgres://ikelyane_agent:…@127.0.0.1:5432/postgres?sslmode=disable" },
       { "name": "shop:3306", "engine": "mariadb",
         "dsn": "ikelyane_agent:…@tcp(127.0.0.1:3306)/", "slowQueryThresholdMs": 500 }
     ]
   }
   ```

   `dsn` is the driver's native format (pgx URL or keyword string; go-sql-driver `user:pass@tcp(host:port)/`
   or `unix(/path/to.sock)`). It is never logged or sent: only a credential-free `host:port` is.

2. **Environment variables** (used when `--config` is not given — the natural fit for a systemd
   `EnvironmentFile`, the pattern already used for this app's other services):

   | Variable | Required | Default |
   |---|---|---|
   | `IKELYANE_SERVER_URL` | yes | — |
   | `IKELYANE_KEY_ID` | yes | — |
   | `IKELYANE_SECRET` | yes | — |
   | `IKELYANE_INTERVAL_SECONDS` | no | `60` (minimum `10`) |
   | `IKELYANE_BUFFER_DIR` | no | `/var/lib/ikelyane-agent/buffer` |
   | `IKELYANE_DATABASES_JSON` | no | — (the `databases` array above, as JSON) |
   | `IKELYANE_REMEDIATION_MODE` | no | `disabled` (`allowlist` \| `any`) |
   | `IKELYANE_REMEDIATION_ALLOWED_SHA256` | with `allowlist` | — (comma-separated SHA-256) |
   | `IKELYANE_REMEDIATION_WORK_DIR` | no | `/var/lib/ikelyane-agent/remediation` |

   See [`ikelyane-agent.example.env`](ikelyane-agent.example.env).

The secret and any database DSN are credentials: keep their file/environment source `0600`, readable only by the agent's
user (and root).

## Run

```bash
./ikelyane-agent                 # collect and send every interval, forever, until SIGINT/SIGTERM
./ikelyane-agent --once          # collect and send a single sample, then exit — good for testing
./ikelyane-agent --config /etc/ikelyane-agent/agent.json
./ikelyane-agent --version
```

The agent logs to stdout/stderr (plain text, one line per event) — no log file of its own; let
systemd/journald or your process supervisor capture it.

## Deploy with systemd

```bash
sudo cp ikelyane-agent /usr/local/bin/ikelyane-agent
sudo useradd --system --no-create-home --shell /usr/sbin/nologin ikelyane-agent
sudo mkdir -p /etc/ikelyane-agent
sudo cp ikelyane-agent.example.env /etc/ikelyane-agent/agent.env   # then edit it in place
sudo chmod 600 /etc/ikelyane-agent/agent.env
sudo cp systemd/ikelyane-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ikelyane-agent
sudo systemctl status ikelyane-agent
journalctl -u ikelyane-agent -f
```

### Permissions

Running as a dedicated unprivileged user (the unit file's default) means some temperature sensors
and other users' processes become unreadable — the agent treats each of those as a soft failure
(logged once, that one field just stays empty) rather than crashing. If you need full sensor
readings, either run the unit as root or grant the specific access your platform needs (e.g. group
membership on `/sys/class/hwmon` on Linux); metrics for the host's own CPU/memory/disks/network are
unaffected either way.

## Delivery behavior

- Every point is idempotent on the server (keyed by source + metric + instance + time): re-sending
  the same sample after a retry or a buffered replay never creates duplicates.
- If a send fails because the server is unreachable or returns a 5xx, the sample is written to
  `bufferDir` and retried — oldest first — at the start of every later cycle, re-signed with a
  fresh timestamp each time (the signature only needs to be *current*, not the metrics' own
  `collectedAt`).
- A response that means "this exact request is malformed or misconfigured" (a 4xx other than a
  clock-skew or host-disabled error) is logged loudly and the sample is dropped — retrying
  identical bytes would fail the same way forever.
- The buffer keeps at most 500 samples (oldest dropped first past that) and never keeps one older
  than 7 days, matching the server's backfill window — see `internal/buffer`.

## Layout

```
cmd/ikelyane-agent/    entry point: flags, the collect/send loop, SNMP and database polling loops
internal/config/       loads IKELYANE_* env vars or a JSON file
internal/collect/      gopsutil-based host metrics, with per-cycle rate calculation for IOPS/bandwidth
internal/snmp/         SNMP v1/v2c/v3 polling (github.com/gosnmp/gosnmp) — MIB-II/IF-MIB, counter-delta rates
internal/dbmetrics/    PostgreSQL (pgx) / MySQL-MariaDB (go-sql-driver) monitoring, slow-query interval deltas
internal/remediation/  local remediation policy, sandboxed script runner, signed job fetch/report
internal/pollerconfig/ fetches the assigned SNMP device list (+ decrypted credentials) from the server
internal/telemetry/    wire types (mirrors src/lib/telemetry/schemas.ts), HMAC signing, HTTP client
internal/buffer/       disk-backed retry queue for when the server is unreachable
```

## Testing

```bash
go test ./...
go test -race ./...          # internal/snmp shares Poller state across goroutines; race-tested
```

`internal/telemetry`'s signing test reproduces the reference HMAC vector pinned in
`docs/telemetry.md` (computed independently with OpenSSL) — a real cross-check of the algorithm,
not just self-consistency. `internal/collect`'s tests include a smoke test that runs the real
collector against whatever machine executes `go test`. `internal/snmp`'s real-agent tests
(`SNMP_TEST_TARGET=…`, see that file's doc comment to stand up a local `snmpd`) poll an actual SNMP
v2c/v3 responder rather than mocking every PDU. `internal/dbmetrics`'s unit tests pin the slow-query
interval arithmetic (interval average vs lifetime, stats reset, eviction) and the server's size limits;
the collectors themselves were verified against real PostgreSQL 16 and MariaDB 11 instances.
