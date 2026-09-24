"use client";

import { Pencil, Play, Power, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import {
  approveExecutionAction,
  cancelExecutionAction,
  createRemediationActionAction,
  deleteRemediationActionAction,
  runRemediationAction,
  toggleRemediationActionAction,
  updateRemediationActionAction,
} from "@/app/actions/remediation";
import { ActionForm } from "@/components/forms/action-form";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import type { RemediationActionRow, RemediationHostRow } from "@/modules/remediation/actions";
import { OS_FAMILIES, SCRIPT_RUNTIMES, STATUS_REASONS } from "@/modules/remediation/constants";

const NAMESPACES = ["remediation.errors", "auth.errors"];

export interface HostOption {
  id: string;
  label: string;
}

function ActionFields({ action, hosts }: { action?: RemediationActionRow; hosts: HostOption[] }) {
  const t = useTranslations();
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <p className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm text-destructive sm:col-span-2">{t("remediation.warning")}</p>
      <div className="space-y-2 sm:col-span-2">
        <Label htmlFor="name">{t("common.name")}</Label>
        <Input id="name" name="name" required maxLength={120} defaultValue={action?.name} placeholder="Restart nginx" />
      </div>
      <div className="space-y-2 sm:col-span-2">
        <Label htmlFor="description">{t("common.description")}</Label>
        <Input id="description" name="description" maxLength={500} defaultValue={action?.description ?? ""} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="runtime">{t("remediation.runtime")}</Label>
        <NativeSelect id="runtime" name="runtime" defaultValue={action?.runtime ?? "BASH"}>
          {SCRIPT_RUNTIMES.map((runtime) => (
            <option key={runtime} value={runtime}>{t(`remediation.runtimes.${runtime.toLowerCase()}`)}</option>
          ))}
        </NativeSelect>
      </div>
      <div className="space-y-2">
        <Label htmlFor="targetHostId">{t("remediation.targetHost")}</Label>
        <NativeSelect id="targetHostId" name="targetHostId" defaultValue={action?.targetHostId ?? ""}>
          <option value="">{t("remediation.sameHostAsIncident")}</option>
          {hosts.map((host) => (
            <option key={host.id} value={host.id}>{host.label}</option>
          ))}
        </NativeSelect>
      </div>
      <div className="space-y-2 sm:col-span-2">
        <Label htmlFor="scriptBody">{t("remediation.script")}</Label>
        <Textarea id="scriptBody" name="scriptBody" required rows={8} spellCheck={false} className="font-mono text-xs" defaultValue={action?.scriptBody ?? "#!/usr/bin/env bash\nset -euo pipefail\n"} />
        <p className="text-xs text-muted-foreground">{t("remediation.scriptHelp")}</p>
      </div>
      <div className="space-y-2 sm:col-span-2">
        <Label htmlFor="args">{t("remediation.args")}</Label>
        <Textarea
          id="args"
          name="args"
          rows={3}
          spellCheck={false}
          className="font-mono text-xs"
          placeholder="SERVICE=nginx"
          defaultValue={action ? Object.entries(action.args).map(([name, value]) => `${name}=${value}`).join("\n") : ""}
        />
        <p className="text-xs text-muted-foreground">{t("remediation.argsHelp")}</p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="timeoutSec">{t("remediation.timeout")} (s)</Label>
        <Input id="timeoutSec" name="timeoutSec" type="number" min={1} max={3600} required defaultValue={action?.timeoutSec ?? 60} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="cooldownSec">{t("remediation.cooldown")} (s)</Label>
        <Input id="cooldownSec" name="cooldownSec" type="number" min={0} max={86400} required defaultValue={action?.cooldownSec ?? 300} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="maxRunsPerHour">{t("remediation.maxRunsPerHour")}</Label>
        <Input id="maxRunsPerHour" name="maxRunsPerHour" type="number" min={1} max={60} required defaultValue={action?.maxRunsPerHour ?? 3} />
      </div>
      <div className="space-y-2">
        <label className="flex items-center gap-2 text-sm font-medium">
          <Checkbox name="requiresApproval" value="true" defaultChecked={action?.requiresApproval ?? true} data-testid="action-requires-approval" />
          {t("remediation.requiresApproval")}
        </label>
        <p className="text-xs text-muted-foreground">{t("remediation.requiresApprovalHelp")}</p>
      </div>
      <div className="space-y-2 sm:col-span-2">
        <Label>{t("remediation.allowedOs")}</Label>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {OS_FAMILIES.map((family) => (
            <label key={family} className="flex items-center gap-2 text-sm">
              <Checkbox name="allowedOsFamilies" value={family} defaultChecked={action?.allowedOsFamilies.includes(family)} />
              {family}
            </label>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">{t("remediation.allowedOsHelp")}</p>
      </div>
    </div>
  );
}

export function CreateRemediationActionDialog({ hosts }: { hosts: HostOption[] }) {
  const t = useTranslations("remediation");
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button>{t("create")}</Button>} />
      <DialogContent className="sm:max-w-2xl">
        <ActionForm
          action={async (previous, formData) => {
            const result = await createRemediationActionAction(previous, formData);
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
                <DialogDescription>{t("subtitle")}</DialogDescription>
              </DialogHeader>
              <ActionFields hosts={hosts} />
              <DialogFooter>
                <Button type="submit" disabled={pending}>{pending ? t("creating") : t("save")}</Button>
              </DialogFooter>
            </>
          )}
        </ActionForm>
      </DialogContent>
    </Dialog>
  );
}

function EditRemediationActionDialog({ action, hosts }: { action: RemediationActionRow; hosts: HostOption[] }) {
  const t = useTranslations("remediation");
  const tc = useTranslations("common");
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="icon-sm" variant="ghost" aria-label={tc("edit")}><Pencil className="size-4" aria-hidden /></Button>} />
      <DialogContent className="sm:max-w-2xl">
        <ActionForm
          action={async (previous, formData) => {
            const result = await updateRemediationActionAction(previous, formData);
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
              <input type="hidden" name="id" value={action.id} />
              <ActionFields action={action} hosts={hosts} />
              <DialogFooter>
                <Button type="submit" disabled={pending}>{pending ? t("creating") : t("save")}</Button>
              </DialogFooter>
            </>
          )}
        </ActionForm>
      </DialogContent>
    </Dialog>
  );
}

