"use client";

import { Pencil, Power, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { createEndpointAction, deleteEndpointAction, toggleEndpointAction, updateEndpointAction } from "@/app/actions/endpoints";
import { ActionForm } from "@/components/forms/action-form";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { HTTP_METHODS, type EndpointRow } from "@/modules/saas/endpoints";

const NAMESPACES = ["endpointAdmin.errors", "auth.errors"];

function EndpointFields({ endpoint }: { endpoint?: EndpointRow }) {
  const t = useTranslations();
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="space-y-2 sm:col-span-2">
        <Label htmlFor="name">{t("common.name")}</Label>
        <Input id="name" name="name" required maxLength={120} defaultValue={endpoint?.name} placeholder="Public website" />
      </div>
      <div className="space-y-2 sm:col-span-2">
        <Label htmlFor="url">{t("saas.url")}</Label>
        <Input id="url" name="url" type="url" required maxLength={2048} defaultValue={endpoint?.url} placeholder="https://example.com" />
      </div>
      <div className="space-y-2">
        <Label htmlFor="method">{t("saas.method")}</Label>
        <NativeSelect id="method" name="method" defaultValue={endpoint?.method ?? "GET"}>
          {HTTP_METHODS.map((method) => (
            <option key={method} value={method}>{method}</option>
          ))}
        </NativeSelect>
      </div>
      <div className="space-y-2">
        <Label htmlFor="expectedStatus">{t("saas.expectedStatus")}</Label>
        <Input id="expectedStatus" name="expectedStatus" type="number" min={100} max={599} required defaultValue={endpoint?.expectedStatus ?? 200} />
      </div>
      <div className="space-y-2 sm:col-span-2">
        <Label htmlFor="expectedBodyContains">{t("saas.expectedBody")}</Label>
        <Input id="expectedBodyContains" name="expectedBodyContains" maxLength={500} defaultValue={endpoint?.expectedBodyContains ?? ""} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="intervalSec">{t("saas.interval")} (s)</Label>
        <Input id="intervalSec" name="intervalSec" type="number" min={10} max={86400} required defaultValue={endpoint?.intervalSec ?? 60} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="timeoutMs">{t("saas.timeout")} (ms)</Label>
        <Input id="timeoutMs" name="timeoutMs" type="number" min={100} max={120000} required defaultValue={endpoint?.timeoutMs ?? 10000} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="slaTargetPercent">{t("saas.slaTarget")} (%)</Label>
        <Input id="slaTargetPercent" name="slaTargetPercent" type="number" min={0} max={100} step="0.01" required defaultValue={endpoint?.slaTargetPercent ?? 99.9} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="tags">{t("common.tags")}</Label>
        <Input id="tags" name="tags" defaultValue={endpoint?.tags.join(", ")} placeholder="prod, public" />
      </div>
      <div className="flex items-center gap-2">
        <Checkbox id="followRedirects" name="followRedirects" value="true" defaultChecked={endpoint?.followRedirects ?? true} />
        <Label htmlFor="followRedirects" className="font-normal">{t("saas.followRedirects")}</Label>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox id="verifySsl" name="verifySsl" value="true" defaultChecked={endpoint?.verifySsl ?? true} />
        <Label htmlFor="verifySsl" className="font-normal">{t("saas.verifySsl")}</Label>
      </div>
    </div>
  );
}

export function RegisterEndpointForm() {
  const t = useTranslations("endpointAdmin");
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button>{t("register")}</Button>} />
      <DialogContent className="sm:max-w-lg">
        <ActionForm
          action={async (previous, formData) => {
            const result = await createEndpointAction(previous, formData);
            if (result.status === "success") setOpen(false);
            return result;
          }}
          namespaces={NAMESPACES}
          className="space-y-4"
        >
          {({ pending }) => (
            <>
              <DialogHeader>
                <DialogTitle>{t("registerTitle")}</DialogTitle>
                <DialogDescription>{t("registerHelp")}</DialogDescription>
              </DialogHeader>
              <EndpointFields />
              <DialogFooter>
                <Button type="submit" disabled={pending}>{pending ? t("registering") : t("register")}</Button>
              </DialogFooter>
            </>
          )}
        </ActionForm>
      </DialogContent>
    </Dialog>
  );
}

export function EditEndpointDialog({ endpoint }: { endpoint: EndpointRow }) {
  const t = useTranslations("endpointAdmin");
  const tc = useTranslations("common");
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="icon-sm" variant="ghost" aria-label={tc("edit")}><Pencil className="size-4" aria-hidden /></Button>} />
      <DialogContent className="sm:max-w-lg">
        <ActionForm
          action={async (previous, formData) => {
            const result = await updateEndpointAction(previous, formData);
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
              <input type="hidden" name="id" value={endpoint.id} />
              <EndpointFields endpoint={endpoint} />
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

export function EndpointActions({ endpoint }: { endpoint: EndpointRow }) {
  const t = useTranslations("endpointAdmin");
  const tc = useTranslations("common");
  return (
    <div className="flex items-center justify-end gap-1">
      <EditEndpointDialog endpoint={endpoint} />
      <ActionForm action={toggleEndpointAction} namespaces={NAMESPACES}>
        {({ pending }) => (
          <>
            <input type="hidden" name="id" value={endpoint.id} />
            <input type="hidden" name="enabled" value={String(!endpoint.enabled)} />
            <Button type="submit" size="icon-sm" variant="ghost" disabled={pending} aria-label={endpoint.enabled ? t("actions.disable") : t("actions.enable")}>
              <Power className="size-4" aria-hidden />
            </Button>
          </>
        )}
      </ActionForm>
      <ActionForm action={deleteEndpointAction} namespaces={NAMESPACES} confirm={t("actions.deleteConfirm", { name: endpoint.name })}>
        {({ pending }) => (
          <>
            <input type="hidden" name="id" value={endpoint.id} />
            <Button type="submit" size="icon-sm" variant="ghost" disabled={pending} aria-label={tc("delete")}>
              <Trash2 className="size-4" aria-hidden />
            </Button>
          </>
        )}
      </ActionForm>
    </div>
  );
}
