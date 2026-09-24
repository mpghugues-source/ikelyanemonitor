import { createHash, randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { cleanup, makeOrg, query, type TestOrg } from "./support/db";
import { loginOk } from "./support/pages";

/**
 * Auto-remediation in the real UI. Hosts are seeded with the policy their agent would report; the
 * agent side itself is covered by agent/internal/remediation tests and a real binary run.
 */

let org: TestOrg;
const SCRIPT = "#!/usr/bin/env bash\nsystemctl restart nginx\n";
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

async function seedHost(label: string, mode: string | null): Promise<string> {
  const id = randomUUID();
  await query(
    `INSERT INTO monitored_hosts (id, "orgId", hostname, "keyId", "hmacSecretEnc", "osFamily", "remediationMode", "updatedAt")
     VALUES ($1, $2, $3, $4, 'v1:aa:bb:cc', 'LINUX', $5, now())`,
    [id, org.id, label, `ikm_${randomUUID().slice(0, 12)}`, mode],
  );
  return id;
}

test.beforeAll(async () => {
  org = await makeOrg("remed");
  await seedHost("web-01", "any");
  await seedHost("db-01", "disabled");
});

test.afterAll(async () => {
  await cleanup();
});

test("administrators write actions; operators run and cancel them; viewers only read", async ({ page, browser }) => {
  await loginOk(page, org.admin.email, { next: "/en/remediation" });
  await page.goto("/en/remediation");
  await page.getByRole("button", { name: "New action" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Scripts run with the privileges of the agent on the target host.");
  await dialog.getByLabel("Name", { exact: true }).fill("Restart nginx");
  await dialog.getByLabel("Script", { exact: true }).fill(SCRIPT);
  await dialog.getByLabel("Arguments", { exact: true }).fill("service=nginx"); // lower-case name: refused, input kept
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog.getByRole("alert")).toContainText("NAME in capitals");
  await dialog.getByLabel("Arguments", { exact: true }).fill("SERVICE=nginx");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();

  const row = page.getByTestId("remediation-action-Restart nginx");
  await expect(row.getByTestId("action-sha256")).toHaveText(sha256(SCRIPT));
  const [audit] = await query<{ metadata: { scriptSha256: string } }>(`SELECT metadata FROM audit_logs WHERE "orgId" = $1 AND action = 'remediation_action.created'`, [org.id]);
  expect(audit.metadata.scriptSha256).toBe(sha256(SCRIPT));

  // Operator: can run, cannot edit.
  const operator = await browser.newPage();
  await loginOk(operator, org.operator.email, { next: "/en/remediation" });
  await operator.goto("/en/remediation");
  const opRow = operator.getByTestId("remediation-action-Restart nginx");
  await expect(opRow.getByRole("button", { name: "Delete" })).toHaveCount(0);
  await expect(operator.getByTestId("host-policy-db-01")).toHaveText(/Disabled/);

  await opRow.getByLabel("Host").selectOption({ label: "db-01 — Disabled" });
  await opRow.getByTestId("run-action").click();
  await expect(opRow.getByTestId("run-outcome")).toHaveText("Not run: the host does not accept remediation (agent configuration)");

  await opRow.getByLabel("Host").selectOption({ label: "web-01 — Any script" });
  await opRow.getByTestId("run-action").click();
  await expect(opRow.getByTestId("run-outcome")).toHaveText("Queued: the agent will pick it up within a few seconds.");
  await operator.reload();
  const latest = operator.getByTestId("execution-row").first();
  await expect(latest.getByTestId("execution-status")).toHaveText("Pending");
  await latest.getByTestId("cancel-execution").click();
  await expect(operator.getByTestId("execution-row").first().getByTestId("execution-status")).toHaveText("Cancelled");

  // Viewer: read-only.
  const viewer = await browser.newPage();
  await loginOk(viewer, org.viewer.email, { next: "/en/remediation" });
  await viewer.goto("/en/remediation");
  await expect(viewer.getByTestId("remediation-action-Restart nginx")).toBeVisible();
  await expect(viewer.getByTestId("run-action")).toHaveCount(0);
  await expect(viewer.getByTestId("cancel-execution")).toHaveCount(0);
  await expect(viewer.getByTestId("execution-row").nth(1).getByTestId("execution-reason")).toHaveText("the host does not accept remediation (agent configuration)");
});

test("a remediation suggested by an alert is approved from the incident, in French too", async ({ page }) => {
  const hostId = await seedHost("app-01", "any");
  const actionId = randomUUID();
  const incidentId = randomUUID();
  const executionId = randomUUID();
  await query(
    `INSERT INTO remediation_actions (id, "orgId", name, runtime, "scriptBody", "timeoutSec", "updatedAt") VALUES ($1, $2, 'Vider le cache', 'BASH', $3, 30, now())`,
    [actionId, org.id, SCRIPT],
  );
  await query(
    `INSERT INTO incidents (id, "orgId", title, severity, status, "sourceKind", "sourceId", "sourceLabel", "startedAt", "updatedAt")
     VALUES ($1, $2, 'Cache saturé', 'CRITICAL', 'OPEN', 'HOST', $3, 'app-01', now(), now())`,
    [incidentId, org.id, hostId],
  );
  await query(
    `INSERT INTO remediation_executions (id, "orgId", "actionId", "incidentId", "hostId", trigger, status, runtime, "scriptBody", "scriptSha256", "timeoutSec")
     VALUES ($1, $2, $3, $4, $5, 'ALERT', 'AWAITING_APPROVAL', 'BASH', $6, $7, 30)`,
    [executionId, org.id, actionId, incidentId, hostId, SCRIPT, sha256(SCRIPT)],
  );

  await loginOk(page, org.operator.email, { locale: "fr", next: "/fr/incidents" });
  await page.goto("/fr/incidents");
  const box = page.getByTestId("incident-remediations");
  await expect(box).toContainText("Vider le cache — app-01");
  await expect(box.getByTestId("incident-remediation-status")).toHaveText("En attente d'approbation");
  await box.getByTestId("approve-execution").click();
  await expect(box.getByTestId("incident-remediation-status")).toHaveText("En attente");
  const [row] = await query<{ status: string; approvedBy: string }>(`SELECT status, "approvedBy" FROM remediation_executions WHERE id = $1`, [executionId]);
  expect(row).toEqual({ status: "PENDING", approvedBy: org.operator.id });
});
