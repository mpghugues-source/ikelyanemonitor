import { expect, type Page, test } from "@playwright/test";
import { generateTotpCode } from "../../src/lib/auth/totp";
import { cleanup, makeOrg, PASSWORD, type TestOrg } from "./support/db";
import { formError, login, loginOk } from "./support/pages";

/**
 * Enrolling in the authenticator app is simulated by reading the secret straight off the page (the
 * "can't scan? enter this code manually" field, data-testid="totp-secret") and computing a code
 * with the real algorithm (src/lib/auth/totp.ts) — the same one an authenticator app would run.
 */
async function enrollTotp(page: Page): Promise<{ secret: string; recoveryCodes: string[] }> {
  await page.goto("/en/settings/profile");
  await page.getByRole("button", { name: "Enable two-factor authentication" }).click();

  const secret = await page.getByTestId("totp-secret").innerText();
  await page.getByLabel("Authentication code").fill(generateTotpCode(secret));
  await page.getByRole("button", { name: "Activate" }).click();

  const codesBlock = page.getByTestId("totp-recovery-codes");
  await expect(codesBlock).toBeVisible();
  const recoveryCodes = (await codesBlock.locator("code").allInnerTexts()).map((c) => c.trim());
  expect(recoveryCodes).toHaveLength(10);

  await codesBlock.getByRole("button", { name: "I've saved these codes" }).click();
  return { secret, recoveryCodes };
}

test.describe("two-factor authentication", () => {
  let org: TestOrg;
  test.beforeAll(async () => {
    org = await makeOrg("totp");
  });
  test.afterAll(cleanup);

  test("enabling requires a correct code, then sign-in needs it too — wrong code refused, right code works", async ({ page }) => {
    const user = org.operator;
    await loginOk(page, user.email);
    await page.goto("/en/settings/profile");
    await page.getByRole("button", { name: "Enable two-factor authentication" }).click();
    await expect(page.getByTestId("totp-secret")).toBeVisible();

    await page.getByLabel("Authentication code").fill("000000");
    await page.getByRole("button", { name: "Activate" }).click();
    await expect(formError(page)).toBeVisible();

    const secret = await page.getByTestId("totp-secret").innerText();
    await page.getByLabel("Authentication code").fill(generateTotpCode(secret));
    await page.getByRole("button", { name: "Activate" }).click();
    await expect(page.getByTestId("totp-recovery-codes")).toBeVisible();
    await page.getByTestId("totp-recovery-codes").getByRole("button", { name: "I've saved these codes" }).click();

    await page.getByRole("button", { name: "Sign out" }).click();
    await login(page, user.email);
    await expect(page).toHaveURL(/\/en\/totp$/);
    await expect(page.getByText(`Signing in as ${user.email}.`)).toBeVisible();

    await page.getByLabel("Authentication code").fill("111111");
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(formError(page)).toBeVisible();
    await expect(page).toHaveURL(/\/en\/totp$/); // still on the challenge, no session

    await page.getByLabel("Authentication code").fill(generateTotpCode(secret));
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(page).not.toHaveURL(/\/(login|totp)$/);
    await expect(page.getByRole("heading", { name: "Welcome to IkelyaneMonitor" })).toBeVisible();
  });

  test("a recovery code signs in once, then is refused the second time", async ({ page }) => {
    const user = org.admin;
    await loginOk(page, user.email);
    const { recoveryCodes } = await enrollTotp(page);
    await page.getByRole("button", { name: "Sign out" }).click();

    await login(page, user.email);
    await expect(page).toHaveURL(/\/en\/totp$/);
    await page.getByRole("button", { name: "Use a recovery code instead" }).click();
    await page.getByLabel("Recovery code").fill(recoveryCodes[0]!);
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(page).not.toHaveURL(/\/(login|totp)$/);

    await page.getByRole("button", { name: "Sign out" }).click();
    await login(page, user.email);
    await expect(page).toHaveURL(/\/en\/totp$/);
    await page.getByRole("button", { name: "Use a recovery code instead" }).click();
    await page.getByLabel("Recovery code").fill(recoveryCodes[0]!);
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(formError(page)).toBeVisible();
    await expect(page).toHaveURL(/\/en\/totp$/);
  });

  test("five wrong codes throw the challenge away and force a fresh sign-in", async ({ page }) => {
    const user = org.viewer;
    await loginOk(page, user.email);
    await enrollTotp(page);
    await page.getByRole("button", { name: "Sign out" }).click();

    await login(page, user.email);
    await expect(page).toHaveURL(/\/en\/totp$/);
    for (let i = 0; i < 4; i++) {
      await page.getByLabel("Authentication code").fill("999999");
      await page.getByRole("button", { name: "Verify" }).click();
      await expect(formError(page)).toBeVisible();
    }
    await page.getByLabel("Authentication code").fill("999999");
    await page.getByRole("button", { name: "Verify" }).click();
    // The challenge is destroyed server-side on the 5th wrong guess; Next.js refetches this same
    // route right after the action, so the page settles on its "no longer valid" state rather than
    // the form (see the comment in the page for why it doesn't redirect() here).
    await expect(page.getByText("This sign-in attempt has expired. Please sign in again.")).toBeVisible();
    await expect(page).toHaveURL(/\/en\/totp$/);

    await page.getByRole("link", { name: "Back to sign in" }).click();
    await expect(page).toHaveURL(/\/en\/login/);
  });

  test("disabling requires the current password, and sign-in is then password-only again", async ({ page }) => {
    const user = org.owner;
    await loginOk(page, user.email);
    await enrollTotp(page);

    const disableForm = page.locator("form", { has: page.getByRole("button", { name: "Disable" }) });
    await disableForm.getByLabel("Current password").fill("not my password");
    await disableForm.getByRole("button", { name: "Disable" }).click();
    await expect(formError(page)).toHaveText("The password is incorrect.");

    await disableForm.getByLabel("Current password").fill(PASSWORD);
    await disableForm.getByRole("button", { name: "Disable" }).click();
    await expect(page.getByRole("button", { name: "Enable two-factor authentication" })).toBeVisible();

    await page.getByRole("button", { name: "Sign out" }).click();
    await loginOk(page, user.email); // straight through, no /totp step
  });

  test("next is preserved through the challenge: landing on a specific page after verifying", async ({ page }) => {
    // A user not touched by the earlier tests: they only leave 2FA enabled on org.operator/admin/viewer.
    const org2 = await makeOrg("totp-next");
    const user = org2.operator;
    await loginOk(page, user.email);
    const { secret } = await enrollTotp(page);
    await page.getByRole("button", { name: "Sign out" }).click();

    await login(page, user.email, { next: "/settings/members" });
    await expect(page).toHaveURL(/\/en\/totp$/);
    await page.getByLabel("Authentication code").fill(generateTotpCode(secret));
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(page).toHaveURL(/\/en\/settings\/members$/);
  });
});
