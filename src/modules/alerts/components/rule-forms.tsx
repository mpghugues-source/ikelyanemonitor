"use client";

import type { MetricSource } from "@/generated/prisma/enums";
import { Pencil, Power, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { createAlertRuleAction, deleteAlertRuleAction, toggleAlertRuleAction, updateAlertRuleAction } from "@/app/actions/alerts";
import { ActionForm } from "@/components/forms/action-form";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { ALERT_OPERATORS, ALERT_SEVERITIES, ANOMALY_SENSITIVITIES, ALERT_SOURCE_KINDS, METRICS_BY_SOURCE_KIND, metricTypeMessageKey, NOTIFICATION_CHANNELS, sourceKindMessageKey } from "@/modules/alerts/constants";
import type { AlertRuleRow } from "@/modules/alerts/rules";

const NAMESPACES = ["alertsAdmin.errors", "auth.errors"];

export interface SourceOption {
  id: string;
  label: string;
}

/** Choices for the form's selects: sources per kind, plus the organization's remediation actions. */
interface SourceOptions {
  HOST: SourceOption[];
  NETWORK_DEVICE: SourceOption[];
  DATABASE: SourceOption[];
  ENDPOINT: SourceOption[];
  remediationActions: SourceOption[];
}

function RuleFields({ rule, sources }: { rule?: AlertRuleRow; sources: SourceOptions }) {
  const t = useTranslations();
  const [sourceKind, setSourceKind] = useState<MetricSource>(rule?.sourceKind ?? "HOST");
  const metrics = METRICS_BY_SOURCE_KIND[sourceKind];
  const sourceOptions: SourceOption[] = sourceKind === "NETWORK_INTERFACE" ? [] : sources[sourceKind];

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="space-y-2 sm:col-span-2">
        <Label htmlFor="name">{t("alerts.rule")}</Label>
        <Input id="name" name="name" required maxLength={120} defaultValue={rule?.name} placeholder="Disk almost full" />
      </div>
      <div className="space-y-2 sm:col-span-2">
        <Label htmlFor="description">{t("common.description")}</Label>
        <Input id="description" name="description" maxLength={500} defaultValue={rule?.description ?? ""} />
      </div>

      <div className="space-y-2">
        <Label htmlFor="sourceKind">{t("alertsAdmin.sourceKind")}</Label>
        <NativeSelect
          id="sourceKind"
          name="sourceKind"
          value={sourceKind}
          onChange={(event) => setSourceKind(event.target.value as MetricSource)}
        >
          {ALERT_SOURCE_KINDS.map((kind) => (
            <option key={kind} value={kind}>{t(`topology.nodeKind.${sourceKindMessageKey(kind)}`)}</option>
          ))}
        </NativeSelect>
      </div>
      <div className="space-y-2">
        <Label htmlFor="sourceId">{t("alertsAdmin.source")}</Label>
        <NativeSelect id="sourceId" name="sourceId" defaultValue={rule?.sourceId ?? ""}>
          <option value="">{t("alerts.allSources")}</option>
          {sourceOptions.map((option) => (
            <option key={option.id} value={option.id}>{option.label}</option>
          ))}
        </NativeSelect>
      </div>

      <div className="space-y-2">
        <Label htmlFor="metric">{t("alerts.metric")}</Label>
        <NativeSelect id="metric" name="metric" defaultValue={rule?.metric ?? metrics[0]}>
          {metrics.map((metric) => (
            <option key={metric} value={metric}>{t(`metricType.${metricTypeMessageKey(metric)}`)}</option>
          ))}
        </NativeSelect>
      </div>
      <div className="space-y-2">
        <Label htmlFor="instanceFilter">{t("alertsAdmin.instanceFilter")}</Label>
        <Input id="instanceFilter" name="instanceFilter" maxLength={200} defaultValue={rule?.instanceFilter ?? ""} placeholder="/var, eth0…" />
        <p className="text-xs text-muted-foreground">{t("alertsAdmin.instanceFilterHelp")}</p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="operator">{t("alerts.operator")}</Label>
        <NativeSelect id="operator" name="operator" defaultValue={rule ? (rule.operator ?? "") : "GT"}>
          {ALERT_OPERATORS.map((operator) => (
            <option key={operator} value={operator}>{t(`alerts.operators.${operator.toLowerCase()}`)}</option>
          ))}
          <option value="">{t("alertsAdmin.noThreshold")}</option>
        </NativeSelect>
      </div>
      <div className="space-y-2">
        <Label htmlFor="threshold">{t("alerts.threshold")}</Label>
        <Input id="threshold" name="threshold" type="number" step="any" defaultValue={rule?.threshold ?? undefined} />
        <p className="text-xs text-muted-foreground">{t("alertsAdmin.thresholdHelp")}</p>
      </div>

      <div className="space-y-2">
        <label className="flex items-center gap-2 text-sm font-medium">
          <Checkbox name="anomalyDetection" value="true" defaultChecked={rule?.anomalyDetection ?? false} data-testid="rule-anomaly" />
          {t("alerts.anomalyDetection")}
        </label>
        <p className="text-xs text-muted-foreground">{t("alertsAdmin.anomalyHelp")}</p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="anomalySensitivity">{t("alerts.anomalySensitivity")}</Label>
        <NativeSelect id="anomalySensitivity" name="anomalySensitivity" defaultValue={rule?.anomalySensitivity ?? "MEDIUM"}>
          {ANOMALY_SENSITIVITIES.map((sensitivity) => (
            <option key={sensitivity} value={sensitivity}>{t(`alerts.sensitivity.${sensitivity.toLowerCase()}`)}</option>
          ))}
        </NativeSelect>
      </div>

      <div className="space-y-2">
        <Label htmlFor="durationSec">{t("alerts.duration")} (s)</Label>
        <Input id="durationSec" name="durationSec" type="number" min={0} max={86400} required defaultValue={rule?.durationSec ?? 300} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="severity">{t("alerts.severity")}</Label>
        <NativeSelect id="severity" name="severity" defaultValue={rule?.severity ?? "WARNING"}>
          {ALERT_SEVERITIES.map((severity) => (
            <option key={severity} value={severity}>{t(`severity.${severity.toLowerCase()}`)}</option>
          ))}
        </NativeSelect>
      </div>

      <div className="space-y-2 sm:col-span-2">
        <Label>{t("alerts.channels")}</Label>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {NOTIFICATION_CHANNELS.map((channel) => (
            <label key={channel} className="flex items-center gap-2 text-sm">
              <Checkbox name="channels" value={channel} defaultChecked={rule?.channels.includes(channel)} />
              {t(`alerts.channel.${channel.toLowerCase()}`)}
            </label>
          ))}
        </div>
      </div>
      <div className="space-y-2 sm:col-span-2">
        <Label htmlFor="notifyEmails">{t("alerts.notifyEmails")}</Label>
        <Input id="notifyEmails" name="notifyEmails" defaultValue={rule?.notifyEmails.join(", ")} placeholder="ops@example.com, oncall@example.com" />
      </div>
      <div className="space-y-2">
        <Label htmlFor="webhookUrl">{t("alerts.webhookUrl")}</Label>
        <Input id="webhookUrl" name="webhookUrl" type="url" maxLength={500} defaultValue={rule?.webhookUrl ?? ""} placeholder="https://…" />
      </div>
      <div className="space-y-2">
        <Label htmlFor="cooldownSec">{t("alerts.cooldown")} (s)</Label>
        <Input id="cooldownSec" name="cooldownSec" type="number" min={60} max={86400} required defaultValue={rule?.cooldownSec ?? 900} />
      </div>

      <div className="space-y-2">
        <Label htmlFor="remediationActionId">{t("alertsAdmin.remediationAction")}</Label>
        <NativeSelect id="remediationActionId" name="remediationActionId" defaultValue={rule?.remediationActionId ?? ""}>
          <option value="">{t("alertsAdmin.noRemediation")}</option>
          {sources.remediationActions.map((action) => (
            <option key={action.id} value={action.id}>{action.label}</option>
          ))}
        </NativeSelect>
      </div>
      <div className="space-y-2">
        <label className="flex items-center gap-2 text-sm font-medium">
          <Checkbox name="autoRemediate" value="true" defaultChecked={rule?.autoRemediate ?? false} data-testid="rule-auto-remediate" />
          {t("remediation.autoRemediate")}
        </label>
        <p className="text-xs text-muted-foreground">{t("alertsAdmin.autoRemediateHelp")}</p>
      </div>
    </div>
  );
}

