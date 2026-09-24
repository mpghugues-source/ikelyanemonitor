import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { ExecutionStatus, ExecutionTrigger, IncidentEventType, MetricSource, type ScriptRuntime } from "@/generated/prisma/enums";
import { recordAudit } from "@/lib/auth/audit";
import type { Actor, Db } from "@/lib/auth/db";
import { can } from "@/lib/auth/permissions";
import { fail, ok, type Result } from "@/lib/result";
import { readArgs, scriptSha256 } from "@/modules/remediation/actions";
import { LIVE_STATUSES, MAX_OUTPUT_BYTES, type StatusReason } from "@/modules/remediation/constants";
import { guardrailViolation } from "@/modules/remediation/guard";

/**
 * Execution lifecycle:
 *
 *   (manual run / alert) ─► guard-rails ─► SKIPPED(reason)
 *                                     └──► AWAITING_APPROVAL ─approve─► PENDING ─agent picks up─► RUNNING ─► SUCCEEDED | FAILED | TIMED_OUT | SKIPPED
 *                                     └──► PENDING (no approval needed)          └─cancel─► CANCELLED
 *
 * The script, runtime, arguments and timeout are COPIED into the execution when it is created: an
 * approval approves exactly what will run, and editing the action later never changes a queued run.
 * The worker (sweepExecutions) expires what nobody picked up and times out what an agent never reported.
 */

/** A delivered execution with no result after its timeout plus this grace is declared lost. */
const RESULT_GRACE_MS = 2 * 60 * 1000;
/** Queued executions no agent collected are cancelled after this long (the host is probably offline). */
const PENDING_TTL_MS = 60 * 60 * 1000;
const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

export interface ExecutionRow {
  id: string;
  actionId: string;
  actionName: string;
  incidentId: string | null;
  hostId: string | null;
  hostLabel: string | null;
  trigger: ExecutionTrigger;
  status: ExecutionStatus;
  statusReason: string | null;
  runtime: ScriptRuntime;
  scriptBody: string;
  scriptSha256: string;
  requestedByEmail: string | null;
  approvedByEmail: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  durationMs: number | null;
  exitCode: number | null;
  stdout: string | null;
  stderr: string | null;
}

export async function listExecutions(db: Db, actor: Actor, filter: { actionId?: string; incidentId?: string; limit?: number } = {}): Promise<Result<ExecutionRow[], "forbidden">> {
  if (!can(actor.role, "remediation:read")) return fail("forbidden");
  const rows = await db.remediationExecution.findMany({
    where: { orgId: actor.orgId, ...(filter.actionId ? { actionId: filter.actionId } : {}), ...(filter.incidentId ? { incidentId: filter.incidentId } : {}) },
    orderBy: { createdAt: "desc" },
    take: Math.min(filter.limit ?? 50, 200),
    include: { action: { select: { name: true } }, host: { select: { hostname: true, displayName: true } } },
  });
  const userIds = [...new Set(rows.flatMap((r) => [r.requestedBy, r.approvedBy]).filter((id): id is string => Boolean(id)))];
  const users = userIds.length ? await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true } }) : [];
  const email = new Map(users.map((u) => [u.id, u.email]));
  return ok(
    rows.map((r) => ({
      id: r.id, actionId: r.actionId, actionName: r.action.name, incidentId: r.incidentId, hostId: r.hostId,
      hostLabel: r.host ? (r.host.displayName ?? r.host.hostname) : null, trigger: r.trigger, status: r.status, statusReason: r.statusReason,
      runtime: r.runtime, scriptBody: r.scriptBody, scriptSha256: r.scriptSha256,
      requestedByEmail: r.requestedBy ? (email.get(r.requestedBy) ?? null) : null, approvedByEmail: r.approvedBy ? (email.get(r.approvedBy) ?? null) : null,
      createdAt: r.createdAt, startedAt: r.startedAt, finishedAt: r.finishedAt, durationMs: r.durationMs, exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr,
    })),
  );
}

interface CreateInput {
  orgId: string;
  actionId: string;
  hostId: string | null;
  trigger: ExecutionTrigger;
  incidentId: string | null;
  requestedBy: string | null;
  needsApproval: boolean;
}

