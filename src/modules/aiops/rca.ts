import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { IncidentEventType, IncidentStatus, type MetricSource, type MetricType } from "@/generated/prisma/enums";
import { blastRadius, dependenciesOf, type DependencyEdge, rootCauseCandidates } from "@/modules/topology/graph";

/**
 * AIOps root-cause analysis — deterministic, computed locally from two signals:
 *   1. the dependency map (topology): if something this incident's source depends on is failing too,
 *      this incident is most likely a SYMPTOM of it; if things that depend on it are failing, it is
 *      most likely their ROOT CAUSE;
 *   2. time correlation: other incidents that started within CORRELATION_WINDOW_MS, on the same
 *      source (co-symptoms: CPU and memory together) or elsewhere.
 *
 * The outcome is stored as structured findings (Incident.rcaFindings) that the UI translates; an
 * optional Claude pass (rca-llm.ts) may then add a written narrative in English and French.
 */

export const RCA_MODEL = "ikelyane-rca-v1";
export const CORRELATION_WINDOW_MS = 15 * 60 * 1000;
/** How many other active incidents are re-analyzed when a new one opens (their picture may change). */
const MAX_REFRESH = 20;
const MAX_LISTED = 10;

export type RcaVerdict = "symptom" | "root_cause" | "isolated" | "not_mapped";

export interface RcaIncident {
  id: string;
  title: string;
  status: IncidentStatus;
  sourceKind: MetricSource | null;
  sourceId: string | null;
  sourceLabel: string | null;
  metric: MetricType | null;
  startedAt: Date;
}

export interface RcaTopology {
  nodes: ReadonlyArray<{ id: string; refId: string | null; label: string }>;
  edges: readonly DependencyEdge[];
}

export interface RcaIncidentRef {
  incidentId: string;
  title: string;
  sourceLabel: string | null;
  metric: MetricType | null;
  /** Seconds between this incident's start and the analyzed one's (negative = started before). */
  offsetSec: number;
}

export interface RcaFindings {
  version: 1;
  verdict: RcaVerdict;
  /** Label of this incident's source on the dependency map, when mapped. */
  node: string | null;
  /** symptom: the failing dependencies most likely at the origin, with their incidents. */
  rootCauses: Array<{ label: string; incidents: RcaIncidentRef[] }>;
  /** root_cause: failing dependents this incident explains. */
  impacted: Array<{ label: string; incidents: RcaIncidentRef[] }>;
  /** Everything that depends on this source, failing or not (count + first labels). */
  blastRadius: { count: number; labels: string[] };
  /** Other incidents on the same source at the same time. */
  sameSource: RcaIncidentRef[];
  /** Other incidents in the time window with no dependency link to this one. */
  correlated: RcaIncidentRef[];
  /** Whether this incident started first among everything correlated with it. */
  firstToStart: boolean;
  confidence: number;
}

function ref(incident: RcaIncident, origin: RcaIncident): RcaIncidentRef {
  return {
    incidentId: incident.id,
    title: incident.title,
    sourceLabel: incident.sourceLabel,
    metric: incident.metric,
    offsetSec: Math.round((incident.startedAt.getTime() - origin.startedAt.getTime()) / 1000),
  };
}

const byOffset = (a: RcaIncidentRef, b: RcaIncidentRef) => Math.abs(a.offsetSec) - Math.abs(b.offsetSec) || a.incidentId.localeCompare(b.incidentId);

/**
 * Pure analysis. `others` are the organization's other incidents that are still active or started
 * within the correlation window of `incident` (the caller filters; this function re-checks the window
 * for time correlation only — an ongoing incident upstream explains a new one however long ago it began).
 */
