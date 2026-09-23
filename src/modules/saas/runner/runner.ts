import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { HealthStatus, MetricSource, MetricType } from "@/generated/prisma/enums";
import type { MetricRow } from "@/lib/telemetry/metrics";
import { evaluateIngestedMetrics } from "@/modules/alerts/evaluate";
import { probe, type ProbeOptions, type ProbeResult } from "@/modules/saas/runner/probe";
import { sslDaysLeft } from "@/modules/saas/sla";

/**
 * Synthetic check runner: claims due endpoint checks, probes them, stores the outcome (latest state on
 * the EndpointCheck row + ENDPOINT_* time series) and feeds the alert engine — the same path agent
 * telemetry takes, so rules on ENDPOINT_AVAILABLE / ENDPOINT_RESPONSE_MS / ENDPOINT_SSL_DAYS_LEFT
 * open and auto-resolve incidents like any other metric.
 *
 * Started by scripts/check-runner.ts as its own long-running process (not inside Next.js request
 * handling). Several runners may run at once: claiming is atomic (see claimDueChecks).
 */

/** Consecutive failures before an endpoint goes DOWN; the first failure only marks it DEGRADED. */
export const FAILURES_BEFORE_DOWN = 2;

export function nextHealth(passed: boolean, previousFailures: number): { status: HealthStatus; consecutiveFailures: number } {
  if (passed) return { status: HealthStatus.UP, consecutiveFailures: 0 };
  const consecutiveFailures = previousFailures + 1;
  return { status: consecutiveFailures >= FAILURES_BEFORE_DOWN ? HealthStatus.DOWN : HealthStatus.DEGRADED, consecutiveFailures };
}

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const MAX_HEADERS = 50;

/**
 * EndpointCheck.headers is free-form JSON: keep only well-formed name → string pairs (an invalid one
 * would make Node throw at request time and turn a configuration slip into a misleading "connection" error).
 */
export function sanitizeHeaders(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(value).slice(0, MAX_HEADERS)) {
    if (!HEADER_NAME.test(name) || typeof headerValue !== "string" || /[\r\n\0]/.test(headerValue)) continue;
    out[name.toLowerCase()] = headerValue;
  }
  return out;
}

export interface ClaimedCheck {
  id: string;
  orgId: string;
  url: string;
  method: string;
  headers: unknown;
  body: string | null;
  expectedStatus: number;
  expectedBodyContains: string | null;
  followRedirects: boolean;
  verifySsl: boolean;
  timeoutMs: number;
  consecutiveFailures: number;
}

/**
 * Atomically take up to `limit` due checks and push their next run one interval ahead. SKIP LOCKED
 * means concurrent runners each get a disjoint set, and a check claimed by one is not due again for
 * the others until its interval has elapsed — a runner that crashes mid-probe just loses that one run.
 * Timestamps are UTC `timestamp(3)` columns (Prisma's convention), hence `now() AT TIME ZONE 'UTC'`.
 */
export async function claimDueChecks(db: PrismaClient, limit: number, scope?: { orgIds: readonly string[] }): Promise<ClaimedCheck[]> {
  if (limit <= 0 || scope?.orgIds.length === 0) return [];
  // Optional restriction to some organizations (a runner dedicated to given tenants; test isolation).
  const orgFilter = scope ? Prisma.sql`AND "orgId" IN (${Prisma.join([...scope.orgIds])})` : Prisma.empty;
  return db.$queryRaw<ClaimedCheck[]>`
    UPDATE endpoint_checks AS e
       SET "nextRunAt" = (now() AT TIME ZONE 'UTC') + make_interval(secs => e."intervalSec")
      FROM (
        SELECT id FROM endpoint_checks
         WHERE enabled AND ("nextRunAt" IS NULL OR "nextRunAt" <= (now() AT TIME ZONE 'UTC')) ${orgFilter}
         ORDER BY "nextRunAt" ASC NULLS FIRST
         LIMIT ${limit}
         FOR UPDATE SKIP LOCKED
      ) AS due
     WHERE e.id = due.id
    RETURNING e.id, e."orgId", e.url, e.method::text AS method, e.headers, e.body, e."expectedStatus",
              e."expectedBodyContains", e."followRedirects", e."verifySsl", e."timeoutMs", e."consecutiveFailures"`;
}

