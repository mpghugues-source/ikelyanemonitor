# ikelyane-agent

The IkelyaneMonitor agent: collects host metrics (CPU, memory, disks, network, temperature,
uptime, process count) and polls SNMP network devices assigned to it in the web UI (routers,
switches, firewalls, APs, UPSes, BMCs — v1/v2c/v3), reporting both over the signed HTTP protocol
described in [`docs/telemetry.md`](../docs/telemetry.md).

Database monitoring (also part of the wire protocol) is not implemented yet.

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

## Build

Requires Go 1.24+.

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
     "bufferDir": "/var/lib/ikelyane-agent/buffer"
   }
   ```

2. **Environment variables** (used when `--config` is not given — the natural fit for a systemd
   `EnvironmentFile`, the pattern already used for this app's other services):

   | Variable | Required | Default |
   |---|---|---|
   | `IKELYANE_SERVER_URL` | yes | — |
   | `IKELYANE_KEY_ID` | yes | — |
   | `IKELYANE_SECRET` | yes | — |
   | `IKELYANE_INTERVAL_SECONDS` | no | `60` (minimum `10`) |
   | `IKELYANE_BUFFER_DIR` | no | `/var/lib/ikelyane-agent/buffer` |

   See [`ikelyane-agent.example.env`](ikelyane-agent.example.env).

The secret is a credential: keep its file/environment source `0600`, readable only by the agent's
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
cmd/ikelyane-agent/    entry point: flags, the collect/send loop, SNMP device polling loop
internal/config/       loads IKELYANE_* env vars or a JSON file
internal/collect/      gopsutil-based host metrics, with per-cycle rate calculation for IOPS/bandwidth
internal/snmp/         SNMP v1/v2c/v3 polling (github.com/gosnmp/gosnmp) — MIB-II/IF-MIB, counter-delta rates
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
v2c/v3 responder rather than mocking every PDU.