export function analyzeIncident(incident: RcaIncident, others: readonly RcaIncident[], topology: RcaTopology): RcaFindings {
  const peers = others.filter((other) => other.id !== incident.id);
  const inWindow = (other: RcaIncident) => Math.abs(other.startedAt.getTime() - incident.startedAt.getTime()) <= CORRELATION_WINDOW_MS;
  const active = (other: RcaIncident) => other.status !== IncidentStatus.RESOLVED;

  // Map sources to dependency-map nodes (refId = the monitored entity's id).
  const nodeByRef = new Map(topology.nodes.filter((n) => n.refId).map((n) => [n.refId as string, n]));
  const labelOf = new Map(topology.nodes.map((n) => [n.id, n.label]));
  const incidentsByNode = new Map<string, RcaIncident[]>();
  for (const other of peers) {
    if (!other.sourceId || !(active(other) || inWindow(other))) continue;
    const node = nodeByRef.get(other.sourceId);
    if (node) incidentsByNode.set(node.id, [...(incidentsByNode.get(node.id) ?? []), other]);
  }
  const self = incident.sourceId ? nodeByRef.get(incident.sourceId) : undefined;

  const sameSource = peers.filter((o) => o.sourceId !== null && o.sourceId === incident.sourceId && (active(o) || inWindow(o))).map((o) => ref(o, incident)).sort(byOffset);
  const linkedIds = new Set<string>(sameSource.map((r) => r.incidentId));

  let verdict: RcaVerdict = self ? "isolated" : "not_mapped";
  const rootCauses: RcaFindings["rootCauses"] = [];
  const impacted: RcaFindings["impacted"] = [];
  let radius: string[] = [];

  if (self) {
    const unhealthy = new Set(incidentsByNode.keys());
    unhealthy.add(self.id);
    radius = blastRadius(topology.edges, self.id);

    const failingUpstream = dependenciesOf(topology.edges, self.id).filter((node) => unhealthy.has(node) && node !== self.id);
    // Every failing dependency is a KNOWN link, even an intermediate one that is itself a symptom
    // (web → api → db, all failing: api is neither web's root cause nor a mere coincidence).
    for (const node of failingUpstream) for (const other of incidentsByNode.get(node) ?? []) linkedIds.add(other.id);
    if (failingUpstream.length > 0) {
      verdict = "symptom";
      const roots = rootCauseCandidates(topology.edges, unhealthy).filter((node) => failingUpstream.includes(node));
      for (const node of roots.length > 0 ? roots : failingUpstream) {
        const incidents = (incidentsByNode.get(node) ?? []).map((o) => ref(o, incident)).sort(byOffset);
        incidents.forEach((r) => linkedIds.add(r.incidentId));
        rootCauses.push({ label: labelOf.get(node) ?? node, incidents });
      }
    }
    const failingDependents = radius.filter((node) => unhealthy.has(node));
    if (failingDependents.length > 0) {
      if (verdict !== "symptom") verdict = "root_cause";
      for (const node of failingDependents) {
        const incidents = (incidentsByNode.get(node) ?? []).map((o) => ref(o, incident)).sort(byOffset);
        incidents.forEach((r) => linkedIds.add(r.incidentId));
        impacted.push({ label: labelOf.get(node) ?? node, incidents });
      }
    }
  }

  const correlated = peers.filter((o) => inWindow(o) && !linkedIds.has(o.id)).map((o) => ref(o, incident)).sort(byOffset);
  const cluster = peers.filter(inWindow);
  const firstToStart = cluster.every((o) => o.startedAt.getTime() >= incident.startedAt.getTime());

  return {
    version: 1,
    verdict,
    node: self?.label ?? null,
    rootCauses: rootCauses.slice(0, MAX_LISTED),
    impacted: impacted.slice(0, MAX_LISTED),
    blastRadius: { count: radius.length, labels: radius.slice(0, MAX_LISTED).map((node) => labelOf.get(node) ?? node) },
    sameSource: sameSource.slice(0, MAX_LISTED),
    correlated: correlated.slice(0, MAX_LISTED),
    firstToStart,
    confidence: confidenceOf(verdict, rootCauses.length, impacted.length, correlated.length, sameSource.length, firstToStart),
  };
}

/**
 * A deliberately simple, explainable heuristic (not a probability): a single failing dependency is a
 * strong explanation; several competing ones, or mere coincidence in time, are weak ones.
 */
export function confidenceOf(verdict: RcaVerdict, roots: number, impacted: number, correlated: number, sameSource: number, first: boolean): number {
  switch (verdict) {
    case "symptom":
      return roots === 1 ? 0.8 : 0.6;
    case "root_cause":
      return Math.min(0.9, 0.7 + 0.05 * impacted + (first ? 0.05 : 0));
    case "isolated":
      return correlated > 0 ? 0.35 : 0.5 + (sameSource > 0 ? 0.1 : 0);
    case "not_mapped":
      return correlated > 0 || sameSource > 0 ? 0.3 : 0.2;
  }
}

