# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Microsoft Teams alert notifications (Adaptive Card for a Teams Workflows webhook), and a “Send a test”
  button on each alert rule that reports the outcome per channel (audited, administrators only).
- Each chat channel has its own URL (Slack, Teams, generic webhook). Previously Slack and the generic
  webhook shared one URL; migration `20261002100000_notification_targets` moves the URL of existing Slack
  rules to the Slack field. SMS and push are shown as “coming soon” instead of silently doing nothing.

### Security

- Alert webhooks are now subject to the same SSRF guard as synthetic checks (`src/lib/net/target-guard.ts`):
  private/loopback/link-local targets are refused at save time and at connection time (DNS rebinding),
  and redirects are no longer followed. `WEBHOOKS_ALLOW_PRIVATE_TARGETS=true` restores internal delivery
  for self-hosted installs. Before this, an organization administrator could make the platform POST to
  internal services (e.g. the database port or a cloud metadata endpoint).

- `ikelyane-agent`: MongoDB and Redis (and Valkey) monitoring — connections, QPS, cache hit ratio,
  replication, storage (Redis: memory), slow operations from MongoDB's profiler and Redis's SLOWLOG
  reduced to value-free shapes (MongoDB command structure, Redis command name). Least-privilege
  monitoring accounts documented in `agent/README.md`.
- CI workflow (GitHub Actions): typecheck, lint, unit + integration tests against a real
  TimescaleDB service container, production build, and the Playwright browser suite on every push
  and pull request. Build/tests badge in the README.
- `SECURITY.md`: vulnerability reporting process. Enabled GitHub private vulnerability reporting on
  the repository.
- `public/.well-known/security.txt` (RFC 9116): served by the app itself at `/.well-known/security.txt`
  wherever it's deployed, pointing to the same reporting channels as `SECURITY.md`.
- `.github/dependabot.yml`: weekly npm and GitHub Actions dependency update PRs. Enabled Dependabot
  security updates on the repository.
- Enabled GitHub secret scanning and push protection on the repository.

## [0.1.0] - 2026-09-22

### Added

- Project scaffold: Next.js 16 (App Router, React 19, TypeScript strict), Tailwind CSS 4 + shadcn/ui,
  Vitest.
- Data model: 18 Prisma models across servers, databases, network devices, web/SaaS endpoints,
  topology, alerts, incidents, remediation and FinOps; TimescaleDB hypertable for `metric_entries`
  with compression, retention and a 5-minute continuous aggregate; CHECK constraints migration.
- Telemetry ingestion API (`POST /api/v1/telemetry`): HMAC-SHA256 request signing, Zod validation,
  atomic and idempotent storage. Documented in `docs/telemetry.md`.
- English/French dictionaries (`messages/{en,fr}.json`) with enforced key parity, and locale-aware
  routing (`/en`, `/fr`).
- Authentication and role-based access control: database-backed sessions (opaque token, `__Host-`
  cookie, only the hash stored, sliding idle timeout, absolute cap, revocation), scrypt password
  hashing with a policy check, per-address/per-IP sign-in throttling, audit log, a single permission
  matrix (Owner > Admin > Operator > Viewer) enforced in pages, Server Actions and business functions,
  single-use invitations, multi-organization support, and server registration with one-time agent
  credentials and secret rotation.
- Playwright browser end-to-end test suite (`tests/e2e/`, 56 tests) against a production build and a
  real database: session lifecycle, RBAC across all four roles, invitations, server registration and
  signed telemetry, account/profile, and CSRF/security-header checks.
- `LICENSE` (proprietary), `CONTRIBUTING.md`, `CODEOWNERS`, GitHub issue templates and a pull request
  template.

### Fixed

- The session cookie was cleared on sign-out without the `Secure`/`Path=/` attributes required by its
  `__Host-` prefix, so browsers silently ignored the deletion and a copied cookie stayed valid after
  logout.
- The invitation-acceptance form accepted an empty name server-side (unlike registration), so a
  request bypassing the form's `required` attribute could create an account with no name.

[Unreleased]: https://github.com/mpghugues-source/ikelyanemonitor/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/mpghugues-source/ikelyanemonitor/releases/tag/v0.1.0
