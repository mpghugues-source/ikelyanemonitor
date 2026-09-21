import { Server } from "lucide-react";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireActor } from "@/lib/auth/dal";
import { can } from "@/lib/auth/permissions";
import { getPrisma } from "@/lib/prisma";
import { HostActions, RegisterHostForm } from "@/modules/servers/components/host-forms";
import { listHosts } from "@/modules/servers/hosts";

export default async function ServersPage({ params }: PageProps<"/[locale]/servers">) {
  const { locale } = await params;
  setRequestLocale(locale);
  const { actor } = await requireActor("hosts:read");
  const t = await getTranslations();
  const format = await getFormatter();

  const hosts = await listHosts(getPrisma(), actor);
  if (!hosts.ok) return null;

  const canWrite = can(actor.role, "hosts:write");
  const canRotate = can(actor.role, "hosts:rotate-secret");

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader icon={Server} title={t("host.title")} subtitle={t("host.subtitle")} />

      {canWrite ? (
        <Card>
          <CardHeader>
            <CardTitle>{t("hostAdmin.registerTitle")}</CardTitle>
            <CardDescription>{t("hostAdmin.registerHelp")}</CardDescription>
          </CardHeader>
          <CardContent>
            <RegisterHostForm />
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardContent className="overflow-x-auto pt-6">
          {hosts.value.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("hostAdmin.empty")}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("hostAdmin.table.host")}</TableHead>
                  <TableHead>{t("hostAdmin.table.status")}</TableHead>
                  <TableHead>{t("hostAdmin.table.lastSeen")}</TableHead>
                  <TableHead>{t("hostAdmin.table.agent")}</TableHead>
                  {canWrite || canRotate ? <TableHead className="text-right">{t("hostAdmin.table.actions")}</TableHead> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {hosts.value.map((host) => (
                  <TableRow key={host.id} data-testid={`host-${host.hostname}`}>
                    <TableCell>
                      <div className="font-medium">{host.displayName ?? host.hostname}</div>
                      <div className="font-mono text-xs text-muted-foreground">{host.hostname}</div>
                    </TableCell>
                    <TableCell className="space-x-1">
                      <Badge variant={host.status === "UP" ? "default" : "secondary"}>{t(`status.${host.status.toLowerCase()}`)}</Badge>
                      {!host.enabled ? <Badge variant="destructive">{t("hostAdmin.disabledBadge")}</Badge> : null}
                      {host.rotationPending ? <Badge variant="outline">{t("hostAdmin.rotationPending")}</Badge> : null}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {host.lastSeenAt ? format.dateTime(host.lastSeenAt, { dateStyle: "short", timeStyle: "short" }) : t("hostAdmin.neverSeen")}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{host.agentVersion ?? "—"}</TableCell>
                    {canWrite || canRotate ? (
                      <TableCell className="text-right">
                        <HostActions hostId={host.id} hostname={host.hostname} enabled={host.enabled} canRotate={canRotate} canWrite={canWrite} />
                      </TableCell>
                    ) : null}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
