# Security Policy

## Supported versions

This project has not reached a stable major release yet. Only the latest tagged release and the
`main` branch are supported with security fixes.

| Version | Supported |
| --- | --- |
| `main` | ✅ |
| latest tag (`v0.1.0`) | ✅ |
| older tags | ❌ |

## Reporting a vulnerability

**Please do not open a public issue for a security vulnerability.**

Use GitHub's private vulnerability reporting for this repository:
[Report a vulnerability](https://github.com/mpghugues-source/ikelyanemonitor/security/advisories/new).
This opens a private advisory visible only to the maintainer until a fix is ready.

If you cannot use that form, email **info@ikelyane.com** with:

- A description of the issue and its impact.
- Steps to reproduce (a minimal request/payload is ideal).
- The affected version or commit.

You will get an acknowledgement within a few days. There is no bug bounty; credit in the release
notes is offered if you'd like it.

## Scope

In scope: the application in this repository — authentication and session handling, role-based
access control, the telemetry ingestion API (`/api/v1/telemetry`), multi-tenant data isolation, and
secret storage.

Out of scope: the hosting server, third-party dependencies (report those upstream), and
denial-of-service reports against a shared/development instance.

## How this project is built to limit impact

Summarized here; see the [README's Security model](README.md#security-model) section for the full
picture.

- Sessions are an opaque token in an `HttpOnly`, `Secure`, `__Host-` prefixed, `SameSite=Lax` cookie;
  only its SHA-256 hash is stored.
- Passwords are hashed with scrypt; sign-in failures are throttled per account and per address.
- Every page, Server Action and business function re-checks permissions against a single matrix
  (`src/lib/auth/permissions.ts`) — the UI and the routing layer are convenience, not the security
  boundary.
- Every database query is scoped by organization (`orgId`); the telemetry API derives the
  organization from the authenticated host, never from the request body.
- Secrets at rest (agent keys, SNMP credentials) are AES-256-GCM encrypted, bound to their row.
- Agent requests are HMAC-SHA256 signed with a 5-minute replay window and constant-time comparison.

These are also exercised by the automated test suite (`npm test`, `npm run test:e2e`) that runs on
every change — see [CI](.github/workflows/ci.yml).