/** The time-series points of one check result. */
export function resultMetricRows(orgId: string, endpointId: string, result: ProbeResult, now: Date): MetricRow[] {
  const base = { time: now, orgId, sourceKind: MetricSource.ENDPOINT, sourceId: endpointId, instance: "" };
  const rows: MetricRow[] = [{ ...base, metric: MetricType.ENDPOINT_AVAILABLE, value: result.passed ? 1 : 0 }];
  if (result.responseMs !== null) rows.push({ ...base, metric: MetricType.ENDPOINT_RESPONSE_MS, value: Math.round(result.responseMs * 10) / 10 });
  if (result.tls) rows.push({ ...base, metric: MetricType.ENDPOINT_SSL_DAYS_LEFT, value: sslDaysLeft(result.tls.validTo, now) });
  return rows;
}

/** Store one probe outcome. Returns false when the check was deleted while it was being probed. */
export async function recordResult(db: PrismaClient, check: ClaimedCheck, result: ProbeResult, now: Date): Promise<boolean> {
  const health = nextHealth(result.passed, check.consecutiveFailures);
  const updated = await db.endpointCheck.updateMany({
    where: { id: check.id, orgId: check.orgId },
    data: {
      status: health.status,
      consecutiveFailures: health.consecutiveFailures,
      lastCheckedAt: now,
      lastStatusCode: result.statusCode,
      lastResponseMs: result.responseMs,
      lastError: result.error,
      lastErrorDetail: result.errorDetail?.slice(0, 200) ?? null,
      // A failed handshake yields no certificate: keep the last one seen rather than erasing it.
      ...(result.tls ? { sslExpiresAt: result.tls.validTo, sslIssuer: result.tls.issuer?.slice(0, 200) ?? null } : {}),
    },
  });
  if (updated.count !== 1) return false;

  const rows = resultMetricRows(check.orgId, check.id, result, now);
  await db.metricEntry.createMany({ data: rows, skipDuplicates: true });

  // Best-effort, like telemetry ingestion: alerting problems must never lose the stored result.
  try {
    await evaluateIngestedMetrics(db, check.orgId, rows, now);
  } catch (error) {
    console.error("[checks] alert evaluation failed", error);
  }
  return true;
}

export async function runCheck(db: PrismaClient, check: ClaimedCheck, options: ProbeOptions): Promise<ProbeResult> {
  const result = await probe(
    {
      url: check.url,
      method: check.method,
      headers: sanitizeHeaders(check.headers),
      body: check.body,
      expectedStatus: check.expectedStatus,
      expectedBodyContains: check.expectedBodyContains,
      followRedirects: check.followRedirects,
      verifySsl: check.verifySsl,
      timeoutMs: check.timeoutMs,
    },
    options,
  );
  await recordResult(db, check, result, new Date());
  return result;
}

/** Claim and run every currently due check (up to `limit`), waiting for all of them. Used by tests. */
export async function runDueChecksOnce(db: PrismaClient, limit: number, options: ProbeOptions, scope?: { orgIds: readonly string[] }): Promise<number> {
  const claimed = await claimDueChecks(db, limit, scope);
  await Promise.all(claimed.map((check) => runCheck(db, check, options)));
  return claimed.length;
}

/** Resolve after `ms`, or as soon as `signal` aborts — without leaving a listener behind each tick. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

export interface RunnerLoopOptions extends ProbeOptions {
  concurrency: number;
  /** How often to look for due checks. */
  tickMs: number;
  signal: AbortSignal;
}

/**
 * Keep up to `concurrency` probes in flight until `signal` aborts, then wait for the in-flight ones to
 * finish (their results are stored) before returning.
 */
export async function runCheckLoop(db: PrismaClient, options: RunnerLoopOptions): Promise<void> {
  const inFlight = new Set<Promise<void>>();

  while (!options.signal.aborted) {
    try {
      const claimed = await claimDueChecks(db, options.concurrency - inFlight.size);
      for (const check of claimed) {
        const task: Promise<void> = runCheck(db, check, options)
          .then((result) => {
            if (!result.passed) console.warn(`[checks] ${check.id} failed: ${result.error}${result.errorDetail ? ` (${result.errorDetail})` : ""}`);
          })
          .catch((error) => console.error(`[checks] ${check.id}: could not store result`, error))
          .finally(() => inFlight.delete(task));
        inFlight.add(task);
      }
    } catch (error) {
      // Database briefly unreachable: keep the process alive and try again next tick.
      console.error("[checks] could not claim due checks", error);
    }
    await sleep(options.tickMs, options.signal);
  }

  await Promise.allSettled([...inFlight]);
}
