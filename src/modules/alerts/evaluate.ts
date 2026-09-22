import type { PrismaClient } from "@/generated/prisma/client";
import { AlertOperator, IncidentEventType, IncidentStatus } from "@/generated/prisma/enums";
import type { MetricRow } from "@/lib/telemetry/metrics";
import { AUTO_RESOLUTION_NOTE } from "@/modules/alerts/constants";
import { dispatchIncidentNotification, type NotifiableIncident, type NotifiableRule, type NotificationOutcome, shouldRenotify } from "@/modules/alerts/notify";
import { resolveSourceLabels } from "@/modules/alerts/resolve-source";

/** True when `value` breaches the rule's condition. Pure — see tests/alerts.test.ts. */
export function breaches(operator: AlertOperator, value: number, threshold: number): boolean {
  switch (operator) {
    case AlertOperator.GT:
      return value > threshold;
    case AlertOperator.GTE:
      return value >= threshold;
    case AlertOperator.LT:
      return value < threshold;
    case AlertOperator.LTE:
      return value <= threshold;
    case AlertOperator.EQ:
      return value === threshold;
    case AlertOperator.NEQ:
      return value !== threshold;
  }
}

export interface MetricPoint {
  time: Date;
  value: number;
}

/**
 * Walking backward from the newest sample, the timestamp of the oldest sample still inside an
 * unbroken breaching streak — or null if the newest sample does not breach at all.
 * `pointsDesc` must be ordered newest first.
 */
export function breachingSince(pointsDesc: readonly MetricPoint[], operator: AlertOperator, threshold: number): Date | null {
  let since: Date | null = null;
  for (const point of pointsDesc) {
    if (!breaches(operator, point.value, threshold)) break;
    since = point.time;
  }
  return since;
}

/** Has the breach lasted at least `durationSec` (the rule's flap-protection window) as of `now`? */
export function isSustained(since: Date | null, durationSec: number, now: Date): boolean {
  if (!since) return false;
  return now.getTime() - since.getTime() >= durationSec * 1000;
}

/** The "worst" of two values so far, given the direction implied by the operator. */
export function worstValue(operator: AlertOperator, a: number, b: number): number {
  if (operator === AlertOperator.GT || operator === AlertOperator.GTE) return Math.max(a, b);
  if (operator === AlertOperator.LT || operator === AlertOperator.LTE) return Math.min(a, b);
  return b;
}

/**
 * How far back to look for a breaching streak. Bounded rather than exactly `durationSec` of
 * history: a rule configured with a very long `durationSec` on a fast-polling source may then take
 * a little longer than strictly necessary to fire the first time — a safe trade-off against an
 * unbounded query. See AlertRule.durationSec doc comment (flap protection).
 */
const HISTORY_LOOKBACK_POINTS = 500;

/** process.env.APP_BASE_URL, trimmed — mirrors src/lib/auth/dal.ts's getBaseUrl() minus the request-header
 * fallback, which this module must not depend on: it can run outside of any request (a future
 * scheduled re-evaluation), not just from the telemetry route. */
function appUrl(): string | null {
  const configured = process.env.APP_BASE_URL?.trim().replace(/\/+$/, "");
  return configured || null;
}

/**
 * Dispatch (best-effort) and record a NOTIFIED event — but only when the rule actually has a
 * channel configured with a target, so silence isn't logged as a fake "notification sent". Never
 * throws: a bad webhook URL or unreachable SMTP must not stop evaluation of the other rules/points
 * in this batch (see the try/catch at each call site below).
 */
async function notify(db: PrismaClient, rule: NotifiableRule, incident: NotifiableIncident, outcome: NotificationOutcome): Promise<void> {
  const results = await dispatchIncidentNotification(rule, incident, outcome, { appUrl: appUrl() });
  if (results.length === 0) return;
  const data = { outcome, results: results.map((r) => ({ channel: r.channel, ok: r.ok, error: r.error ?? null })) };
  await db.incidentEvent.create({ data: { incidentId: incident.id, type: IncidentEventType.NOTIFIED, data } });
}

/**
 * Re-evaluate every enabled static-threshold rule against the metric points just stored by one
 * telemetry ingestion, opening/updating/auto-resolving incidents as needed, and dispatching
 * notifications (email/Slack/webhook — see src/modules/alerts/notify.ts) on open, on
 * auto-resolution, and again while an incident stays open once `cooldownSec` has elapsed since the
 * last one.
 *
 * Best-effort by design: called AFTER the ingestion transaction commits (see the route handler),
 * wrapped in try/catch there — a bug here must never make telemetry storage fail. AI anomaly
 * detection (`AlertRule.anomalyDetection`) is not implemented yet: rules only fire against a static
 * threshold. TEAMS/SMS/PUSH channels are configurable but not dispatched (see notify.ts).
 */
