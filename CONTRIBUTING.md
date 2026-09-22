# Contributing

IkelyaneMonitor is a proprietary project (see [LICENSE](LICENSE)) maintained by a single team. The
source is public for reference and transparency, but **external pull requests are not accepted** —
the license does not grant rights to modify or redistribute the code. If you find a bug or have a
suggestion, please [open an issue](https://github.com/mpghugues-source/ikelyanemonitor/issues); that's
the right way to reach the maintainers.

The rest of this document is the internal workflow, for anyone on the team picking up the code.

## Setup

```bash
npm install                                    # also runs `prisma generate`
POSTGRES_PASSWORD=$(openssl rand -hex 24) docker compose up -d   # PostgreSQL + TimescaleDB, 127.0.0.1:5440
export DATABASE_URL=postgresql://ikelyane:<password>@127.0.0.1:5440/ikelyanemonitor
export IKELYANE_SECRET_KEY=$(openssl rand -base64 32)
npm run db:migrate
npm run dev
```

See the [README](README.md#quick-start) for the full quick start, including creating the first
account, and [`docs/telemetry.md`](docs/telemetry.md) for the agent protocol.

## Before opening a change

```bash
npm run typecheck
npm run lint
npm test                                                          # unit tests
DATABASE_URL=… IKELYANE_SECRET_KEY=$(openssl rand -base64 32) npm test   # + integration, real DB
npm run build && npm run test:e2e                                  # browser tests, real DB (port 3010)
```

All of the above must pass. Integration and E2E tests create their own organizations/users and clean
up after themselves — safe to run against the shared dev database.

## Conventions

- **Next.js 16**: `proxy.ts`, not `middleware.ts`; `params`/`searchParams` are `await`ed; use the
  global `PageProps<'/route'>` / `LayoutProps<'/route'>` helpers (run `npx next typegen` after adding
  routes). Read the relevant guide in `node_modules/next/dist/docs/` before writing App Router code —
  this version has breaking changes from what most training data assumes.
- **i18n**: no hard-coded UI text. Every key goes in **both** `messages/en.json` and
  `messages/fr.json` (`tests/i18n.test.ts` enforces parity). Navigate with `Link`/`useRouter`/
  `usePathname` from `@/i18n/navigation`, never `next/link` or `next/navigation` directly.
- **Multi-tenancy**: every query is scoped by `orgId`. The telemetry API derives the organization
  from the authenticated host — never from the request body.
- **Authorization**: every page calls `requireActor("<permission>")` and every Server Action calls
  `authorize("<permission>")` (`src/lib/auth/dal.ts`) — layouts and the proxy are convenience only,
  not security boundaries. Business functions take an `Actor` built from the session (never from form
  input), re-check `can(role, permission)`, and scope every query by `actor.orgId`. A new permission
  goes in `src/lib/auth/permissions.ts` **and** its test matrix (`tests/auth/permissions.test.ts`),
  which fails on any unreviewed privilege change — treat that failure as a signal to double-check the
  change, not to update blindly.
- **Secrets** (agent HMAC keys, SNMP credentials) are stored encrypted (`src/lib/crypto.ts`, columns
  suffixed `Enc`). Never log them, and never add a new secret column without encrypting it.
- **Errors**: expected failures are returned as `Result` (`src/lib/result.ts`) with a stable error
  code; the UI translates it (`auth.errors.*`, `members.errors.*`, …). Never return a sentence from
  the server.
- **Prisma**: the client is generated to `src/generated/prisma` (git-ignored); import from
  `@/generated/prisma/client` and get an instance via `getPrisma()`, never `new PrismaClient()`.
  Inside `$transaction`, `return fail(...)` still **commits** everything written so far — throw to
  roll back. `prisma migrate diff` proposes dropping `metric_entries_time_idx`: that index belongs to
  TimescaleDB, not Prisma — remove that line from any generated migration.
- Domain logic lives under `src/modules/<domain>/`, kept pure and unit-tested; wire it into pages and
  Server Actions, don't inline it there.

## Commits

Small, focused commits with an imperative summary line. Attribution trailers (`Co-Authored-By: …`)
are added by whichever tool produced the commit — keep them if present, don't add your own by hand.
