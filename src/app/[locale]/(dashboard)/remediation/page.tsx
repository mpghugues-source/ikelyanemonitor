import { Wrench } from "lucide-react";
import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireActor } from "@/lib/auth/dal";
import { can } from "@/lib/auth/permissions";
import { formatDuration } from "@/lib/format";
import { getPrisma } from "@/lib/prisma";
import { listRemediationActions, listRemediationHosts } from "@/modules/remediation/actions";
import { CreateRemediationActionDialog, ExecutionDecision, RemediationActionAdmin, RunActionForm } from "@/modules/remediation/components/remediation-forms";
import { STATUS_REASONS } from "@/modules/remediation/constants";
import { listExecutions } from "@/modules/remediation/executions";

const STATUS_KEY = {
  PENDING: "pending", AWAITING_APPROVAL: "awaitingApproval", RUNNING: "running", SUCCEEDED: "succeeded",
  FAILED: "failed", TIMED_OUT: "timedOut", SKIPPED: "skipped", CANCELLED: "cancelled",
} as const;

export default async function RemediationPage({ params }: PageProps<"/[locale]/remediation">) {
  const { locale } = await params;
  setRequestLocale(locale);
  const { actor } = await requireActor("remediation:read");
  const t = await getTranslations();
  const format = await getFormatter();
  const db = getPrisma();

  const [actions, hosts, executions] = await Promise.all([listRemediationActions(db, actor), listRemediationHosts(db, actor), listExecutions(db, actor, { limit: 50 })]);
  if (!actions.ok || !hosts.ok || !executions.ok) return null;

  const canWrite = can(actor.role, "remediation:write");
  const canRun = can(actor.role, "remediation:run");
  const hostOptions = hosts.value.map((host) => ({ id: host.id, label: host.label }));
  const modeLabel = (mode: string | null, count: number) =>
    mode === "disabled" || mode === "allowlist" || mode === "any" ? t(`remediation.mode.${mode}`, { count }) : t("remediation.mode.unknown");
  const reasonLabel = (reason: string | null) => {
    const known = STATUS_REASONS.find((r) => r === reason);
    return known ? t(`remediation.reason.${known}`) : null;
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <PageHeader icon={Wrench} title={t("remediation.title")} subtitle={t("remediation.subtitle")} />
        {canWrite ? <CreateRemediationActionDialog hosts={hostOptions} /> : null}
      </div>
      <p className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{t("remediation.warning")}</p>

      <Card>
        <CardContent className="overflow-x-auto pt-6">
          {actions.value.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("remediation.empty")}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("remediation.action")}</TableHead>
                  <TableHead>{t("remediation.targetHost")}</TableHead>
                  <TableHead>{t("remediation.sha256")}</TableHead>
                  <TableHead className="text-right">{t("remediation.actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {actions.value.map((action) => (
                  <TableRow key={action.id} data-testid={`remediation-action-${action.name}`}>
                    <TableCell className="align-top">
                      <div className="font-medium">{action.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {t(`remediation.runtimes.${action.runtime.toLowerCase() as "bash" | "powershell" | "python"}`)} · {t("remediation.timeout")} {action.timeoutSec} s
                      </div>
                      <div className="mt-1 space-x-1">
                        {action.requiresApproval ? <Badge variant="outline">{t("remediation.requiresApproval")}</Badge> : null}
                        {!action.enabled ? <Badge variant="secondary">{t("common.disabled")}</Badge> : null}
                      </div>
                      <details className="mt-1 text-xs">
                        <summary className="cursor-pointer text-muted-foreground">{t("remediation.script")}</summary>
                        <pre className="mt-1 max-h-60 overflow-auto rounded bg-muted p-2 font-mono">{action.scriptBody}</pre>
                      </details>
                    </TableCell>
                    <TableCell className="align-top text-muted-foreground">{action.targetHostLabel ?? t("remediation.sameHostAsIncident")}</TableCell>
                    <TableCell className="align-top">
                      <code className="break-all font-mono text-xs" title={t("remediation.sha256Help")} data-testid="action-sha256">{action.scriptSha256}</code>
                    </TableCell>
                    <TableCell className="space-y-2 align-top">
                      {canRun ? <RunActionForm action={action} hosts={hosts.value} /> : null}
                      {canWrite ? <RemediationActionAdmin action={action} hosts={hostOptions} /> : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("remediation.executions")}</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {executions.value.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("remediation.executionsEmpty")}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("remediation.when")}</TableHead>
                  <TableHead>{t("remediation.action")}</TableHead>
                  <TableHead>{t("remediation.host")}</TableHead>
                  <TableHead>{t("remediation.status")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {executions.value.map((execution) => (
                  <TableRow key={execution.id} data-testid="execution-row">
                    <TableCell className="align-top text-muted-foreground">
                      {format.dateTime(execution.createdAt, { dateStyle: "short", timeStyle: "medium" })}
                      <div className="text-xs">
                        {execution.trigger === "ALERT" ? t("remediation.byAlert") : execution.requestedByEmail ? t("remediation.requestedBy", { email: execution.requestedByEmail }) : null}
                      </div>
                      {execution.approvedByEmail ? <div className="text-xs">{t("remediation.approvedBy", { email: execution.approvedByEmail })}</div> : null}
                    </TableCell>
                    <TableCell className="align-top">{execution.actionName}</TableCell>
                    <TableCell className="align-top text-muted-foreground">{execution.hostLabel ?? "—"}</TableCell>
                    <TableCell className="space-y-1 align-top">
                      <Badge variant={execution.status === "SUCCEEDED" ? "default" : execution.status === "FAILED" || execution.status === "TIMED_OUT" ? "destructive" : "secondary"} data-testid="execution-status">
                        {t(`remediation.executionStatus.${STATUS_KEY[execution.status]}`)}
                      </Badge>
                      {reasonLabel(execution.statusReason) ? <div className="text-xs text-muted-foreground" data-testid="execution-reason">{reasonLabel(execution.statusReason)}</div> : null}
                      {execution.exitCode !== null ? <div className="text-xs text-muted-foreground">{t("remediation.exitCode")}: {execution.exitCode}</div> : null}
                      {execution.durationMs !== null ? <div className="text-xs text-muted-foreground">{t("remediation.duration")}: {formatDuration(execution.durationMs)}</div> : null}
                      {execution.stdout || execution.stderr ? (
                        <details className="text-xs">
                          <summary className="cursor-pointer text-muted-foreground">{t("remediation.output")}</summary>
                          {execution.stdout ? <pre className="mt-1 max-h-60 overflow-auto rounded bg-muted p-2 font-mono" data-testid="execution-stdout">{execution.stdout}</pre> : null}
                          {execution.stderr ? <pre className="mt-1 max-h-60 overflow-auto rounded bg-destructive/10 p-2 font-mono">{execution.stderr}</pre> : null}
                        </details>
                      ) : null}
                      {canRun ? <ExecutionDecision executionId={execution.id} status={execution.status} /> : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("remediation.hostsTitle")}</CardTitle>
          <p className="text-sm text-muted-foreground">{t("remediation.hostsHelp")}</p>
        </CardHeader>
        <CardContent>
          <ul className="space-y-1 text-sm">
            {hosts.value.map((host) => (
              <li key={host.id} className="flex justify-between gap-4" data-testid={`host-policy-${host.label}`}>
                <span>{host.label}</span>
                <span className="text-muted-foreground">{modeLabel(host.remediationMode, host.remediationAllowlist.length)}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
