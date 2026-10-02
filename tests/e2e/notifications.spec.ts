import { expect, test } from "@playwright/test";
import { cleanup, makeOrg, query, type TestOrg } from "./support/db";
import { loginOk } from "./support/pages";

/**
 * Notification channels in the real UI: one URL per chat channel (Slack / Microsoft Teams / generic), the
 * save-time refusal of private targets, the "Send a test" dialog, and the send-time SSRF guard (a hostname
 * that resolves to loopback passes the save-time check but is never connected to). No request leaves the
 * machine: every target here is refused before connecting.
 */

test.describe.configure({ mode: "serial" });

let org: TestOrg;

test.beforeAll(async () => {
  org = await makeOrg("notify");
});

test.afterAll(async () => {
  await cleanup();
});

test("an administrator configures Teams, is refused a private URL, and tests the channel", async ({ page }) => {
  await loginOk(page, org.admin.email, { next: "/en/alerts" });
  await page.goto("/en/alerts");

  await page.getByRole("button", { name: "Create rule" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Rule").fill("Teams CPU");
  await dialog.getByLabel("Threshold").fill("90");
  await expect(dialog.getByTestId("rule-channel-sms")).toBeDisabled();
  await expect(dialog.getByTestId("rule-channel-push")).toBeDisabled();
  await dialog.getByTestId("rule-channel-teams").click();
  await dialog.getByLabel("Microsoft Teams webhook URL").fill("http://127.0.0.1:5441/");
  await dialog.getByRole("button", { name: "Create rule" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("A webhook URL is invalid or points to a private address.");

  // Kept what was typed (ActionForm), only the URL changes. localtest.me is a public name resolving to loopback.
  await dialog.getByLabel("Microsoft Teams webhook URL").fill("http://localtest.me:5441/workflows/x");
  await dialog.getByRole("button", { name: "Create rule" }).click();
  await expect(dialog).toBeHidden();

  const [rule] = await query<{ channels: string; teamsWebhookUrl: string | null; slackWebhookUrl: string | null }>(
    `SELECT channels::text AS channels, "teamsWebhookUrl", "slackWebhookUrl" FROM alert_rules WHERE "orgId" = $1`,
    [org.id],
  );
  expect(rule).toEqual({ channels: "{TEAMS}", teamsWebhookUrl: "http://localtest.me:5441/workflows/x", slackWebhookUrl: null });

  const row = page.getByTestId("alert-rule-Teams CPU");
  await row.getByTestId("rule-test-notification").click();
  const testDialog = page.getByRole("dialog");
  await testDialog.getByRole("button", { name: "Send a test" }).click();
  const result = testDialog.getByTestId("test-result-teams");
  await expect(result).toHaveAttribute("data-ok", "false");
  await expect(result).toHaveText(/^Microsoft Teams — (Refused: the address is not public|Host name not found)$/);

  const audit = await query(`SELECT 1 FROM audit_logs WHERE "orgId" = $1 AND action = 'alert_rule.test_sent'`, [org.id]);
  expect(audit).toHaveLength(1);
});

test("operators cannot reach the test button", async ({ page }) => {
  await loginOk(page, org.operator.email, { next: "/en/alerts" });
  await page.goto("/en/alerts");
  await expect(page.getByTestId("alert-rule-Teams CPU")).toBeVisible();
  await expect(page.getByTestId("rule-test-notification")).toHaveCount(0);
});
