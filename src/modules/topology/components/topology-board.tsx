"use client";

import { Background, Controls, MarkerType, ReactFlow, type Edge, type Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCallback, useMemo } from "react";
import { updateNodePositionAction } from "@/app/actions/topology";
import type { TopologyGraph } from "@/modules/topology/service";

const KIND_STYLE: Record<string, { background: string; border: string }> = {
  HOST: { background: "#dcfce7", border: "1px solid #16a34a" },
  NETWORK_DEVICE: { background: "#e0f2fe", border: "1px solid #0284c7" },
  DATABASE: { background: "#fef3c7", border: "1px solid #d97706" },
  ENDPOINT: { background: "#ede9fe", border: "1px solid #7c3aed" },
  SERVICE: { background: "#f1f5f9", border: "1px solid #475569" },
  EXTERNAL: { background: "#f1f5f9", border: "1px dashed #64748b" },
};

export function TopologyBoard({ graph }: { graph: TopologyGraph }) {
  const nodes = useMemo<Node[]>(
    () =>
      graph.nodes.map((node) => ({
        id: node.id,
        position: { x: node.positionX, y: node.positionY },
        data: { label: node.label },
        style: { ...KIND_STYLE[node.kind], borderRadius: 8, padding: 8, fontSize: 12, color: "#0f172a", width: 140 },
      })),
    [graph.nodes],
  );

  const edges = useMemo<Edge[]>(
    () =>
      graph.edges.map((edge) => ({
        id: edge.id,
        source: edge.parentNodeId,
        target: edge.childNodeId,
        label: edge.label ?? undefined,
        markerEnd: { type: MarkerType.ArrowClosed },
        style: edge.criticality === "CRITICAL" ? { stroke: "#dc2626" } : undefined,
      })),
    [graph.edges],
  );

  const onNodeDragStop = useCallback((_event: unknown, node: Node) => {
    void updateNodePositionAction(node.id, node.position.x, node.position.y);
  }, []);

  return (
    <div className="h-[460px] overflow-hidden rounded-xl border bg-card">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        nodesConnectable={false}
        colorMode="light"
        onNodeDragStop={onNodeDragStop}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
