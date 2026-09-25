import { Globe } from "lucide-react";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireActor } from "@/lib/auth/dal";
import { can } from "@/lib/auth/permissions";
import { getPrisma } from "@/lib/prisma";
import { CheckNowButton, EndpointActions, RegisterEndpointForm } from "@/modules/saas/components/endpoint-forms";
import { endpointAvailability, endpointFailedChecks, listEndpoints } from "@/modules/saas/endpoints";
import { PROBE_ERROR_CODES } from "@/modules/saas/runner/error-codes";
import { isSlaBreached, sslDaysLeft } from "@/modules/saas/sla";

const DAY_MS = 24 * 60 * 60 * 1000;
const SLA_WINDOW_DAYS = 30;

export default async function SaasPage({ params }: PageProps<"/[locale]/saas">) {
  const { locale } = await params;
  setRequestLocale(locale);
  const { actor } = await requireActor("endpoints:read");
  const t = await getTranslations();
  const format = await getFormatter();

  const endpoints = await listEndpoints(getPrisma(), actor);
  if (!endpoints.ok) return null;

  const canWrite = can(actor.role, "endpoints:write");
  const canCheck = can(actor.role, "endpoints:check");
  const now = new Date();
  const ids = endpoints.value.map((endpoint) => endpoint.id);
  const slaSince = new Date(now.getTime() - SLA_WINDOW_DAYS * DAY_MS);
  const [availability24h, availability30d, failures30d] = await Promise.all([
    endpointAvailability(getPrisma(), actor, ids, new Date(now.getTime() - DAY_MS)),
    endpointAvailability(getPrisma(), actor, ids, slaSince),
    endpointFailedChecks(getPrisma(), actor, ids, slaSince),
  ]);
  const percent = (value: number | undefined) =>
    value === undefined ? t("saas.noData") : `${format.number(value, { maximumFractionDigits: value >= 99 ? 3 : 1 })} %`;

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
                  <TableHead>{t("saas.availability24h")}</TableHead>
                  <TableHead>{t("saas.availability30d")}</TableHead>
                  <TableHead>{t("saas.sslCertificate")}</TableHead>
                  <TableHead>{t("saas.lastCheck")}</TableHead>
                  {canCheck ? <TableHead className="text-right">{t("common.actions")}</TableHead> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {endpoints.value.map((endpoint) => {
                  const daysLeft = endpoint.sslExpiresAt ? sslDaysLeft(endpoint.sslExpiresAt, now) : null;
                  const month = availability30d.get(endpoint.id);
                  // Each failed check stands for one interval of downtime.
                  const downtimeMinutes = ((failures30d.get(endpoint.id) ?? 0) * endpoint.intervalSec) / 60;
                  const errorCode = PROBE_ERROR_CODES.find((code) => code === endpoint.lastError);
                  return (
                    <TableRow key={endpoint.id} data-testid={`endpoint-${endpoint.name}`}>
                      <TableCell>
                        <div className="font-medium">{endpoint.name}</div>
                        <div className="font-mono text-xs text-muted-foreground">{endpoint.method} {endpoint.url}</div>
                      </TableCell>
                      <TableCell className="space-x-1">
                        <Badge variant={endpoint.status === "UP" ? "default" : "secondary"}>{t(`status.${endpoint.status.toLowerCase()}`)}</Badge>
                        {!endpoint.enabled ? <Badge variant="destructive">{t("common.disabled")}</Badge> : null}
                        {errorCode ? (
                          <div className="mt-1 text-xs text-destructive" data-testid="endpoint-last-error">
                            {t(`saas.checkError.${errorCode}`)}
                            {endpoint.lastErrorDetail ? <span className="font-mono"> ({endpoint.lastErrorDetail})</span> : null}
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {endpoint.lastResponseMs !== null ? `${Math.round(endpoint.lastResponseMs)} ms` : "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{percent(availability24h.get(endpoint.id))}</TableCell>
                      <TableCell className="space-x-1 text-muted-foreground">
                        <span>{percent(month)}</span>
                        {isSlaBreached(downtimeMinutes, endpoint.slaTargetPercent, SLA_WINDOW_DAYS) ? <Badge variant="destructive">{t("saas.slaBreached")}</Badge> : null}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {daysLeft === null ? "—" : daysLeft < 0 ? t("saas.sslExpired") : t("saas.sslExpiresIn", { days: daysLeft })}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {endpoint.lastCheckedAt ? format.dateTime(endpoint.lastCheckedAt, { dateStyle: "short", timeStyle: "short" }) : t("hostAdmin.neverSeen")}
                      </TableCell>
                      {canCheck ? (
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            <CheckNowButton endpoint={endpoint} />
                            {canWrite ? <EndpointActions endpoint={endpoint} /> : null}
                          </div>
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
