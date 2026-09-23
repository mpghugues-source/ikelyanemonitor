# Telemetry protocol (v1)

How `ikelyane-agent` sends metrics to IkelyaneMonitor. This is the contract implemented by the Go
agent in [`agent/`](../agent) (host metrics, SNMP network devices, PostgreSQL/MySQL/MariaDB) and the
reference for anyone writing a custom collector (e.g. for MongoDB, Redis or SQL Server, which the agent
does not cover yet).

- Endpoint: `POST /api/v1/telemetry`
- Body: JSON, at most `TELEMETRY_MAX_BODY_BYTES` (1 MiB by default)
- Auth: HMAC-SHA256 signature over the **raw body**, one key pair per monitored host
- Server implementation: `src/app/api/v1/telemetry/route.ts` · schemas: `src/lib/telemetry/schemas.ts`
- Agent implementation: [`agent/README.md`](../agent/README.md)

## 1. Credentials

Register a host (until the UI exists):

```bash
DATABASE_URL=… IKELYANE_SECRET_KEY=… npm run provision:host -- --org acme --hostname web-01
```

It prints a **key id** (`ikm_…`, public) and a **secret** (shown once; only its AES-256-GCM ciphertext
is stored). The agent keeps both in its local configuration, readable by the agent's user only.

## 2. Signing a request

Two headers:

| Header | Value |
|---|---|
| `X-Ikelyane-Key-Id` | the key id, e.g. `ikm_kCCFHf2iaNon_ab4qI-ibTIv` |
| `X-Ikelyane-Signature` | `t=<unix seconds>,v1=<hex>` |

```
v1 = hex( HMAC-SHA256( key = secret (its UTF-8 bytes, as a string),
                       message = "<t>" + "." + <exact bytes of the request body> ) )
```

- `t` is the **current Unix time in seconds** (not milliseconds). The server rejects a `t` more than
  `TELEMETRY_MAX_CLOCK_SKEW_SECONDS` (300 s) away from its own clock: this is what stops a captured
  request from being replayed later. Keep the agent's clock in sync (NTP).
- Sign the **exact bytes you send**. Do not re-serialize the JSON after signing.
- During a secret rotation you may send several `v1=` values (`t=…,v1=<new>,v1=<old>`); the request
  is accepted if any of them verifies.

Reference vector (pins the algorithm; produced with OpenSSL, independent of the server code):

```bash
printf '1758000000.{"schemaVersion":1}' | openssl dgst -sha256 -hmac 's3cret-value'
# 07aa1d93786628978c587392dbeff781224052a62006514beac26bc3a9c0b219
```

### Shell / curl

```bash
BODY='{"schemaVersion":1, …}'                     # one line; this exact text is signed AND sent
T=$(date +%s)
SIG=$(printf '%s.%s' "$T" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $NF}')
curl -X POST https://monitor.example.com/api/v1/telemetry \
  -H 'Content-Type: application/json' \
  -H "X-Ikelyane-Key-Id: $KEYID" \
  -H "X-Ikelyane-Signature: t=$T,v1=$SIG" \
  --data-binary "$BODY"                            # --data-binary: curl must not alter the bytes
```

### Go

```go
t := time.Now().Unix()                         // ONE timestamp, used for the signature AND the header
mac := hmac.New(sha256.New, []byte(secret))    // key = the secret string's UTF-8 bytes
fmt.Fprintf(mac, "%d.", t)
mac.Write(body)                                // the exact bytes that will be sent
sig := hex.EncodeToString(mac.Sum(nil))
req.Header.Set("X-Ikelyane-Key-Id", keyID)
req.Header.Set("X-Ikelyane-Signature", fmt.Sprintf("t=%d,v1=%s", t, sig))
```

## 3. Payload

```jsonc
{
  "schemaVersion": 1,                       // must be 1
  "sentAt": "2026-09-21T20:00:00Z",         // ISO-8601 with timezone
  "agent": { "version": "0.1.0" },
  "system":       { … },                    // optional  — this host
  "snmpDevices":  [ … ],                    // optional  — up to 200 devices
  "databases":    [ … ]                     // optional  — up to 100 instances
}                                           // at least one of the three is required
```

