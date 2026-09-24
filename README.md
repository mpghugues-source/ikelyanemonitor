# IkelyaneMonitor

[![CI](https://github.com/mpghugues-source/ikelyanemonitor/actions/workflows/ci.yml/badge.svg)](https://github.com/mpghugues-source/ikelyanemonitor/actions/workflows/ci.yml)
![Status](https://img.shields.io/badge/status-in%20development-yellow)
![License](https://img.shields.io/badge/license-proprietary-red)

Repository: https://github.com/mpghugues-source/ikelyanemonitor

All-in-one monitoring platform: **servers** (Windows / Linux / Unix / macOS via a local agent),
**databases** (PostgreSQL, MySQL, MariaDB, MongoDB, Redis, SQL Server), **network equipment** over
SNMP v1/v2c/v3, **web & SaaS endpoints**, with **AIOps**, **FinOps / GreenOps** and a **dependency
topology map** — natively bilingual (English / Français).

Stack: Next.js 16 (App Router, React 19, TypeScript strict) · next-intl · Tailwind CSS 4 + shadcn/ui ·
React Flow · Prisma 7 · PostgreSQL 17 + TimescaleDB · Zod.

## Status

| Area | State |
|---|---|
| Project structure, `/en` & `/fr` routing, app shell | ✅ done |
| Database schema (18 models) + TimescaleDB hypertable, compression, retention, 5-min rollups | ✅ done, tested on a real database |
| i18n dictionaries (439 keys, EN/FR parity enforced by a test) | ✅ done |
| Telemetry ingestion API — HMAC, Zod, atomic + idempotent storage | ✅ done, tested end to end |
| Module logic: energy/carbon model, dependency-graph blast radius, SLA helpers | ✅ done (pure, tested) |
| Dashboard UIs (CRUD, forms) for servers/databases/network/SaaS/topology | ✅ done |
| Authentication & RBAC — sessions, sign-in throttling, roles (Owner/Admin/Operator/Viewer), invitations (emailed), members, audit log, host registration UI, TOTP two-factor + recovery codes | ✅ done; tested against a real database, both server logic (`npm test`) and browser flows (`npm run test:e2e`) |
| Alert evaluation, incident lifecycle, notifications (e-mail, Slack, generic webhook) | ✅ done |
| Synthetic HTTP(S) checks — run by the background worker (`npm run worker`): status/body assertions, redirects, TLS expiry, availability 24 h / 30 days vs SLA, "check now", SSRF-guarded, alerts on `ENDPOINT_*` metrics | ✅ done |
| `ikelyane-agent` (Go) — host metrics (CPU/memory/disks/network/temperature/uptime) + SNMP v1/v2c/v3 device polling (fetches its assignment + credentials from the server) + PostgreSQL/MySQL/MariaDB monitoring (connections, QPS, cache, deadlocks, replication, storage, engine-normalized slow queries), signed delivery, offline buffering | ✅ done; see [`agent/`](agent) |
| AIOps — anomaly detection (robust baseline with daily seasonality, per-rule sensitivity, combinable with a threshold) and root-cause analysis (dependency map + time correlation, explained in the UI; optional Claude narrative EN/FR when `ANTHROPIC_API_KEY` is set) | ✅ done |
| Auto-remediation — scripts run by the agents, by hand or when an alert fires, with approvals, guard-rails (cooldown, hourly cap, OS filter, no duplicates) and a host-side consent the platform cannot override (`disabled` by default, SHA-256 allowlist, or any) | ✅ done; see [`agent/README.md`](agent/README.md#remediation) |
| Agent: MongoDB/Redis/SQL Server · SSE/WebSocket live streaming | ⏳ next — protocol is specified in `docs/telemetry.md` |

## Quick start

```bash
npm install                                    # also runs `prisma generate`

# 1. Database (PostgreSQL + TimescaleDB, bound to 127.0.0.1:5440)
POSTGRES_PASSWORD=$(openssl rand -hex 24) docker compose up -d

# 2. Configuration — see env.example (create your own .env, never commit it)
export DATABASE_URL=postgresql://ikelyane:<password>@127.0.0.1:5440/ikelyanemonitor
export IKELYANE_SECRET_KEY=$(openssl rand -base64 32)   # keep it: it encrypts stored secrets

# 3. Schema
npm run db:migrate

# 4. Run
npm run dev            # http://localhost:3000  →  /en  or  /fr

# 5. Create the first account (an organization and its owner). Self-service sign-up is off by
#    default; the initial password is generated and printed once.
npm run create:owner -- --email you@example.com --name "Your Name" --org "Acme"

# 6. Sign in at /en or /fr, then register servers from the Servers page
#    (or from the command line: npm run provision:host -- --org acme --hostname web-01)

# 7. Start the background worker (synthetic checks; optional Claude RCA narratives) — a separate process
npm run worker

# 8. Build and run the agent on a server you want monitored — see agent/README.md
cd agent && go build -o ikelyane-agent ./cmd/ikelyane-agent
IKELYANE_SERVER_URL=http://localhost:3000 IKELYANE_KEY_ID=ikm_… IKELYANE_SECRET=… ./ikelyane-agent
```

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` / `build` / `start` | Next.js |
| `npm test` | Unit tests. With `DATABASE_URL` and `IKELYANE_SECRET_KEY` set it **also** runs the integration tests against a real TimescaleDB |
| `npm run test:e2e` | Playwright browser tests (Chromium) against a **production build**: run `npm run build` first, then set `DATABASE_URL` and `IKELYANE_SECRET_KEY` and run this — it starts its own server on port 3010 |
| `npm run worker` | Long-running background worker (same `DATABASE_URL`/`IKELYANE_SECRET_KEY` as the app): synthetic checks and, when `ANTHROPIC_API_KEY` is set, Claude RCA narratives. Several may run side by side: each unit of work is claimed by exactly one. `CHECK_RUNNER_CONCURRENCY` (default 20), `AIOPS_LLM_MAX_PER_HOUR` (default 60) |
| `npm run typecheck` · `npm run lint` | `tsc --noEmit` · ESLint |
| `npm run db:migrate` · `db:status` · `db:generate` | Prisma migrations / client |
| `npm run create:owner` | Create the first organization + owner account (initial password printed once) |
| `npm run provision:host` | Register a host, print its key id and secret (once) |

## Layout

```
messages/{en,fr}.json          UI dictionaries (keys must match: tests/i18n.test.ts)
prisma/schema.prisma           data model
prisma/migrations/             0001 init · 0002 TimescaleDB · 0003 CHECK constraints
src/i18n/                      next-intl routing, request config, locale-aware navigation
src/proxy.ts                   language negotiation (Next.js 16 "proxy", formerly middleware)
src/app/[locale]/(dashboard)/  pages: overview, servers, databases, network, saas, topology, finops
src/app/api/v1/telemetry/      ingestion endpoint
src/modules/<domain>/          domain logic per module (ingest, energy, graph, sla…)
src/lib/                       env, crypto (AES-256-GCM), prisma, telemetry/{schemas,signature,auth,metrics,ingest}
src/lib/auth/                  permissions (RBAC matrix), password (scrypt), sessions, login, throttle, invitations, members, audit, dal
src/app/actions/               Server Actions (each re-checks session + permission)
docs/telemetry.md              agent ↔ server protocol
tests/                         unit + integration (real database)
tests/e2e/                     Playwright browser tests (real database, production build)
playwright.config.ts           E2E config: production build, port 3010
agent/                         ikelyane-agent (Go) — separate module, see agent/README.md
```

## Security model

- **Agent authentication:** HMAC-SHA256 over `"<timestamp>.<raw body>"`, per-host key, 5-minute replay
  window, constant-time comparison, unknown key indistinguishable from wrong signature.
- **Secrets at rest:** agent HMAC secrets and SNMP credentials are AES-256-GCM encrypted with
  `IKELYANE_SECRET_KEY`, bound to their row (AAD) so a ciphertext copied elsewhere fails to decrypt.
- **Database credentials never reach the server**: agents keep them locally; `endpoint` values
  containing credentials are rejected, and slow-query text must be normalized by the agent.
- **Multi-tenancy:** every table carries `orgId`; ingestion derives the organization from the
  authenticated host — never from the payload.
- **Sessions:** opaque 256-bit token in an HttpOnly, SameSite=Lax, `__Host-` prefixed cookie; only its SHA-256 is stored; sliding 12 h idle timeout, 7-day cap; revoked on password change; a disabled user or a removed member loses access on the very next request.
- **Passwords:** scrypt (N=2^15, r=8, p=3), 12–128 characters, common/repetitive passwords refused; unknown accounts cost the same hashing work as real ones; failures are throttled per e-mail (8 / 15 min) and per address (30 / 15 min).
- **Authorization:** one permission matrix (`src/lib/auth/permissions.ts`), checked in the proxy (optimistic, cookie only), in every page and Server Action (authoritative, database) and again inside each business function. Administrators cannot grant a role at or above their own, and an organization always keeps at least one owner (race-safe).
- **Synthetic checks cannot reach the platform's own network (SSRF):** every address a check connects
  to — IP literal, resolved hostname (checked at connection time, so DNS rebinding does not help) and
  every redirect hop — must be public unicast; loopback, private, link-local (cloud metadata),
  CGNAT, IPv4-mapped IPv6 etc. are refused (`src/modules/saas/runner/target-guard.ts`). Only a
  single-tenant install monitoring its own LAN should set `CHECKS_ALLOW_PRIVATE_TARGETS=true`.
  Configured request headers are never forwarded to another origin on redirect.
- **Auto-remediation is opt-in on each host, not on the platform:** a script only runs if the host's
  own agent configuration allows it — `disabled` by default; in `allowlist` mode only scripts whose
  SHA-256 the host owner listed, so a compromised platform or administrator account cannot run new code
  there. Only administrators write scripts (audited with their SHA-256); an execution runs a snapshot
  frozen when it was queued (what gets approved is what runs); jobs are delivered in HMAC-signed
  responses and run in a clean environment without the agent's secrets.
- **AIOps and external AI:** anomaly detection and root-cause analysis run locally. Nothing is sent to
  an AI provider unless `ANTHROPIC_API_KEY` is set; then, for each analyzed incident, the worker sends
  Claude the incident (title, severity, source label, metric and values), the computed findings (labels
  of related sources and incidents) and last-hour statistics of the metric — never credentials,
  identifiers of agents, or request/response bodies (`src/modules/aiops/rca-llm.ts`). Calls are capped
  per hour (`AIOPS_LLM_MAX_PER_HOUR`) and only made from the background worker.
- **Bounded input:** body size, array lengths, string lengths, value ranges and timestamp window are
  all enforced before anything is stored.

## Known limitations

- Anomaly baselines model DAILY seasonality only (same time of day over the last 7 days), not weekly
  patterns such as quiet weekends; they need ~30 points of history before a rule can fire.
- Synthetic checks run from wherever the runner runs: `EndpointCheck.regions` and multi-step
  `syntheticScript` scenarios are stored but not executed yet. When TLS verification fails (e.g. an
  expired certificate), the check reports `tls` with the reason but the certificate's dates are not
  recorded.
- Server Actions rely on the browser's `Origin` matching the host: the reverse proxy must preserve the `Host` header (Apache: `ProxyPreserveHost On`).
- The ingestion endpoint has no rate limiting (put it behind a reverse proxy limit).
- `npm audit` reports 4 findings in the **Prisma CLI's** dev tooling (`mysql2`, `deepmerge-ts`); they
  do not ship in the runtime, and the suggested fix is a downgrade to Prisma 6, so it is not applied.

## License

Proprietary — all rights reserved. The source is public for reference; see [LICENSE](LICENSE).
