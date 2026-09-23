import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { cleanup, makeOrg, query, type TestOrg } from "./support/db";
import { loginOk } from "./support/pages";

/**
 * The SaaS page once the synthetic check runner has produced results: failure reason, availability,
 * and "Check now" for operators (endpoints:check) without the configuration actions (endpoints:write).
 * Results are seeded in the database — the runner itself is covered by tests/integration/checks.test.ts.
 */

let org: TestOrg;
let failingId: string;

test.beforeAll(async () => {
  org = await makeOrg("checks");
  failingId = randomUUID();
  const healthyId = randomUUID();
  await query(
    `INSERT INTO endpoint_checks (id, "orgId", name, url, status, "lastCheckedAt", "lastResponseMs", "lastError", "lastErrorDetail", "consecutiveFailures", "nextRunAt", "updatedAt")
     VALUES ($1, $2, 'Internal admin', 'http://10.0.0.5/', 'DOWN', now(), NULL, 'blocked_target', '10.0.0.5', 3, now() + interval '1 hour', now()),
            ($3, $2, 'Public site', 'https://example.com/', 'UP', now(), 42, NULL, NULL, 0, now() + interval '1 hour', now())`,
    [failingId, org.id, healthyId],
  );
  // Public site: 3 passed checks out of 4 in the last hour → 75 %; nothing for the failing one's 30-day window beyond today.
  for (const [minutesAgo, value] of [[50, 1], [40, 0], [30, 1], [20, 1]] as const) {
    await query(
      `INSERT INTO metric_entries (time, "orgId", "sourceKind", "sourceId", metric, instance, value)
       VALUES (now() - make_interval(mins => $1), $2, 'ENDPOINT', $3, 'ENDPOINT_AVAILABLE', '', $4)`,
      [minutesAgo, org.id, healthyId, value],
    );
  }
});

test.afterAll(async () => {
  await cleanup();
});

test("operators see the failure reason and availability, and can request a check — but not configure", async ({ page }) => {
  await loginOk(page, org.operator.email, { next: "/en/saas" });
  await page.goto("/en/saas");

  const failing = page.getByTestId("endpoint-Internal admin");
  await expect(failing.getByTestId("endpoint-last-error")).toHaveText("Blocked: private or reserved address (10.0.0.5)");
  await expect(failing).toContainText("No data");

  const healthy = page.getByTestId("endpoint-Public site");
  await expect(healthy).toContainText("75 %");
  await expect(healthy).toContainText("42 ms");
  await expect(healthy).toContainText("SLA breached"); // 75 % < 99.9 % target
  await expect(healthy.getByTestId("endpoint-last-error")).toHaveCount(0);

  await expect(failing.getByRole("button", { name: "Delete" })).toHaveCount(0);
  await failing.getByTestId("endpoint-check-now").click();
  await expect(failing.getByTestId("endpoint-check-now")).toHaveAttribute("title", /Check scheduled/);
  const [row] = await query<{ nextRunAt: Date | null }>(`SELECT "nextRunAt" FROM endpoint_checks WHERE id = $1`, [failingId]);
  expect(row.nextRunAt).toBeNull();
});

test("viewers get no check button; administrators get every action", async ({ browser }) => {
  const viewer = await browser.newPage();
  await loginOk(viewer, org.viewer.email, { next: "/en/saas" });
  await viewer.goto("/en/saas");
  await expect(viewer.getByTestId("endpoint-Internal admin")).toBeVisible();
  await expect(viewer.getByTestId("endpoint-check-now")).toHaveCount(0);

  const admin = await browser.newPage();
  await loginOk(admin, org.admin.email, { next: "/en/saas" });
  await admin.goto("/en/saas");
  const failing = admin.getByTestId("endpoint-Internal admin");
  await expect(failing.getByTestId("endpoint-check-now")).toBeVisible();
  await expect(failing.getByRole("button", { name: "Delete" })).toBeVisible();
});

test("the failure reason is translated", async ({ page }) => {
  await loginOk(page, org.operator.email, { locale: "fr", next: "/fr/saas" });
  await page.goto("/fr/saas");
  await expect(page.getByTestId("endpoint-Internal admin").getByTestId("endpoint-last-error")).toHaveText("Bloqué : adresse privée ou réservée (10.0.0.5)");
});