export function CreateAlertRuleDialog({ sources }: { sources: SourceOptions }) {
  const t = useTranslations("alertsAdmin");
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button>{t("create")}</Button>} />
      <DialogContent className="sm:max-w-2xl">
        <ActionForm
          action={async (previous, formData) => {
            const result = await createAlertRuleAction(previous, formData);
            if (result.status === "success") setOpen(false);
            return result;
          }}
          namespaces={NAMESPACES}
          className="space-y-4"
        >
          {({ pending }) => (
            <>
              <DialogHeader>
                <DialogTitle>{t("createTitle")}</DialogTitle>
                <DialogDescription>{t("createTitle")}</DialogDescription>
              </DialogHeader>
              <RuleFields sources={sources} />
              <DialogFooter>
                <Button type="submit" disabled={pending}>{pending ? t("creating") : t("create")}</Button>
              </DialogFooter>
            </>
          )}
        </ActionForm>
      </DialogContent>
    </Dialog>
  );
}

function EditAlertRuleDialog({ rule, sources }: { rule: AlertRuleRow; sources: SourceOptions }) {
  const t = useTranslations("alertsAdmin");
  const tc = useTranslations("common");
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="icon-sm" variant="ghost" aria-label={tc("edit")}><Pencil className="size-4" aria-hidden /></Button>} />
      <DialogContent className="sm:max-w-2xl">
        <ActionForm
          action={async (previous, formData) => {
            const result = await updateAlertRuleAction(previous, formData);
            if (result.status === "success") setOpen(false);
            return result;
          }}
          namespaces={NAMESPACES}
          className="space-y-4"
        >
          {({ pending }) => (
            <>
              <DialogHeader>
                <DialogTitle>{t("editTitle")}</DialogTitle>
              </DialogHeader>
              <input type="hidden" name="id" value={rule.id} />
              <RuleFields rule={rule} sources={sources} />
              <DialogFooter>
                <Button type="submit" disabled={pending}>{pending ? tc("loading") : tc("save")}</Button>
              </DialogFooter>
            </>
          )}
        </ActionForm>
      </DialogContent>
    </Dialog>
  );
}

