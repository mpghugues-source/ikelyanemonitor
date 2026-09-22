import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { Role } from "@/generated/prisma/enums";
import type { Actor } from "@/lib/auth/db";
import type { MetricRow } from "@/lib/telemetry/metrics";

/**
 * Alert rules, the evaluation engine and the incident lifecycle against a REAL PostgreSQL.
 * Skipped unless DATABASE_URL and IKELYANE_SECRET_KEY are set (see tests/integration/telemetry-route.test.ts).
 */
const enabled = Boolean(process.env.DATABASE_URL && process.env.IKELYANE_SECRET_KEY);

describe.skipIf(!enabled)("alerts and incidents", () => {
  let db: PrismaClient;
  let m: {
    rules: typeof import("@/modules/alerts/rules");
    evaluate: typeof import("@/modules/alerts/evaluate");
    incidents: typeof import("@/modules/incidents/service");
  };

  const runId = randomBytes(4).toString("hex");
  const domain = `${runId}.test`;
  let counter = 0;

  const orgIds: string[] = [];

  interface Fixture {
    orgId: string;
    owner: Actor;
    admin: Actor;
    operator: Actor;
    viewer: Actor;
  }

  async function makeOrg(label: string): Promise<Fixture> {
    const org = await db.organization.create({ data: { name: `${label}-${runId}`, slug: `${label}-${runId}-${++counter}` } });
    orgIds.push(org.id);
    const actors = {} as Record<Role, Actor>;
    for (const role of ["OWNER", "ADMIN", "OPERATOR", "VIEWER"] as Role[]) {
      const email = `${label}-${role.toLowerCase()}-${++counter}@${domain}`;
      const user = await db.user.create({ data: { email, name: label, passwordHash: "x" } });
      await db.membership.create({ data: { userId: user.id, orgId: org.id, role } });
      actors[role] = { userId: user.id, email, orgId: org.id, role, ip: "203.0.113.9" };
    }
    return { orgId: org.id, owner: actors.OWNER, admin: actors.ADMIN, operator: actors.OPERATOR, viewer: actors.VIEWER };
  }

  async function makeHost(orgId: string, hostname: string) {
    return db.monitoredHost.create({ data: { orgId, hostname, keyId: `ikm_${randomBytes(6).toString("hex")}`, hmacSecretEnc: "v1:aa:bb:cc" } });
  }

  beforeAll(async () => {
    db = (await import("@/lib/prisma")).getPrisma();
    m = {
      rules: await import("@/modules/alerts/rules"),
      evaluate: await import("@/modules/alerts/evaluate"),
      incidents: await import("@/modules/incidents/service"),
    };
  });

  afterAll(async () => {
    if (!db) return;
    // MetricEntry has no FK to Organization (the hypertable is append-only), so it does not cascade.
    await db.metricEntry.deleteMany({ where: { orgId: { in: orgIds } } });
    await db.auditLog.deleteMany({ where: { orgId: { in: orgIds } } });
    await db.organization.deleteMany({ where: { id: { in: orgIds } } });
    await db.user.deleteMany({ where: { email: { endsWith: `@${domain}` } } });
  });

  const ruleInput = {
    name: "CPU too high",
    description: null,
    sourceKind: "HOST" as const,
    sourceId: null,
    metric: "CPU_USAGE_PERCENT" as const,
    instanceFilter: null,
    operator: "GT" as const,
    threshold: 90,
    durationSec: 120,
    severity: "CRITICAL" as const,
    channels: [],
    notifyEmails: [],
    webhookUrl: null,
    cooldownSec: 900,
  };

  describe("alert rules", () => {
    it("enforces write permission and rejects a source from another organization", async () => {
      const a = await makeOrg("rule-perm-a");
      const b = await makeOrg("rule-perm-b");
      const hostB = await makeHost(b.orgId, "host-b.example");

      expect(await m.rules.createAlertRule(db, a.viewer, ruleInput)).toEqual({ ok: false, error: "forbidden" });
      expect(await m.rules.createAlertRule(db, a.operator, ruleInput)).toEqual({ ok: false, error: "forbidden" });
      expect(await m.rules.createAlertRule(db, a.admin, { ...ruleInput, sourceId: hostB.id })).toEqual({ ok: false, error: "invalid_source" });
      expect(await m.rules.createAlertRule(db, a.admin, { ...ruleInput, sourceId: "does-not-exist" })).toEqual({ ok: false, error: "invalid_source" });
    });

    it("creates, lists (with resolved source label), updates, toggles and deletes, scoped by organization", async () => {
      const a = await makeOrg("rule-crud-a");
      const b = await makeOrg("rule-crud-b");
      const hostA = await makeHost(a.orgId, "host-a.example");

      const created = await m.rules.createAlertRule(db, a.admin, { ...ruleInput, sourceId: hostA.id });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const listA = await m.rules.listAlertRules(db, a.viewer);
      expect(listA.ok && listA.value).toHaveLength(1);
      expect(listA.ok && listA.value[0]?.sourceLabel).toBe("host-a.example");
      const listB = await m.rules.listAlertRules(db, b.viewer);
      expect(listB.ok && listB.value).toHaveLength(0);

      expect(await m.rules.updateAlertRule(db, b.admin, created.value.id, ruleInput)).toEqual({ ok: false, error: "not_found" });
      expect(await m.rules.deleteAlertRule(db, b.admin, created.value.id)).toEqual({ ok: false, error: "not_found" });

      const renamed = await m.rules.updateAlertRule(db, a.admin, created.value.id, { ...ruleInput, sourceId: hostA.id, name: "Renamed" });
      expect(renamed.ok).toBe(true);
      const afterUpdate = await m.rules.listAlertRules(db, a.admin);
      expect(afterUpdate.ok && afterUpdate.value[0]?.name).toBe("Renamed");

      expect(await m.rules.setAlertRuleEnabled(db, a.operator, created.value.id, false)).toEqual({ ok: false, error: "forbidden" });
      const disabled = await m.rules.setAlertRuleEnabled(db, a.admin, created.value.id, false);
      expect(disabled.ok).toBe(true);
      // Editing the rule again must NOT silently re-enable it (only the dedicated toggle may).
      await m.rules.updateAlertRule(db, a.admin, created.value.id, { ...ruleInput, sourceId: hostA.id, name: "Renamed again" });
      const afterEdit = await m.rules.listAlertRules(db, a.admin);
      expect(afterEdit.ok && afterEdit.value[0]?.enabled).toBe(false);

      const deleted = await m.rules.deleteAlertRule(db, a.admin, created.value.id);
      expect(deleted.ok).toBe(true);
      const afterDelete = await m.rules.listAlertRules(db, a.admin);
      expect(afterDelete.ok && afterDelete.value).toHaveLength(0);
    });
  });

  describe("evaluation engine", () => {
    async function insert(orgId: string, sourceId: string, points: Array<{ secondsAgo: number; value: number }>, now: Date) {
      const rows: MetricRow[] = points.map(({ secondsAgo, value }) => ({
        time: new Date(now.getTime() - secondsAgo * 1000),
        orgId,
        sourceKind: "HOST",
        sourceId,
        metric: "CPU_USAGE_PERCENT",
        instance: "",
        value,
      }));
      await db.metricEntry.createMany({ data: rows });
      return rows;
    }

    it("opens an incident once the breach has lasted durationSec, tracks the peak, and auto-resolves when it clears", async () => {
      const org = await makeOrg("eval");
      const host = await makeHost(org.orgId, "eval-host.example");
      const rule = await m.rules.createAlertRule(db, org.admin, { ...ruleInput, sourceId: host.id, durationSec: 120 });
      expect(rule.ok).toBe(true);
      if (!rule.ok) return;

      const t0 = new Date("2026-01-01T00:00:00Z");

      // Breach just started (60s of history): not sustained yet, no incident.
      const early = await insert(org.orgId, host.id, [{ secondsAgo: 60, value: 95 }, { secondsAgo: 0, value: 96 }], t0);
      await m.evaluate.evaluateIngestedMetrics(db, org.orgId, [early[early.length - 1]], t0);
      expect(await db.incident.count({ where: { orgId: org.orgId } })).toBe(0);

      // 150s later the breach has been continuous for well over durationSec: incident opens.
      const t1 = new Date(t0.getTime() + 150_000);
      const sustained = await insert(org.orgId, host.id, [{ secondsAgo: 0, value: 97 }], t1);
      await m.evaluate.evaluateIngestedMetrics(db, org.orgId, sustained, t1);
      const opened = await db.incident.findFirst({ where: { orgId: org.orgId } });
      expect(opened?.status).toBe("OPEN");
      expect(opened?.triggerValue).toBe(97);
      expect(opened?.peakValue).toBe(97);
      expect(opened?.sourceLabel).toBe("eval-host.example");
      expect(opened?.title).toBe("CPU too high");

      // A worse reading updates the peak but does not open a second incident.
      const t2 = new Date(t1.getTime() + 30_000);
      const worse = await insert(org.orgId, host.id, [{ secondsAgo: 0, value: 99.5 }], t2);
      await m.evaluate.evaluateIngestedMetrics(db, org.orgId, worse, t2);
      expect(await db.incident.count({ where: { orgId: org.orgId } })).toBe(1);
      const afterWorse = await db.incident.findFirst({ where: { orgId: org.orgId } });
      expect(afterWorse?.peakValue).toBe(99.5);
      expect(afterWorse?.triggerValue).toBe(99.5);

      // The condition clears: auto-resolved, with the sentinel resolution note.
      const t3 = new Date(t2.getTime() + 30_000);
      const cleared = await insert(org.orgId, host.id, [{ secondsAgo: 0, value: 40 }], t3);
      await m.evaluate.evaluateIngestedMetrics(db, org.orgId, cleared, t3);
      const resolved = await db.incident.findFirst({ where: { orgId: org.orgId } });
      expect(resolved?.status).toBe("RESOLVED");
      expect(resolved?.resolutionNote).toBe("auto");
      expect(resolved?.resolvedBy).toBeNull();

      const events = await db.incidentEvent.findMany({ where: { incidentId: resolved?.id }, orderBy: { createdAt: "asc" } });
      expect(events.map((e) => e.type)).toEqual(["OPENED", "RESOLVED"]);
    });

    it("does nothing for a disabled rule", async () => {
      const org = await makeOrg("eval-disabled");
      const host = await makeHost(org.orgId, "eval-host-2.example");
      const rule = await m.rules.createAlertRule(db, org.admin, { ...ruleInput, sourceId: host.id, durationSec: 0 });
      expect(rule.ok).toBe(true);
      if (!rule.ok) return;
      await m.rules.setAlertRuleEnabled(db, org.admin, rule.value.id, false);

      const now = new Date("2026-01-02T00:00:00Z");
      const points = await insert(org.orgId, host.id, [{ secondsAgo: 0, value: 99 }], now);
      await m.evaluate.evaluateIngestedMetrics(db, org.orgId, points, now);
      expect(await db.incident.count({ where: { orgId: org.orgId } })).toBe(0);
    });
  });

  describe("incident lifecycle", () => {
    async function makeIncident(orgId: string) {
      return db.incident.create({ data: { orgId, title: "Manual test incident", severity: "WARNING", status: "OPEN" } });
    }

    it("enforces incidents:acknowledge and organization scoping on every transition", async () => {
      const a = await makeOrg("lifecycle-a");
      const b = await makeOrg("lifecycle-b");
      const incident = await makeIncident(a.orgId);

      expect(await m.incidents.acknowledgeIncident(db, a.viewer, incident.id)).toEqual({ ok: false, error: "forbidden" });
      expect(await m.incidents.acknowledgeIncident(db, b.operator, incident.id)).toEqual({ ok: false, error: "not_found" });

      const acked = await m.incidents.acknowledgeIncident(db, a.operator, incident.id);
      expect(acked.ok).toBe(true);
      expect(await m.incidents.acknowledgeIncident(db, a.operator, incident.id)).toEqual({ ok: false, error: "invalid_status" });

      const resolved = await m.incidents.resolveIncident(db, a.operator, incident.id, "fixed the disk");
      expect(resolved.ok).toBe(true);
      expect(await m.incidents.resolveIncident(db, a.operator, incident.id, null)).toEqual({ ok: false, error: "invalid_status" });

      const reopened = await m.incidents.reopenIncident(db, a.operator, incident.id);
      expect(reopened.ok).toBe(true);
      expect(await m.incidents.reopenIncident(db, a.operator, incident.id)).toEqual({ ok: false, error: "invalid_status" });

      const note = await m.incidents.addIncidentNote(db, a.operator, incident.id, "still investigating");
      expect(note.ok).toBe(true);
      expect(await m.incidents.addIncidentNote(db, a.viewer, incident.id, "nope")).toEqual({ ok: false, error: "forbidden" });

      const row = await db.incident.findUniqueOrThrow({ where: { id: incident.id } });
      expect(row.status).toBe("OPEN");
      expect(row.acknowledgedAt).toBeNull();
      expect(row.resolvedAt).toBeNull();

      const events = await db.incidentEvent.findMany({ where: { incidentId: incident.id }, orderBy: { createdAt: "asc" } });
      expect(events.map((e) => e.type)).toEqual(["ACKNOWLEDGED", "RESOLVED", "REOPENED", "NOTE"]);
      expect(events.every((e) => e.actorId === a.operator.userId)).toBe(true);
    });

    it("lists active and resolved incidents separately, most severe/most recent first", async () => {
      const org = await makeOrg("lifecycle-list");
      const info = await db.incident.create({ data: { orgId: org.orgId, title: "info", severity: "INFO", status: "OPEN" } });
      const critical = await db.incident.create({ data: { orgId: org.orgId, title: "critical", severity: "CRITICAL", status: "OPEN" } });
      const resolvedOne = await db.incident.create({ data: { orgId: org.orgId, title: "old", severity: "WARNING", status: "RESOLVED", resolvedAt: new Date() } });

      const active = await m.incidents.listActiveIncidents(db, org.viewer);
      expect(active.ok && active.value.map((i) => i.id)).toEqual([critical.id, info.id]);

      const resolved = await m.incidents.listResolvedIncidents(db, org.viewer);
      expect(resolved.ok && resolved.value.map((i) => i.id)).toEqual([resolvedOne.id]);
    });
  });
});
