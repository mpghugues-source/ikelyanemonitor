import { describe, expect, it } from "vitest";
import { breaches, breachingSince, isSustained, type MetricPoint, worstValue } from "@/modules/alerts/evaluate";
import { formatBytes, formatDuration } from "@/lib/format";
import { carbonKgCo2e, energyCost, energyKwh, estimatePowerWatts, wastedCapacityRatio } from "@/modules/finops/energy";
import { blastRadius, dependenciesOf, rootCauseCandidates, type DependencyEdge } from "@/modules/topology/graph";
import { availabilityPercent, errorBudgetMinutes, isSlaBreached, sslDaysLeft } from "@/modules/saas/sla";

describe("formatBytes", () => {
  it("picks the largest unit under which the value is at least 1", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(2n * 1024n * 1024n * 1024n)).toBe("2.0 GB");
  });

  it("rejects negative or non-finite input", () => {
    expect(formatBytes(-1)).toBe("—");
    expect(formatBytes(Number.NaN)).toBe("—");
  });
});

describe("formatDuration", () => {
  it("picks the coarsest useful unit pair", () => {
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(150_000)).toBe("2m 30s");
    expect(formatDuration(2 * 3_600_000 + 15 * 60_000)).toBe("2h 15m");
    expect(formatDuration(3 * 86_400_000 + 4 * 3_600_000)).toBe("3d 4h");
    expect(formatDuration(0)).toBe("0s");
  });

  it("rejects negative or non-finite input", () => {
    expect(formatDuration(-1)).toBe("—");
    expect(formatDuration(Number.NaN)).toBe("—");
  });
});

describe("finops / greenops energy model", () => {
  it("interpolates power linearly between idle and max", () => {
    expect(estimatePowerWatts(0, 100, 300)).toBe(100);
    expect(estimatePowerWatts(100, 100, 300)).toBe(300);
    expect(estimatePowerWatts(50, 100, 300)).toBe(200);
  });

  it("clamps utilization and tolerates swapped bounds", () => {
    expect(estimatePowerWatts(250, 100, 300)).toBe(300);
    expect(estimatePowerWatts(-10, 100, 300)).toBe(100);
    expect(estimatePowerWatts(50, 300, 100)).toBe(200);
  });

  it("computes facility energy with PUE: 200 W for 24 h at PUE 1.5 = 7.2 kWh", () => {
    expect(energyKwh(200, 24, 1.5)).toBeCloseTo(7.2, 10);
    expect(energyKwh(200, 24)).toBeCloseTo(4.8, 10);
  });

  it("never lets a PUE below 1 reduce energy", () => {
    expect(energyKwh(1000, 1, 0.2)).toBe(1);
  });

  it("converts energy to carbon: 100 kWh on a 400 gCO2e/kWh grid = 40 kg", () => {
    expect(carbonKgCo2e(100, 400)).toBe(40);
    expect(carbonKgCo2e(100, 0)).toBe(0); // a fully decarbonized grid
  });

  it("prices energy", () => {
    expect(energyCost(100, 0.15)).toBeCloseTo(15, 10);
  });

  it("measures wasted capacity against a target utilization", () => {
    expect(wastedCapacityRatio(10, 60)).toBeCloseTo(1 - 10 / 60, 10);
    expect(wastedCapacityRatio(60, 60)).toBe(0);
    expect(wastedCapacityRatio(95, 60)).toBe(0); // above target: nothing wasted
    expect(wastedCapacityRatio(0, 60)).toBe(1);
  });
});

describe("topology graph (edge parent → child = 'parent depends on child')", () => {
  // web ──▶ api ──▶ db          web ──▶ cache
  // api ──▶ auth ──▶ db         batch ──▶ db
  const edges: DependencyEdge[] = [
    { parent: "web", child: "api" },
    { parent: "api", child: "db" },
    { parent: "api", child: "auth" },
    { parent: "auth", child: "db" },
    { parent: "web", child: "cache" },
    { parent: "batch", child: "db" },
  ];

  it("blast radius of a leaf is everything that depends on it, transitively", () => {
    expect(new Set(blastRadius(edges, "db"))).toEqual(new Set(["api", "auth", "web", "batch"]));
  });

  it("a failing top-level service impacts nobody", () => {
    expect(blastRadius(edges, "web")).toEqual([]);
  });

  it("lists upstream dependencies transitively", () => {
    expect(new Set(dependenciesOf(edges, "web"))).toEqual(new Set(["api", "cache", "db", "auth"]));
  });

  it("terminates on cycles", () => {
    const cyclic: DependencyEdge[] = [
      { parent: "a", child: "b" },
      { parent: "b", child: "a" },
    ];
    expect(blastRadius(cyclic, "a")).toEqual(["b"]);
    expect(dependenciesOf(cyclic, "a")).toEqual(["b"]);
  });

  it("tells root cause from symptoms: only db is a root cause when db, api and web are down", () => {
    expect(rootCauseCandidates(edges, new Set(["db", "api", "web"]))).toEqual(["db"]);
  });

  it("reports several independent root causes, biggest blast radius first", () => {
    // db (radius 4) and cache (radius 1) are both down: two unrelated causes.
    expect(rootCauseCandidates(edges, new Set(["db", "cache", "web"]))).toEqual(["db", "cache"]);
  });

  it("returns nothing when nothing is unhealthy", () => {
    expect(rootCauseCandidates(edges, new Set())).toEqual([]);
  });
});

