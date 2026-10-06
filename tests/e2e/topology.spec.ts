import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { cleanup, makeOrg, query, type TestOrg } from "./support/db";
import { loginOk } from "./support/pages";

/**
 * The interactive dependency map in a real browser: live health and impact colouring, the
 * selection panel, auto layout, drawing a dependency handle to handle, and deleting one.
 *
 *   Web shop ──▶ Orders API ──▶ db-01 (host DOWN)
 *   Web shop ──▶ CDN
 */

let org: TestOrg;
const id = { web: randomUUID(), api: randomUUID(), db: randomUUID(), cdn: randomUUID(), host: randomUUID() };
const edge = { webApi: randomUUID(), apiDb: randomUUID(), webCdn: randomUUID() };

test.beforeAll(async () => {
  org = await makeOrg("topology");
  await query(
    `INSERT INTO monitored_hosts (id, "orgId", hostname, "keyId", "hmacSecretEnc", status, "updatedAt")
     VALUES ($1, $2, 'db-01.example', $3, 'v1:aa:bb:cc', 'DOWN', now())`,
    [id.host, org.id, `ikm_${randomUUID().slice(0, 12)}`],
  );
  const nodes: Array<[string, string, string | null, string, number, number]> = [
    [id.web, "SERVICE", null, "Web shop", 0, 0],
    [id.api, "SERVICE", null, "Orders API", 300, 0],
    [id.db, "HOST", id.host, "db-01", 600, 0],
    [id.cdn, "EXTERNAL", null, "CDN", 0, 300],
  ];
  for (const [nodeId, kind, refId, label, x, y] of nodes) {
    await query(
      `INSERT INTO topology_nodes (id, "orgId", kind, "refId", label, "positionX", "positionY", "updatedAt")
       VALUES ($1, $2, $3::"TopologyNodeKind", $4, $5, $6, $7, now())`,
      [nodeId, org.id, kind, refId, label, x, y],
    );
  }
  for (const [edgeId, parent, child] of [
    [edge.webApi, id.web, id.api],
    [edge.apiDb, id.api, id.db],
    [edge.webCdn, id.web, id.cdn],
  ]) {
    await query(`INSERT INTO service_dependencies (id, "orgId", "parentNodeId", "childNodeId") VALUES ($1, $2, $3, $4)`, [edgeId, org.id, parent, child]);
  }
});

test.afterAll(async () => {
  await cleanup();
});

const mapNode = (page: Page, nodeId: string) => page.locator(`.react-flow__node[data-id="${nodeId}"]`);

test("a viewer sees live health, the impact of a failure, and what a node depends on — read-only", async ({ page }) => {
  await loginOk(page, org.viewer.email, { next: "/en/topology" });
  await page.goto("/en/topology");

  await expect(page.getByTestId("topology-node")).toHaveCount(4);
  await expect(mapNode(page, id.db).getByTestId("topology-node")).toHaveAttribute("data-health", "down");
  // The failure climbs against the arrows: everything that depends on db-01 is impacted, the CDN is not.
  await expect(mapNode(page, id.api).getByTestId("topology-node")).toHaveAttribute("data-impacted", "true");
  await expect(mapNode(page, id.web).getByTestId("topology-node")).toHaveAttribute("data-impacted", "true");
  await expect(mapNode(page, id.cdn).getByTestId("topology-node")).not.toHaveAttribute("data-impacted");
  await expect(mapNode(page, id.cdn).getByTestId("topology-node")).toHaveAttribute("data-health", "logical");

  await mapNode(page, id.api).click();
  const panel = page.getByTestId("topology-panel");
  await expect(panel).toContainText("Orders API");
  await expect(panel).toContainText("Depends on (1)db-01");
  await expect(panel).toContainText("Impacted if it fails (1)Web shop");
  await expect(mapNode(page, id.cdn).getByTestId("topology-node")).toHaveClass(/opacity-30/);

  await mapNode(page, id.db).click();
  await expect(panel).toContainText("Impacted if it fails (2)Orders API, Web shop");
  await expect(panel.getByRole("link", { name: "Details" })).toHaveAttribute("href", "/en/servers");

  // No editing affordance for a viewer, and a drag does not move anything.
  await expect(page.getByRole("button", { name: "Auto layout" })).toHaveCount(0);
  const box = await mapNode(page, id.cdn).boundingBox();
  if (!box) throw new Error("no box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 200, box.y + 200, { steps: 5 });
  await page.mouse.up();
  const [cdn] = await query<{ positionX: number; positionY: number }>(`SELECT "positionX", "positionY" FROM topology_nodes WHERE id = $1`, [id.cdn]);
  expect(cdn).toEqual({ positionX: 0, positionY: 300 });
});

test("an administrator arranges the map, draws a dependency and deletes another", async ({ page }) => {
  await loginOk(page, org.admin.email, { next: "/en/topology" });
  await page.goto("/en/topology");
  await expect(page.getByTestId("topology-node")).toHaveCount(4);

  // Auto layout: what depends on something sits above it, and the layout is saved.
  await page.getByRole("button", { name: "Auto layout" }).click();
  await expect
    .poll(async () => {
      const rows = await query<{ id: string; positionY: number }>(`SELECT id, "positionY" FROM topology_nodes WHERE "orgId" = $1`, [org.id]);
      const y = new Map(rows.map((r) => [r.id, r.positionY]));
      return (y.get(id.web) as number) < (y.get(id.api) as number) && (y.get(id.api) as number) < (y.get(id.db) as number);
    })
    .toBe(true);

  // The layout is saved before the 300 ms fitView animation ends: measure handles only once the viewport stops moving.
  const viewport = page.locator(".react-flow__viewport");
  let lastTransform = "";
  await expect
    .poll(async () => {
      const transform = await viewport.evaluate((el) => getComputedStyle(el).transform);
      const settled = transform === lastTransform;
      lastTransform = transform;
      return settled;
    }, { intervals: [150] })
    .toBe(true);

  // Draw "Orders API depends on CDN" from the API's bottom handle onto the CDN's top handle.
  const from = await mapNode(page, id.api).locator(".react-flow__handle.source").boundingBox();
  const to = await mapNode(page, id.cdn).locator(".react-flow__handle.target").boundingBox();
  if (!from || !to) throw new Error("no handles");
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 10 });
  await page.mouse.up();
  await expect
    .poll(async () => (await query(`SELECT 1 FROM service_dependencies WHERE "parentNodeId" = $1 AND "childNodeId" = $2 AND kind = 'DEPENDS_ON'`, [id.api, id.cdn])).length)
    .toBe(1);
  await expect(page.locator(".react-flow__edge")).toHaveCount(4);

  // Select the "Web shop → CDN" edge and delete it from the panel.
  await page.locator(`.react-flow__edge[data-id="${edge.webCdn}"] .react-flow__edge-interaction`).click({ force: true });
  const panel = page.getByTestId("topology-panel");
  await expect(panel).toContainText("Web shop depends on CDN");
  page.once("dialog", (dialog) => void dialog.accept());
  await panel.getByRole("button", { name: "Delete this dependency" }).click();
  await expect(page.locator(".react-flow__edge")).toHaveCount(3);
  await expect(panel).toHaveCount(0);
  expect(await query(`SELECT 1 FROM service_dependencies WHERE id = $1`, [edge.webCdn])).toHaveLength(0);
});
