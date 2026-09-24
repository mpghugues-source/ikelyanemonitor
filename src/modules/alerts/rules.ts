import type { PrismaClient } from "@/generated/prisma/client";
import type { AlertOperator, AnomalySensitivity, MetricSource, MetricType, NotificationChannel, Severity } from "@/generated/prisma/enums";
import { resolveSourceLabels, sourceExists } from "@/modules/alerts/resolve-source";
import { recordAudit } from "@/lib/auth/audit";
import type { Actor, Db } from "@/lib/auth/db";
import { can } from "@/lib/auth/permissions";
import { fail, ok, type Result } from "@/lib/result";

/**
 * Alert rules: a static threshold, AIOps anomaly detection, or both (both must then hold — see
 * conditionHolds in src/modules/alerts/evaluate.ts). Auto-remediation is configured in the schema but
 * not wired up yet.
 */
export interface AlertRuleRow {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  sourceKind: MetricSource;
  sourceId: string | null;
  sourceLabel: string | null;
  metric: MetricType;
  instanceFilter: string | null;
  /** null = no threshold (anomaly-only rule). */
  operator: AlertOperator | null;
  threshold: number | null;
  anomalyDetection: boolean;
  anomalySensitivity: AnomalySensitivity;
  durationSec: number;
  severity: Severity;
  channels: NotificationChannel[];
  notifyEmails: string[];
  webhookUrl: string | null;
  cooldownSec: number;
  remediationActionId: string | null;
  autoRemediate: boolean;
  createdAt: Date;
}

export async function listAlertRules(db: Db, actor: Actor): Promise<Result<AlertRuleRow[], "forbidden">> {
  if (!can(actor.role, "alerts:read")) return fail("forbidden");
  const rows = await db.alertRule.findMany({
    where: { orgId: actor.orgId },
    orderBy: { name: "asc" },
    select: {
      id: true, name: true, description: true, enabled: true, sourceKind: true, sourceId: true, metric: true,
      instanceFilter: true, operator: true, threshold: true, anomalyDetection: true, anomalySensitivity: true, durationSec: true, severity: true, channels: true,
      notifyEmails: true, webhookUrl: true, cooldownSec: true, remediationActionId: true, autoRemediate: true, createdAt: true,
    },
  });

  // Resolve source labels in one batch per (kind), not one query per row.
  const idsByKind = new Map<MetricSource, string[]>();
  for (const row of rows) {
    if (!row.sourceId) continue;
    idsByKind.set(row.sourceKind, [...(idsByKind.get(row.sourceKind) ?? []), row.sourceId]);
  }
  const labelsByKind = new Map<MetricSource, Map<string, string>>();
  for (const [kind, ids] of idsByKind) labelsByKind.set(kind, await resolveSourceLabels(db, actor.orgId, kind, ids));

  return ok(
    rows.map((row) => ({
      ...row,
      sourceLabel: row.sourceId ? (labelsByKind.get(row.sourceKind)?.get(row.sourceId) ?? null) : null,
    })),
  );
}

export interface AlertRuleInput {
  name: string;
  description: string | null;
  sourceKind: MetricSource;
  /** null = every source of that kind in the organization. */
  sourceId: string | null;
  metric: MetricType;
  instanceFilter: string | null;
  /** Set together, or both null for an anomaly-only rule. */
  operator: AlertOperator | null;
  threshold: number | null;
  anomalyDetection: boolean;
  anomalySensitivity: AnomalySensitivity;
  durationSec: number;
  severity: Severity;
  channels: NotificationChannel[];
  notifyEmails: string[];
  webhookUrl: string | null;
  cooldownSec: number;
  /** Remediation to queue (or suggest) when the rule opens an incident. */
  remediationActionId: string | null;
  /** Run it without a human — only if the action itself does not require approval. */
  autoRemediate: boolean;
}

export type AlertRuleWriteError = "forbidden" | "invalid_source" | "not_found" | "condition_required" | "invalid_remediation";

async function remediationInOrg(db: PrismaClient, orgId: string, id: string | null): Promise<boolean> {
  return !id || (await db.remediationAction.count({ where: { id, orgId } })) === 1;
}

