"use client";

import { Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { deleteDependencyAction, deleteNodeAction } from "@/app/actions/topology";
import { ActionForm } from "@/components/forms/action-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { TopologyEdgeRow, TopologyNodeRow } from "@/modules/topology/service";

const NAMESPACES = ["topologyAdmin.errors", "auth.errors"];

export function NodeList({ nodes }: { nodes: TopologyNodeRow[] }) {
  const t = useTranslations("topology");
  const tc = useTranslations("common");
  if (nodes.length === 0) return null;
  return (
    <ul className="divide-y rounded-lg border">
      {nodes.map((node) => (
        <li key={node.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
          <div>
            <span className="font-medium">{node.label}</span>{" "}
            <Badge variant="secondary">{t(`nodeKind.${node.kind === "NETWORK_DEVICE" ? "networkDevice" : node.kind.toLowerCase()}`)}</Badge>
          </div>
          <ActionForm action={deleteNodeAction} namespaces={NAMESPACES}>
            {({ pending }) => (
              <>
                <input type="hidden" name="id" value={node.id} />
                <Button type="submit" size="icon-sm" variant="ghost" disabled={pending} aria-label={tc("delete")}>
                  <Trash2 className="size-4" aria-hidden />
                </Button>
              </>
            )}
          </ActionForm>
        </li>
      ))}
    </ul>
  );
}

export function EdgeList({ edges, nodesById }: { edges: TopologyEdgeRow[]; nodesById: Map<string, TopologyNodeRow> }) {
  const t = useTranslations("topology");
  const tc = useTranslations("common");
  if (edges.length === 0) return null;
  return (
    <ul className="divide-y rounded-lg border">
      {edges.map((edge) => (
        <li key={edge.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
          <div>
            <span className="font-medium">{nodesById.get(edge.parentNodeId)?.label ?? "?"}</span>
            {" → "}
            <span className="font-medium">{nodesById.get(edge.childNodeId)?.label ?? "?"}</span>{" "}
            <Badge variant={edge.criticality === "CRITICAL" ? "destructive" : "secondary"}>
              {t(`dependencyKind.${edge.kind.toLowerCase().replace(/_([a-z])/g, (_match, char: string) => char.toUpperCase())}`)}
            </Badge>
          </div>
          <ActionForm action={deleteDependencyAction} namespaces={NAMESPACES}>
            {({ pending }) => (
              <>
                <input type="hidden" name="id" value={edge.id} />
                <Button type="submit" size="icon-sm" variant="ghost" disabled={pending} aria-label={tc("delete")}>
                  <Trash2 className="size-4" aria-hidden />
                </Button>
              </>
            )}
          </ActionForm>
        </li>
      ))}
    </ul>
  );
}
