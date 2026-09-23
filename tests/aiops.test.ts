import { describe, expect, it, vi } from "vitest";
import { assess, baselineRanges, computeBaseline, MIN_BASELINE_POINTS, SEASONAL_DAYS, Z_THRESHOLD } from "@/modules/aiops/anomaly";
import { analyzeIncident, type RcaIncident, type RcaTopology } from "@/modules/aiops/rca";
import { requestNarrative, type NarrativeDeps } from "@/modules/aiops/rca-llm";
import { conditionHolds, streakSince } from "@/modules/alerts/evaluate";

const around = (centre: number, spread: number, n: number) => Array.from({ length: n }, (_, i) => centre + ((i % 5) - 2) * (spread / 2));

describe("baselineRanges", () => {
  const now = new Date("2026-09-23T14:00:00Z");
  it("covers the recent 6 h minus the evaluated stretch, and ±30 min at this time of day on each of the last 7 days", () => {
    const ranges = baselineRanges(now, 300);
    expect(ranges).toHaveLength(1 + SEASONAL_DAYS);
    expect(ranges[0]).toEqual({ from: new Date("2026-09-23T08:00:00Z"), to: new Date("2026-09-23T13:45:00Z") }); // 300 s + 10 min guard
    expect(ranges[1]).toEqual({ from: new Date("2026-09-22T13:30:00Z"), to: new Date("2026-09-22T14:30:00Z") });
    expect(ranges[7]).toEqual({ from: new Date("2026-09-16T13:30:00Z"), to: new Date("2026-09-16T14:30:00Z") });
  });
  it("drops the recent range when the rule's duration swallows it", () => {
    expect(baselineRanges(now, 6 * 3600)).toHaveLength(SEASONAL_DAYS);
  });
});

describe("computeBaseline", () => {
  it("is still learning below the minimum number of points", () => {
    expect(computeBaseline(around(20, 2, MIN_BASELINE_POINTS - 1))).toBeNull();
    expect(computeBaseline(around(20, 2, MIN_BASELINE_POINTS))).not.toBeNull();
  });

  it("is robust: a past outage inside the window barely moves it", () => {
    const clean = computeBaseline(around(20, 2, 100));
    const withOutage = computeBaseline([...around(20, 2, 95), 100, 100, 100, 100, 100]);
    expect(clean?.median).toBe(20);
    expect(withOutage?.median).toBe(20);
    expect(Math.abs((withOutage?.scale ?? 0) - (clean?.scale ?? 0))).toBeLessThan(0.5);
  });

  it("floors the scale so a perfectly flat series is not hypersensitive", () => {
    const flat = computeBaseline(new Array(50).fill(40));
    expect(flat?.scale).toBeCloseTo(2); // 5 % of 40
    expect(assess(41, flat!, "HIGH").anomalous).toBe(false);
    expect(assess(60, flat!, "MEDIUM").anomalous).toBe(true);
  });

  it("treats any departure from an always-zero series as anomalous (e.g. deadlocks)", () => {
    const zeros = computeBaseline(new Array(50).fill(0));
    expect(assess(1, zeros!, "LOW").anomalous).toBe(true);
    expect(assess(0, zeros!, "HIGH").anomalous).toBe(false);
  });
});

describe("assess", () => {
  const baseline = { median: 100, scale: 10, points: 100 };
  it("uses the sensitivity's robust z threshold, in both directions", () => {
    expect(assess(100 + Z_THRESHOLD.HIGH * 10, baseline, "HIGH").anomalous).toBe(true);
    expect(assess(100 + Z_THRESHOLD.HIGH * 10, baseline, "MEDIUM").anomalous).toBe(false);
    expect(assess(100 - 70, baseline, "LOW").anomalous).toBe(true);
    expect(assess(100 - 70, baseline, "LOW").z).toBe(-7);
  });
  it("scores 0.5 at the threshold, rising towards 1", () => {
    expect(assess(145, baseline, "MEDIUM").score).toBeCloseTo(0.5);
    expect(assess(100, baseline, "MEDIUM").score).toBe(0);
    expect(assess(1000, baseline, "MEDIUM").score).toBeGreaterThan(0.9);
  });
});

