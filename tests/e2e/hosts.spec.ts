import { createHmac } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { cleanup, makeOrg, query, type TestOrg } from "./support/db";
import { formError, loginOk, skipBrowserValidation } from "./support/pages";

const ENDPOINT = "/api/v1/telemetry";

function body() {
  const now = new Date();
  return JSON.stringify({
    schemaVersion: 1,
    sentAt: now.toISOString(),
    agent: { version: "0.1.0-e2e" },
    system: {
      collectedAt: new Date(now.getTime() - 5_000).toISOString(),
      inventory: { osFamily: "linux", osName: "AlmaLinux", cpuCores: 4, memoryTotalBytes: 8_000_000_000, ipAddresses: ["10.0.0.9"] },
      cpu: { usagePercent: 33.3, loadAverage1m: 0.5 },
      memory: { usedPercent: 50, usedBytes: 4_000_000_000 },
    },
  });
}

/** What a real agent does: sign "<t>.<raw body>" with the secret it was given. */
async function send(request: APIRequestContext, creds: { keyId: string; secret: string }, raw = body()) {
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", creds.secret).update(`${t}.${raw}`).digest("hex");
  return request.post(ENDPOINT, {
    data: raw,
    headers: { "content-type": "application/json", "x-ikelyane-key-id": creds.keyId, "x-ikelyane-signature": `t=${t},v1=${v1}` },
  });
}

async function register(page: Page, hostname: string, displayName = "") {
  await page.goto("/en/servers");
  await page.getByLabel("Hostname").fill(hostname);
  if (displayName) await page.getByLabel("Display name (optional)").fill(displayName);
  await page.getByRole("button", { name: "Register server" }).click();
  const card = page.getByTestId("credentials");
  await expect(card).toBeVisible();
  return {
    keyId: (await card.getByTestId("credential-keyId").textContent())!.trim(),
    secret: (await card.getByTestId("credential-secret").textContent())!.trim(),
  };
}

