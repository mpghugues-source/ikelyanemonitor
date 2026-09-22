import type { PrismaClient } from "@/generated/prisma/client";
import type { AlertOperator, MetricSource, MetricType, NotificationChannel, Severity } from "@/generated/prisma/enums";
import { resolveSourceLabels, sourceExists } from "@/modules/alerts/resolve-source";
import { recordAudit } from "@/lib/auth/audit";
import type { Actor, Db } from "@/lib/auth/db";
import { can } from "@/lib/auth/permissions";
import { fail, ok, type Result } from "@/lib/result";

/**
 * Static-threshold alert rules (`AlertRule.anomalyDetection = false`). AI anomaly detection and
 * auto-remediation are configured in the schema but not wired up yet — this module only manages
 * the threshold half, which is what `src/modules/alerts/evaluate.ts` acts on.
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
  operator: AlertOperator;
  threshold: number;
  durationSec: number;
  severity: Severity;
  channels: NotificationChannel[];
  notifyEmails: string[];
  webhookUrl: string | null;
  cooldownSec: number;
  createdAt: Date;
}

export async function listAlertRules(db: Db, actor: Actor): Promise<Result<AlertRuleRow[], "forbidden">> {
  if (!can(actor.role, "alerts:read")) return fail("forbidden");
  const rows = await db.alertRule.findMany({
    where: { orgId: actor.orgId },
    orderBy: { name: "asc" },
    select: {
      id: true, name: true, description: true, enabled: true, sourceKind: true, sourceId: true, metric: true,
      instanceFilter: true, operator: true, threshold: true, durationSec: true, severity: true, channels: true,
      notifyEmails: true, webhookUrl: true, cooldownSec: true, createdAt: true,
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
    rows.map(({ operator, threshold, ...row }) => ({
      ...row,
      // operator/threshold are always set together for a static-threshold rule (anomalyDetection=false is the
      // only kind this module creates); the DB columns are nullable to also support a future anomaly-only rule.
      operator: operator ?? "GT",
      threshold: threshold ?? 0,
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
  operator: AlertOperator;
  threshold: number;
  durationSec: number;
  severity: Severity;
  channels: NotificationChannel[];
  notifyEmails: string[];
  webhookUrl: string | null;
  cooldownSec: number;
}

export type AlertRuleWriteError = "forbidden" | "invalid_source" | "not_found";

export async function createAlertRule(db: PrismaClient, actor: Actor, input: AlertRuleInput): Promise<Result<{ id: string }, AlertRuleWriteError>> {
  if (!can(actor.role, "alerts:write")) return fail("forbidden");
  if (input.sourceId && !(await sourceExists(db, actor.orgId, input.sourceKind, input.sourceId))) return fail("invalid_source");

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
  if (input.sourceId && !(await sourceExists(db, actor.orgId, input.sourceKind, input.sourceId))) return fail("invalid_source");

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