/** A rule needs a complete threshold, anomaly detection, or both (mirrors the alert_rules CHECK constraint). */
function conditionError(input: AlertRuleInput): "condition_required" | null {
  const hasThreshold = input.operator !== null && input.threshold !== null && Number.isFinite(input.threshold);
  const halfThreshold = (input.operator === null) !== (input.threshold === null);
  return halfThreshold || (!hasThreshold && !input.anomalyDetection) ? "condition_required" : null;
}

export async function createAlertRule(db: PrismaClient, actor: Actor, input: AlertRuleInput): Promise<Result<{ id: string }, AlertRuleWriteError>> {
  if (!can(actor.role, "alerts:write")) return fail("forbidden");
  const invalid = conditionError(input);
  if (invalid) return fail(invalid);
  if (input.sourceId && !(await sourceExists(db, actor.orgId, input.sourceKind, input.sourceId))) return fail("invalid_source");
  if (!(await remediationInOrg(db, actor.orgId, input.remediationActionId))) return fail("invalid_remediation");

  return db.$transaction(async (tx) => {
    const rule = await tx.alertRule.create({ data: { orgId: actor.orgId, ...input }, select: { id: true } });
    await recordAudit(tx, {
      action: "alert_rule.created",
      orgId: actor.orgId,
      actorId: actor.userId,
      actorEmail: actor.email,
      targetType: "alert_rule",
      targetId: rule.id,
      ipAddress: actor.ip,
      metadata: { name: input.name, metric: input.metric },
    });
    return ok(rule);
  });
}

export async function updateAlertRule(db: PrismaClient, actor: Actor, id: string, input: AlertRuleInput): Promise<Result<true, AlertRuleWriteError>> {
  if (!can(actor.role, "alerts:write")) return fail("forbidden");
  const invalid = conditionError(input);
  if (invalid) return fail(invalid);
  if (input.sourceId && !(await sourceExists(db, actor.orgId, input.sourceKind, input.sourceId))) return fail("invalid_source");
  if (!(await remediationInOrg(db, actor.orgId, input.remediationActionId))) return fail("invalid_remediation");

  return db.$transaction(async (tx) => {
    const result = await tx.alertRule.updateMany({ where: { id, orgId: actor.orgId }, data: input });
    if (result.count !== 1) return fail("not_found");
    await recordAudit(tx, {
      action: "alert_rule.updated",
      orgId: actor.orgId,
      actorId: actor.userId,
      actorEmail: actor.email,
      targetType: "alert_rule",
      targetId: id,
      ipAddress: actor.ip,
      metadata: { name: input.name, metric: input.metric },
    });
    return ok(true as const);
  });
}

export async function setAlertRuleEnabled(db: PrismaClient, actor: Actor, id: string, enabled: boolean): Promise<Result<true, AlertRuleWriteError>> {
  if (!can(actor.role, "alerts:write")) return fail("forbidden");
  return db.$transaction(async (tx) => {
    const result = await tx.alertRule.updateMany({ where: { id, orgId: actor.orgId }, data: { enabled } });
    if (result.count !== 1) return fail("not_found");
    await recordAudit(tx, {
      action: enabled ? "alert_rule.enabled" : "alert_rule.disabled",
      orgId: actor.orgId,
      actorId: actor.userId,
      actorEmail: actor.email,
      targetType: "alert_rule",
      targetId: id,
      ipAddress: actor.ip,
    });
    return ok(true as const);
  });
}

export async function deleteAlertRule(db: PrismaClient, actor: Actor, id: string): Promise<Result<true, AlertRuleWriteError>> {
  if (!can(actor.role, "alerts:write")) return fail("forbidden");
  return db.$transaction(async (tx) => {
    const result = await tx.alertRule.deleteMany({ where: { id, orgId: actor.orgId } });
    if (result.count !== 1) return fail("not_found");
    await recordAudit(tx, {
      action: "alert_rule.deleted",
      orgId: actor.orgId,
      actorId: actor.userId,
      actorEmail: actor.email,
      targetType: "alert_rule",
      targetId: id,
      ipAddress: actor.ip,
    });
    return ok(true as const);
  });
}
