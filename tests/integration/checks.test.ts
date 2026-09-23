import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { Role } from "@/generated/prisma/enums";
import type { Actor } from "@/lib/auth/db";

/**
 * The synthetic check runner against a REAL PostgreSQL and a real local HTTP server: claiming,
 * storing results and time series, and alerting through the same engine as agent telemetry.
 * Skipped unless DATABASE_URL and IKELYANE_SECRET_KEY are set.
 *
 * Every claim is scoped to this file's organizations, so endpoints created by other suites running
 * in parallel are never probed here (and vice versa).
 */
const enabled = Boolean(process.env.DATABASE_URL && process.env.IKELYANE_SECRET_KEY);

describe.skipIf(!enabled)("synthetic check runner", () => {
  let db: PrismaClient;
  let runner: typeof import("@/modules/saas/runner/runner");
  let endpoints: typeof import("@/modules/saas/endpoints");
  let rules: typeof import("@/modules/alerts/rules");

  const runId = randomBytes(4).toString("hex");
  const domain = `${runId}.test`;
  const orgIds: string[] = [];
  let counter = 0;
  let server: http.Server;
  let base = "";
  let healthy = true;
  let hits = 0;
  const LOCAL = { allowPrivateTargets: true };

  async function makeOrg(label: string): Promise<Record<Role, Actor>> {
    const org = await db.organization.create({ data: { name: `${label}-${runId}`, slug: `${label}-${runId}-${++counter}` } });
    orgIds.push(org.id);
    const actors = {} as Record<Role, Actor>;
    for (const role of ["OWNER", "ADMIN", "OPERATOR", "VIEWER"] as Role[]) {
      const email = `${label}-${role.toLowerCase()}-${++counter}@${domain}`;
      const user = await db.user.create({ data: { email, name: label, passwordHash: "x" } });
      await db.membership.create({ data: { userId: user.id, orgId: org.id, role } });
      actors[role] = { userId: user.id, email, orgId: org.id, role, ip: "203.0.113.9" };
    }
    return actors;
  }

  const input = (url: string) => ({
    name: `site-${++counter}`, url, method: "GET" as const, expectedStatus: 200, expectedBodyContains: "healthy",
    intervalSec: 60, timeoutMs: 3000, tags: [], followRedirects: true, verifySsl: true, slaTargetPercent: 99.9,
  });

  async function createEndpoint(actor: Actor, url: string): Promise<string> {
    const created = await endpoints.createEndpoint(db, actor, input(url));
    if (!created.ok) throw new Error(created.error);
    return created.value.id;
  }

  beforeAll(async () => {
    db = (await import("@/lib/prisma")).getPrisma();
    runner = await import("@/modules/saas/runner/runner");
    endpoints = await import("@/modules/saas/endpoints");
    rules = await import("@/modules/alerts/rules");
    server = http.createServer((_req, res) => {
      hits++;
      if (healthy) return res.end("all healthy");
      res.statusCode = 503;
      res.end("maintenance");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server?.close();
    if (!db) return;
    await db.metricEntry.deleteMany({ where: { orgId: { in: orgIds } } });
    await db.auditLog.deleteMany({ where: { orgId: { in: orgIds } } });
    await db.organization.deleteMany({ where: { id: { in: orgIds } } });
    await db.user.deleteMany({ where: { email: { endsWith: `@${domain}` } } });
  });

  it("claims each due check exactly once, even with concurrent runners", async () => {
    const org = await makeOrg("claim");
    const ids = await Promise.all(Array.from({ length: 6 }, () => createEndpoint(org.OWNER, `${base}/`)));
    const scope = { orgIds: [org.OWNER.orgId] };

    const [first, second, third] = await Promise.all([
      runner.claimDueChecks(db, 4, scope),
      runner.claimDueChecks(db, 4, scope),
      runner.claimDueChecks(db, 4, scope),
    ]);
    const claimed = [...first, ...second, ...third].map((c) => c.id);
    expect(claimed.sort()).toEqual([...ids].sort());
    expect(new Set(claimed).size).toBe(6);

    // Not due again before their interval.
    expect(await runner.claimDueChecks(db, 10, scope)).toEqual([]);
    const rows = await db.endpointCheck.findMany({ where: { id: { in: ids } }, select: { nextRunAt: true } });
    for (const row of rows) {
      const inSeconds = ((row.nextRunAt?.getTime() ?? 0) - Date.now()) / 1000;
      expect(inSeconds).toBeGreaterThan(50);
      expect(inSeconds).toBeLessThanOrEqual(61);
    }
  });

  it("skips disabled checks; editing, re-enabling or 'check now' makes a check due immediately", async () => {
    const org = await makeOrg("sched");
    const scope = { orgIds: [org.OWNER.orgId] };
    const id = await createEndpoint(org.OWNER, `${base}/`);
    expect((await runner.claimDueChecks(db, 10, scope)).map((c) => c.id)).toEqual([id]);

    expect((await endpoints.requestEndpointCheck(db, org.OPERATOR, id)).ok).toBe(true);
    expect((await runner.claimDueChecks(db, 10, scope)).map((c) => c.id)).toEqual([id]);

    await endpoints.setEndpointEnabled(db, org.OWNER, id, false);
    await db.endpointCheck.update({ where: { id }, data: { nextRunAt: null } });
    expect(await runner.claimDueChecks(db, 10, scope)).toEqual([]);
    expect(await endpoints.requestEndpointCheck(db, org.OWNER, id)).toEqual({ ok: false, error: "not_found" });

    await endpoints.setEndpointEnabled(db, org.OWNER, id, true);
    expect((await runner.claimDueChecks(db, 10, scope)).map((c) => c.id)).toEqual([id]);

    await endpoints.updateEndpoint(db, org.OWNER, id, input(`${base}/edited`));
    expect((await runner.claimDueChecks(db, 10, scope)).map((c) => c.id)).toEqual([id]);
  });

  it("'check now' is RBAC-checked and org-scoped", async () => {
    const org = await makeOrg("rbac");
    const other = await makeOrg("other");
    const id = await createEndpoint(org.OWNER, `${base}/`);
    expect(await endpoints.requestEndpointCheck(db, org.VIEWER, id)).toEqual({ ok: false, error: "forbidden" });
    expect(await endpoints.requestEndpointCheck(db, other.OWNER, id)).toEqual({ ok: false, error: "not_found" });
  });

  it("stores results, time series and availability; DEGRADED then DOWN then UP", async () => {
    const org = await makeOrg("results");
    const scope = { orgIds: [org.OWNER.orgId] };
    const id = await createEndpoint(org.OWNER, `${base}/`);
    const due = () => db.endpointCheck.update({ where: { id }, data: { nextRunAt: null } });

    healthy = true;
    expect(await runner.runDueChecksOnce(db, 10, LOCAL, scope)).toBe(1);
    let row = await db.endpointCheck.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ status: "UP", lastStatusCode: 200, consecutiveFailures: 0, lastError: null });
    expect(row.lastResponseMs).toBeGreaterThan(0);

    healthy = false;
    await due();
    await runner.runDueChecksOnce(db, 10, LOCAL, scope);
    row = await db.endpointCheck.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ status: "DEGRADED", lastStatusCode: 503, consecutiveFailures: 1, lastError: "status_mismatch", lastErrorDetail: "HTTP 503" });

    await due();
    await runner.runDueChecksOnce(db, 10, LOCAL, scope);
    row = await db.endpointCheck.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ status: "DOWN", consecutiveFailures: 2 });

    healthy = true;
    await due();
    await runner.runDueChecksOnce(db, 10, LOCAL, scope);
    row = await db.endpointCheck.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ status: "UP", consecutiveFailures: 0, lastError: null, lastErrorDetail: null });

    const series = await db.metricEntry.findMany({ where: { sourceId: id, metric: "ENDPOINT_AVAILABLE" }, orderBy: { time: "asc" } });
    expect(series.map((p) => p.value)).toEqual([1, 0, 0, 1]);
    expect(series.every((p) => p.orgId === org.OWNER.orgId && p.sourceKind === "ENDPOINT")).toBe(true);
    expect(await db.metricEntry.count({ where: { sourceId: id, metric: "ENDPOINT_RESPONSE_MS" } })).toBe(4);

    const availability = await endpoints.endpointAvailability(db, org.VIEWER, [id], new Date(Date.now() - 3600_000));
    expect(availability.get(id)).toBe(50);
    const outsider = await makeOrg("outsider");
    expect((await endpoints.endpointAvailability(db, outsider.OWNER, [id], new Date(0))).size).toBe(0);
  });

  it("with the default guard, a private target is recorded as blocked and never reached", async () => {
    const org = await makeOrg("ssrf");
    const id = await createEndpoint(org.OWNER, `${base}/`);
    const before = hits;
    await runner.runDueChecksOnce(db, 10, { allowPrivateTargets: false }, { orgIds: [org.OWNER.orgId] });
    const row = await db.endpointCheck.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ status: "DEGRADED", lastError: "blocked_target", lastErrorDetail: "127.0.0.1", lastStatusCode: null });
    expect(hits).toBe(before);
  });

  it("feeds the alert engine: an availability rule opens an incident and auto-resolves it", async () => {
    const org = await makeOrg("alerting");
    const scope = { orgIds: [org.OWNER.orgId] };
    const id = await createEndpoint(org.OWNER, `${base}/`);
    const rule = await rules.createAlertRule(db, org.ADMIN, {
      name: "Website down", description: null, sourceKind: "ENDPOINT", sourceId: id, metric: "ENDPOINT_AVAILABLE",
      instanceFilter: null, operator: "LT", threshold: 1, anomalyDetection: false, anomalySensitivity: "MEDIUM", durationSec: 0, severity: "CRITICAL",
      channels: [], notifyEmails: [], webhookUrl: null, cooldownSec: 900,
    });
    expect(rule.ok).toBe(true);

    healthy = false;
    await runner.runDueChecksOnce(db, 10, LOCAL, scope);
    const open = await db.incident.findFirst({ where: { orgId: org.OWNER.orgId, sourceId: id } });
    expect(open).toMatchObject({ status: "OPEN", sourceKind: "ENDPOINT", metric: "ENDPOINT_AVAILABLE", triggerValue: 0 });
    expect(open?.sourceLabel).toMatch(/^site-/);

    healthy = true;
    await db.endpointCheck.update({ where: { id }, data: { nextRunAt: null } });
    await runner.runDueChecksOnce(db, 10, LOCAL, scope);
    const after = await db.incident.findUniqueOrThrow({ where: { id: open?.id } });
    expect(after.status).toBe("RESOLVED");
  });

  it("a check deleted mid-probe stores nothing", async () => {
    const org = await makeOrg("deleted");
    const id = await createEndpoint(org.OWNER, `${base}/`);
    const [claimed] = await runner.claimDueChecks(db, 10, { orgIds: [org.OWNER.orgId] });
    await endpoints.deleteEndpoint(db, org.OWNER, id);
    const stored = await runner.recordResult(db, claimed, { passed: true, statusCode: 200, responseMs: 5, error: null, errorDetail: null, tls: null }, new Date());
    expect(stored).toBe(false);
    expect(await db.metricEntry.count({ where: { sourceId: id } })).toBe(0);
  });
});