Unknown fields are ignored (forward compatibility). Numbers must be finite; percentages are 0–100;
`cacheHitRatio` is a **ratio 0–1**. Every array and string is bounded — see `schemas.ts`.

### `system` (SystemMetrics)

```jsonc
{
  "collectedAt": "2026-09-21T20:00:00Z",
  "inventory": {                            // send at startup and when it changes
    "osFamily": "linux",                    // windows | linux | macos | unix | other
    "osName": "AlmaLinux", "osVersion": "9.4", "kernelVersion": "5.14.0", "arch": "x86_64",
    "cpuModel": "AMD EPYC 7B13", "cpuCores": 8, "cpuThreads": 16,
    "memoryTotalBytes": 16000000000, "diskTotalBytes": 500000000000,
    "ipAddresses": ["10.0.0.5"], "virtualization": "kvm", "agentVersion": "0.1.0"
  },
  "cpu":    { "usagePercent": 42.5, "loadAverage1m": 1.2 },
  "memory": { "usedPercent": 63, "usedBytes": 10000000000, "swapUsedPercent": 0 },
  "disks":  [{ "mount": "/", "device": "nvme0n1", "usedPercent": 71, "usedBytes": 0,
               "readIops": 120, "writeIops": 80, "readBps": 0, "writeBps": 0 }],
  "network": [{ "name": "eth0", "inBps": 1000000, "outBps": 250000 }],   // bits per second
  "temperatures": [{ "sensor": "cpu0", "celsius": 55 }],
  "processCount": 312, "uptimeSeconds": 86400, "powerWatts": 180
}
```

### `snmpDevices` (SNMPDevices)

```jsonc
[{
  "collectedAt": "…",
  "device": {
    "ipAddress": "192.168.1.1",             // identifies the device within the organization
    "type": "router",                       // router | switch | firewall | ap | ups | bmc | other
    "reachable": true,                      // false = SNMP poll failed → device is marked DOWN
    "vendor": "MikroTik", "model": "RB4011", "sysName": "core-rtr", "uptimeSeconds": 123456,
    "latencyMs": 2.1, "temperatureCelsius": 48, "powerWatts": 35
  },
  "interfaces": [{
    "ifIndex": 1, "name": "ether1", "alias": "uplink", "speedMbps": 1000,
    "adminStatus": "up", "operStatus": "up",                    // up | down | testing | unknown
    "inBps": 5000, "outBps": 9000,                              // computed by the agent from counter deltas
    "utilizationPercent": 0.9, "packetLossPercent": 0,
    "inErrors": 0, "outErrors": 0, "crcErrors": 3,              // cumulative counters read from the device
    "errorsPerSec": 0, "crcErrorsPerSec": 0                     // rates, stored as time series
  }]
}]
```

SNMP credentials are configured server-side (stored encrypted). The agent does not choose which
devices to poll or with what credentials — it fetches its assignment from the server; see
"Discovering SNMP targets" below.

### `databases` (DatabaseMetrics)

```jsonc
[{
  "collectedAt": "…",
  "instance": { "name": "main:5432", "engine": "postgresql", "version": "17.2",
                "endpoint": "10.0.0.9:5432", "maxConnections": 100 },
  "reachable": true,
  "metrics": { "qps": 250, "activeConnections": 25, "cacheHitRatio": 0.98,
               "slowQueriesPerMin": 1, "deadlocksPerMin": 0, "replicationLagSeconds": 0,
               "storageUsedBytes": 4000000000 },
  "slowQueries": [{ "capturedAt": "…", "fingerprint": "a1b2c3", "queryText": "SELECT … WHERE id = ?",
                    "durationMs": 2300, "calls": 1 }]
}]
```

