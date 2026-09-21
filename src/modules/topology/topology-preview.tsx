"use client";

import { Background, Controls, MarkerType, ReactFlow, type Edge, type Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";

/**
 * SAMPLE data proving the React Flow integration. It will be replaced by the organization's real
 * TopologyNode / ServiceDependency rows. Edges follow the schema's convention: they point from the
 * PARENT to what it DEPENDS ON (child), so a failure travels against the arrows.
 */
const KIND_STYLE = {
  external: { background: "#f1f5f9", border: "1px dashed #64748b" },
  network: { background: "#e0f2fe", border: "1px solid #0284c7" },
  host: { background: "#dcfce7", border: "1px solid #16a34a" },
  database: { background: "#fef3c7", border: "1px solid #d97706" },
} as const;

const node = (id: string, label: string, x: number, y: number, kind: keyof typeof KIND_STYLE): Node => ({
  id,
  position: { x, y },
  data: { label },
  style: { ...KIND_STYLE[kind], borderRadius: 8, padding: 8, fontSize: 12, color: "#0f172a", width: 130 },
});

const nodes: Node[] = [
  node("web", "web-01", 200, 0, "host"),
  node("api", "api-01", 60, 120, "host"),
  node("cache", "cache-01", 340, 120, "host"),
  node("db", "postgres-01", 60, 250, "database"),
  node("fw", "firewall", 340, 250, "network"),
  node("net", "Internet", 340, 370, "external"),
];

const edge = (parent: string, child: string): Edge => ({
  id: `${parent}->${child}`,
  source: parent,
  target: child,
  markerEnd: { type: MarkerType.ArrowClosed },
});

const edges: Edge[] = [edge("web", "api"), edge("web", "cache"), edge("api", "db"), edge("cache", "fw"), edge("fw", "net")];

export function TopologyPreview({ note }: { note: string }) {
  return (
    <div>
      <div className="h-[460px] overflow-hidden rounded-xl border bg-card">
        <ReactFlow nodes={nodes} edges={edges} fitView nodesConnectable={false} colorMode="light">
          <Background />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{note}</p>
    </div>
  );
}
