import { expect, test } from "@playwright/test";
import { cleanup, makeOrg, PASSWORD, query, type TestOrg } from "./support/db";
import { formError, login, loginOk, skipBrowserValidation } from "./support/pages";

const NEW_PASSWORD = "another-Long-Passphrase-42";

test.describe("account and profile", () => {
  let org: TestOrg;
  test.beforeAll(async () => {
    org = await makeOrg("acct");
  });
  test.afterAll(cleanup);

  test("changing the password: wrong current password refused, weak refused, then it works and signs out other devices", async ({ page, browser }) => {
    const user = org.operator;
    const other = await (await browser.newContext()).newPage();
    await loginOk(other, user.email);
    await other.goto("/en/servers");

    await loginOk(page, user.email);
    await page.goto("/en/settings/profile");

    await page.getByLabel("Current password").fill("not my password at all");
    await page.getByLabel("New password").fill(NEW_PASSWORD);
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(formError(page)).toHaveText("The current password is incorrect.");

    await skipBrowserValidation(page); // the server must refuse it too, not only the browser
    await page.getByLabel("Current password").fill(PASSWORD);
    await page.getByLabel("New password").fill("tooshort");
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "at least 12 characters" })).toBeVisible();

    await page.getByLabel("Current password").fill(PASSWORD);
    await page.getByLabel("New password").fill(NEW_PASSWORD);
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(page.getByText(/Password changed\. 1 other device was signed out\./)).toBeVisible();

    // The other browser was signed out; this one stays signed in.
    await other.goto("/en/servers");
    await expect(other).toHaveURL(/\/en\/login/);
    await page.goto("/en/servers");
    await expect(page.getByRole("heading", { name: "Servers" })).toBeVisible();

    // Old password is dead, new password works.
    await page.getByRole("button", { name: "Sign out" }).click();
    await login(page, user.email);
    await expect(formError(page)).toHaveText("Incorrect email or password.");
    await loginOk(page, user.email, { password: NEW_PASSWORD });

    await other.context().close();
  });

  test("the language switch changes the page and is remembered for the account", async ({ page }) => {
    await loginOk(page, org.viewer.email);
    await expect(page).toHaveURL(/\/en$/);

    await page.getByRole("group", { name: "Switch language" }).getByRole("button", { name: "Français" }).click();
    await expect(page).toHaveURL(/\/fr$/);
    await expect(page.getByRole("button", { name: "Se déconnecter" })).toBeVisible();
    await expect.poll(async () => (await query<{ locale: string }>(`SELECT locale FROM users WHERE id = $1`, [org.viewer.id]))[0].locale).toBe("FR");

    // Signing out keeps the page in the current language.
    await page.getByRole("button", { name: "Se déconnecter" }).click();
    await expect(page).toHaveURL(/\/fr\/login$/);
  });

  test("the whole interface exists in French too: role pages render without raw message keys", async ({ page }) => {
    await loginOk(page, org.owner.email, { locale: "fr" });
    for (const path of ["/fr", "/fr/servers", "/fr/settings/profile", "/fr/settings/members", "/fr/settings/audit", "/fr/forbidden"]) {
      await page.goto(path);
      const text = await page.locator("body").innerText();
      // next-intl shows the key path (e.g. "members.title") or MISSING_MESSAGE when a translation is absent.
      expect(text, path).not.toMatch(/MISSING_MESSAGE|\b(?:auth|members|hostAdmin|profile|audit|settings)\.[a-zA-Z]+\b/);
    }
  });

  test("the audit log records sign-ins, failures and logouts of this organization, with the address", async ({ page }) => {
    await login(page, org.admin.email, { password: "wrong-password-here" });
    await expect(formError(page)).toBeVisible();
    await loginOk(page, org.admin.email);
    await page.getByRole("button", { name: "Sign out" }).click();

    await loginOk(page, org.owner.email);
    await page.goto("/en/settings/audit");
    await expect(page.getByRole("row").filter({ hasText: "Signed in" }).first()).toBeVisible();
    await expect(page.getByRole("row").filter({ hasText: "Signed out" }).first()).toBeVisible();
    await expect(page.getByRole("row").filter({ hasText: org.admin.email }).first()).toBeVisible();
    // No secret material ever ends up in the log.
    const text = await page.locator("body").innerText();
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain("wrong-password-here");
  });
});

test.describe("transport and browser hardening", () => {
  test("responses carry anti-clickjacking and content-type protections", async ({ request }) => {
    for (const path of ["/en/login", "/fr/login", "/api/v1/telemetry"]) {
      const response = await request.get(path);
      const headers = response.headers();
      expect(headers["x-content-type-options"], path).toBe("nosniff");
      expect(headers["x-frame-options"] ?? headers["content-security-policy"], path).toBeTruthy();
    }
  });

  test("private pages are not cacheable by shared caches", async ({ page }) => {
    const org = await makeOrg("cache");
    await loginOk(page, org.viewer.email);
    const response = await page.goto("/en/settings/members");
    const cacheControl = response!.headers()["cache-control"] ?? "";
    expect(cacheControl).not.toMatch(/\bpublic\b/);
    await cleanup();
  });

  test("a cross-site request cannot trigger a Server Action with the victim's cookie (forced logout)", async ({ page, request, baseURL }) => {
    const org = await makeOrg("csrf");
    await loginOk(page, org.owner.email);
    await page.goto("/en/settings/members");

    // Record the request the browser itself sends when the user clicks "Sign out" — without letting it through.
    let captured: { url: string; headers: Record<string, string>; body: Buffer } | undefined;
    await page.route("**/*", async (route) => {
      const req = route.request();
      if (req.method() === "POST" && req.headers()["next-action"]) {
        captured = { url: req.url(), headers: req.headers(), body: req.postDataBuffer()! };
        await route.abort();
      } else {
        await route.continue();
      }
    });
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect.poll(() => captured).toBeTruthy();
    const { url, headers, body } = captured!;

    const cookies = (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
    const liveSessions = async () =>
      Number((await query<{ n: string }>(`SELECT count(*)::text AS n FROM sessions WHERE "userId" = $1 AND "revokedAt" IS NULL`, [org.owner.id]))[0].n);
    expect(await liveSessions()).toBe(1);

    const replay = (origin: string) =>
      request.post(url, {
        headers: { ...headers, cookie: cookies, origin, host: new URL(baseURL!).host },
        data: body,
        maxRedirects: 0,
      });

    // What an attacker's page would make the victim's browser send: the cookie rides along, the Origin is foreign.
    const attack = await replay("https://evil.example");
    expect(attack.status()).toBeGreaterThanOrEqual(400);
    expect(await liveSessions(), "the session must survive the forged request").toBe(1);

    // Control: the identical request from our own origin does sign the user out — so this test can tell the difference.
    const legit = await replay(baseURL!);
    expect(legit.status(), await legit.text()).toBeLessThan(500);
    await expect.poll(liveSessions).toBe(0);
    await cleanup();
  });
});