/** Admin-only configuration actions of one row. */
export function RemediationActionAdmin({ action, hosts }: { action: RemediationActionRow; hosts: HostOption[] }) {
  const tc = useTranslations("common");
  const t = useTranslations("remediation");
  return (
    <div className="flex items-center justify-end gap-1">
      <EditRemediationActionDialog action={action} hosts={hosts} />
      <ActionForm action={toggleRemediationActionAction} namespaces={NAMESPACES}>
        {({ pending }) => (
          <>
            <input type="hidden" name="id" value={action.id} />
            <input type="hidden" name="enabled" value={String(!action.enabled)} />
            <Button type="submit" size="icon-sm" variant="ghost" disabled={pending} aria-label={action.enabled ? t("disable") : t("enable")}>
              <Power className="size-4" aria-hidden />
            </Button>
          </>
        )}
      </ActionForm>
      <ActionForm action={deleteRemediationActionAction} namespaces={NAMESPACES} confirm={t("deleteConfirm", { name: action.name })}>
        {({ pending }) => (
          <>
            <input type="hidden" name="id" value={action.id} />
            <Button type="submit" size="icon-sm" variant="ghost" disabled={pending} aria-label={tc("delete")}>
              <Trash2 className="size-4" aria-hidden />
            </Button>
          </>
        )}
      </ActionForm>
    </div>
  );
}

/** "Run now" (operators and above). A host must be picked unless the action has a fixed target. */
export function RunActionForm({ action, hosts }: { action: RemediationActionRow; hosts: RemediationHostRow[] }) {
  const t = useTranslations("remediation");
  if (!action.enabled) return null;
  return (
    <ActionForm action={runRemediationAction} namespaces={NAMESPACES} className="flex flex-wrap items-center justify-end gap-2">
      {({ pending, state }) => (
        <>
          <input type="hidden" name="actionId" value={action.id} />
          {action.targetHostId ? null : (
            <NativeSelect name="hostId" required aria-label={t("chooseHost")} defaultValue="" className="max-w-48">
              <option value="" disabled>{t("chooseHost")}</option>
              {hosts.map((host) => (
                <option key={host.id} value={host.id}>
                  {host.label} — {host.remediationMode ? t(`mode.${host.remediationMode as "disabled" | "allowlist" | "any"}`, { count: host.remediationAllowlist.length }) : t("mode.unknown")}
                </option>
              ))}
            </NativeSelect>
          )}
          <Button type="submit" size="sm" variant="outline" disabled={pending} data-testid="run-action">
            <Play className="size-4" aria-hidden />
            {pending ? t("queuing") : t("run")}
          </Button>
          {state.status === "success" && state.data ? (
            <p role="status" className="w-full text-right text-xs text-muted-foreground" data-testid="run-outcome">
              {state.data.status === "SKIPPED"
                ? t("skipped", { reason: t(`reason.${(STATUS_REASONS.find((r) => r === state.data?.reason) ?? "start_failed") as "start_failed"}`) })
                : t("queued")}
            </p>
          ) : null}
        </>
      )}
    </ActionForm>
  );
}

/** Approve / cancel buttons for an execution that is waiting (operators and above). */
export function ExecutionDecision({ executionId, status }: { executionId: string; status: string }) {
  const t = useTranslations("remediation");
  if (status !== "AWAITING_APPROVAL" && status !== "PENDING") return null;
  return (
    <div className="flex items-center gap-2">
      {status === "AWAITING_APPROVAL" ? (
        <ActionForm action={approveExecutionAction} namespaces={NAMESPACES}>
          {({ pending }) => (
            <>
              <input type="hidden" name="id" value={executionId} />
              <Button type="submit" size="sm" disabled={pending} data-testid="approve-execution">{pending ? t("approving") : t("approve")}</Button>
            </>
          )}
        </ActionForm>
      ) : null}
      <ActionForm action={cancelExecutionAction} namespaces={NAMESPACES}>
        {({ pending }) => (
          <>
            <input type="hidden" name="id" value={executionId} />
            <Button type="submit" size="sm" variant="outline" disabled={pending} data-testid="cancel-execution">{pending ? t("cancelling") : t("cancel")}</Button>
          </>
        )}
      </ActionForm>
    </div>
  );
}
