"use client";

import {
  applyNodeChanges,
  Background,
  Controls,
  Handle,
  MarkerType,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Boxes, Cloud, Database, Globe, LayoutGrid, Network, Server, TriangleAlert, X, type LucideIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState, useTransition, type ReactNode } from "react";
import { connectNodesAction, deleteDependencyAction, saveLayoutAction } from "@/app/actions/topology";
import { ActionForm, ErrorText } from "@/components/forms/action-form";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import type { TopologyNodeKind } from "@/generated/prisma/enums";
import { idle, type FormState } from "@/lib/form-state";
import { cn } from "@/lib/utils";
import { Link, useRouter } from "@/i18n/navigation";
import { blastRadius, dependenciesOf, layeredLayout, type DependencyEdge } from "@/modules/topology/graph";
import { impactedNodes, isUnhealthy, type NodeHealth } from "@/modules/topology/health";
import type { NodeHealthInfo, TopologyGraph } from "@/modules/topology/service";

const NAMESPACES = ["topologyAdmin.errors", "auth.errors"];
/** Live map: statuses are re-read from the server this often while the tab is visible. */
const REFRESH_MS = 30_000;

const KIND_ICON: Record<TopologyNodeKind, LucideIcon> = {
  HOST: Server,
  NETWORK_DEVICE: Network,
  DATABASE: Database,
  ENDPOINT: Globe,
  SERVICE: Boxes,
  EXTERNAL: Cloud,
};

/** Where the entity behind a node is managed. */
const KIND_HREF: Partial<Record<TopologyNodeKind, "/servers" | "/network" | "/databases" | "/saas">> = {
  HOST: "/servers",
  NETWORK_DEVICE: "/network",
  DATABASE: "/databases",
  ENDPOINT: "/saas",
};

const HEALTH_DOT: Record<NodeHealth, string> = {
  up: "bg-emerald-500",
  degraded: "bg-amber-500",
  down: "bg-red-600",
  maintenance: "bg-sky-500",
  unknown: "bg-slate-400",
};

const HEALTH_CARD: Record<NodeHealth, string> = {
  up: "border-emerald-500/60",
  degraded: "border-amber-500 bg-amber-50 dark:bg-amber-950/40",
  down: "border-red-600 bg-red-50 dark:bg-red-950/40",
  maintenance: "border-sky-500/60",
  unknown: "border-border",
};

/** SNAKE_CASE enum value → camelCase dictionary key (NETWORK_DEVICE → networkDevice). */
const camel = (value: string) => value.toLowerCase().replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

type Focus = "selected" | "dependency" | "impacted" | "dimmed" | null;

type MapNodeData = {
  label: string;
  kind: TopologyNodeKind;
  health: NodeHealth | null;
  impacted: boolean;
  openIncidents: number;
  connectable: boolean;
  focus: Focus;
};
type MapNode = Node<MapNodeData, "entity">;

function EntityNode({ data }: NodeProps<MapNode>) {
  const t = useTranslations("topology");
  const Icon = KIND_ICON[data.kind];
  const handle = cn("!size-2.5 !border-background !bg-muted-foreground", !data.connectable && "!opacity-0 !pointer-events-none");
  return (
    <div
      data-testid="topology-node"
      data-health={data.health ?? "logical"}
      data-impacted={data.impacted || undefined}
      className={cn(
        "w-[170px] rounded-lg border-2 bg-card px-3 py-2 text-card-foreground shadow-sm transition-opacity",
        data.health ? HEALTH_CARD[data.health] : "border-dashed border-border",
        data.impacted && "outline-2 outline-offset-2 outline-dashed outline-amber-500",
        data.focus === "selected" && "ring-2 ring-primary ring-offset-2 ring-offset-background",
        data.focus === "dependency" && "ring-2 ring-sky-500",
        data.focus === "impacted" && "ring-2 ring-orange-500",
        data.focus === "dimmed" && "opacity-30",
      )}
    >
      <Handle type="target" position={Position.Top} isConnectable={data.connectable} className={handle} />
      <div className="flex items-center gap-2">
        <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="truncate text-xs font-medium" title={data.label}>
          {data.label}
        </span>
      </div>
      <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
        <span className="truncate">{t(`nodeKind.${camel(data.kind)}`)}</span>
        <span className="flex items-center gap-1">
          {data.openIncidents > 0 ? (
            <span className="flex items-center gap-0.5 font-semibold text-red-600" title={t("openIncidents", { count: data.openIncidents })}>
              <TriangleAlert className="size-3" aria-hidden />
              {data.openIncidents}
            </span>
          ) : null}
          {data.health ? <span className={cn("size-2 rounded-full", HEALTH_DOT[data.health])} aria-hidden /> : null}
        </span>
      </div>
      <Handle type="source" position={Position.Bottom} isConnectable={data.connectable} className={handle} />
    </div>
  );
}