test.describe("servers and agent credentials", () => {
  let org: TestOrg;
  test.beforeAll(async () => {
    org = await makeOrg("hosts");
  });
  test.afterAll(cleanup);

  test("register → credentials shown once → a real signed request is accepted → metrics stored", async ({ page, request }) => {
    await loginOk(page, org.admin.email);
    const creds = await register(page, "web-01.e2e.test", "Front web");
    expect(creds.keyId).toMatch(/^ikm_[A-Za-z0-9_-]{24}$/);
    expect(creds.secret.length).toBeGreaterThanOrEqual(32);

    // The secret is on screen only right now: after a reload it is gone from the page.
    await page.reload();
    await expect(page.getByTestId("credentials")).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText(creds.secret);
    await expect(page.getByTestId("host-web-01.e2e.test")).toContainText("Front web");
    await expect(page.getByTestId("host-web-01.e2e.test")).toContainText("Never"); // no report yet

    // In the database it is stored encrypted, not as typed.
    const stored = await query<{ secretEnc: string }>(`SELECT "hmacSecretEnc" AS "secretEnc" FROM monitored_hosts WHERE "keyId" = $1`, [creds.keyId]);
    expect(stored[0].secretEnc).not.toContain(creds.secret);

    // The agent (played by the test) reports.
    const ok = await send(request, creds);
    expect(ok.status(), await ok.text()).toBe(200);
    const stats = await query<{ n: string }>(`SELECT count(*)::text AS n FROM metric_entries WHERE "orgId" = $1`, [org.id]);
    expect(Number(stats[0].n)).toBeGreaterThan(0);

    // The page now shows the agent version and a last-seen time.
    await page.reload();
    const row = page.getByTestId("host-web-01.e2e.test");
    await expect(row).toContainText("0.1.0-e2e");
    await expect(row).not.toContainText("Never");
  });

  test("the same hostname cannot be registered twice", async ({ page }) => {
    await loginOk(page, org.owner.email);
    await register(page, "dup.e2e.test");
    await page.getByLabel("Hostname").fill("dup.e2e.test");
    await page.getByRole("button", { name: "Register server" }).click();
    await expect(formError(page)).toHaveText("A server with this hostname already exists.");
  });

  test("an invalid hostname is refused by the server", async ({ page }) => {
    await loginOk(page, org.owner.email);
    await page.goto("/en/servers");
    // Bypass the browser's own constraint checks, as a script would.
    await skipBrowserValidation(page);
    await page.getByLabel("Hostname").fill("bad host; rm -rf /");
    await page.getByRole("button", { name: "Register server" }).click();
    await expect(formError(page)).toHaveText("Invalid hostname.");
    expect(await query(`SELECT 1 FROM monitored_hosts WHERE "orgId" = $1 AND hostname LIKE '%rm -rf%'`, [org.id])).toHaveLength(0);
  });

  test("rotating the secret: new secret works, old one keeps working during the grace period", async ({ page, request }) => {
    await loginOk(page, org.owner.email);
    const first = await register(page, "rotate.e2e.test");
    expect((await send(request, first)).status()).toBe(200);

    page.once("dialog", (dialog) => dialog.accept());
    await page.getByTestId("host-rotate.e2e.test").getByRole("button", { name: "Rotate secret" }).click();
    const card = page.getByTestId("host-rotate.e2e.test").getByTestId("credentials");
    await expect(card).toBeVisible();
    const next = { keyId: (await card.getByTestId("credential-keyId").textContent())!.trim(), secret: (await card.getByTestId("credential-secret").textContent())!.trim() };

    expect(next.keyId).toBe(first.keyId); // same key id, new secret
    expect(next.secret).not.toBe(first.secret);
    expect((await send(request, next)).status()).toBe(200);
    expect((await send(request, first)).status(), "old secret during the overlap").toBe(200);

    await page.reload();
    await expect(page.getByTestId("host-rotate.e2e.test")).toContainText("Previous secret still valid");
  });

  test("disabling a server stops its agent at once; enabling lets it back in", async ({ page, request }) => {
    await loginOk(page, org.owner.email);
    const creds = await register(page, "toggle.e2e.test");
    expect((await send(request, creds)).status()).toBe(200);

    await page.getByTestId("host-toggle.e2e.test").getByRole("button", { name: "Disable" }).click();
    await expect(page.getByTestId("host-toggle.e2e.test")).toContainText("Disabled");
    const refused = await send(request, creds);
    expect(refused.status()).toBe(403);

    await page.getByTestId("host-toggle.e2e.test").getByRole("button", { name: "Enable" }).click();
    await expect(page.getByTestId("host-toggle.e2e.test")).not.toContainText("Disabled");
    expect((await send(request, creds)).status()).toBe(200);
  });

  test("the API refuses tampered, replayed-late and unsigned requests", async ({ page, request }) => {
    await loginOk(page, org.owner.email);
    const creds = await register(page, "api.e2e.test");

    // Body changed after signing.
    const raw = body();
    const t = Math.floor(Date.now() / 1000);
    const v1 = createHmac("sha256", creds.secret).update(`${t}.${raw}`).digest("hex");
    const tampered = await request.post(ENDPOINT, {
      data: raw.replace("33.3", "99.9"),
      headers: { "content-type": "application/json", "x-ikelyane-key-id": creds.keyId, "x-ikelyane-signature": `t=${t},v1=${v1}` },
    });
    expect(tampered.status()).toBe(401);

    // A validly signed request captured 10 minutes ago.
    const old = t - 600;
    const oldSig = createHmac("sha256", creds.secret).update(`${old}.${raw}`).digest("hex");
    const stale = await request.post(ENDPOINT, {
      data: raw,
      headers: { "content-type": "application/json", "x-ikelyane-key-id": creds.keyId, "x-ikelyane-signature": `t=${old},v1=${oldSig}` },
    });
    expect(stale.status()).toBe(401);

    // No credentials at all — and a browser-style cookie session is NOT an alternative to the signature.
    const anonymous = await request.post(ENDPOINT, { data: raw, headers: { "content-type": "application/json" } });
    expect(anonymous.status()).toBe(401);
    const cookies = await page.context().cookies();
    const withSession = await request.post(ENDPOINT, {
      data: raw,
      headers: { "content-type": "application/json", cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") },
    });
    expect(withSession.status()).toBe(401);
  });

  test("a viewer and an operator cannot rotate or disable: no button, and no page to do it from", async ({ page }) => {
    await loginOk(page, org.owner.email);
    await register(page, "guarded.e2e.test");
    await page.getByRole("button", { name: "Sign out" }).click();

    for (const who of [org.viewer, org.operator]) {
      await loginOk(page, who.email);
      await page.goto("/en/servers");
      const row = page.getByTestId("host-guarded.e2e.test");
      await expect(row).toBeVisible(); // they can read
      await expect(row.getByRole("button")).toHaveCount(0); // but not act
      await page.getByRole("button", { name: "Sign out" }).click();
    }
  });
});
