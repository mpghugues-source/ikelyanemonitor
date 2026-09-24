import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { Role } from "@/generated/prisma/enums";
import type { Actor } from "@/lib/auth/db";
import type { MetricRow } from "@/lib/telemetry/metrics";

/**
 * AIOps against a REAL PostgreSQL/TimescaleDB: anomaly rules on seeded history, root-cause analysis
 * through the dependency map, and the Claude narrative queue (with a fake client — no network).
 * Skipped unless DATABASE_URL and IKELYANE_SECRET_KEY are set.
 */
const enabled = Boolean(process.env.DATABASE_URL && process.env.IKELYANE_SECRET_KEY);

describe.skipIf(!enabled)("AIOps", () => {
  let db: PrismaClient;
  let evaluate: typeof import("@/modules/alerts/evaluate");
  let rules: typeof import("@/modules/alerts/rules");
  let rca: typeof import("@/modules/aiops/rca");
  let llm: typeof import("@/modules/aiops/rca-llm");
  let incidents: typeof import("@/modules/incidents/service");
  let baseline: typeof import("@/modules/aiops/baseline");

  const runId = randomBytes(4).toString("hex");
  const domain = `${runId}.test`;
  const orgIds: string[] = [];
  let counter = 0;

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

  async function makeHost(orgId: string, hostname: string) {
    return db.monitoredHost.create({ data: { orgId, hostname, keyId: `ikm_${randomBytes(6).toString("hex")}`, hmacSecretEnc: "v1:aa:bb:cc" } });
  }

  const rule = (overrides: Partial<Parameters<typeof rules.createAlertRule>[2]> = {}): Parameters<typeof rules.createAlertRule>[2] => ({
    name: "CPU unusual", description: null, sourceKind: "HOST", sourceId: null, metric: "CPU_USAGE_PERCENT", instanceFilter: null,
    operator: null, threshold: null, anomalyDetection: true, anomalySensitivity: "MEDIUM", durationSec: 0, severity: "WARNING",
    channels: [], notifyEmails: [], webhookUrl: null, cooldownSec: 900, remediationActionId: null, autoRemediate: false, ...overrides,
  });

  /** A week of normal CPU around 20 % (± 2), where the baseline looks: last 6 h + ±30 min on each past day. */
  async function seedNormalHistory(orgId: string, hostId: string, now: Date): Promise<void> {
    const rows: MetricRow[] = [];
    const push = (t: number, i: number) =>
      rows.push({ time: new Date(t), orgId, sourceKind: "HOST", sourceId: hostId, metric: "CPU_USAGE_PERCENT", instance: "", value: 20 + ((i % 5) - 2) });
    let i = 0;
    for (let t = now.getTime() - 6 * 3600_000; t < now.getTime() - 20 * 60_000; t += 5 * 60_000) push(t, i++);
    for (let day = 1; day <= 7; day++) {
      const centre = now.getTime() - day * 86_400_000;
      for (let t = centre - 25 * 60_000; t <= centre + 25 * 60_000; t += 10 * 60_000) push(t, i++);
    }
    await db.metricEntry.createMany({ data: rows });
  }

  async function ingest(orgId: string, hostId: string, value: number, now: Date) {
    const row: MetricRow = { time: now, orgId, sourceKind: "HOST", sourceId: hostId, metric: "CPU_USAGE_PERCENT", instance: "", value };
    await db.metricEntry.create({ data: row });
    await evaluate.evaluateIngestedMetrics(db, orgId, [row], now);
  }

  beforeAll(async () => {
    db = (await import("@/lib/prisma")).getPrisma();
    evaluate = await import("@/modules/alerts/evaluate");
    rules = await import("@/modules/alerts/rules");
    rca = await import("@/modules/aiops/rca");
    llm = await import("@/modules/aiops/rca-llm");
    incidents = await import("@/modules/incidents/service");
    baseline = await import("@/modules/aiops/baseline");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    baseline.clearBaselineCache();
  });

  afterAll(async () => {
    if (!db) return;
    await db.metricEntry.deleteMany({ where: { orgId: { in: orgIds } } });
    await db.auditLog.deleteMany({ where: { orgId: { in: orgIds } } });
    await db.organization.deleteMany({ where: { id: { in: orgIds } } });
    await db.user.deleteMany({ where: { email: { endsWith: `@${domain}` } } });
  });

  it("rules need a threshold, anomaly detection, or both", async () => {
    const org = await makeOrg("cond");
    expect(await rules.createAlertRule(db, org.ADMIN, rule({ anomalyDetection: false }))).toEqual({ ok: false, error: "condition_required" });
    expect(await rules.createAlertRule(db, org.ADMIN, rule({ anomalyDetection: false, operator: "GT", threshold: null }))).toEqual({ ok: false, error: "condition_required" });
    expect((await rules.createAlertRule(db, org.ADMIN, rule())).ok).toBe(true);
    const listed = await rules.listAlertRules(db, org.VIEWER);
    expect(listed.ok && listed.value[0]).toMatchObject({ operator: null, threshold: null, anomalyDetection: true, anomalySensitivity: "MEDIUM" });
  });

  it("an anomaly-only rule opens an incident on a spike, with a score and the baseline, then auto-resolves", async () => {
    const org = await makeOrg("anomaly");
    const host = await makeHost(org.OWNER.orgId, "app-01");
    const now = new Date();
    await seedNormalHistory(org.OWNER.orgId, host.id, now);
    expect((await rules.createAlertRule(db, org.ADMIN, rule())).ok).toBe(true);

    await ingest(org.OWNER.orgId, host.id, 21, new Date(now.getTime() - 60_000));
    expect(await db.incident.count({ where: { orgId: org.OWNER.orgId } })).toBe(0); // normal value

    await ingest(org.OWNER.orgId, host.id, 65, now);
    const open = await db.incident.findFirstOrThrow({ where: { orgId: org.OWNER.orgId }, include: { events: true } });
    expect(open).toMatchObject({ status: "OPEN", sourceLabel: "app-01", triggerValue: 65 });
    expect(open.anomalyScore).toBeGreaterThan(0.5);
    const opened = open.events.find((e) => e.type === "OPENED")?.data as { anomaly: { baselineMedian: number; z: number }; operator: null };
    expect(opened.operator).toBeNull();
    expect(opened.anomaly.baselineMedian).toBe(20);
    expect(opened.anomaly.z).toBeGreaterThan(4.5);

    // RCA ran on open: not on the dependency map.
    expect(open.rcaModel).toBe(rca.RCA_MODEL);
    expect(open.rcaFindings).toMatchObject({ verdict: "not_mapped" });
    expect(open.events.some((e) => e.type === "RCA_GENERATED")).toBe(true);
    expect(open.rcaLlmRequestedAt).toBeNull(); // no ANTHROPIC_API_KEY: nothing queued for Claude

    await ingest(org.OWNER.orgId, host.id, 20, new Date(now.getTime() + 60_000));
    expect((await db.incident.findUniqueOrThrow({ where: { id: open.id } })).status).toBe("RESOLVED");
  });

  it("stays silent while learning, and a threshold filters harmless anomalies", async () => {
    const org = await makeOrg("learning");
    const host = await makeHost(org.OWNER.orgId, "new-host");
    const now = new Date();
    expect((await rules.createAlertRule(db, org.ADMIN, rule())).ok).toBe(true);
    await ingest(org.OWNER.orgId, host.id, 99, now); // no history at all
    expect(await db.incident.count({ where: { orgId: org.OWNER.orgId } })).toBe(0);

    const org2 = await makeOrg("floor");
    const host2 = await makeHost(org2.OWNER.orgId, "busy-host");
    await seedNormalHistory(org2.OWNER.orgId, host2.id, now);
    expect((await rules.createAlertRule(db, org2.ADMIN, rule({ operator: "GT", threshold: 90 }))).ok).toBe(true);
    await ingest(org2.OWNER.orgId, host2.id, 65, now); // anomalous, but under 90 %
    expect(await db.incident.count({ where: { orgId: org2.OWNER.orgId } })).toBe(0);
    await ingest(org2.OWNER.orgId, host2.id, 95, new Date(now.getTime() + 60_000));
    expect(await db.incident.count({ where: { orgId: org2.OWNER.orgId } })).toBe(1);
  });

  it("RCA follows the dependency map, and re-analyzes earlier incidents when a new one opens", async () => {
    const org = await makeOrg("rca");
    const orgId = org.OWNER.orgId;
    const web = await makeHost(orgId, "web-01");
    const dbHost = await makeHost(orgId, "db-01");
    const webNode = await db.topologyNode.create({ data: { orgId, kind: "HOST", refId: web.id, label: "Web" } });
    const dbNode = await db.topologyNode.create({ data: { orgId, kind: "HOST", refId: dbHost.id, label: "Database" } });
    await db.serviceDependency.create({ data: { orgId, parentNodeId: webNode.id, childNodeId: dbNode.id } });
    expect((await rules.createAlertRule(db, org.ADMIN, rule({ anomalyDetection: false, operator: "GT", threshold: 90 }))).ok).toBe(true);

    const now = new Date();
    await ingest(orgId, web.id, 95, now); // web fails first: isolated for now
    const webIncident = await db.incident.findFirstOrThrow({ where: { orgId, sourceId: web.id } });
    expect(webIncident.rcaFindings).toMatchObject({ verdict: "isolated" });

    await ingest(orgId, dbHost.id, 97, new Date(now.getTime() + 30_000)); // then its database
    const dbIncident = await db.incident.findFirstOrThrow({ where: { orgId, sourceId: dbHost.id } });
    expect(dbIncident.rcaFindings).toMatchObject({ verdict: "root_cause", impacted: [{ label: "Web" }] });
    const reanalyzed = await db.incident.findUniqueOrThrow({ where: { id: webIncident.id }, include: { events: true } });
    expect(reanalyzed.rcaFindings).toMatchObject({ verdict: "symptom", rootCauses: [{ label: "Database" }] });
    expect(reanalyzed.rcaConfidence).toBe(0.8);
    expect(reanalyzed.events.filter((e) => e.type === "RCA_GENERATED")).toHaveLength(2);

    // Unchanged findings are not rewritten.
    expect(await rca.refreshIncidentRca(db, orgId, webIncident.id)).toBe(false);

    // Re-analyze: operators may, viewers may not, other organizations cannot see it.
    const outsider = await makeOrg("outsider");
    expect(await incidents.reanalyzeIncident(db, org.VIEWER, webIncident.id)).toEqual({ ok: false, error: "forbidden" });
    expect(await incidents.reanalyzeIncident(db, outsider.OWNER, webIncident.id)).toEqual({ ok: false, error: "not_found" });
    expect(await incidents.reanalyzeIncident(db, org.OPERATOR, webIncident.id)).toEqual({ ok: true, value: true });
    const listed = await incidents.listActiveIncidents(db, org.VIEWER);
    expect(listed.ok && listed.value.find((i) => i.id === webIncident.id)?.rca).toMatchObject({ confidence: 0.8, narrativePending: false, findings: { verdict: "symptom" } });
  });

  it("with Claude enabled, narratives are queued, settled, served once, and dropped when stale", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key-never-used");
    const org = await makeOrg("llm");
    const orgId = org.OWNER.orgId;
    const host = await makeHost(orgId, "cache-01");
    expect((await rules.createAlertRule(db, org.ADMIN, rule({ anomalyDetection: false, operator: "GT", threshold: 90 }))).ok).toBe(true);
    await ingest(orgId, host.id, 99, new Date());
    const inc = await db.incident.findFirstOrThrow({ where: { orgId } });
    expect(inc.rcaLlmRequestedAt).not.toBeNull();
    const scope = { orgIds: [orgId] };

    // Not settled yet: bursts of re-analysis coalesce before anything is sent.
    expect(await llm.claimNarrativeRequests(db, 5, scope)).toEqual([]);
    const settle = () => db.incident.update({ where: { id: inc.id }, data: { rcaLlmRequestedAt: new Date(Date.now() - llm.SETTLE_MS - 1000) } });
    await settle();

    const parse = vi.fn().mockResolvedValue({ stop_reason: "end_turn", parsed_output: { summaryEn: "Cache host CPU saturated.", summaryFr: "Le CPU de l'hôte de cache est saturé." } });
    const deps = { client: { beta: { messages: { parse } } } as never, model: "claude-opus-5" };

    const [claimed] = await llm.claimNarrativeRequests(db, 5, scope);
    expect(claimed).toMatchObject({ id: inc.id, rcaLlmAttempts: 1 });
    expect(await llm.claimNarrativeRequests(db, 5, scope)).toEqual([]); // leased: nobody else gets it
    expect(await llm.serveNarrative(db, claimed, deps)).toBe("stored");

    const stored = await db.incident.findUniqueOrThrow({ where: { id: inc.id }, include: { events: true } });
    expect(stored).toMatchObject({ rcaSummaryEn: "Cache host CPU saturated.", rcaSummaryFr: "Le CPU de l'hôte de cache est saturé.", rcaModel: `${rca.RCA_MODEL}+claude-opus-5`, rcaLlmRequestedAt: null, rcaLlmError: null });
    expect(stored.events.some((e) => e.type === "RCA_GENERATED" && (e.data as { narrative?: boolean }).narrative)).toBe(true);
    const sent = JSON.parse(parse.mock.calls[0][0].messages[0].content);
    expect(sent.incident).toMatchObject({ title: "CPU unusual", source: "cache-01", metric: "CPU_USAGE_PERCENT", triggerValue: 99 });
    expect(sent.findings.verdict).toBe("not_mapped");
    expect(sent.metricRecentWindow).toMatchObject({ points: 1, max: 99 });
    expect(JSON.stringify(sent)).not.toContain(host.keyId); // no credentials or internal identifiers

    // Findings change while a request is in flight → the (now stale) narrative is not stored.
    await incidents.reanalyzeIncident(db, org.OPERATOR, inc.id);
    await settle();
    const [again] = await llm.claimNarrativeRequests(db, 5, scope);
    await db.incident.update({ where: { id: inc.id }, data: { rcaGeneratedAt: new Date() } });
    expect(await llm.serveNarrative(db, again, deps)).toBe("stale");

    // API failure: recorded (no content), retried later, not immediately.
    await incidents.reanalyzeIncident(db, org.OPERATOR, inc.id);
    await settle();
    const [third] = await llm.claimNarrativeRequests(db, 5, scope);
    const failing = { client: { beta: { messages: { parse: vi.fn().mockRejectedValue(new TypeError("fetch failed")) } } } as never, model: "claude-opus-5" };
    expect(await llm.serveNarrative(db, third, failing)).toBe("failed");
    const failed = await db.incident.findUniqueOrThrow({ where: { id: inc.id } });
    expect(failed.rcaLlmError).toBe("TypeError");
    expect(failed.rcaLlmRequestedAt).not.toBeNull();
    expect(await llm.claimNarrativeRequests(db, 5, scope)).toEqual([]);
  });
});
