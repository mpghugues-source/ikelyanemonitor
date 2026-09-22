# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
