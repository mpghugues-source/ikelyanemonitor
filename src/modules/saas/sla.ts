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

export function isSlaBreached(availability: number | null, slaTargetPercent: number): boolean {
  return availability !== null && availability < slaTargetPercent;
}
