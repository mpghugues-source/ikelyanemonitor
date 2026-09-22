"use client";

import { Pencil, Power } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toggleDatabaseAction, updateDatabaseSettingsAction } from "@/app/actions/databases";
import { ActionForm } from "@/components/forms/action-form";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { DatabaseRow } from "@/modules/databases/instances";

const NAMESPACES = ["databaseAdmin.errors", "auth.errors"];

export function EditDatabaseDialog({ database }: { database: DatabaseRow }) {
  const t = useTranslations("databaseAdmin");
  const tc = useTranslations("common");
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="icon-sm" variant="ghost" aria-label={tc("edit")}><Pencil className="size-4" aria-hidden /></Button>} />
      <DialogContent className="sm:max-w-sm">
        <ActionForm
          action={async (previous, formData) => {
            const result = await updateDatabaseSettingsAction(previous, formData);
            if (result.status === "success") setOpen(false);
            return result;
          }}
          namespaces={NAMESPACES}
          className="space-y-4"
        >
          {({ pending }) => (
            <>
              <DialogHeader>
                <DialogTitle>{database.name}</DialogTitle>
              </DialogHeader>
              <input type="hidden" name="id" value={database.id} />
              <div className="space-y-2">
                <Label htmlFor="slowQueryThresholdMs">{t("slowQueryThresholdMs")}</Label>
                <Input id="slowQueryThresholdMs" name="slowQueryThresholdMs" type="number" min={1} max={600000} required defaultValue={database.slowQueryThresholdMs} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="tags">{tc("tags")}</Label>
                <Input id="tags" name="tags" defaultValue={database.tags.join(", ")} placeholder="prod, critical" />
              </div>
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

export function DatabaseActions({ database }: { database: DatabaseRow }) {
  const t = useTranslations("databaseAdmin");
  return (
    <div className="flex items-center justify-end gap-1">
      <EditDatabaseDialog database={database} />
      <ActionForm action={toggleDatabaseAction} namespaces={NAMESPACES}>
        {({ pending }) => (
          <>
            <input type="hidden" name="id" value={database.id} />
            <input type="hidden" name="enabled" value={String(!database.enabled)} />
            <Button type="submit" size="icon-sm" variant="ghost" disabled={pending} aria-label={database.enabled ? t("actions.disable") : t("actions.enable")}>
              <Power className="size-4" aria-hidden />
            </Button>
          </>
        )}
      </ActionForm>
    </div>
  );
}
