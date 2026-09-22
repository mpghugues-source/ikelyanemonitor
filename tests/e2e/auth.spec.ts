import { expect, test } from "@playwright/test";
import { cleanup, makeOrg, PASSWORD, query, type TestOrg } from "./support/db";
import { formError, login, loginOk } from "./support/pages";

const SESSION_COOKIE = "__Host-ikm_session";

test.describe("sign-in and sessions", () => {
  let org: TestOrg;
  test.beforeAll(async () => {
    org = await makeOrg("auth");
  });
  test.afterAll(cleanup);

  test("an anonymous visitor is sent to the login page, then back where they were going", async ({ page }) => {
    await page.goto("/en/servers");
    await expect(page).toHaveURL(/\/en\/login\?next=%2Fservers$/);

    await page.getByLabel("Email address").fill(org.viewer.email);
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/en\/servers$/);
    await expect(page.getByRole("heading", { name: "Servers" })).toBeVisible();
  });

  test("the language of the login page is kept in the redirect (French)", async ({ page }) => {
    await page.goto("/fr/settings/members");
    await expect(page).toHaveURL(/\/fr\/login\?next=%2Fsettings%2Fmembers$/);
    await expect(page.getByRole("heading", { name: "Connexion" })).toBeVisible();
  });

  for (const target of ["https://evil.example/phish", "//evil.example", "/\\evil.example", "javascript:alert(1)"]) {
    test(`ignores a hostile "next" parameter (${target})`, async ({ page }) => {
      await loginOk(page, org.viewer.email, { next: target });
      // Whatever was asked, the browser stayed on our own origin, on the overview page.
      expect(new URL(page.url()).origin).toBe(new URL(test.info().project.use.baseURL!).origin);
      await expect(page).toHaveURL(/\/en$/);
    });
  }

  test("a wrong password and an unknown account get the same generic message, and no session", async ({ page, context }) => {
    await login(page, org.viewer.email, { password: "this is not the password" });
    await expect(formError(page)).toHaveText("Incorrect email or password.");
    await expect(page).toHaveURL(/\/en\/login/);

    await login(page, `nobody@${org.viewer.email.split("@")[1]}`);
    await expect(formError(page)).toHaveText("Incorrect email or password.");

    expect((await context.cookies()).some((c) => c.name.includes("ikm_session"))).toBe(false);
  });

  test("errors are shown in the language of the page (French)", async ({ page }) => {
    await login(page, org.viewer.email, { password: "pas le bon mot de passe", locale: "fr" });
    await expect(formError(page)).toHaveText("E-mail ou mot de passe incorrect.");
  });

  test("the session cookie is HttpOnly, Secure, SameSite=Lax and __Host- prefixed — and invisible to scripts", async ({ page, context }) => {
    await loginOk(page, org.operator.email);

    const cookie = (await context.cookies()).find((c) => c.name === SESSION_COOKIE);
    expect(cookie, "session cookie").toBeDefined();
    expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: "Lax", path: "/" });
    expect(cookie!.value.length).toBeGreaterThanOrEqual(43); // 256-bit random token

    // Not reachable from JavaScript (XSS cannot steal it), and never copied into web storage.
    const visible = await page.evaluate(() => ({
      cookie: document.cookie,
      local: JSON.stringify({ ...localStorage }),
      session: JSON.stringify({ ...sessionStorage }),
    }));
    expect(visible.cookie).not.toContain("ikm_session");
    expect(visible.local).not.toContain(cookie!.value);
    expect(visible.session).not.toContain(cookie!.value);
  });

  test("the database holds only a HASH of the token", async ({ page, context }) => {
    await loginOk(page, org.admin.email);
    const token = (await context.cookies()).find((c) => c.name === SESSION_COOKIE)!.value;
    const rows = await query<{ n: string }>(`SELECT count(*)::text AS n FROM sessions WHERE "tokenHash" = $1`, [token]);
    expect(rows[0].n).toBe("0"); // the raw token is nowhere in the table
  });

  test("locks the account after repeated failures — even for the correct password — and says how long to wait", async ({ page }) => {
    for (let attempt = 1; attempt <= 8; attempt++) {
      await login(page, org.owner.email, { password: `wrong password number ${attempt}` });
      await expect(formError(page)).toHaveText("Incorrect email or password.");
    }
    await login(page, org.owner.email); // correct password, but the account is now throttled
    await expect(formError(page)).toContainText(/Too many attempts\. Try again in \d+ minutes?\./);
    await expect(page).toHaveURL(/\/en\/login/);
  });

  test("signing out revokes the session on the server: a replayed cookie no longer works", async ({ page, context }) => {
    await loginOk(page, org.viewer.email);
    const stolen = (await context.cookies()).find((c) => c.name === SESSION_COOKIE)!;

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/en\/login$/);
    expect((await context.cookies()).some((c) => c.name === SESSION_COOKIE)).toBe(false);

    // An attacker who copied the cookie before logout tries it.
    await context.addCookies([stolen]);
    await page.goto("/en/servers");
    await expect(page).toHaveURL(/\/en\/login/);
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  });

  test("a forged or garbage session cookie is treated as signed out", async ({ page, context }) => {
    const { baseURL } = test.info().project.use;
    await context.addCookies([{ name: SESSION_COOKIE, value: "not-a-real-token", domain: new URL(baseURL!).hostname, path: "/", secure: true, httpOnly: true }]);
    await page.goto("/en/servers");
    await expect(page).toHaveURL(/\/en\/login/);
  });

  test("an idle session expires: the next navigation asks to sign in again", async ({ page }) => {
    await loginOk(page, org.operator.email);
    await query(`UPDATE sessions SET "expiresAt" = now() - interval '1 minute' WHERE "userId" = $1`, [org.operator.id]);
    await page.goto("/en/servers");
    await expect(page).toHaveURL(/\/en\/login/);
  });

  test("a session past its absolute lifetime ends even though it was active", async ({ page }) => {
    await loginOk(page, org.operator.email);
    await query(`UPDATE sessions SET "absoluteExpiresAt" = now() - interval '1 minute' WHERE "userId" = $1`, [org.operator.id]);
    await page.goto("/en/servers");
    await expect(page).toHaveURL(/\/en\/login/);
  });

  test("an already signed-in user who opens the login page is sent to the app", async ({ page }) => {
    await loginOk(page, org.viewer.email);
    await page.goto("/en/login");
    await expect(page).toHaveURL(/\/en$/);
  });
});

