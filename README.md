# IkelyaneMonitor

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
| Dashboard UIs (charts, tables, forms) for each module | ⏳ placeholders; topology shows a React Flow sample |
| Authentication & RBAC — sessions, sign-in throttling, roles (Owner/Admin/Operator/Viewer), invitations, members, audit log, host registration UI | ✅ done; server logic tested against a real database (see *Testing*); browser flows not yet automated |
| Alert evaluation, incident lifecycle, notifications | ⏳ next |
| AIOps (anomaly detection, RCA), auto-remediation execution | ⏳ next (schema ready) |
| `ikelyane-agent` (Go/Rust) and SSE/WebSocket live streaming | ⏳ next — protocol is specified in `docs/telemetry.md` |

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
```

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` / `build` / `start` | Next.js |
| `npm test` | Unit tests. With `DATABASE_URL` and `IKELYANE_SECRET_KEY` set it **also** runs the integration tests against a real TimescaleDB |
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
- **Bounded input:** body size, array lengths, string lengths, value ranges and timestamp window are
  all enforced before anything is stored.

## Known limitations

- No multi-factor authentication yet, and no e-mail delivery: an invitation link is shown once to the person who creates it, who passes it on.
- Server Actions rely on the browser's `Origin` matching the host: the reverse proxy must preserve the `Host` header (Apache: `ProxyPreserveHost On`).
- Browser-level flows (sign-in, invitation, role-based UI) are not yet covered by automated end-to-end tests; the server-side logic behind them is.
- The ingestion endpoint has no rate limiting (put it behind a reverse proxy limit).
- `npm audit` reports 4 findings in the **Prisma CLI's** dev tooling (`mysql2`, `deepmerge-ts`); they
  do not ship in the runtime, and the suggested fix is a downgrade to Prisma 6, so it is not applied.