describe("conditionHolds", () => {
  const baseline = { median: 20, scale: 2, points: 100 };
  const threshold = { operator: "GT" as const, value: 90 };
  const anomaly = { baseline, sensitivity: "MEDIUM" as const };

  it("threshold only / anomaly only", () => {
    expect(conditionHolds({ threshold, anomaly: null }, 95)).toBe(true);
    expect(conditionHolds({ threshold, anomaly: null }, 50)).toBe(false);
    expect(conditionHolds({ threshold: null, anomaly }, 50)).toBe(true);
    expect(conditionHolds({ threshold: null, anomaly }, 22)).toBe(false);
  });
  it("both: the value must be anomalous AND cross the threshold", () => {
    expect(conditionHolds({ threshold, anomaly }, 50)).toBe(false); // anomalous but under 90
    expect(conditionHolds({ threshold, anomaly }, 95)).toBe(true);
  });
  it("never holds while the detector is learning, or with no condition at all", () => {
    expect(conditionHolds({ threshold: null, anomaly: { baseline: null, sensitivity: "HIGH" } }, 1e9)).toBe(false);
    expect(conditionHolds({ threshold, anomaly: { baseline: null, sensitivity: "HIGH" } }, 1e9)).toBe(false);
    expect(conditionHolds({ threshold: null, anomaly: null }, 1)).toBe(false);
  });
  it("streakSince walks back while the condition holds", () => {
    const t = (m: number) => new Date(Date.UTC(2026, 8, 23, 14, m));
    const points = [{ time: t(3), value: 60 }, { time: t(2), value: 55 }, { time: t(1), value: 21 }, { time: t(0), value: 70 }];
    expect(streakSince(points, (v) => conditionHolds({ threshold: null, anomaly }, v))).toEqual(t(2));
  });
});

// ── Root-cause analysis ──────────────────────────────────────────────────────────────────────────

