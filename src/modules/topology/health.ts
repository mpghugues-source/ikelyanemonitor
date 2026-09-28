/**
 * Live health of the dependency map — pure functions, safe to import from client components.
 *
 * A node's own health combines the status of the monitored entity behind it (host, device,
 * database, endpoint) with the incidents currently open on that entity: an entity reporting UP
 * while a CRITICAL alert is firing on it is not healthy. Logical nodes (SERVICE / EXTERNAL) have no
 * status of their own; they only appear IMPACTED when something they depend on is unhealthy.
 */
import { blastRadius, type DependencyEdge } from "./graph";

export type NodeHealth = "up" | "degraded" | "down" | "maintenance" | "unknown";
export type EntityStatus = "UP" | "DEGRADED" | "DOWN" | "MAINTENANCE" | "UNKNOWN";
export type IncidentSeverity = "INFO" | "WARNING" | "CRITICAL";

export function combineHealth(entityStatus: EntityStatus | null, openIncidentSeverities: readonly IncidentSeverity[]): NodeHealth {
  // Planned maintenance explains whatever fires meanwhile: do not paint it as an outage.
  if (entityStatus === "MAINTENANCE") return "maintenance";
  if (entityStatus === "DOWN" || openIncidentSeverities.includes("CRITICAL")) return "down";
  // INFO incidents are shown as a count on the node but do not change its colour.
  if (entityStatus === "DEGRADED" || openIncidentSeverities.includes("WARNING")) return "degraded";
  if (entityStatus === "UP") return "up";
  return "unknown";
}

export const isUnhealthy = (health: NodeHealth) => health === "down" || health === "degraded";

/** Nodes hurt by someone else's failure: the union of the blast radii of unhealthy nodes, minus those nodes. */
export function impactedNodes(edges: readonly DependencyEdge[], unhealthy: ReadonlySet<string>): Set<string> {
  const impacted = new Set<string>();
  for (const node of unhealthy) for (const parent of blastRadius(edges, node)) if (!unhealthy.has(parent)) impacted.add(parent);
  return impacted;
}