const NODE_TYPES = { entity: EntityNode };

type Selection = { type: "node"; id: string } | { type: "edge"; id: string } | null;

interface BoardProps {
  graph: TopologyGraph;
  health: Record<string, NodeHealthInfo>;
  canWrite: boolean;
}

export function TopologyBoard(props: BoardProps) {
  return (
    <ReactFlowProvider>
      <Board {...props} />
    </ReactFlowProvider>
  );
}

function Board({ graph, health, canWrite }: BoardProps) {
  const t = useTranslations("topology");
  const router = useRouter();
  const { fitView } = useReactFlow();
  const [pending, startTransition] = useTransition();
  const [actionState, setActionState] = useState<FormState>(idle);
  const [selected, setSelection] = useState<Selection>(null);
  // A selection whose node or edge has just been deleted (here or by someone else) simply ends.
  const selection =
    selected && (selected.type === "node" ? graph.nodes.some((n) => n.id === selected.id) : graph.edges.some((e) => e.id === selected.id)) ? selected : null;

  const edges = useMemo<DependencyEdge[]>(
    () =>
      graph.edges.map((e) => ({
        parent: e.parentNodeId,
        child: e.childNodeId,
      })),
    [graph.edges],
  );
  const unhealthy = useMemo(
    () =>
      new Set(
        Object.entries(health)
          .filter(([, info]) => isUnhealthy(info.health))
          .map(([id]) => id),
      ),
    [health],
  );
  const impacted = useMemo(() => impactedNodes(edges, unhealthy), [edges, unhealthy]);

  // React Flow owns the node objects (it stores their measured size on them), so they live in state;
  // when the server sends a new graph or new statuses, the data is refreshed but a node keeps the
  // position it has on screen (a drag being saved must not jump back on a background refresh).
  const buildNodes = useCallback(
    (previous: readonly MapNode[]): MapNode[] => {
      const byId = new Map(previous.map((node) => [node.id, node]));
      return graph.nodes.map((row) => {
        const current = byId.get(row.id);
        return {
          ...current,
          id: row.id,
          type: "entity",
          position: current?.position ?? { x: row.positionX, y: row.positionY },
          data: {
            label: row.label,
            kind: row.kind,
            health: health[row.id]?.health ?? null,
            impacted: impacted.has(row.id),
            openIncidents: health[row.id]?.openIncidents ?? 0,
            connectable: canWrite,
            focus: null,
          },
        };
      });
    },
    [graph.nodes, health, impacted, canWrite],
  );
  const [nodes, setNodes] = useState<MapNode[]>(() => buildNodes([]));
  const [builtWith, setBuiltWith] = useState(() => buildNodes);
  if (builtWith !== buildNodes) {
    setBuiltWith(() => buildNodes);
    setNodes(buildNodes(nodes));
  }

  const onNodesChange = useCallback((changes: NodeChange<MapNode>[]) => setNodes((current) => applyNodeChanges(changes, current)), []);

  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [router]);

  // What the selection highlights: what the node depends on, and what its failure would take down.
  const focus = useMemo(() => {
    if (selection?.type !== "node") return null;
    return {
      id: selection.id,
      dependencies: new Set(dependenciesOf(edges, selection.id)),
      radius: new Set(blastRadius(edges, selection.id)),
    };
  }, [selection, edges]);

  const displayNodes = useMemo<MapNode[]>(() => {
    if (!focus) return nodes;
    const focusOf = (id: string): Focus =>
      id === focus.id ? "selected" : focus.dependencies.has(id) ? "dependency" : focus.radius.has(id) ? "impacted" : "dimmed";
    return nodes.map((node) => ({
      ...node,
      data: { ...node.data, focus: focusOf(node.id) },
    }));
  }, [nodes, focus]);

  const displayEdges = useMemo<Edge[]>(
    () =>
      graph.edges.map((edge) => {
        const childHealth = health[edge.childNodeId]?.health;
        // The failure travels against the arrow: from the unhealthy child up to the parent.
        const failing = childHealth === "down" ? "#dc2626" : childHealth === "degraded" || impacted.has(edge.childNodeId) ? "#d97706" : null;
        const onPath =
          !focus ||
          ((edge.parentNodeId === focus.id || focus.radius.has(edge.parentNodeId)) && (edge.childNodeId === focus.id || focus.radius.has(edge.childNodeId))) ||
          ((edge.parentNodeId === focus.id || focus.dependencies.has(edge.parentNodeId)) && focus.dependencies.has(edge.childNodeId));
        const isSelected = selection?.type === "edge" && selection.id === edge.id;
        const stroke = isSelected ? "var(--primary)" : (failing ?? (edge.criticality === "CRITICAL" ? "#64748b" : "#94a3b8"));
        return {
          id: edge.id,
          source: edge.parentNodeId,
          target: edge.childNodeId,
          label: edge.label ?? undefined,
          animated: failing !== null,
          markerEnd: { type: MarkerType.ArrowClosed, color: stroke },
          style: {
            stroke,
            strokeWidth: isSelected ? 3 : edge.criticality === "CRITICAL" ? 2.5 : 1.5,
            opacity: onPath ? 1 : 0.2,
          },
        };
      }),
    [graph.edges, health, impacted, focus, selection],
  );

  const isValidConnection = useCallback(
    (connection: Connection | Edge) =>
      connection.source !== connection.target && !graph.edges.some((e) => e.parentNodeId === connection.source && e.childNodeId === connection.target),
    [graph.edges],
  );

  const onConnect = useCallback((connection: Connection) => {
    startTransition(async () => setActionState(await connectNodesAction(connection.source, connection.target)));
  }, []);

  const saveNodes = useCallback((moved: ReadonlyArray<{ id: string; position: { x: number; y: number } }>) => {
    if (moved.length === 0) return;
    startTransition(async () => {
      const result = await saveLayoutAction(moved.map((n) => ({ id: n.id, x: n.position.x, y: n.position.y })));
      if (result.status === "error") setActionState(result);
    });
  }, []);

  const autoLayout = () => {
    const positions = layeredLayout(
      graph.nodes.map((n) => n.id),
      edges,
      { columnGap: 210, rowGap: 140 },
    );
    const next = nodes.map((node) => ({
      ...node,
      position: positions.get(node.id) ?? node.position,
    }));
    setNodes(next);
    saveNodes(next);
    requestAnimationFrame(() => void fitView({ padding: 0.2, duration: 300 }));
  };

  const labelOf = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n.label])), [graph.nodes]);

  return (
    <div className="space-y-2">
      {/* The details sit BESIDE the map (below it on small screens), never over nodes they talk about. */}
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_17rem]">
        <div className="relative h-[560px] overflow-hidden rounded-xl border bg-card" data-testid="topology-board">
          <ReactFlow<MapNode>
            nodes={displayNodes}
            edges={displayEdges}
            nodeTypes={NODE_TYPES}
            onNodesChange={onNodesChange}
            onNodeClick={(_, node) => setSelection({ type: "node", id: node.id })}
            onEdgeClick={(_, edge) => setSelection({ type: "edge", id: edge.id })}
            onPaneClick={() => setSelection(null)}
            onNodeDragStop={(_, __, dragged) => saveNodes(dragged)}
            nodesDraggable={canWrite}
            nodesConnectable={canWrite}
            isValidConnection={isValidConnection}
            onConnect={onConnect}
            deleteKeyCode={null}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            minZoom={0.2}
            colorMode="light"
          >
            <Background />
            <Controls showInteractive={false} />
            {canWrite ? (
              <Panel position="top-left">
                <Button size="sm" variant="outline" onClick={autoLayout} disabled={pending} className="bg-card">
                  <LayoutGrid className="size-4" aria-hidden />
                  {t("autoLayout")}
                </Button>
              </Panel>
            ) : null}
          </ReactFlow>
        </div>
        <aside>
          {selection ? (
            <SelectionPanel
              selection={selection}
              graph={graph}
              health={health}
              impacted={impacted}
              focus={focus}
              labelOf={labelOf}
              canWrite={canWrite}
              onClose={() => setSelection(null)}
            />
          ) : (
            <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">{t("selectHint")}</p>
          )}
        </aside>
      </div>
      <ErrorText state={actionState} namespaces={NAMESPACES} />
      <Legend />
      <p className="text-xs text-muted-foreground">
        {t("arrowHint")} {canWrite ? t("connectHint") : null}
      </p>
    </div>
  );
}

