@AGENTS.md

# IkelyaneMonitor — working notes

Read `README.md` (status, layout, security model) and `docs/telemetry.md` (agent protocol) first.

## Conventions

- **Next.js 16**: `proxy.ts` (not middleware); `params`/`searchParams` are **async** (`await params`);
  use the global `PageProps<'/route'>` / `LayoutProps<'/route'>` helpers (run `npx next typegen`
  after adding routes). Always read the relevant guide in `node_modules/next/dist/docs/` first.
- **i18n**: no hard-coded UI text. Add every key to BOTH `messages/en.json` and `messages/fr.json`
  (`tests/i18n.test.ts` fails otherwise). Use `Link`/`useRouter`/`usePathname` from `@/i18n/navigation`.
- **Multi-tenant**: every query is scoped by `orgId`. In the telemetry API the org comes from the
  authenticated host, never from the request body.
- **Secrets** are stored encrypted (`src/lib/crypto.ts`, columns suffixed `Enc`). Never log them.
- **Prisma 7**: connection URL in `prisma.config.ts`; client generated to `src/generated/prisma`
  (git-ignored); import from `@/generated/prisma/client`. Use `getPrisma()` — never instantiate a client.
- **Time series**: `MetricEntry` is a TimescaleDB hypertable created by migration 0002 (Prisma cannot
  declare it). Per-port network metrics use `sourceKind=NETWORK_DEVICE` + `instance=<port name>`.
- Add domain logic under `src/modules/<domain>/`; keep pure functions pure and unit-tested.
- **Authorization**: every page calls `requireActor("<permission>")` (src/lib/auth/dal.ts) and every Server
  Action calls `authorize("<permission>")` — layouts and the proxy are NOT security boundaries. Business
  functions take an `Actor` built from the session (never from form input), re-check `can(role, permission)`
  and scope every query by `actor.orgId`. New permissions go in `src/lib/auth/permissions.ts` AND its test
  matrix (`tests/auth/permissions.test.ts`), which fails on any unreviewed change of privilege.
- Forms bound to Server Actions use `ActionForm` (src/components/forms/action-form.tsx): it submits through a
  transition so a server-side validation error does NOT wipe what the user typed (React 19 resets a form after
  every `action` run); the form is reset only on success.
- Background work (synthetic checks, Claude RCA narratives) runs in `npm run worker` (scripts/worker.ts), never in
  a request. Work units are claimed atomically so several workers can run side by side.
- Expected failures are returned as `Result` (`src/lib/result.ts`) with a stable error code that the UI
  translates (`auth.errors.*`, `members.errors.*`…); never return sentences from the server.
- Inside a Prisma `$transaction`, `return fail(...)` still COMMITS earlier writes: throw to roll back.
- Migrations generated with `prisma migrate diff` propose `DROP INDEX "metric_entries_time_idx"` (a
  TimescaleDB-owned index): delete that line.

## Testing

```bash
npm test                                   # unit tests only
DATABASE_URL=… IKELYANE_SECRET_KEY=$(openssl rand -base64 32) npm test   # + integration (real DB)
```
Integration tests create their own organizations and delete them afterwards.

## Environment gotchas

- `.env*` files are protected by the dev environment's permission rules (cannot be read or written by
  the assistant): the template is `env.example`; pass variables inline when running commands.
- Dev database: `docker compose up -d` (TimescaleDB on **127.0.0.1:5440** only — Docker bypasses the
  server firewall, so never publish ports on all interfaces).
- Port 3000 is used by another app on the shared server: run tests/servers on another port.
