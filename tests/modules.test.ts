import { describe, expect, it } from "vitest";
import { carbonKgCo2e, energyCost, energyKwh, estimatePowerWatts, wastedCapacityRatio } from "@/modules/finops/energy";
import { blastRadius, dependenciesOf, rootCauseCandidates, type DependencyEdge } from "@/modules/topology/graph";
import { availabilityPercent, errorBudgetMinutes, isSlaBreached, sslDaysLeft } from "@/modules/saas/sla";

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
