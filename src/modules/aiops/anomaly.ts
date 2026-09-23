import type { AnomalySensitivity } from "@/generated/prisma/enums";

/**
 * AIOps anomaly detection — pure statistics, no I/O (see baseline.ts for loading samples).
 *
 * A value is anomalous when it sits too many ROBUST standard deviations away from what is normal for
 * this series at this time of day. "Normal" is a sample made of:
 *   • the recent past (last 6 h, minus the stretch being evaluated so an ongoing anomaly cannot
 *     contaminate its own baseline), and
 *   • the same time of day (±30 min) on each of the previous 7 days — daily seasonality: a nightly
 *     backup that always spikes CPU at 02:00 is part of the baseline at 02:00.
 *
 * Median and MAD (median absolute deviation) rather than mean and standard deviation: one outage or
 * spike inside the baseline window barely moves them, so past incidents do not teach the detector
 * that failure is normal.
 */

export const RECENT_WINDOW_MS = 6 * 60 * 60 * 1000;
export const SEASONAL_DAYS = 7;
export const SEASONAL_HALF_WIDTH_MS = 30 * 60 * 1000;
/** Fewer points than this and the detector is still learning: it never flags anything. */
export const MIN_BASELINE_POINTS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;
/** MAD → standard deviation for normally distributed data. */
const MAD_TO_SIGMA = 1.4826;
/** A deviation smaller than 5 % of the typical level is never an anomaly, however flat the series. */
const RELATIVE_SCALE_FLOOR = 0.05;
const ABSOLUTE_SCALE_FLOOR = 1e-9;

/** Robust z-score beyond which a value is anomalous, per rule sensitivity. */
export const Z_THRESHOLD: Readonly<Record<AnomalySensitivity, number>> = { HIGH: 3, MEDIUM: 4.5, LOW: 6 };

export interface TimeRange {
  from: Date;
  /** Exclusive. */
  to: Date;
}

/**
 * The time ranges whose points form the baseline for an evaluation at `now` of a rule that needs
 * `durationSec` of sustained anomaly. The most recent `durationSec + 10 min` are excluded.
 */
export function baselineRanges(now: Date, durationSec: number): TimeRange[] {
  const t = now.getTime();
  const guard = durationSec * 1000 + 10 * 60 * 1000;
  const ranges: TimeRange[] = [{ from: new Date(t - RECENT_WINDOW_MS), to: new Date(t - guard) }];
  for (let day = 1; day <= SEASONAL_DAYS; day++) {
    const centre = t - day * DAY_MS;
    ranges.push({ from: new Date(centre - SEASONAL_HALF_WIDTH_MS), to: new Date(centre + SEASONAL_HALF_WIDTH_MS) });
  }
  return ranges.filter((range) => range.to > range.from);
}

export interface Baseline {
  median: number;
  /** Robust standard deviation (floored, see RELATIVE_SCALE_FLOOR). */
  scale: number;
  points: number;
}

function median(sorted: readonly number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Baseline of a sample, or null while there is not enough history ("learning"). */
export function computeBaseline(values: readonly number[]): Baseline | null {
  const finite = values.filter(Number.isFinite);
  if (finite.length < MIN_BASELINE_POINTS) return null;
  const sorted = [...finite].sort((a, b) => a - b);
  const med = median(sorted);
  const mad = median(sorted.map((v) => Math.abs(v - med)).sort((a, b) => a - b));
  const scale = Math.max(MAD_TO_SIGMA * mad, RELATIVE_SCALE_FLOOR * Math.abs(med), ABSOLUTE_SCALE_FLOOR);
  return { median: med, scale, points: finite.length };
}

export interface AnomalyVerdict {
  anomalous: boolean;
  /** Signed robust z-score: positive = above normal. */
  z: number;
  /** 0–1 severity of the deviation: 0.5 exactly at the sensitivity threshold, → 1 as it grows. */
  score: number;
}

export function assess(value: number, baseline: Baseline, sensitivity: AnomalySensitivity): AnomalyVerdict {
  const z = (value - baseline.median) / baseline.scale;
  const threshold = Z_THRESHOLD[sensitivity];
  const magnitude = Math.abs(z);
  return { anomalous: magnitude >= threshold, z, score: magnitude / (magnitude + threshold) };
}
