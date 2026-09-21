/**
 * GreenOps / FinOps estimation helpers. Pure functions: no I/O, easy to test and to reuse from
 * both the API and the UI.
 *
 * Inputs come from the schema: MonitoredHost.powerIdleWatts / powerMaxWatts / hourlyCost, and
 * Organization.powerUsageEffectiveness / carbonIntensityGco2PerKwh / energyPricePerKwh.
 */

/**
 * Estimated electrical draw of a server from its CPU utilization, using the standard linear model
 *   P(u) = P_idle + (P_max − P_idle) · u
 * It is an ESTIMATE (memory, disks and fans also matter); the UI must label it as such and prefer
 * measured watts (MetricType.POWER_WATTS from IPMI/RAPL/UPS) whenever they exist.
 */
export function estimatePowerWatts(cpuUtilizationPercent: number, idleWatts: number, maxWatts: number): number {
  const u = Math.min(100, Math.max(0, cpuUtilizationPercent)) / 100;
  const low = Math.min(idleWatts, maxWatts);
  const high = Math.max(idleWatts, maxWatts);
  return low + (high - low) * u;
}

/**
 * Facility-level energy in kWh: IT load × hours × PUE. PUE (≥ 1) accounts for cooling and power
 * distribution overhead of the data center (1.0 = none).
 */
export function energyKwh(averageWatts: number, hours: number, powerUsageEffectiveness = 1): number {
  return (Math.max(0, averageWatts) * Math.max(0, hours) * Math.max(1, powerUsageEffectiveness)) / 1000;
}

/** Carbon footprint in kg CO₂e for an amount of energy on a grid of the given intensity. */
export function carbonKgCo2e(kwh: number, gridIntensityGco2PerKwh: number): number {
  return (Math.max(0, kwh) * Math.max(0, gridIntensityGco2PerKwh)) / 1000;
}

/** Cost of an amount of energy, in the organization's currency. */
export function energyCost(kwh: number, pricePerKwh: number): number {
  return Math.max(0, kwh) * Math.max(0, pricePerKwh);
}

/**
 * Wastage of an under-used machine: the share of its cost that buys idle capacity above a target
 * utilization. Returns a value in [0, 1]; e.g. a machine averaging 10 % CPU with a 60 % target
 * wastes 1 − 10/60 ≈ 83 % of its capacity.
 */
export function wastedCapacityRatio(averageUtilizationPercent: number, targetUtilizationPercent = 60): number {
  const target = Math.max(1, Math.min(100, targetUtilizationPercent));
  const used = Math.max(0, Math.min(100, averageUtilizationPercent));
  return Math.max(0, 1 - used / target);
}
