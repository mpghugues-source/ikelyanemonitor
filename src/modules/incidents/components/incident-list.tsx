"use client";

import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { acknowledgeIncidentAction, addIncidentNoteAction, reanalyzeIncidentAction, reopenIncidentAction, resolveIncidentAction } from "@/app/actions/incidents";
import { ActionForm } from "@/components/forms/action-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { formatDuration } from "@/lib/format";
import { AUTO_RESOLUTION_NOTE, metricTypeMessageKey, sourceKindMessageKey } from "@/modules/alerts/constants";
import type { RcaIncidentRef } from "@/modules/aiops/rca";
import { ExecutionDecision } from "@/modules/remediation/components/remediation-forms";
import { STATUS_REASONS } from "@/modules/remediation/constants";
import type { IncidentRow } from "@/modules/incidents/service";

const NAMESPACES = ["incidentsAdmin.errors", "auth.errors"];

function severityVariant(severity: IncidentRow["severity"]): "destructive" | "secondary" | "outline" {
  if (severity === "CRITICAL") return "destructive";
  if (severity === "WARNING") return "secondary";
  return "outline";
}

function EventLine({ event, now }: { event: IncidentRow["events"][number]; now: Date }) {
  const t = useTranslations();
  const eventKey = { OPENED: "opened", ACKNOWLEDGED: "acknowledged", NOTE: "note", NOTIFIED: "notified", REMEDIATION_STARTED: "remediationStarted", REMEDIATION_FINISHED: "remediationFinished", RCA_GENERATED: "rcaGenerated", RESOLVED: "resolved", REOPENED: "reopened" }[event.type];
  const isSystemResolution = event.type === "RESOLVED" && event.message === AUTO_RESOLUTION_NOTE;

  return (
    <li className="flex items-start justify-between gap-3 border-t py-2 text-sm first:border-t-0">
      <div>
        <span className="font-medium">{t(`incidents.event.${eventKey}`)}</span>
        {isSystemResolution ? <p className="text-muted-foreground">{t("incidentsAdmin.systemResolved")}</p> : null}
        {!isSystemResolution && event.message ? <p className="text-muted-foreground">{event.message}</p> : null}
        {event.actorEmail ? <p className="text-xs text-muted-foreground">{event.actorEmail}</p> : null}
      </div>
      <span className="shrink-0 text-xs text-muted-foreground">{formatDuration(now.getTime() - event.createdAt.getTime())}</span>
    </li>
  );
}

function AddNoteForm({ incidentId }: { incidentId: string }) {
  const t = useTranslations("incidentsAdmin");
  return (
    <ActionForm action={addIncidentNoteAction} namespaces={NAMESPACES} className="flex gap-2">
      {({ pending }) => (
        <>
          <input type="hidden" name="id" value={incidentId} />
          <Textarea name="message" required maxLength={2000} placeholder={t("notePlaceholder")} className="min-h-9" />
          <Button type="submit" variant="outline" disabled={pending}>{pending ? t("adding") : t("addNote")}</Button>
        </>
      )}
    </ActionForm>
  );
}

function ResolveForm({ incidentId }: { incidentId: string }) {
  const t = useTranslations("incidentsAdmin");
  const ti = useTranslations("incidents");
  const [open, setOpen] = useState(false);
  if (!open) return <Button size="sm" onClick={() => setOpen(true)}>{ti("resolve")}</Button>;
  return (
    <ActionForm action={resolveIncidentAction} namespaces={NAMESPACES} className="flex flex-1 gap-2">
      {({ pending }) => (
        <>
          <input type="hidden" name="id" value={incidentId} />
          <Textarea name="note" maxLength={2000} placeholder={t("resolutionNotePlaceholder")} className="min-h-9" />
          <Button type="submit" disabled={pending}>{pending ? t("resolving") : ti("resolve")}</Button>
        </>
      )}
    </ActionForm>
  );
}

function RefList({ refs }: { refs: RcaIncidentRef[] }) {
  const t = useTranslations();
  const offset = (sec: number) =>
    sec === 0 ? t("aiops.offsetSame") : t(sec < 0 ? "aiops.offsetBefore" : "aiops.offsetAfter", { duration: formatDuration(Math.abs(sec) * 1000) });
  return (
    <ul className="ml-4 list-disc text-muted-foreground">
      {refs.map((ref) => (
        <li key={ref.incidentId}>
          {ref.title}
          {ref.sourceLabel ? ` — ${ref.sourceLabel}` : ""}
          {ref.metric ? ` · ${t(`metricType.${metricTypeMessageKey(ref.metric)}`)}` : ""} ({offset(ref.offsetSec)})
        </li>
      ))}
    </ul>
  );
}

