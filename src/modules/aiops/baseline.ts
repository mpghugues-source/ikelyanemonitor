import type { PrismaClient } from "@/generated/prisma/client";
import type { MetricSource, MetricType } from "@/generated/prisma/enums";
import { type Baseline, baselineRanges, computeBaseline } from "@/modules/aiops/anomaly";

/**
 * Loads (and caches) the baseline of one series. A baseline is recomputed at most every
 * CACHE_TTL_MS per series and process: agents report every minute, and re-reading up to a week of
 * history on every ingested point would dominate the database load for no real gain in accuracy.
 */

const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 10_000;
/** Upper bound on points read per baseline (7 × 1 h seasonal + 6 h recent at 10 s resolution ≈ 5 000). */
const MAX_SAMPLE_POINTS = 6_000;

export interface SeriesKey {
  orgId: string;
  sourceKind: MetricSource;
  sourceId: string;
  metric: MetricType;
  instance: string;
}

const cache = new Map<string, { at: number; baseline: Baseline | null }>();

function cacheKey(series: SeriesKey, durationSec: number): string {
  return [series.sourceId, series.metric, series.instance, durationSec].join("\u0000");
}

/** Test helper. */
export function clearBaselineCache(): void {
  cache.clear();
}

export async function loadBaseline(db: PrismaClient, series: SeriesKey, durationSec: number, now: Date): Promise<Baseline | null> {
  const key = cacheKey(series, durationSec);
  const hit = cache.get(key);
  if (hit && now.getTime() - hit.at < CACHE_TTL_MS && now.getTime() >= hit.at) return hit.baseline;

  const ranges = baselineRanges(now, durationSec);
  const rows = await db.metricEntry.findMany({
    where: {
      orgId: series.orgId,
      sourceKind: series.sourceKind,
      sourceId: series.sourceId,
      metric: series.metric,
      instance: series.instance,
      OR: ranges.map((range) => ({ time: { gte: range.from, lt: range.to } })),
    },
    select: { value: true },
    take: MAX_SAMPLE_POINTS,
  });
  const baseline = computeBaseline(rows.map((row) => row.value));

  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { at: now.getTime(), baseline });
  return baseline;
}
