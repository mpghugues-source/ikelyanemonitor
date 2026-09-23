import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { cleanup, makeOrg, query, type TestOrg } from "./support/db";
import { loginOk } from "./support/pages";

/**
 * AIOps in the real UI: creating an anomaly-detection rule, and reading a root-cause analysis
 * (deterministic findings translated in the browser, plus a stored Claude narrative per language).
 * Incident data is seeded; the engine itself is covered by tests/integration/aiops.test.ts.
 */

let org: TestOrg;
let incidentId: string;

test.beforeAll(async () => {
  org = await makeOrg("aiops");
  incidentId = randomUUID();
  const findings = {
    version: 1,
    verdict: "symptom",
    node: "Web front",
    rootCauses: [{ label: "Orders DB", incidents: [{ incidentId: "x", title: "DB connections saturated", sourceLabel: "db-01", metric: "DB_CONNECTION_USAGE_PERCENT", offsetSec: -240 }] }],
    impacted: [],
    blastRadius: { count: 2, labels: ["Load balancer", "Checkout"] },
    sameSource: [],
    correlated: [],
    firstToStart: false,
    confidence: 0.8,
  };
  await query(
    `INSERT INTO incidents (id, "orgId", title, severity, status, "sourceKind", "sourceId", "sourceLabel", metric, "triggerValue", "anomalyScore",
                            "rcaFindings", "rcaConfidence", "rcaModel", "rcaSummaryEn", "rcaSummaryFr", "rcaGeneratedAt", "startedAt", "updatedAt")
     VALUES ($1, $2, 'Web latency unusual', 'WARNING', 'OPEN', 'HOST', 'web-host', 'web-01', 'CPU_USAGE_PERCENT', 71, 0.82,
             $3::jsonb, 0.8, 'ikelyane-rca-v1+claude-opus-5', 'The orders database ran out of connections.', 'La base des commandes a épuisé ses connexions.', now(), now(), now())`,
    [incidentId, org.id, JSON.stringify(findings)],
  );
});

test.afterAll(async () => {
  await cleanup();
});

test("an administrator creates an anomaly-only rule; a rule with no condition is refused", async ({ page }) => {
  await loginOk(page, org.admin.email, { next: "/en/alerts" });
  await page.goto("/en/alerts");

  await page.getByRole("button", { name: "Create rule" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Rule").fill("CPU unusual");
  await dialog.getByLabel("Condition").selectOption({ label: "No threshold (anomaly detection only)" });
  await dialog.getByRole("button", { name: "Create rule" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Set a threshold, enable anomaly detection, or both.");

  await dialog.getByTestId("rule-anomaly").click();
  await dialog.getByLabel("Anomaly sensitivity").selectOption({ label: "High" });
  await dialog.getByRole("button", { name: "Create rule" }).click();
  await expect(dialog).toBeHidden();

  const row = page.getByTestId("alert-rule-CPU unusual");
  await expect(row.getByTestId("rule-anomaly-badge")).toHaveText("AI anomaly detection · High");
  const [rule] = await query<{ operator: string | null; threshold: number | null; anomalyDetection: boolean; anomalySensitivity: string }>(
    `SELECT operator, threshold, "anomalyDetection", "anomalySensitivity" FROM alert_rules WHERE "orgId" = $1`,
    [org.id],
  );
  expect(rule).toEqual({ operator: null, threshold: null, anomalyDetection: true, anomalySensitivity: "HIGH" });
});

test("operators read the analysis in their language and can re-run it; viewers only read", async ({ page, browser }) => {
  await loginOk(page, org.operator.email, { next: "/en/incidents" });
  await page.goto("/en/incidents");
  const panel = page.getByTestId("rca-panel");
  await expect(panel.getByTestId("rca-verdict")).toHaveText("Likely a symptom: a dependency of Web front is failing too.");
  await expect(panel.getByTestId("rca-root")).toContainText("Orders DB");
  await expect(panel.getByTestId("rca-root")).toContainText("DB connections saturated — db-01");
  await expect(panel.getByTestId("rca-root")).toContainText("4m 0s before");
  await expect(panel).toContainText("2 components depend on it: Load balancer, Checkout");
  await expect(panel.getByTestId("anomaly-score")).toHaveText("Anomaly score: 82%");
  await expect(panel.getByTestId("rca-narrative")).toContainText("The orders database ran out of connections.");
  await expect(panel.getByTestId("rca-narrative")).toContainText("AI-generated: verify before acting.");

  const fr = await browser.newPage();
  await loginOk(fr, org.viewer.email, { locale: "fr", next: "/fr/incidents" });
  await fr.goto("/fr/incidents");
  const frPanel = fr.getByTestId("rca-panel");
  await expect(frPanel.getByTestId("rca-verdict")).toHaveText("Probablement un symptôme : une dépendance de Web front est elle aussi en échec.");
  await expect(frPanel.getByTestId("rca-narrative")).toContainText("La base des commandes a épuisé ses connexions.");
  await expect(frPanel.getByTestId("rca-reanalyze")).toHaveCount(0);

  // Re-analyze recomputes from the real (empty) dependency map: the seeded source is not on it.
  await panel.getByTestId("rca-reanalyze").click();
  await expect(panel.getByTestId("rca-verdict")).toHaveText(/not on the dependency map/);
  await expect(panel.getByTestId("rca-narrative")).toHaveCount(0); // a narrative for the old findings is dropped
  const [row] = await query<{ count: string }>(`SELECT count(*) FROM incident_events WHERE "incidentId" = $1 AND type = 'RCA_GENERATED'`, [incidentId]);
  expect(Number(row.count)).toBe(1);
});
