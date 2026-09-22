"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { acknowledgeIncidentAction, addIncidentNoteAction, reopenIncidentAction, resolveIncidentAction } from "@/app/actions/incidents";
import { ActionForm } from "@/components/forms/action-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { formatDuration } from "@/lib/format";
import { AUTO_RESOLUTION_NOTE, metricTypeMessageKey, sourceKindMessageKey } from "@/modules/alerts/constants";
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
