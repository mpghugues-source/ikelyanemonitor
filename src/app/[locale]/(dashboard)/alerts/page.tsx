import { Bell } from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireActor } from "@/lib/auth/dal";
import { can } from "@/lib/auth/permissions";
import { getPrisma } from "@/lib/prisma";
import { AlertRuleActions, CreateAlertRuleDialog, type SourceOption } from "@/modules/alerts/components/rule-forms";
import { listAlertRules } from "@/modules/alerts/rules";
import { metricTypeMessageKey, sourceKindMessageKey } from "@/modules/alerts/constants";
import { listDatabases } from "@/modules/databases/instances";
import { listDevices } from "@/modules/network/devices";
import { listEndpoints } from "@/modules/saas/endpoints";
import { listRemediationActions } from "@/modules/remediation/actions";
import { listHosts } from "@/modules/servers/hosts";

export default async function AlertsPage({ params }: PageProps<"/[locale]/alerts">) {
  const { locale } = await params;
  setRequestLocale(locale);
  const { actor } = await requireActor("alerts:read");
  const t = await getTranslations();
  const db = getPrisma();

  const rules = await listAlertRules(db, actor);
  if (!rules.ok) return null;

  const canWrite = can(actor.role, "alerts:write");
  const [hosts, devices, databases, endpoints, remediationActions] = canWrite
    ? await Promise.all([listHosts(db, actor), listDevices(db, actor), listDatabases(db, actor), listEndpoints(db, actor), listRemediationActions(db, actor)])
    : [null, null, null, null, null];

  const sources: Record<"HOST" | "NETWORK_DEVICE" | "DATABASE" | "ENDPOINT" | "remediationActions", SourceOption[]> = {
    remediationActions: remediationActions?.ok ? remediationActions.value.map((action) => ({ id: action.id, label: action.name })) : [],
    HOST: hosts?.ok ? hosts.value.map((host) => ({ id: host.id, label: host.displayName ?? host.hostname })) : [],
    NETWORK_DEVICE: devices?.ok ? devices.value.map((device) => ({ id: device.id, label: device.name })) : [],
    DATABASE: databases?.ok ? databases.value.map((instance) => ({ id: instance.id, label: instance.name })) : [],
    ENDPOINT: endpoints?.ok ? endpoints.value.map((endpoint) => ({ id: endpoint.id, label: endpoint.name })) : [],
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <PageHeader icon={Bell} title={t("alerts.title")} subtitle={t("alerts.subtitle")} />
        {canWrite ? <CreateAlertRuleDialog sources={sources} /> : null}
      </div>

      <Card>
        <CardContent className="overflow-x-auto pt-6">
          {rules.value.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("alertsAdmin.empty")}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("alerts.rule")}</TableHead>
                  <TableHead>{t("alerts.scope")}</TableHead>
                  <TableHead>{t("alerts.metric")}</TableHead>
                  <TableHead>{t("alerts.operator")}</TableHead>
                  <TableHead>{t("alerts.severity")}</TableHead>
                  <TableHead>{t("common.status")}</TableHead>
                  {canWrite ? <TableHead className="text-right">{t("common.actions")}</TableHead> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rules.value.map((rule) => (
                  <TableRow key={rule.id} data-testid={`alert-rule-${rule.name}`}>
                    <TableCell>
                      <div className="font-medium">{rule.name}</div>
                      {rule.description ? <div className="text-xs text-muted-foreground">{rule.description}</div> : null}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {t(`topology.nodeKind.${sourceKindMessageKey(rule.sourceKind)}`)}
                      {rule.sourceLabel ? ` — ${rule.sourceLabel}` : ` — ${t("alerts.allSources")}`}
                      {rule.instanceFilter ? ` (${rule.instanceFilter})` : ""}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{t(`metricType.${metricTypeMessageKey(rule.metric)}`)}</TableCell>
                    <TableCell className="space-y-1 text-muted-foreground">
                      {rule.operator && rule.threshold !== null ? (
                        <div>{t(`alerts.operators.${rule.operator.toLowerCase()}`)} {rule.threshold}</div>
                      ) : null}
                      {rule.anomalyDetection ? (
                        <Badge variant="outline" data-testid="rule-anomaly-badge">
                          {t("alerts.anomalyDetection")} · {t(`alerts.sensitivity.${rule.anomalySensitivity.toLowerCase()}`)}
                        </Badge>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <Badge variant={rule.severity === "CRITICAL" ? "destructive" : rule.severity === "WARNING" ? "secondary" : "outline"}>
                        {t(`severity.${rule.severity.toLowerCase()}`)}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {rule.enabled ? <Badge>{t("common.enabled")}</Badge> : <Badge variant="secondary">{t("common.disabled")}</Badge>}
                    </TableCell>
                    {canWrite ? (
                      <TableCell className="text-right">
                        <AlertRuleActions rule={rule} sources={sources} />
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