**Security rules for database data:** never send credentials (an `endpoint` containing `@` is
rejected) and always send **normalized** query text (literals replaced by placeholders) — raw
values would put personal data in the monitoring database.

## 3b. Discovering SNMP targets

`GET /api/v1/poller-config` — the devices assigned to the calling host (set in the web UI, per
device: "polled by \<this host\>"), with SNMP credentials **decrypted** for this one response —
the only place they ever leave the server in clear text, and only to the exact host authorized to
poll each device.

Signed exactly like `POST /api/v1/telemetry`, over an **empty body** (a GET has none):

```
t=<unix seconds>, v1=hex(HMAC-SHA256(secret, "<t>."))
```

```jsonc
// 200
{
  "devices": [
    {
      "id": "dev_…",
      "ipAddress": "192.168.1.1",
      "type": "router",              // same enum as snmpDevices[].device.type
      "pollIntervalSec": 60,
      "snmp": {
        "version": "v2c",            // v1 | v2c | v3
        "port": 161, "timeoutMs": 3000, "retries": 1,
        "community": "public",       // v1/v2c only, else null
        "v3": null                   // present only when version = "v3":
        // "v3": { "username": "…", "securityLevel": "AUTH_PRIV", "authProtocol": "SHA256",
        //         "authKey": "…", "privProtocol": "AES", "privKey": "…", "contextName": "…" }
      }
    }
  ]
}
```

Same error codes as `POST /api/v1/telemetry` (401/403/500 — there is no request body to be
malformed, so no 400/413/422 here). Poll this on startup and periodically (e.g. every few minutes)
to pick up devices added, removed or reassigned in the web UI; there is no push notification.
Results for `snmpDevices` still go through `POST /api/v1/telemetry` like everything else.

## 4. Responses

| Status | `error.code` | Meaning | Agent action |
|---|---|---|---|
| 200 | — | Stored. Body lists counts: `metricsReceived`, `metricsStored`, `devices`, `interfaces`, `databases`, `slowQueriesStored` | Drop the batch |
| 400 | `invalid_json` | Body is not JSON | Bug — do not retry |
| 401 | `missing_key_id`, `missing_signature`, `malformed_signature` | Header missing or malformed | Bug — do not retry |
| 401 | `invalid_signature` | Wrong secret, altered body, or unknown key (deliberately indistinguishable) | Check configuration |
| 401 | `timestamp_out_of_tolerance` | `t` too far from server time | Fix the clock, then retry |
| 403 | `host_disabled` | Host switched off in IkelyaneMonitor | Stop; retry later |
| 413 | `payload_too_large` | Body over the limit | Split the batch |
| 422 | `invalid_payload` | Schema violation; `error.details.issues[]` gives `path` + `message` | Bug — do not retry |
| 422 | `timestamp_out_of_range` | A `collectedAt` is older than `TELEMETRY_MAX_BACKFILL_DAYS` (7) or in the future | Drop or fix the point |
| 500 | `internal_error` | Nothing was stored | Retry with exponential backoff |

Error bodies: `{ "status": "error", "error": { "code", "message", "details"? } }`.

## 5. Delivery semantics (what makes retrying safe)

- **Atomic:** a request is stored entirely or not at all. One invalid section rejects the whole request.
- **Idempotent:** every point is keyed by `(source, metric, instance, time)`; sending the same batch
  again inserts nothing (`metricsStored: 0`). After a network error or 5xx, **resend the same batch**.
- **Buffering:** after an outage, replay buffered points oldest-first, in requests of a few thousand
  points. Points older than 7 days are refused by design.
- **Batch size:** one request may carry up to 200 devices × 1024 ports and 100 databases, within the
  1 MiB body limit. Typical host samples are a few KiB.

## 6. Secret rotation

1. Generate a new secret; store the old ciphertext in `previousHmacSecretEnc` with
   `previousSecretExpiresAt` a few hours ahead (both secrets are accepted meanwhile).
2. Update the agent; after the grace period the old secret is refused.

(A UI/API for this is planned; the columns and verification logic already exist and are tested.)
