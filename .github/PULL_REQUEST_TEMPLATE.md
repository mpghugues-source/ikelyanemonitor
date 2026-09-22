<!--
This project is proprietary and does not accept external pull requests (see CONTRIBUTING.md and
LICENSE). This template is for the internal team; if you found this project externally, please open
an issue instead of a pull request.
-->

## What does this change?

<!-- One or two sentences: what it does and why. -->

## How was it tested?

- [ ] `npm run typecheck` and `npm run lint` pass
- [ ] `npm test` passes (unit tests)
- [ ] `npm test` with `DATABASE_URL`/`IKELYANE_SECRET_KEY` set passes (+ integration tests, real DB)
- [ ] `npm run build && npm run test:e2e` passes (browser tests, real DB)
- [ ] Manually verified: <!-- what you clicked through / called, and what you saw -->

## Checklist

- [ ] New or changed UI text was added to **both** `messages/en.json` and `messages/fr.json`
- [ ] New permissions were added to `src/lib/auth/permissions.ts` **and** its test matrix
- [ ] New secrets are stored encrypted (`src/lib/crypto.ts`), never logged
- [ ] Every new/changed query is scoped by `orgId`
- [ ] Docs updated if behavior, scripts, or setup steps changed (`README.md`, `docs/telemetry.md`)

## Related issue

<!-- Closes #... , if any -->