describe("alert evaluation", () => {
  it("evaluates every operator", () => {
    expect(breaches("GT", 91, 90)).toBe(true);
    expect(breaches("GT", 90, 90)).toBe(false);
    expect(breaches("GTE", 90, 90)).toBe(true);
    expect(breaches("LT", 5, 10)).toBe(true);
    expect(breaches("LT", 10, 10)).toBe(false);
    expect(breaches("LTE", 10, 10)).toBe(true);
    expect(breaches("EQ", 1, 1)).toBe(true);
    expect(breaches("EQ", 1, 0)).toBe(false);
    expect(breaches("NEQ", 1, 0)).toBe(true);
  });

  const at = (secondsAgo: number, value: number, now: Date): MetricPoint => ({ time: new Date(now.getTime() - secondsAgo * 1000), value });

  it("finds the start of an unbroken breaching streak, newest first", () => {
    const now = new Date("2026-09-22T12:00:00Z");
    const pointsDesc = [at(0, 95, now), at(60, 92, now), at(120, 91, now), at(180, 80, now), at(240, 96, now)];
    // The streak breaks at t-180s (80 does not breach > 90): the streak "since" is t-120s.
    expect(breachingSince(pointsDesc, "GT", 90)).toEqual(new Date(now.getTime() - 120_000));
  });

  it("returns null when the newest sample does not breach", () => {
    const now = new Date("2026-09-22T12:00:00Z");
    expect(breachingSince([at(0, 50, now), at(60, 95, now)], "GT", 90)).toBeNull();
  });

  it("is not sustained until the streak covers the full duration", () => {
    const now = new Date("2026-09-22T12:00:00Z");
    const since = new Date(now.getTime() - 299_000);
    expect(isSustained(since, 300, now)).toBe(false);
    expect(isSustained(new Date(now.getTime() - 300_000), 300, now)).toBe(true);
    expect(isSustained(null, 300, now)).toBe(false);
  });

  it("tracks the worst value in the direction implied by the operator", () => {
    expect(worstValue("GT", 91, 95)).toBe(95);
    expect(worstValue("GTE", 95, 91)).toBe(95);
    expect(worstValue("LT", 10, 5)).toBe(5);
    expect(worstValue("LTE", 5, 10)).toBe(5);
    expect(worstValue("EQ", 1, 2)).toBe(2);
  });
});

describe("saas SLA helpers", () => {
  it("counts whole days until certificate expiry, negative when expired", () => {
    const now = new Date("2026-09-22T00:00:00Z");
    expect(sslDaysLeft(new Date("2026-10-22T00:00:00Z"), now)).toBe(30);
    expect(sslDaysLeft(new Date("2026-09-22T23:00:00Z"), now)).toBe(0);
    expect(sslDaysLeft(new Date("2026-09-20T00:00:00Z"), now)).toBe(-2);
  });

  it("computes availability, and returns null without data", () => {
    expect(availabilityPercent(999, 1000)).toBeCloseTo(99.9, 10);
    expect(availabilityPercent(0, 0)).toBeNull();
    expect(availabilityPercent(12, 10)).toBe(100);
  });

  it("derives the error budget: 99.9 % over 30 days = 43.2 minutes", () => {
    expect(errorBudgetMinutes(99.9, 30)).toBeCloseTo(43.2, 8);
    expect(errorBudgetMinutes(100, 30)).toBe(0);
  });

  it("flags an SLA breach only when there is data below target", () => {
    expect(isSlaBreached(99.5, 99.9)).toBe(true);
    expect(isSlaBreached(99.95, 99.9)).toBe(false);
    expect(isSlaBreached(null, 99.9)).toBe(false);
  });
});