export async function evaluateIngestedMetrics(db: PrismaClient, orgId: string, rows: readonly MetricRow[], now: Date): Promise<void> {
  if (rows.length === 0) return;

  // One point per series: the latest value ingested for it (a batch can carry backfilled history).
  const latest = new Map<string, MetricRow>();
  for (const row of rows) {
    const key = `${row.sourceKind}\u0000${row.sourceId}\u0000${row.metric}\u0000${row.instance}`;
    const current = latest.get(key);
    if (!current || row.time > current.time) latest.set(key, row);
  }
  const points = [...latest.values()];

  const rules = await db.alertRule.findMany({
    where: {
      orgId,
      enabled: true,
      anomalyDetection: false,
      operator: { not: null },
      threshold: { not: null },
      sourceKind: { in: [...new Set(points.map((p) => p.sourceKind))] },
      metric: { in: [...new Set(points.map((p) => p.metric))] },
    },
  });
  if (rules.length === 0) return;

  for (const point of points) {
    const matching = rules.filter(
      (rule) =>
        rule.sourceKind === point.sourceKind &&
        rule.metric === point.metric &&
        (rule.sourceId === null || rule.sourceId === point.sourceId) &&
        (rule.instanceFilter === null || rule.instanceFilter === point.instance),
    );
    for (const rule of matching) {
      // Guaranteed non-null by the `findMany` where-clause above; Prisma's return type stays
      // nullable regardless, since it can't reflect a runtime filter.
      if (rule.operator === null || rule.threshold === null) continue;
      const operator = rule.operator;
      const threshold = rule.threshold;

      const history = await db.metricEntry.findMany({
        where: { orgId, sourceKind: point.sourceKind, sourceId: point.sourceId, metric: point.metric, instance: point.instance, time: { lte: now } },
        orderBy: { time: "desc" },
        take: HISTORY_LOOKBACK_POINTS,
        select: { time: true, value: true },
      });
      const sustained = isSustained(breachingSince(history, operator, threshold), rule.durationSec, now);

      // Known simplification: matched on (rule, source, metric) — NOT instance — because Incident
      // has no `instance` column. A wildcard rule (instanceFilter = null) that breaches on several
      // instances of the same source+metric at once shares one incident until ALL of them clear.
      const open = await db.incident.findFirst({
        where: { orgId, ruleId: rule.id, sourceId: point.sourceId, metric: point.metric, status: { not: IncidentStatus.RESOLVED } },
      });

      if (sustained && !open) {
        const labels = await resolveSourceLabels(db, orgId, point.sourceKind, [point.sourceId]);
        const incident = await db.incident.create({
          data: {
            orgId,
            ruleId: rule.id,
            title: rule.name,
            severity: rule.severity,
            status: IncidentStatus.OPEN,
            sourceKind: point.sourceKind,
            sourceId: point.sourceId,
            sourceLabel: labels.get(point.sourceId) ?? null,
            metric: point.metric,
            triggerValue: point.value,
            peakValue: point.value,
            startedAt: now,
          },
        });
        await db.incidentEvent.create({
          data: {
            incidentId: incident.id,
            type: IncidentEventType.OPENED,
            data: { operator, threshold, value: point.value, instance: point.instance },
          },
        });
        try {
          await notify(db, rule, incident, "opened");
        } catch (error) {
          console.error("[alerts] notification failed", error);
        }
      } else if (sustained && open) {
        const updated = await db.incident.update({
          where: { id: open.id },
          data: { triggerValue: point.value, peakValue: worstValue(operator, open.peakValue ?? point.value, point.value) },
        });
        const lastNotified = await db.incidentEvent.findFirst({ where: { incidentId: open.id, type: IncidentEventType.NOTIFIED }, orderBy: { createdAt: "desc" } });
        if (shouldRenotify(lastNotified?.createdAt ?? null, rule.cooldownSec, now)) {
          try {
            await notify(db, rule, updated, "still_open");
          } catch (error) {
            console.error("[alerts] notification failed", error);
          }
        }
      } else if (!sustained && open) {
        const resolved = await db.incident.update({
          where: { id: open.id },
          data: { status: IncidentStatus.RESOLVED, resolvedAt: now, resolvedBy: null, resolutionNote: AUTO_RESOLUTION_NOTE },
        });
        await db.incidentEvent.create({ data: { incidentId: open.id, type: IncidentEventType.RESOLVED, data: { auto: true } } });
        try {
          await notify(db, rule, resolved, "resolved");
        } catch (error) {
          console.error("[alerts] notification failed", error);
        }
      }
    }
  }
}