/** Deterministic findings (translated here from their structured form) + the optional Claude narrative. */
function RcaPanel({ incident, canAct }: { incident: IncidentRow; canAct: boolean }) {
  const t = useTranslations("aiops");
  const format = useFormatter();
  const locale = useLocale();
  const { rca } = incident;
  const findings = rca.findings;
  const narrative = locale === "fr" ? rca.summaryFr : rca.summaryEn;
  const percent = (value: number) => format.number(value, { style: "percent", maximumFractionDigits: 0 });

  return (
    <section className="space-y-2 rounded-md border p-3 text-sm" data-testid="rca-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium">{t("rootCause")}</h3>
        <div className="flex items-center gap-2">
          {incident.anomalyScore !== null ? (
            <Badge variant="outline" data-testid="anomaly-score">{t("anomalyScore")}: {percent(incident.anomalyScore)}</Badge>
          ) : null}
          {rca.confidence !== null ? <Badge variant="secondary">{t("confidenceValue", { value: percent(rca.confidence) })}</Badge> : null}
        </div>
      </div>

      {findings ? (
        <div className="space-y-2">
          <p data-testid="rca-verdict">{t(`verdict.${findings.verdict}`, { node: findings.node ?? incident.sourceLabel ?? "?" })}</p>
          {findings.rootCauses.length > 0 ? (
            <div>
              <p className="font-medium">{t("probableOrigin")}</p>
              {findings.rootCauses.map((root) => (
                <div key={root.label} data-testid="rca-root">
                  <p>{root.label}</p>
                  <RefList refs={root.incidents} />
                </div>
              ))}
            </div>
          ) : null}
          {findings.impacted.length > 0 ? (
            <div>
              <p className="font-medium">{t("alsoFailing")}</p>
              {findings.impacted.map((node) => (
                <div key={node.label} data-testid="rca-impacted">
                  <p>{node.label}</p>
                  <RefList refs={node.incidents} />
                </div>
              ))}
            </div>
          ) : null}
          {findings.blastRadius.count > 0 ? (
            <p className="text-muted-foreground">{t("blastRadius", { count: findings.blastRadius.count, labels: findings.blastRadius.labels.join(", ") })}</p>
          ) : null}
          {findings.sameSource.length > 0 ? (
            <div>
              <p className="font-medium">{t("sameSource")}</p>
              <RefList refs={findings.sameSource} />
            </div>
          ) : null}
          {findings.correlated.length > 0 ? (
            <div>
              <p className="font-medium">{t("correlatedNoLink")}</p>
              <RefList refs={findings.correlated} />
            </div>
          ) : null}
          {findings.firstToStart && (findings.correlated.length > 0 || findings.impacted.length > 0) ? (
            <p className="text-muted-foreground">{t("firstToStart")}</p>
          ) : null}
          <p className="text-xs text-muted-foreground">{t("deterministic")}</p>
        </div>
      ) : (
        <p className="text-muted-foreground">{t("noAnalysis")}</p>
      )}

      {narrative ? (
        <div className="space-y-1 border-t pt-2" data-testid="rca-narrative">
          <p className="font-medium">{t("summary")}</p>
          <p className="whitespace-pre-line">{narrative}</p>
          <p className="text-xs text-muted-foreground">{t("aiGenerated")}</p>
        </div>
      ) : rca.narrativePending ? (
        <p className="border-t pt-2 text-muted-foreground">{t("narrativePending")}</p>
      ) : rca.narrativeFailed ? (
        <p className="border-t pt-2 text-muted-foreground">{t("narrativeFailed")}</p>
      ) : null}

      {canAct ? (
        <ActionForm action={reanalyzeIncidentAction} namespaces={["aiops.errors", ...NAMESPACES]}>
          {({ pending }) => (
            <>
              <input type="hidden" name="id" value={incident.id} />
              <Button type="submit" variant="outline" size="sm" disabled={pending} data-testid="rca-reanalyze">
                {pending ? t("reanalyzing") : t("reanalyze")}
              </Button>
            </>
          )}
        </ActionForm>
      ) : null}
    </section>
  );
}

const EXECUTION_STATUS_KEY: Record<string, string> = {
  PENDING: "pending", AWAITING_APPROVAL: "awaitingApproval", RUNNING: "running", SUCCEEDED: "succeeded",
  FAILED: "failed", TIMED_OUT: "timedOut", SKIPPED: "skipped", CANCELLED: "cancelled",
};