export interface CreatedExecution {
  id: string;
  status: ExecutionStatus;
  statusReason: StatusReason | null;
}

/**
 * Create one execution after checking the guard-rails, serialized per (action, host) with an advisory
 * lock so two simultaneous triggers cannot both slip under a cooldown or rate limit.
 * Returns null when the action does not exist in this organization.
 */
export async function createExecution(db: PrismaClient, input: CreateInput, now = new Date()): Promise<CreatedExecution | null> {
  return db.$transaction(async (tx) => {
    const action = await tx.remediationAction.findFirst({ where: { id: input.actionId, orgId: input.orgId } });
    if (!action) return null;
    const sha = scriptSha256(action.scriptBody);
    const snapshot = { runtime: action.runtime, scriptBody: action.scriptBody, scriptSha256: sha, args: readArgs(action.args), timeoutSec: action.timeoutSec };
    const base = { orgId: input.orgId, actionId: action.id, incidentId: input.incidentId, trigger: input.trigger, requestedBy: input.requestedBy, ...snapshot };

    const hostId = input.hostId ?? action.targetHostId;
    const host = hostId ? await tx.monitoredHost.findFirst({ where: { id: hostId, orgId: input.orgId } }) : null;
    if (!host) {
      const skipped = await tx.remediationExecution.create({ data: { ...base, hostId: null, status: ExecutionStatus.SKIPPED, statusReason: "no_target_host", finishedAt: now } });
      return { id: skipped.id, status: skipped.status, statusReason: "no_target_host" as const };
    }

    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`remediation:${action.id}:${host.id}`}))`;
    const recent = await tx.remediationExecution.findMany({
      where: { actionId: action.id, hostId: host.id, OR: [{ createdAt: { gte: new Date(now.getTime() - Math.max(3600, action.cooldownSec) * 1000) } }, { status: { in: [...LIVE_STATUSES] } }] },
      select: { status: true, createdAt: true },
    });
    const violation = guardrailViolation(action, host, sha, recent, now);
    const status = violation ? ExecutionStatus.SKIPPED : input.needsApproval ? ExecutionStatus.AWAITING_APPROVAL : ExecutionStatus.PENDING;
    const execution = await tx.remediationExecution.create({
      data: { ...base, hostId: host.id, status, statusReason: violation, ...(violation ? { finishedAt: now } : {}) },
    });
    return { id: execution.id, status, statusReason: violation };
  });
}

export type ExecutionWriteError = "forbidden" | "not_found" | "invalid_status";

/** "Run now" by a person: counts as the human decision, so no separate approval is required. */
export async function requestRun(db: PrismaClient, actor: Actor, actionId: string, hostId: string | null): Promise<Result<CreatedExecution, ExecutionWriteError>> {
  if (!can(actor.role, "remediation:run")) return fail("forbidden");
  const created = await createExecution(db, { orgId: actor.orgId, actionId, hostId, trigger: ExecutionTrigger.MANUAL, incidentId: null, requestedBy: actor.userId, needsApproval: false });
  if (!created) return fail("not_found");
  await recordAudit(db, {
    action: "remediation.run_requested", orgId: actor.orgId, actorId: actor.userId, actorEmail: actor.email,
    targetType: "remediation_execution", targetId: created.id, ipAddress: actor.ip,
    metadata: { actionId, hostId, status: created.status, reason: created.statusReason },
  });
  return ok(created);
}

/** Approve an alert-triggered execution. Guard-rails on the host are re-checked: its policy may have changed. */
export async function approveExecution(db: PrismaClient, actor: Actor, id: string, now = new Date()): Promise<Result<CreatedExecution, ExecutionWriteError>> {
  if (!can(actor.role, "remediation:run")) return fail("forbidden");
  const execution = await db.remediationExecution.findFirst({ where: { id, orgId: actor.orgId }, include: { host: true, action: true } });
  if (!execution) return fail("not_found");
  if (execution.status !== ExecutionStatus.AWAITING_APPROVAL) return fail("invalid_status");

  // Same checks as at creation, minus "already queued / cooldown" which this very execution would trip.
  const violation = execution.host ? guardrailViolation({ ...execution.action, cooldownSec: 0, maxRunsPerHour: 1_000 }, execution.host, execution.scriptSha256, [], now) : "no_target_host";
  const status = violation ? ExecutionStatus.SKIPPED : ExecutionStatus.PENDING;
  const updated = await db.remediationExecution.updateMany({
    where: { id, status: ExecutionStatus.AWAITING_APPROVAL },
    data: { status, statusReason: violation, approvedBy: actor.userId, ...(violation ? { finishedAt: now } : {}) },
  });
  if (updated.count !== 1) return fail("invalid_status");
  await recordAudit(db, {
    action: "remediation.approved", orgId: actor.orgId, actorId: actor.userId, actorEmail: actor.email,
    targetType: "remediation_execution", targetId: id, ipAddress: actor.ip, metadata: { scriptSha256: execution.scriptSha256, status, reason: violation },
  });
  return ok({ id, status, statusReason: violation });
}

export async function cancelExecution(db: PrismaClient, actor: Actor, id: string, now = new Date()): Promise<Result<true, ExecutionWriteError>> {
  if (!can(actor.role, "remediation:run")) return fail("forbidden");
  const updated = await db.remediationExecution.updateMany({
    where: { id, orgId: actor.orgId, status: { in: [ExecutionStatus.AWAITING_APPROVAL, ExecutionStatus.PENDING] } },
    data: { status: ExecutionStatus.CANCELLED, statusReason: "cancelled", finishedAt: now },
  });
  if (updated.count !== 1) {
    return (await db.remediationExecution.count({ where: { id, orgId: actor.orgId } })) === 1 ? fail("invalid_status") : fail("not_found");
  }
  await recordAudit(db, {
    action: "remediation.cancelled", orgId: actor.orgId, actorId: actor.userId, actorEmail: actor.email,
    targetType: "remediation_execution", targetId: id, ipAddress: actor.ip,
  });
  return ok(true as const);
}

// ── Alert trigger ────────────────────────────────────────────────────────────────────────────

/**
 * When a rule with a remediation action opens an incident: queue it on the action's target host, or
 * on the incident's own host. It runs without a human only if the rule says "run automatically" AND
 * the action does not require approval; otherwise it waits in AWAITING_APPROVAL (a suggestion).
 */
export async function triggerForIncident(
  db: PrismaClient,
  rule: { orgId: string; remediationActionId: string | null; autoRemediate: boolean },
  incident: { id: string; sourceKind: MetricSource | null; sourceId: string | null },
  now = new Date(),
): Promise<CreatedExecution | null> {
  if (!rule.remediationActionId) return null;
  const action = await db.remediationAction.findFirst({ where: { id: rule.remediationActionId, orgId: rule.orgId }, select: { requiresApproval: true } });
  if (!action) return null;
  const incidentHost = incident.sourceKind === MetricSource.HOST ? incident.sourceId : null;
  const created = await createExecution(
    db,
    {
      orgId: rule.orgId, actionId: rule.remediationActionId, hostId: incidentHost, trigger: ExecutionTrigger.ALERT,
      incidentId: incident.id, requestedBy: null, needsApproval: !rule.autoRemediate || action.requiresApproval,
    },
    now,
  );
  if (created) {
    await db.incidentEvent.create({
      data: { incidentId: incident.id, type: IncidentEventType.REMEDIATION_STARTED, data: { executionId: created.id, status: created.status, reason: created.statusReason } },
    });
  }
  return created;
}

// ── Agent side (called from /api/v1/remediation/*, authenticated as the host) ──────────────────

export interface DeliveredExecution {
  id: string;
  runtime: ScriptRuntime;
  script: string;
  sha256: string;
  args: Record<string, string>;
  timeoutSec: number;
  incidentId: string | null;
}

/** Hand the oldest PENDING execution of this host to its agent, marking it RUNNING (compare-and-set). */
export async function claimNextExecution(db: PrismaClient, orgId: string, hostId: string, now = new Date()): Promise<DeliveredExecution | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const next = await db.remediationExecution.findFirst({ where: { orgId, hostId, status: ExecutionStatus.PENDING }, orderBy: { createdAt: "asc" } });
    if (!next) return null;
    const won = await db.remediationExecution.updateMany({ where: { id: next.id, status: ExecutionStatus.PENDING }, data: { status: ExecutionStatus.RUNNING, startedAt: now } });
    if (won.count !== 1) continue;
    return { id: next.id, runtime: next.runtime, script: next.scriptBody, sha256: next.scriptSha256, args: readArgs(next.args), timeoutSec: next.timeoutSec, incidentId: next.incidentId };
  }
  return null;
}

export interface ExecutionResultInput {
  executionId: string;
  status: "succeeded" | "failed" | "timed_out" | "skipped";
  reason?: StatusReason | null;
  exitCode?: number | null;
  durationMs?: number | null;
  stdout?: string;
  stderr?: string;
}

/** Keep at most MAX_OUTPUT_BYTES of UTF-8, cut on a character boundary. */
export function truncateOutput(text: string | undefined): string | null {
  if (!text) return null;
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= MAX_OUTPUT_BYTES) return text;
  return bytes.subarray(0, MAX_OUTPUT_BYTES).toString("utf8").replace(/�$/, "");
}

const RESULT_STATUS = { succeeded: ExecutionStatus.SUCCEEDED, failed: ExecutionStatus.FAILED, timed_out: ExecutionStatus.TIMED_OUT, skipped: ExecutionStatus.SKIPPED } as const;

/** Store an agent's result. Only the host the execution was delivered to may report it, once. */
export async function recordExecutionResult(db: PrismaClient, orgId: string, hostId: string, input: ExecutionResultInput, now = new Date()): Promise<"stored" | "not_found"> {
  const status = RESULT_STATUS[input.status];
  const updated = await db.remediationExecution.updateMany({
    where: { id: input.executionId, orgId, hostId, status: ExecutionStatus.RUNNING },
    data: {
      status,
      statusReason: input.reason ?? null,
      exitCode: input.exitCode ?? null,
      durationMs: input.durationMs ?? null,
      stdout: truncateOutput(input.stdout),
      stderr: truncateOutput(input.stderr),
      finishedAt: now,
    },
  });
  if (updated.count !== 1) return "not_found";
  const execution = await db.remediationExecution.findUnique({ where: { id: input.executionId }, select: { incidentId: true } });
  if (execution?.incidentId) {
    await db.incidentEvent.create({
      data: { incidentId: execution.incidentId, type: IncidentEventType.REMEDIATION_FINISHED, data: { executionId: input.executionId, status, exitCode: input.exitCode ?? null, reason: input.reason ?? null } as Prisma.InputJsonValue },
    });
  }
  return "stored";
}

/** Worker housekeeping: expire what was never collected or approved, time out what was never reported. */
export async function sweepExecutions(db: PrismaClient, now = new Date()): Promise<number> {
  const t = now.getTime();
  const expiredPending = await db.remediationExecution.updateMany({
    where: { status: ExecutionStatus.PENDING, createdAt: { lt: new Date(t - PENDING_TTL_MS) } },
    data: { status: ExecutionStatus.CANCELLED, statusReason: "expired", finishedAt: now },
  });
  const expiredApproval = await db.remediationExecution.updateMany({
    where: { status: ExecutionStatus.AWAITING_APPROVAL, createdAt: { lt: new Date(t - APPROVAL_TTL_MS) } },
    data: { status: ExecutionStatus.CANCELLED, statusReason: "expired", finishedAt: now },
  });
  // Columns are UTC timestamp(3) without time zone (Prisma's convention): convert the parameter explicitly
  // rather than depend on the session's TimeZone setting.
  const nowUtc = now.toISOString();
  const lost = await db.$executeRaw`
    UPDATE remediation_executions
       SET status = 'TIMED_OUT', "statusReason" = 'agent_lost', "finishedAt" = (${nowUtc}::timestamptz AT TIME ZONE 'UTC')
     WHERE status = 'RUNNING'
       AND "startedAt" + make_interval(secs => "timeoutSec" + ${RESULT_GRACE_MS / 1000}) < (${nowUtc}::timestamptz AT TIME ZONE 'UTC')`;
  return expiredPending.count + expiredApproval.count + lost;
}