test.describe("access is cut immediately when the account or membership changes", () => {
  let org: TestOrg;
  test.beforeAll(async () => {
    org = await makeOrg("cut");
  });
  test.afterAll(cleanup);

  test("disabling a user signs them out on their very next request", async ({ page }) => {
    await loginOk(page, org.viewer.email);
    await expect(page.getByRole("heading", { name: /Welcome/ })).toBeVisible();

    await query(`UPDATE users SET "disabledAt" = now() WHERE id = $1`, [org.viewer.id]);
    await page.goto("/en/servers");
    await expect(page).toHaveURL(/\/en\/login/);

    // …and they cannot sign in again either, with the right password, without being told why.
    await login(page, org.viewer.email);
    await expect(formError(page)).toHaveText("Incorrect email or password.");
  });

  test("removing someone from their only organization leaves them with nothing to see", async ({ page }) => {
    await loginOk(page, org.operator.email);
    await page.goto("/en/servers");
    await expect(page.getByRole("heading", { name: "Servers" })).toBeVisible();

    await query(`DELETE FROM memberships WHERE "userId" = $1`, [org.operator.id]);
    await page.goto("/en/servers");
    await expect(page).toHaveURL(/\/en\/no-organization$/);
    await expect(page.getByRole("heading", { name: "No organization" })).toBeVisible();
    // The list of servers is not rendered anywhere.
    await expect(page.getByText("No server registered yet.")).toHaveCount(0);
  });
});
