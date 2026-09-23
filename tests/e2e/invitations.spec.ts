import { expect, test, type Browser, type Page } from "@playwright/test";
import { cleanup, domain, makeOrg, makeUser, PASSWORD, query, type TestOrg } from "./support/db";
import { formError, loginOk, skipBrowserValidation } from "./support/pages";

let counter = 0;
const newEmail = (label: string) => `${label}-${Date.now().toString(36)}${++counter}@${domain}`;

/** Sign in as `who` and create an invitation through the real form; returns the one-time link. */
async function invite(page: Page, who: string, email: string, role: "Operator" | "Viewer" | "Administrator" = "Viewer"): Promise<string> {
  await loginOk(page, who);
  await page.goto("/en/settings/members");
  await page.getByLabel("Email address").fill(email);
  await page.locator("#invite-role").selectOption({ label: role });
  await page.getByRole("button", { name: "Create invitation" }).click();
  const link = (await page.getByTestId("invitation-link").textContent())!.trim();
  expect(link).toMatch(/\/en\/invite\/[A-Za-z0-9_-]{30,}$/);
  return link;
}

async function freshPage(browser: Browser) {
  const context = await browser.newContext();
  return { context, page: await context.newPage() };
}

test.describe("invitations", () => {
  let org: TestOrg;
  test.beforeAll(async () => {
    org = await makeOrg("inv");
  });
  test.afterAll(cleanup);

  test("full journey: admin invites → newcomer sets a password → signs in with the invited role", async ({ page, browser }) => {
    const email = newEmail("newcomer");
    const link = await invite(page, org.admin.email, email, "Operator");

    // The link is not stored in clear: only its hash is in the database.
    const token = link.split("/").pop()!;
    expect(await query(`SELECT 1 FROM invitations WHERE "tokenHash" = $1`, [token])).toHaveLength(0);
    expect(await query(`SELECT 1 FROM invitations WHERE "orgId" = $1 AND email = $2`, [org.id, email])).toHaveLength(1);

    // It appears in the pending list.
    await page.reload();
    await expect(page.getByText(email)).toBeVisible();

    const { context, page: guest } = await freshPage(browser);
    await guest.goto(link);
    await expect(guest.getByRole("heading", { name: `Join ${org.name}` })).toBeVisible();
    await expect(guest.getByText("invited with the role Operator")).toBeVisible();

    // A weak password is refused with a clear message and does not consume the invitation. What the
    // person typed is kept after a refusal (ActionForm only resets the form after a success).
    await skipBrowserValidation(guest); // the server must refuse it too, not only the browser's minlength
    await guest.getByLabel("Full name").fill("New Comer");
    await guest.getByLabel("Password", { exact: true }).fill("short");
    await guest.getByRole("button", { name: "Accept invitation" }).click();
    await expect(formError(guest)).toContainText("at least 12 characters");
    expect(await query(`SELECT 1 FROM users WHERE email = $1`, [email])).toHaveLength(0);

    await expect(guest.getByLabel("Full name")).toHaveValue("New Comer");

    // An empty name is refused server-side too, not only by the input's `required` attribute.
    await guest.getByLabel("Full name").fill("");
    await guest.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await guest.getByRole("button", { name: "Accept invitation" }).click();
    await expect(formError(guest)).toContainText("Fill in all required fields.");
    expect(await query(`SELECT 1 FROM users WHERE email = $1`, [email])).toHaveLength(0);

    await guest.getByLabel("Full name").fill("New Comer");
    await guest.getByLabel("Password", { exact: true }).fill("motdepasse123");
    await guest.getByRole("button", { name: "Accept invitation" }).click();
    await expect(formError(guest)).toContainText("too common");

    await guest.getByLabel("Full name").fill("New Comer");
    await guest.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await guest.getByRole("button", { name: "Accept invitation" }).click();
    await expect(guest).toHaveURL(/\/en$/);
    await expect(guest.getByTestId("role-badge")).toHaveText("Operator");
    await expect(guest.getByTestId("org-name")).toHaveText(org.name);
    await expect(guest.getByTestId("user-name")).toHaveText("New Comer");

    // The operator role really applies: no server registration form, no audit log.
    await guest.goto("/en/servers");
    await expect(guest.getByLabel("Hostname")).toHaveCount(0);
    await guest.goto("/en/settings/audit");
    await expect(guest.getByRole("heading", { name: "Access denied" })).toBeVisible();

    // Single use: the same link is now dead, for anyone.
    const { context: other, page: stranger } = await freshPage(browser);
    await stranger.goto(link);
    await expect(stranger.getByText("invalid, has expired or was already used")).toBeVisible();
    await expect(stranger.getByLabel("Full name")).toHaveCount(0);

    // The invitation is gone from the pending list (the newcomer is now a member instead, listed once).
    await page.reload();
    await expect(page.getByText(email)).toHaveCount(1);
    await page.goto("/en/settings/audit");
    await expect(page.getByRole("row").filter({ hasText: "Member joined" }).first()).toBeVisible();

    await context.close();
    await other.close();
  });

  test("the newcomer can sign in again later with the password they chose", async ({ page, browser }) => {
    const email = newEmail("returning");
    const link = await invite(page, org.owner.email, email);
    const { context, page: guest } = await freshPage(browser);
    await guest.goto(link);
    await guest.getByLabel("Full name").fill("Returning User");
    await guest.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await guest.getByRole("button", { name: "Accept invitation" }).click();
    await expect(guest).toHaveURL(/\/en$/);
    await guest.getByRole("button", { name: "Sign out" }).click();
    await loginOk(guest, email);
    await expect(guest.getByTestId("role-badge")).toHaveText("Viewer");
    await context.close();
  });

  test("a revoked invitation no longer works", async ({ page, browser }) => {
    const email = newEmail("revoked");
    const link = await invite(page, org.owner.email, email);
    await page.reload();
    await page.getByRole("button", { name: "Revoke" }).first().click();
    await expect(page.getByText(email)).toHaveCount(0);

    const { context, page: guest } = await freshPage(browser);
    await guest.goto(link);
    await expect(guest.getByText("invalid, has expired or was already used")).toBeVisible();
    await context.close();
  });

  test("an expired invitation no longer works", async ({ page, browser }) => {
    const email = newEmail("expired");
    const link = await invite(page, org.owner.email, email);
    await query(`UPDATE invitations SET "expiresAt" = now() - interval '1 minute' WHERE email = $1`, [email]);
    const { context, page: guest } = await freshPage(browser);
    await guest.goto(link);
    await expect(guest.getByText("invalid, has expired or was already used")).toBeVisible();
    await context.close();
    void page;
  });

  test("a garbage token shows the same message as a used one (nothing to learn from it)", async ({ page }) => {
    await page.goto("/en/invite/this-token-does-not-exist-0123456789abcdef");
    await expect(page.getByText("invalid, has expired or was already used")).toBeVisible();
  });

  test("an existing account must sign in first, then joins with that same account", async ({ page, browser }) => {
    const existing = await makeUser("already-here");
    const link = await invite(page, org.owner.email, existing.email, "Operator");

    const { context, page: guest } = await freshPage(browser);
    await guest.goto(link);
    await expect(guest.getByText(`An account already exists for ${existing.email}`)).toBeVisible();
    // No way to overwrite the existing account's password from an invitation.
    await expect(guest.getByLabel("Password", { exact: true })).toHaveCount(0);

    await guest.getByRole("link", { name: "Sign in" }).click();
    await expect(guest).toHaveURL(/\/en\/login/);
    await guest.getByLabel("Email address").fill(existing.email);
    await guest.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await guest.getByRole("button", { name: "Sign in" }).click();

    await expect(guest).toHaveURL(/\/en\/invite\//); // brought back to the invitation
    await guest.getByRole("button", { name: `Join with your account ${existing.email}` }).click();
    await expect(guest).toHaveURL(/\/en$/);
    const rows = await query<{ role: string }>(`SELECT role FROM memberships WHERE "userId" = $1 AND "orgId" = $2`, [existing.id, org.id]);
    expect(rows).toEqual([{ role: "OPERATOR" }]);
    await context.close();
  });

  test("signed in as somebody else: the invitation is refused and nothing is granted", async ({ page, browser }) => {
    const intended = await makeUser("intended");
    const link = await invite(page, org.owner.email, intended.email, "Operator");

    const impostor = await makeUser("impostor");
    const { context, page: guest } = await freshPage(browser);
    await loginOk(guest, impostor.email);
    await guest.goto(link);
    await expect(guest.getByText(new RegExp(`signed in as ${impostor.email}.*invitation is for ${intended.email}`))).toBeVisible();
    await expect(guest.getByRole("button", { name: /Join with your account|Accept invitation/ })).toHaveCount(0);
    expect(await query(`SELECT 1 FROM memberships WHERE "userId" = $1`, [impostor.id])).toHaveLength(0);

    // The invitation stays usable by its rightful recipient.
    expect(await query(`SELECT 1 FROM invitations WHERE email = $1 AND "acceptedAt" IS NULL`, [intended.email])).toHaveLength(1);
    await context.close();
  });

  test("an administrator cannot invite an administrator by tampering with the form", async ({ page }) => {
    await loginOk(page, org.admin.email);
    await page.goto("/en/settings/members");
    await page.getByLabel("Email address").fill(newEmail("escalate"));
    // Add an option the UI never offers, as an attacker editing the DOM would.
    await page.locator("#invite-role").evaluate((select: HTMLSelectElement) => {
      const option = new Option("Owner", "OWNER");
      select.add(option);
      select.value = "OWNER";
    });
    await page.getByRole("button", { name: "Create invitation" }).click();
    await expect(formError(page)).toHaveText("You cannot grant this role.");
    await expect(page.getByTestId("invitation-link")).toHaveCount(0);
  });

  test("inviting somebody who is already a member is refused", async ({ page }) => {
    await loginOk(page, org.owner.email);
    await page.goto("/en/settings/members");
    await page.getByLabel("Email address").fill(org.viewer.email);
    await page.getByRole("button", { name: "Create invitation" }).click();
    await expect(formError(page)).toHaveText("This person is already a member.");
  });
});