function Legend() {
  const t = useTranslations("topology");
  const ts = useTranslations("status");
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground" aria-label={t("legend")}>
      {(Object.keys(HEALTH_DOT) as NodeHealth[]).map((health) => (
        <li key={health} className="flex items-center gap-1.5">
          <span className={cn("size-2 rounded-full", HEALTH_DOT[health])} aria-hidden />
          {ts(health)}
        </li>
      ))}
      <li className="flex items-center gap-1.5">
        <span className="size-3 rounded-sm outline-2 outline-dashed outline-amber-500" aria-hidden />
        {t("impacted")}
      </li>
      <li className="flex items-center gap-1.5">
        <span className="size-3 rounded-sm border-2 border-dashed border-border" aria-hidden />
        {t("logical")}
      </li>
    </ul>
  );
}

interface SelectionPanelProps {
  selection: NonNullable<Selection>;
  graph: TopologyGraph;
  health: Record<string, NodeHealthInfo>;
  impacted: ReadonlySet<string>;
  focus: { dependencies: Set<string>; radius: Set<string> } | null;
  labelOf: Map<string, string>;
  canWrite: boolean;
  onClose: () => void;
}

function SelectionPanel({ selection, graph, health, impacted, focus, labelOf, canWrite, onClose }: SelectionPanelProps) {
  const t = useTranslations("topology");
  const ts = useTranslations("status");
  const tsev = useTranslations("severity");
  const tc = useTranslations("common");

  let body: ReactNode = null;
  if (selection.type === "node") {
    const node = graph.nodes.find((n) => n.id === selection.id);
    if (!node) return null;
    const info = health[node.id];
    const href = KIND_HREF[node.kind];
    body = (
      <>
        <p className="pr-6 font-medium break-words">{node.label}</p>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="secondary">{t(`nodeKind.${camel(node.kind)}`)}</Badge>
          {info ? (
            <Badge variant="outline" className="gap-1.5">
              <span className={cn("size-2 rounded-full", HEALTH_DOT[info.health])} aria-hidden />
              {ts(info.health)}
            </Badge>
          ) : null}
          {impacted.has(node.id) ? (
            <Badge variant="outline" className="border-amber-500 text-amber-700 dark:text-amber-400">
              {t("impacted")}
            </Badge>
          ) : null}
        </div>
        {!info ? <p className="text-xs text-muted-foreground">{t("logicalHint")}</p> : null}
        {info && info.openIncidents > 0 ? (
          <Link href="/incidents" className="block text-xs font-medium text-red-600 hover:underline">
            {t("openIncidents", { count: info.openIncidents })}
          </Link>
        ) : null}
        <NodeGroup title={t("dependsOnList")} ids={focus?.dependencies} labelOf={labelOf} tone="text-sky-700 dark:text-sky-400" />
        <NodeGroup title={t("impactList")} ids={focus?.radius} labelOf={labelOf} tone="text-orange-700 dark:text-orange-400" />
        {href ? (
          <Link href={href} className={cn(buttonVariants({ size: "sm", variant: "outline" }), "w-full")}>
            {tc("details")}
          </Link>
        ) : null}
      </>
    );
  } else {
    const edge = graph.edges.find((e) => e.id === selection.id);
    if (!edge) return null;
    body = (
      <>
        <p className="pr-6 text-sm">
          {t("edgeSentence", {
            parent: labelOf.get(edge.parentNodeId) ?? "?",
            child: labelOf.get(edge.childNodeId) ?? "?",
          })}
        </p>
        <div className="flex flex-wrap gap-1.5">
          <Badge variant="secondary">{t(`dependencyKind.${camel(edge.kind)}`)}</Badge>
          <Badge variant="outline">
            {t("criticality")}: {tsev(edge.criticality.toLowerCase())}
          </Badge>
        </div>
        {edge.label ? <p className="text-xs text-muted-foreground">{edge.label}</p> : null}
        {canWrite ? (
          <ActionForm action={deleteDependencyAction} namespaces={NAMESPACES} confirm={t("deleteDependencyConfirm")}>
            {({ pending }) => (
              <>
                <input type="hidden" name="id" value={edge.id} />
                <Button type="submit" size="sm" variant="destructive" className="w-full" disabled={pending}>
                  {t("deleteDependency")}
                </Button>
              </>
            )}
          </ActionForm>
        ) : null}
      </>
    );
  }

  return (
    <div className="relative space-y-3 rounded-lg border bg-popover p-3 text-popover-foreground shadow-md" data-testid="topology-panel">
      <button type="button" onClick={onClose} className="absolute top-2 right-2 rounded p-1 text-muted-foreground hover:bg-muted" aria-label={tc("close")}>
        <X className="size-4" aria-hidden />
      </button>
      {body}
    </div>
  );
}

function NodeGroup({ title, ids, labelOf, tone }: { title: string; ids: Set<string> | undefined; labelOf: Map<string, string>; tone: string }) {
  const tc = useTranslations("common");
  const labels = [...(ids ?? [])].map((id) => labelOf.get(id) ?? id).sort((a, b) => a.localeCompare(b));
  const shown = labels.slice(0, 8);
  return (
    <div className="text-xs">
      <p className="font-medium">
        {title} <span className="text-muted-foreground">({labels.length})</span>
      </p>
      {labels.length === 0 ? (
        <p className="text-muted-foreground">{tc("none")}</p>
      ) : (
        <p className={cn("break-words", tone)}>
          {shown.join(", ")}
          {labels.length > shown.length ? ` +${labels.length - shown.length}` : ""}
        </p>
      )}
    </div>
  );
}
