import { Workflow } from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { requireActor } from "@/lib/auth/dal";
import { can } from "@/lib/auth/permissions";
import { getPrisma } from "@/lib/prisma";
import { listDatabases } from "@/modules/databases/instances";
import { listDevices } from "@/modules/network/devices";
import { listEndpoints } from "@/modules/saas/endpoints";
import { listHosts } from "@/modules/servers/hosts";
import { TopologyBoard } from "@/modules/topology/components/topology-board";
import { AddDependencyDialog, AddNodeDialog } from "@/modules/topology/components/topology-forms";
import { EdgeList, NodeList } from "@/modules/topology/components/topology-lists";
import { listTopology } from "@/modules/topology/service";

export default async function TopologyPage({ params }: PageProps<"/[locale]/topology">) {
  const { locale } = await params;
  setRequestLocale(locale);
  const { actor } = await requireActor("topology:read");
  const t = await getTranslations("topology");
  const ta = await getTranslations("topologyAdmin");
  const db = getPrisma();

  const graph = await listTopology(db, actor);
  if (!graph.ok) return null;

  const canWrite = can(actor.role, "topology:write");
  const [hosts, devices, databases, endpoints] = canWrite
    ? await Promise.all([listHosts(db, actor), listDevices(db, actor), listDatabases(db, actor), listEndpoints(db, actor)])
    : [null, null, null, null];

  const entities = {
    HOST: hosts?.ok ? hosts.value.map((h) => ({ id: h.id, name: h.displayName ?? h.hostname })) : [],
    NETWORK_DEVICE: devices?.ok ? devices.value.map((d) => ({ id: d.id, name: d.name })) : [],
    DATABASE: databases?.ok ? databases.value.map((d) => ({ id: d.id, name: d.name })) : [],
    ENDPOINT: endpoints?.ok ? endpoints.value.map((e) => ({ id: e.id, name: e.name })) : [],
  };
  const nodesById = new Map(graph.value.nodes.map((node) => [node.id, node]));

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <PageHeader icon={Workflow} title={t("title")} subtitle={t("subtitle")} />
        {canWrite ? (
          <div className="flex gap-2">
            <AddNodeDialog entities={entities} />
            <AddDependencyDialog nodes={graph.value.nodes} />
          </div>
        ) : null}
      </div>

      {graph.value.nodes.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="py-16 text-center text-sm text-muted-foreground">{ta("empty")}</CardContent>
        </Card>
      ) : (
        <div>
          <TopologyBoard graph={graph.value} />
          <p className="mt-2 text-xs text-muted-foreground">{t("arrowHint")}</p>
        </div>
      )}

      {canWrite && graph.value.nodes.length > 0 ? (
        <div className="grid gap-6 sm:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>{t("nodes")}</CardTitle>
            </CardHeader>
            <CardContent>
              <NodeList nodes={graph.value.nodes} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t("dependencies")}</CardTitle>
            </CardHeader>
            <CardContent>
              <EdgeList edges={graph.value.edges} nodesById={nodesById} />
            </CardContent>
          </Card>
        </div>
      ) : null}
    </div>
  );
}
