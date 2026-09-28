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

export interface LayoutOptions {
  /** Horizontal distance between two node centres of the same layer. */
  columnGap?: number;
  /** Vertical distance between two layers. */
  rowGap?: number;
}

/** Edges that close a cycle, found by a depth-first walk in input order (deterministic). */
function backEdges(nodeIds: readonly string[], edges: readonly DependencyEdge[]): Set<DependencyEdge> {
  const children = new Map<string, DependencyEdge[]>();
  for (const edge of edges) children.set(edge.parent, [...(children.get(edge.parent) ?? []), edge]);
  const state = new Map<string, "open" | "done">();
  const back = new Set<DependencyEdge>();
  for (const root of nodeIds) {
    if (state.has(root)) continue;
    // Iterative DFS: a stack of [node, index of the next outgoing edge to visit].
    const stack: Array<[string, number]> = [[root, 0]];
    state.set(root, "open");
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const out = children.get(frame[0]) ?? [];
      if (frame[1] >= out.length) {
        state.set(frame[0], "done");
        stack.pop();
        continue;
      }
      const edge = out[frame[1]++];
      const seen = state.get(edge.child);
      if (seen === "open") back.add(edge);
      else if (seen === undefined) {
        state.set(edge.child, "open");
        stack.push([edge.child, 0]);
      }
    }
  }
  return back;
}

/**
 * Layered ("Sugiyama-lite") layout: what depends on something sits ABOVE it, so arrows point down
 * and a failure climbs up the picture. Each node goes to its longest-path depth from a top-level
 * node, cycles are broken first, and each layer is ordered by the mean position of its parents to
 * limit crossings. Nodes without any dependency get their own bottom row instead of crowding the top.
 * Returns the top-left corner of each node, centred on x = 0.
 */
export function layeredLayout(nodeIds: readonly string[], edges: readonly DependencyEdge[], options: LayoutOptions = {}): Map<string, { x: number; y: number }> {
  const columnGap = options.columnGap ?? 200;
  const rowGap = options.rowGap ?? 130;
  const known = new Set(nodeIds);
  const valid = edges.filter((e) => known.has(e.parent) && known.has(e.child) && e.parent !== e.child);
  const back = backEdges(nodeIds, valid);
  const dag = valid.filter((e) => !back.has(e));

  const parentsOf = buildIndex(dag, "child");
  const childrenOf = buildIndex(dag, "parent");
  const connected = new Set(valid.flatMap((e) => [e.parent, e.child]));

  // Longest-path layering over the DAG (Kahn's topological order).
  const indegree = new Map(nodeIds.map((id) => [id, parentsOf.get(id)?.length ?? 0]));
  const layer = new Map<string, number>(nodeIds.map((id) => [id, 0]));
  const queue = nodeIds.filter((id) => indegree.get(id) === 0);
  while (queue.length > 0) {
    const node = queue.shift() as string;
    for (const child of childrenOf.get(node) ?? []) {
      layer.set(child, Math.max(layer.get(child) ?? 0, (layer.get(node) ?? 0) + 1));
      const left = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, left);
      if (left === 0) queue.push(child);
    }
  }

  const layers: string[][] = [];
  for (const id of nodeIds) {
    if (!connected.has(id)) continue;
    const depth = layer.get(id) ?? 0;
    (layers[depth] ??= []).push(id);
  }
  const isolated = nodeIds.filter((id) => !connected.has(id));

  // Order each layer by the barycentre of its parents (input order breaks ties: Array.sort is stable).
  const order = new Map<string, number>();
  for (const row of layers) {
    if (!row) continue;
    const score = (id: string) => {
      const parents = (parentsOf.get(id) ?? []).filter((p) => order.has(p));
      return parents.length === 0 ? Number.POSITIVE_INFINITY : parents.reduce((sum, p) => sum + (order.get(p) as number), 0) / parents.length;
    };
    const scored = row.map((id) => ({ id, score: score(id) }));
    scored.sort((a, b) => (a.score === b.score ? 0 : a.score < b.score ? -1 : 1));
    scored.forEach(({ id }, index) => order.set(id, index - (scored.length - 1) / 2));
    row.splice(0, row.length, ...scored.map(({ id }) => id));
  }

  const positions = new Map<string, { x: number; y: number }>();
  const rows = [...layers.filter(Boolean), ...(isolated.length > 0 ? [isolated] : [])];
  rows.forEach((row, depth) => {
    row.forEach((id, index) => positions.set(id, { x: (index - (row.length - 1) / 2) * columnGap, y: depth * rowGap }));
  });
  return positions;
}
