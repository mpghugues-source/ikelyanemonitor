import { Globe } from "lucide-react";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireActor } from "@/lib/auth/dal";
import { can } from "@/lib/auth/permissions";
import { getPrisma } from "@/lib/prisma";
import { EndpointActions, RegisterEndpointForm } from "@/modules/saas/components/endpoint-forms";
import { listEndpoints } from "@/modules/saas/endpoints";
import { sslDaysLeft } from "@/modules/saas/sla";

export default async function SaasPage({ params }: PageProps<"/[locale]/saas">) {
  const { locale } = await params;
  setRequestLocale(locale);
  const { actor } = await requireActor("endpoints:read");
  const t = await getTranslations();
  const format = await getFormatter();

  const endpoints = await listEndpoints(getPrisma(), actor);
  if (!endpoints.ok) return null;

  const canWrite = can(actor.role, "endpoints:write");
  const now = new Date();

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <PageHeader icon={Globe} title={t("saas.title")} subtitle={t("saas.subtitle")} />
        {canWrite ? <RegisterEndpointForm /> : null}
      </div>

      <Card>
        <CardContent className="overflow-x-auto pt-6">
          {endpoints.value.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("endpointAdmin.empty")}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("saas.endpoint")}</TableHead>
                  <TableHead>{t("common.status")}</TableHead>
                  <TableHead>{t("saas.responseTime")}</TableHead>
                  <TableHead>{t("saas.sslCertificate")}</TableHead>
                  <TableHead>{t("saas.lastCheck")}</TableHead>
                  {canWrite ? <TableHead className="text-right">{t("common.actions")}</TableHead> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {endpoints.value.map((endpoint) => {
                  const daysLeft = endpoint.sslExpiresAt ? sslDaysLeft(endpoint.sslExpiresAt, now) : null;
                  return (
                    <TableRow key={endpoint.id} data-testid={`endpoint-${endpoint.name}`}>
                      <TableCell>
                        <div className="font-medium">{endpoint.name}</div>
                        <div className="font-mono text-xs text-muted-foreground">{endpoint.method} {endpoint.url}</div>
                      </TableCell>
                      <TableCell className="space-x-1">
                        <Badge variant={endpoint.status === "UP" ? "default" : "secondary"}>{t(`status.${endpoint.status.toLowerCase()}`)}</Badge>
                        {!endpoint.enabled ? <Badge variant="destructive">{t("common.disabled")}</Badge> : null}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {endpoint.lastResponseMs !== null ? `${Math.round(endpoint.lastResponseMs)} ms` : "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {daysLeft === null ? "—" : daysLeft < 0 ? t("saas.sslExpired") : t("saas.sslExpiresIn", { days: daysLeft })}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {endpoint.lastCheckedAt ? format.dateTime(endpoint.lastCheckedAt, { dateStyle: "short", timeStyle: "short" }) : t("hostAdmin.neverSeen")}
                      </TableCell>
                      {canWrite ? (
                        <TableCell className="text-right">
                          <EndpointActions endpoint={endpoint} />
                        </TableCell>
                      ) : null}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
