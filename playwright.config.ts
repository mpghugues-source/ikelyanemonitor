import { defineConfig, devices } from "@playwright/test";

/**
 * Browser end-to-end tests against a PRODUCTION build (`npm run build` first) served on a dedicated
 * port, backed by a real PostgreSQL + TimescaleDB.
 *
 *   DATABASE_URL=postgresql://… IKELYANE_SECRET_KEY=$(openssl rand -base64 32) npm run test:e2e
 *
 * Each test creates its own organization and users (tests/e2e/support/db.ts) and everything is
 * deleted afterwards, so the suite is safe to run against a development database.
 *
 * Port 3000 is used by another application on this server: the default here is 3010.
 */
const PORT = Number(process.env.E2E_PORT ?? 3010);
const BASE_URL = `http://127.0.0.1:${PORT}`;

for (const name of ["DATABASE_URL", "IKELYANE_SECRET_KEY"]) {
  if (!process.env[name]) throw new Error(`${name} is required to run the end-to-end tests.`);
}

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // One worker: the tests share one database and some of them exercise per-address throttling.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    locale: "en-US",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `node_modules/.bin/next start -p ${PORT} -H 127.0.0.1`,
    url: `${BASE_URL}/en/login`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      ...(process.env as Record<string, string>),
      NODE_ENV: "production",
      APP_BASE_URL: BASE_URL,
      AUTH_ALLOW_REGISTRATION: "false",
      // No reverse proxy in front: do not trust X-Forwarded-For (the tests set it explicitly when needed).
      AUTH_TRUST_PROXY_HEADERS: "true",
    },
  },
});
