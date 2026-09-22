import { Database } from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireActor } from "@/lib/auth/dal";
import { can } from "@/lib/auth/permissions";
import { formatBytes } from "@/lib/format";
import { getPrisma } from "@/lib/prisma";
import { DatabaseActions } from "@/modules/databases/components/database-forms";
import { listDatabases } from "@/modules/databases/instances";

export default async function DatabasesPage({ params }: PageProps<"/[locale]/databases">) {
  const { locale } = await params;
  setRequestLocale(locale);
  const { actor } = await requireActor("databases:read");
  const t = await getTranslations();

  const databases = await listDatabases(getPrisma(), actor);
  if (!databases.ok) return null;

  const canWrite = can(actor.role, "databases:write");

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader icon={Database} title={t("database.title")} subtitle={t("database.subtitle")} />

      <Card>
        <CardContent className="overflow-x-auto pt-6">
          {databases.value.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("databaseAdmin.empty")}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("database.instance")}</TableHead>
                  <TableHead>{t("database.engine")}</TableHead>
                  <TableHead>{t("common.status")}</TableHead>
                  <TableHead>{t("database.connections")}</TableHead>
                  <TableHead>{t("database.cacheHitRatio")}</TableHead>
                  <TableHead>{t("database.storageUsed")}</TableHead>
                  {canWrite ? <TableHead className="text-right">{t("common.actions")}</TableHead> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {databases.value.map((database) => (
                  <TableRow key={database.id} data-testid={`database-${database.name}`}>
                    <TableCell>
                      <div className="font-medium">{database.name}</div>
                      <div className="font-mono text-xs text-muted-foreground">{database.hostname ?? database.endpoint ?? "—"}</div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {t(`database.engines.${database.engine.toLowerCase()}`)}
                      {database.isReplica ? <Badge variant="outline" className="ml-2">{t("database.replica")}</Badge> : null}
                    </TableCell>
                    <TableCell className="space-x-1">
                      <Badge variant={database.status === "UP" ? "default" : "secondary"}>{t(`status.${database.status.toLowerCase()}`)}</Badge>
                      {!database.enabled ? <Badge variant="destructive">{t("common.disabled")}</Badge> : null}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {database.activeConnections ?? "—"}{database.maxConnections ? ` / ${database.maxConnections}` : ""}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {database.cacheHitRatio !== null ? `${(database.cacheHitRatio * 100).toFixed(1)}%` : "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {database.storageUsedBytes !== null ? formatBytes(database.storageUsedBytes) : "—"}
                      {database.storageQuotaBytes ? ` / ${formatBytes(database.storageQuotaBytes)}` : ""}
                    </TableCell>
                    {canWrite ? (
                      <TableCell className="text-right">
                        <DatabaseActions database={database} />
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