const T0 = new Date("2026-09-23T14:00:00Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

function incident(id: string, sourceId: string | null, minutes: number, extra: Partial<RcaIncident> = {}): RcaIncident {
  return { id, title: `alert ${id}`, status: "OPEN", sourceKind: "HOST", sourceId, sourceLabel: sourceId ? `label-${sourceId}` : null, metric: "CPU_USAGE_PERCENT", startedAt: at(minutes), ...extra };
}

// web-app → api → db (an edge parent → child reads "parent depends on child"); lb → web-app; batch → db
const topology: RcaTopology = {
  nodes: [
    { id: "n-lb", refId: "lb", label: "Load balancer" },
    { id: "n-web", refId: "web", label: "Web app" },
    { id: "n-api", refId: "api", label: "API" },
    { id: "n-db", refId: "db", label: "PostgreSQL" },
    { id: "n-batch", refId: null, label: "Batch service" },
  ],
  edges: [
    { parent: "n-lb", child: "n-web" },
    { parent: "n-web", child: "n-api" },
    { parent: "n-api", child: "n-db" },
    { parent: "n-batch", child: "n-db" },
  ],
};

describe("analyzeIncident", () => {
  const db = incident("i-db", "db", 0, { metric: "DB_CONNECTION_USAGE_PERCENT" });
  const api = incident("i-api", "api", 2);
  const web = incident("i-web", "web", 3);

  it("a failing dependency makes an incident a symptom, pointing at the deepest failing dependency", () => {
    const findings = analyzeIncident(web, [db, api, web], topology);
    expect(findings.verdict).toBe("symptom");
    expect(findings.node).toBe("Web app");
    expect(findings.rootCauses.map((r) => r.label)).toEqual(["PostgreSQL"]); // api is itself a symptom of db
    expect(findings.rootCauses[0].incidents[0]).toMatchObject({ incidentId: "i-db", offsetSec: -180 });
    expect(findings.correlated).toEqual([]); // db and api are explained by the dependency map
    expect(findings.confidence).toBe(0.8);
  });

  it("failing dependents make an incident the root cause, with its blast radius", () => {
    const findings = analyzeIncident(db, [db, api, web], topology);
    expect(findings.verdict).toBe("root_cause");
    expect(findings.impacted.map((r) => r.label).sort()).toEqual(["API", "Web app"]);
    expect(findings.blastRadius.count).toBe(4); // api, batch, web, lb
    expect(findings.blastRadius.labels).toContain("Batch service");
    expect(findings.firstToStart).toBe(true);
    expect(findings.confidence).toBeCloseTo(0.85);
  });

  it("isolated when mapped but nothing related fails; time correlation is still reported", () => {
    const unrelated = incident("i-x", "not-on-map", 5, { sourceKind: "ENDPOINT" });
    const findings = analyzeIncident(web, [web, unrelated], topology);
    expect(findings.verdict).toBe("isolated");
    expect(findings.correlated.map((r) => r.incidentId)).toEqual(["i-x"]);
    expect(findings.firstToStart).toBe(true);
    expect(findings.confidence).toBe(0.35);
  });

  it("not_mapped when the source is not on the map; same-source alerts are grouped", () => {
    const cpu = incident("i-cpu", "host-9", 0);
    const mem = incident("i-mem", "host-9", 1, { metric: "MEMORY_USED_PERCENT" });
    const findings = analyzeIncident(cpu, [cpu, mem], topology);
    expect(findings.verdict).toBe("not_mapped");
    expect(findings.sameSource.map((r) => r.incidentId)).toEqual(["i-mem"]);
    expect(findings.correlated).toEqual([]);
  });

  it("an ongoing upstream incident explains a new one however long ago it began; old resolved ones do not", () => {
    const oldOngoing = incident("i-db-old", "db", -600);
    expect(analyzeIncident(web, [oldOngoing, web], topology).verdict).toBe("symptom");

    const oldResolved = incident("i-db-done", "db", -600, { status: "RESOLVED" });
    const findings = analyzeIncident(web, [oldResolved, web], topology);
    expect(findings.verdict).toBe("isolated");
    expect(findings.correlated).toEqual([]); // outside the 15-minute window
  });

  it("tolerates dependency cycles", () => {
    const cyclic: RcaTopology = { nodes: topology.nodes, edges: [...topology.edges, { parent: "n-db", child: "n-web" }] };
    expect(() => analyzeIncident(web, [db, api, web], cyclic)).not.toThrow();
  });
});

// ── Claude narrative (fake client: no network, no cost) ──────────────────────────────────────────

function fakeDeps(response: unknown): { deps: NarrativeDeps; parse: ReturnType<typeof vi.fn> } {
  const parse = vi.fn().mockResolvedValue(response);
  return { deps: { client: { beta: { messages: { parse } } } as unknown as NarrativeDeps["client"], model: "claude-opus-5" }, parse };
}

describe("requestNarrative", () => {
  it("sends the incident as data, with adaptive thinking, structured output and server-side fallbacks", async () => {
    const { deps, parse } = fakeDeps({ stop_reason: "end_turn", parsed_output: { summaryEn: " The database saturated. ", summaryFr: "La base est saturée." } });
    const result = await requestNarrative(deps, { incident: { title: "API errors" } });
    expect(result).toEqual({ summaryEn: "The database saturated.", summaryFr: "La base est saturée." });

    const request = parse.mock.calls[0][0];
    expect(request).toMatchObject({ model: "claude-opus-5", thinking: { type: "adaptive" }, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" });
    expect(request.messages).toEqual([{ role: "user", content: JSON.stringify({ incident: { title: "API errors" } }) }]);
    expect(request.system).toMatch(/not instructions/);
    expect(request.output_config.format).toBeDefined();
    expect(request).not.toHaveProperty("temperature");
  });

  it("returns null on a refusal or an empty answer", async () => {
    expect(await requestNarrative(fakeDeps({ stop_reason: "refusal", parsed_output: null }).deps, {})).toBeNull();
    expect(await requestNarrative(fakeDeps({ stop_reason: "end_turn", parsed_output: { summaryEn: " ", summaryFr: "x" } }).deps, {})).toBeNull();
  });
});
