/**
 * Dependency-graph analysis for the topology map and for AIOps root-cause analysis.
 *
 * Convention (same as the ServiceDependency table): an edge `parent → child` reads
 * "the PARENT depends on the CHILD". Therefore a failure propagates from child to parent:
 * when a database (child) fails, the web service that depends on it (parent) is impacted.
 */
export interface DependencyEdge {
  parent: string;
  child: string;
}

function buildIndex(edges: readonly DependencyEdge[], from: "parent" | "child"): Map<string, string[]> {
  const to = from === "parent" ? "child" : "parent";
  const index = new Map<string, string[]>();
  for (const edge of edges) {
    const list = index.get(edge[from]);
    if (list) list.push(edge[to]);
    else index.set(edge[from], [edge[to]]);
  }
  return index;
}

/** Breadth-first walk that tolerates cycles (a `visited` set guarantees termination). */
function reach(start: string, next: Map<string, string[]>): string[] {
  const visited = new Set<string>([start]);
  const queue = [start];
  const order: string[] = [];
  while (queue.length > 0) {
    const node = queue.shift() as string;
    for (const neighbour of next.get(node) ?? []) {
      if (visited.has(neighbour)) continue;
      visited.add(neighbour);
      order.push(neighbour);
      queue.push(neighbour);
    }
  }
  return order;
}

/**
 * Blast radius: every node that depends — directly or transitively — on `failedNodeId`.
 * The failed node itself is not included.
 */
export function blastRadius(edges: readonly DependencyEdge[], failedNodeId: string): string[] {
  return reach(failedNodeId, buildIndex(edges, "child"));
}

/** Everything `nodeId` depends on, directly or transitively (its upstream dependencies). */
export function dependenciesOf(edges: readonly DependencyEdge[], nodeId: string): string[] {
  return reach(nodeId, buildIndex(edges, "parent"));
}

/**
 * Root-cause candidates among unhealthy nodes: an unhealthy node is a probable ROOT cause when none
 * of the things it depends on is unhealthy too (otherwise it is more likely a symptom).
 * Ordered by blast radius, largest first — the failure explaining the most breakage comes first.
 */
export function rootCauseCandidates(edges: readonly DependencyEdge[], unhealthy: ReadonlySet<string>): string[] {
  const dependencies = buildIndex(edges, "parent");
  return [...unhealthy]
    .filter((node) => !(dependencies.get(node) ?? []).some((dep) => unhealthy.has(dep)))
    .map((node) => ({ node, radius: blastRadius(edges, node).length }))
    .sort((a, b) => b.radius - a.radius || a.node.localeCompare(b.node))
    .map(({ node }) => node);
}
