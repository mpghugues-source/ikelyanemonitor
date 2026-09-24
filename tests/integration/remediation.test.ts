import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { Role } from "@/generated/prisma/enums";
import type { Actor } from "@/lib/auth/db";

/**
 * Auto-remediation against a REAL PostgreSQL: RBAC, guard-rails, frozen script snapshots, approvals,
 * the alert trigger, the signed agent endpoints and the worker sweep.
 * Skipped unless DATABASE_URL and IKELYANE_SECRET_KEY are set.
 */
const enabled = Boolean(process.env.DATABASE_URL && process.env.IKELYANE_SECRET_KEY);

describe.skipIf(!enabled)("auto-remediation", () => {
  let db: PrismaClient;
  let actions: typeof import("@/modules/remediation/actions");
  let executions: typeof import("@/modules/remediation/executions");
  let rules: typeof import("@/modules/alerts/rules");
  let evaluate: typeof import("@/modules/alerts/evaluate");
  let crypto: typeof import("@/lib/crypto");
  let sig: typeof import("@/lib/telemetry/signature");
  let nextRoute: typeof import("@/app/api/v1/remediation/next/route");
  let resultRoute: typeof import("@/app/api/v1/remediation/result/route");

  const runId = randomBytes(4).toString("hex");
  const domain = `${runId}.test`;
  const orgIds: string[] = [];
  let counter = 0;
  const SCRIPT = "#!/usr/bin/env bash\nsystemctl restart nginx\n";

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

  /** A host with real credentials (for the signed routes) and the given agent-reported policy. */
  async function makeHost(orgId: string, name: string, mode: string | null, allowlist: string[] = []) {
    const { keyId, secret } = crypto.generateAgentCredentials();
    const host = await db.monitoredHost.create({
      data: { orgId, hostname: `${name}-${++counter}`, keyId, hmacSecretEnc: crypto.encryptSecret(secret, crypto.hostSecretAad(keyId)), osFamily: "LINUX", remediationMode: mode, remediationAllowlist: allowlist },
    });
    return { ...host, secret };
  }

  const actionInput = (overrides: Partial<Parameters<typeof actions.createRemediationAction>[2]> = {}): Parameters<typeof actions.createRemediationAction>[2] => ({
    name: `restart-${++counter}`, description: null, runtime: "BASH", scriptBody: SCRIPT, args: { SERVICE: "nginx" }, timeoutSec: 30,
    targetHostId: null, allowedOsFamilies: [], requiresApproval: true, cooldownSec: 0, maxRunsPerHour: 10, ...overrides,
  });

  async function createAction(actor: Actor, overrides: Parameters<typeof actionInput>[0] = {}): Promise<string> {
    const created = await actions.createRemediationAction(db, actor, actionInput(overrides));
    if (!created.ok) throw new Error(created.error);
    return created.value.id;
  }

  function signedGet(host: { keyId: string; secret: string }): Request {
    const ts = Math.floor(Date.now() / 1000);
    return new Request("http://localhost/api/v1/remediation/next", {
      headers: { [sig.KEY_ID_HEADER]: host.keyId, [sig.SIGNATURE_HEADER]: `t=${ts},v1=${sig.computeSignature(host.secret, ts, "")}` },
    });
  }

  function signedPost(host: { keyId: string; secret: string }, body: object): Request {
    const raw = JSON.stringify(body);
    const ts = Math.floor(Date.now() / 1000);
    return new Request("http://localhost/api/v1/remediation/result", {
      method: "POST",
      body: raw,
      headers: { "content-type": "application/json", [sig.KEY_ID_HEADER]: host.keyId, [sig.SIGNATURE_HEADER]: `t=${ts},v1=${sig.computeSignature(host.secret, ts, raw)}` },
    });
  }

  beforeAll(async () => {
    db = (await import("@/lib/prisma")).getPrisma();
    actions = await import("@/modules/remediation/actions");
    executions = await import("@/modules/remediation/executions");
    rules = await import("@/modules/alerts/rules");
    evaluate = await import("@/modules/alerts/evaluate");
    crypto = await import("@/lib/crypto");
    sig = await import("@/lib/telemetry/signature");
    nextRoute = await import("@/app/api/v1/remediation/next/route");
    resultRoute = await import("@/app/api/v1/remediation/result/route");
  });

  afterAll(async () => {
    if (!db) return;
    await db.metricEntry.deleteMany({ where: { orgId: { in: orgIds } } });
    await db.auditLog.deleteMany({ where: { orgId: { in: orgIds } } });
    await db.organization.deleteMany({ where: { id: { in: orgIds } } });
    await db.user.deleteMany({ where: { email: { endsWith: `@${domain}` } } });
  });

  it("only administrators write scripts; every change is audited with the script's SHA-256", async () => {
    const org = await makeOrg("rbac");
    expect(await actions.createRemediationAction(db, org.OPERATOR, actionInput())).toEqual({ ok: false, error: "forbidden" });
    expect(await actions.createRemediationAction(db, org.ADMIN, actionInput({ scriptBody: "   " }))).toEqual({ ok: false, error: "invalid_script" });
    expect(await actions.createRemediationAction(db, org.ADMIN, actionInput({ args: { "bad-name": "x" } }))).toEqual({ ok: false, error: "invalid_args" });
    const other = await makeOrg("other");
    const foreignHost = await makeHost(other.OWNER.orgId, "foreign", "any");
    expect(await actions.createRemediationAction(db, org.ADMIN, actionInput({ targetHostId: foreignHost.id }))).toEqual({ ok: false, error: "invalid_host" });

    const id = await createAction(org.ADMIN);
    const audit = await db.auditLog.findFirstOrThrow({ where: { orgId: org.OWNER.orgId, action: "remediation_action.created" } });
    expect((audit.metadata as { scriptSha256: string }).scriptSha256).toBe(actions.scriptSha256(SCRIPT));

    const listed = await actions.listRemediationActions(db, org.VIEWER);
    expect(listed.ok && listed.value[0]).toMatchObject({ id, scriptSha256: actions.scriptSha256(SCRIPT), args: { SERVICE: "nginx" } });
    expect(await executions.requestRun(db, org.VIEWER, id, null)).toEqual({ ok: false, error: "forbidden" });
    expect(await executions.requestRun(db, other.OWNER, id, null)).toEqual({ ok: false, error: "not_found" });
  });

  it("guard-rails: host consent, allowlist, OS, duplicates, cooldown, hourly limit", async () => {
    const org = await makeOrg("guard");
    const orgId = org.OWNER.orgId;
    const run = async (actionId: string, hostId: string) => {
      const r = await executions.requestRun(db, org.OPERATOR, actionId, hostId);
      if (!r.ok) throw new Error(r.error);
      return r.value;
    };

    const actionId = await createAction(org.ADMIN);
    expect(await run(actionId, (await makeHost(orgId, "old-agent", null)).id)).toMatchObject({ status: "SKIPPED", statusReason: "host_not_accepting" });
    expect(await run(actionId, (await makeHost(orgId, "no-consent", "disabled")).id)).toMatchObject({ status: "SKIPPED", statusReason: "host_not_accepting" });
    expect(await run(actionId, (await makeHost(orgId, "other-list", "allowlist", ["0".repeat(64)])).id)).toMatchObject({ status: "SKIPPED", statusReason: "not_in_allowlist" });
    expect(await run(actionId, (await makeHost(orgId, "listed", "allowlist", [actions.scriptSha256(SCRIPT)])).id)).toMatchObject({ status: "PENDING", statusReason: null });

    const windowsOnly = await createAction(org.ADMIN, { allowedOsFamilies: ["WINDOWS"] });
    expect(await run(windowsOnly, (await makeHost(orgId, "linux", "any")).id)).toMatchObject({ status: "SKIPPED", statusReason: "os_not_allowed" });

    const host = await makeHost(orgId, "busy", "any");
    const cooled = await createAction(org.ADMIN, { cooldownSec: 600, maxRunsPerHour: 2 });
    const first = await run(cooled, host.id);
    expect(first.status).toBe("PENDING");
    expect(await run(cooled, host.id)).toMatchObject({ status: "SKIPPED", statusReason: "already_queued" });
    await db.remediationExecution.update({ where: { id: first.id }, data: { status: "SUCCEEDED" } });
    expect(await run(cooled, host.id)).toMatchObject({ status: "SKIPPED", statusReason: "cooldown" });

    const limited = await createAction(org.ADMIN, { cooldownSec: 0, maxRunsPerHour: 2 });
    for (let i = 0; i < 2; i++) {
      const e = await run(limited, host.id);
      await db.remediationExecution.update({ where: { id: e.id }, data: { status: "FAILED" } });
    }
    expect(await run(limited, host.id)).toMatchObject({ status: "SKIPPED", statusReason: "rate_limited" });

    // Concurrent requests for the same action and host: exactly one gets queued.
    const racer = await createAction(org.ADMIN);
    const racerHost = await makeHost(orgId, "racer", "any");
    const outcomes = await Promise.all(Array.from({ length: 5 }, () => run(racer, racerHost.id)));
    expect(outcomes.filter((o) => o.status === "PENDING")).toHaveLength(1);
  });

  it("an execution runs the script as it was when queued; the signed endpoints deliver it once to its own host", async () => {
    const org = await makeOrg("flow");
    const host = await makeHost(org.OWNER.orgId, "web", "any");
    const intruder = await makeHost(org.OWNER.orgId, "intruder", "any");
    const actionId = await createAction(org.ADMIN, { requiresApproval: false });
    const queued = await executions.requestRun(db, org.OPERATOR, actionId, host.id);
    expect(queued.ok && queued.value.status).toBe("PENDING");

    // Edited after queuing: the queued run keeps the original script.
    await actions.updateRemediationAction(db, org.ADMIN, actionId, actionInput({ scriptBody: "echo edited\n" }));

    expect(await (await nextRoute.GET(signedGet(intruder))).json()).toEqual({ execution: null });
    const res = await nextRoute.GET(signedGet(host));
    const raw = await res.text();
    const header = res.headers.get(sig.SIGNATURE_HEADER) ?? "";
    // The response is signed with the host's secret over the exact body (what the agent verifies).
    const t = Number(/t=(\d+)/.exec(header)?.[1]);
    expect(header).toContain(`v1=${sig.computeSignature(host.secret, t, raw)}`);
    const { execution } = JSON.parse(raw);
    expect(execution).toMatchObject({ runtime: "bash", script: SCRIPT, sha256: actions.scriptSha256(SCRIPT), args: { SERVICE: "nginx" }, timeoutSec: 30 });
    expect(await (await nextRoute.GET(signedGet(host))).json()).toEqual({ execution: null }); // RUNNING now: not handed out twice

    // Only the host it was delivered to may report, once.
    const report = { executionId: execution.id, status: "succeeded", exitCode: 0, durationMs: 1234, stdout: "restarted\n" };
    expect((await resultRoute.POST(signedPost(intruder, report))).status).toBe(409);
    expect((await resultRoute.POST(signedPost(host, { ...report, status: "exploded" }))).status).toBe(422);
    expect((await resultRoute.POST(signedPost(host, report))).status).toBe(200);
    expect((await resultRoute.POST(signedPost(host, report))).status).toBe(409);
    const stored = await db.remediationExecution.findUniqueOrThrow({ where: { id: execution.id } });
    expect(stored).toMatchObject({ status: "SUCCEEDED", exitCode: 0, durationMs: 1234, stdout: "restarted\n" });
    expect(stored.finishedAt).not.toBeNull();

    // A wrong signature is refused before anything happens.
    const forged = signedGet({ keyId: host.keyId, secret: "not-the-secret" });
    expect((await nextRoute.GET(forged)).status).toBe(401);
  });

  it("an alert queues its remediation — automatically, or pending approval — and records it on the incident", async () => {
    const org = await makeOrg("alert");
    const orgId = org.OWNER.orgId;
    const host = await makeHost(orgId, "app", "any");
    const auto = await createAction(org.ADMIN, { requiresApproval: false });
    const guarded = await createAction(org.ADMIN, { requiresApproval: true });
    const base = {
      description: null, sourceKind: "HOST" as const, sourceId: host.id, instanceFilter: null, operator: "GT" as const, threshold: 90,
      anomalyDetection: false, anomalySensitivity: "MEDIUM" as const, durationSec: 0, severity: "CRITICAL" as const,
      channels: [], notifyEmails: [], webhookUrl: null, cooldownSec: 900,
    };
    expect((await rules.createAlertRule(db, org.ADMIN, { ...base, name: "cpu", metric: "CPU_USAGE_PERCENT", remediationActionId: auto, autoRemediate: true })).ok).toBe(true);
    expect((await rules.createAlertRule(db, org.ADMIN, { ...base, name: "mem", metric: "MEMORY_USED_PERCENT", remediationActionId: guarded, autoRemediate: true })).ok).toBe(true);
    const outsider = await makeOrg("outsider");
    const foreign = await createAction(outsider.ADMIN);
    expect(await rules.createAlertRule(db, org.ADMIN, { ...base, name: "x", metric: "CPU_USAGE_PERCENT", remediationActionId: foreign, autoRemediate: true })).toEqual({ ok: false, error: "invalid_remediation" });

    const now = new Date();
    const rows = (["CPU_USAGE_PERCENT", "MEMORY_USED_PERCENT"] as const).map((metric) => ({ time: now, orgId, sourceKind: "HOST" as const, sourceId: host.id, metric, instance: "", value: 99 }));
    await db.metricEntry.createMany({ data: rows });
    await evaluate.evaluateIngestedMetrics(db, orgId, rows, now);

    const queued = await db.remediationExecution.findMany({ where: { orgId }, include: { incident: { include: { events: true } } } });
    const byAction = new Map(queued.map((e) => [e.actionId, e]));
    expect(byAction.get(auto)).toMatchObject({ trigger: "ALERT", status: "PENDING", hostId: host.id });
    expect(byAction.get(guarded)).toMatchObject({ trigger: "ALERT", status: "AWAITING_APPROVAL" });
    expect(byAction.get(auto)?.incident?.events.some((e) => e.type === "REMEDIATION_STARTED")).toBe(true);

    // Approving re-checks the host: its owner has turned remediation off in the meantime.
    await db.monitoredHost.update({ where: { id: host.id }, data: { remediationMode: "disabled" } });
    const denied = await executions.approveExecution(db, org.OPERATOR, byAction.get(guarded)!.id);
    expect(denied).toMatchObject({ ok: true, value: { status: "SKIPPED", statusReason: "host_not_accepting" } });
    expect(await executions.approveExecution(db, org.OPERATOR, byAction.get(guarded)!.id)).toEqual({ ok: false, error: "invalid_status" });
    expect(await executions.cancelExecution(db, org.VIEWER, byAction.get(auto)!.id)).toEqual({ ok: false, error: "forbidden" });
    expect(await executions.cancelExecution(db, org.OPERATOR, byAction.get(auto)!.id)).toEqual({ ok: true, value: true });
  });

  it("the worker expires uncollected jobs and times out jobs an agent never reported", async () => {
    const org = await makeOrg("sweep");
    const host = await makeHost(org.OWNER.orgId, "gone", "any");
    const actionId = await createAction(org.ADMIN, { requiresApproval: false, timeoutSec: 10 });
    const a = await executions.requestRun(db, org.OPERATOR, actionId, host.id);
    const b = await executions.requestRun(db, org.OPERATOR, await createAction(org.ADMIN, { timeoutSec: 10 }), host.id);
    if (!a.ok || !b.ok) throw new Error("setup");
    const hourAgo = new Date(Date.now() - 2 * 3600_000);
    await db.remediationExecution.update({ where: { id: a.value.id }, data: { createdAt: hourAgo } });
    await db.remediationExecution.update({ where: { id: b.value.id }, data: { status: "RUNNING", startedAt: new Date(Date.now() - 5 * 60_000) } });

    expect(await executions.sweepExecutions(db)).toBeGreaterThanOrEqual(2);
    expect(await db.remediationExecution.findUniqueOrThrow({ where: { id: a.value.id } })).toMatchObject({ status: "CANCELLED", statusReason: "expired" });
    expect(await db.remediationExecution.findUniqueOrThrow({ where: { id: b.value.id } })).toMatchObject({ status: "TIMED_OUT", statusReason: "agent_lost" });
  });

  it("telemetry records the host's reported policy; an agent that reports none is treated as not accepting", async () => {
    const org = await makeOrg("policy");
    const host = await makeHost(org.OWNER.orgId, "reporting", "any");
    const { ingestTelemetry } = await import("@/lib/telemetry/ingest");
    const agent = { hostId: host.id, orgId: host.orgId, hostname: host.hostname, keyId: host.keyId, firstSeenAt: null, responseSecrets: [host.secret] };
    const ctx = { now: new Date(), maxBackfillMs: 7 * 86_400_000, maxSkewMs: 300_000 };
    const sha = "a".repeat(64);
    const system = { collectedAt: new Date().toISOString(), cpu: { usagePercent: 1 } };
    await ingestTelemetry(db, agent, { schemaVersion: 1, sentAt: new Date().toISOString(), agent: { version: "t", remediation: { mode: "allowlist", allowedSha256: [sha] } }, system } as never, ctx);
    expect(await db.monitoredHost.findUniqueOrThrow({ where: { id: host.id } })).toMatchObject({ remediationMode: "allowlist", remediationAllowlist: [sha] });
    await ingestTelemetry(db, agent, { schemaVersion: 1, sentAt: new Date().toISOString(), agent: { version: "old" }, system } as never, ctx);
    expect(await db.monitoredHost.findUniqueOrThrow({ where: { id: host.id } })).toMatchObject({ remediationMode: "disabled", remediationAllowlist: [] });
  });
});
