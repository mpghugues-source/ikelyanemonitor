/** SLA and certificate helpers for endpoint monitoring. Pure functions. */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days until a TLS certificate expires; negative once it has expired. */
export function sslDaysLeft(expiresAt: Date, now: Date): number {
  return Math.floor((expiresAt.getTime() - now.getTime()) / DAY_MS);
}

/** Availability in percent over a set of checks. No checks yet = no information, not "0 %". */
export function availabilityPercent(successfulChecks: number, totalChecks: number): number | null {
  if (totalChecks <= 0) return null;
  return (Math.min(successfulChecks, totalChecks) / totalChecks) * 100;
}

/** Allowed downtime, in minutes, for an SLA target over a window ("99.9 %" over 30 days ≈ 43.2 min). */
export function errorBudgetMinutes(slaTargetPercent: number, windowDays: number): number {
  const target = Math.min(100, Math.max(0, slaTargetPercent));
  return (1 - target / 100) * windowDays * 24 * 60;
}

/**
 * An SLA is judged over its whole period: breached once the downtime exceeds the error budget of the
 * window ("99.9 %" over 30 days = 43.2 min). Comparing the availability ratio instead would flag a
 * freshly added endpoint after a few failed checks, since its window only holds hours of data.
 */
export function isSlaBreached(downtimeMinutes: number, slaTargetPercent: number, windowDays: number): boolean {
  return downtimeMinutes > errorBudgetMinutes(slaTargetPercent, windowDays);
}