export function AlertRuleActions({ rule, sources }: { rule: AlertRuleRow; sources: SourceOptions }) {
  const t = useTranslations("alertsAdmin");
  const tc = useTranslations("common");
  return (
    <div className="flex items-center justify-end gap-1">
      <EditAlertRuleDialog rule={rule} sources={sources} />
      <ActionForm action={toggleAlertRuleAction} namespaces={NAMESPACES}>
        {({ pending }) => (
          <>
            <input type="hidden" name="id" value={rule.id} />
            <input type="hidden" name="enabled" value={String(!rule.enabled)} />
            <Button type="submit" size="icon-sm" variant="ghost" disabled={pending} aria-label={rule.enabled ? t("actions.disable") : t("actions.enable")}>
              <Power className="size-4" aria-hidden />
            </Button>
          </>
        )}
      </ActionForm>
      <ActionForm action={deleteAlertRuleAction} namespaces={NAMESPACES} confirm={t("actions.deleteConfirm", { name: rule.name })}>
        {({ pending }) => (
          <>
            <input type="hidden" name="id" value={rule.id} />
            <Button type="submit" size="icon-sm" variant="ghost" disabled={pending} aria-label={tc("delete")}>
              <Trash2 className="size-4" aria-hidden />
            </Button>
          </>
        )}
      </ActionForm>
    </div>
  );
}