// ── Persistence ───────────────────────────────────────────────────────────────────────────────

const INCIDENT_SELECT = {
  id: true, title: true, status: true, sourceKind: true, sourceId: true, sourceLabel: true, metric: true, startedAt: true,
} as const;

/** Whether a Claude narrative should be requested (see rca-llm.ts). */
export function llmEnabled(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}

/** Stable view of findings for change detection (offsets and ordering noise excluded). */
function signature(findings: RcaFindings): string {
  const ids = (refs: RcaIncidentRef[]) => refs.map((r) => r.incidentId).sort().join(",");
  return JSON.stringify([
    findings.verdict, findings.node,
    findings.rootCauses.map((r) => [r.label, ids(r.incidents)]),
    findings.impacted.map((r) => [r.label, ids(r.incidents)]),
    ids(findings.sameSource), ids(findings.correlated), findings.blastRadius.count, findings.firstToStart,
  ]);
}

async function loadContext(db: PrismaClient, orgId: string, around: Date) {
  const windowStart = new Date(around.getTime() - CORRELATION_WINDOW_MS);
  const windowEnd = new Date(around.getTime() + CORRELATION_WINDOW_MS);
  const [others, nodes, edges] = await Promise.all([
    db.incident.findMany({
      where: { orgId, OR: [{ status: { not: IncidentStatus.RESOLVED } }, { startedAt: { gte: windowStart, lte: windowEnd } }] },
      select: INCIDENT_SELECT,
      orderBy: { startedAt: "desc" },
      take: 500,
    }),
    db.topologyNode.findMany({ where: { orgId }, select: { id: true, refId: true, label: true } }),
    db.serviceDependency.findMany({ where: { orgId }, select: { parentNodeId: true, childNodeId: true } }),
  ]);
  return { others, topology: { nodes, edges: edges.map((e) => ({ parent: e.parentNodeId, child: e.childNodeId })) } };
}

/**
 * (Re)compute and store the RCA of one incident. Writes only when the findings changed, so repeated
 * calls are cheap and the timeline is not flooded. Returns whether anything was written.
 */
export async function refreshIncidentRca(db: PrismaClient, orgId: string, incidentId: string, now = new Date(), options: { force?: boolean } = {}): Promise<boolean> {
  const incident = await db.incident.findFirst({ where: { id: incidentId, orgId }, select: { ...INCIDENT_SELECT, rcaFindings: true } });
  if (!incident) return false;
  const { others, topology } = await loadContext(db, orgId, incident.startedAt);
  const findings = analyzeIncident(incident, others, topology);

  const previous = incident.rcaFindings as unknown as RcaFindings | null;
  if (!options.force && previous && previous.version === 1 && signature(previous) === signature(findings)) return false;

  const wantsLlm = llmEnabled();
  await db.$transaction([
    db.incident.update({
      where: { id: incident.id },
      data: {
        rcaFindings: findings as unknown as Prisma.InputJsonValue,
        rcaConfidence: findings.confidence,
        rcaModel: RCA_MODEL,
        rcaGeneratedAt: now,
        // A narrative written for the previous findings no longer matches them.
        rcaSummaryEn: null,
        rcaSummaryFr: null,
        rcaLlmRequestedAt: wantsLlm ? now : null,
        rcaLlmAttempts: 0,
        rcaLlmError: null,
      },
    }),
    db.incidentEvent.create({
      data: { incidentId: incident.id, type: IncidentEventType.RCA_GENERATED, data: { model: RCA_MODEL, verdict: findings.verdict, confidence: findings.confidence } },
    }),
  ]);
  return true;
}

/**
 * After an incident opened: analyze it, then re-analyze the other active incidents around it — a new
 * failure upstream turns an "isolated" incident into a "symptom" (and vice versa for its cause).
 */
export async function analyzeAfterOpen(db: PrismaClient, orgId: string, incidentId: string, now = new Date()): Promise<void> {
  await refreshIncidentRca(db, orgId, incidentId, now);
  const neighbours = await db.incident.findMany({
    where: { orgId, id: { not: incidentId }, status: { not: IncidentStatus.RESOLVED } },
    select: { id: true },
    orderBy: { startedAt: "desc" },
    take: MAX_REFRESH,
  });
  for (const neighbour of neighbours) await refreshIncidentRca(db, orgId, neighbour.id, now);
}