function RemediationList({ incident, canAct }: { incident: IncidentRow; canAct: boolean }) {
  const t = useTranslations("remediation");
  if (incident.remediations.length === 0) return null;
  return (
    <section className="space-y-2 rounded-md border p-3 text-sm" data-testid="incident-remediations">
      <h3 className="font-medium">{t("title")}</h3>
      <ul className="space-y-2">
        {incident.remediations.map((execution) => {
          const reason = STATUS_REASONS.find((r) => r === execution.statusReason);
          return (
            <li key={execution.id} className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <span className="font-medium">{execution.actionName}</span>
                {execution.hostLabel ? <span className="text-muted-foreground"> — {execution.hostLabel}</span> : null}
                <span className="ml-2"><Badge variant="secondary" data-testid="incident-remediation-status">{t(`executionStatus.${EXECUTION_STATUS_KEY[execution.status] ?? "pending"}`)}</Badge></span>
                {reason ? <div className="text-xs text-muted-foreground">{t(`reason.${reason}`)}</div> : null}
                {execution.exitCode !== null ? <div className="text-xs text-muted-foreground">{t("exitCode")}: {execution.exitCode}</div> : null}
              </div>
              {canAct ? <ExecutionDecision executionId={execution.id} status={execution.status} /> : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function IncidentCard({ incident, canAct, now }: { incident: IncidentRow; canAct: boolean; now: Date }) {
  const t = useTranslations();
  const ti = useTranslations("incidents");
  const tia = useTranslations("incidentsAdmin");

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <Badge variant={severityVariant(incident.severity)}>{t(`severity.${incident.severity.toLowerCase()}`)}</Badge>
              <span className="font-medium">{incident.title}</span>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {incident.sourceKind ? t(`topology.nodeKind.${sourceKindMessageKey(incident.sourceKind)}`) : null}
              {incident.sourceLabel ? ` — ${incident.sourceLabel}` : ""}
              {incident.metric ? ` · ${t(`metricType.${metricTypeMessageKey(incident.metric)}`)}` : ""}
              {incident.triggerValue !== null ? ` = ${incident.triggerValue}` : ""}
            </p>
          </div>
          <div className="text-right text-sm text-muted-foreground">
            <div>{ti(`status.${incident.status.toLowerCase() as "open" | "acknowledged" | "resolved"}`)}</div>
            <div>{ti("duration")}: {formatDuration((incident.resolvedAt ?? now).getTime() - incident.startedAt.getTime())}</div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {incident.peakValue !== null && incident.peakValue !== incident.triggerValue ? (
          <p className="text-sm text-muted-foreground">{ti("peakValue")}: {incident.peakValue}</p>
        ) : null}
        {incident.resolutionNote && incident.resolutionNote !== AUTO_RESOLUTION_NOTE ? (
          <p className="text-sm">{ti("resolutionNote")}: {incident.resolutionNote}</p>
        ) : null}

        <RcaPanel incident={incident} canAct={canAct} />
        <RemediationList incident={incident} canAct={canAct} />

        {canAct ? (
          <div className="flex flex-wrap items-center gap-2">
            {incident.status === "OPEN" ? (
              <ActionForm action={acknowledgeIncidentAction} namespaces={NAMESPACES}>
                {({ pending }) => (
                  <>
                    <input type="hidden" name="id" value={incident.id} />
                    <Button type="submit" variant="outline" size="sm" disabled={pending}>{pending ? tia("acknowledging") : ti("acknowledge")}</Button>
                  </>
                )}
              </ActionForm>
            ) : null}
            {incident.status !== "RESOLVED" ? <ResolveForm incidentId={incident.id} /> : null}
            {incident.status === "RESOLVED" ? (
              <ActionForm action={reopenIncidentAction} namespaces={NAMESPACES}>
                {({ pending }) => (
                  <>
                    <input type="hidden" name="id" value={incident.id} />
                    <Button type="submit" variant="outline" size="sm" disabled={pending}>{pending ? tia("reopening") : ti("reopen")}</Button>
                  </>
                )}
              </ActionForm>
            ) : null}
          </div>
        ) : null}

        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">{ti("timeline")} ({incident.events.length})</summary>
          <ul className="mt-2">
            {incident.events.map((event) => (
              <EventLine key={event.id} event={event} now={now} />
            ))}
          </ul>
        </details>

        {canAct ? <AddNoteForm incidentId={incident.id} /> : null}
      </CardContent>
    </Card>
  );
}
