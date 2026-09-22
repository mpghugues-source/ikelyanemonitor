"use client";

import { useTranslations } from "next-intl";
import { inviteMemberAction } from "@/app/actions/members";
import { ActionForm, CopyButton } from "@/components/forms/action-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";

export interface RoleOption {
  value: string;
  label: string;
}

/** `roles` is what the CURRENT user may grant (computed on the server); the server re-checks it. */
export function InviteMemberForm({ roles }: { roles: RoleOption[] }) {
  const t = useTranslations("members.invite");
  return (
    <ActionForm action={inviteMemberAction} namespaces={["members.errors", "auth.errors"]} className="space-y-4">
      {({ pending, state }) => (
        <>
          <div className="grid gap-4 sm:grid-cols-[1fr_12rem_auto] sm:items-end">
            <div className="space-y-2">
              <Label htmlFor="invite-email">{t("email")}</Label>
              <Input id="invite-email" name="email" type="email" required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="invite-role">{t("role")}</Label>
              <NativeSelect id="invite-role" name="role" defaultValue={roles.at(-1)?.value} className="w-full">
                {roles.map((role) => (
                  <option key={role.value} value={role.value}>
                    {role.label}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <Button type="submit" disabled={pending}>
              {pending ? t("submitting") : t("submit")}
            </Button>
          </div>

          {state.status === "success" && state.data ? (
            <div role="status" className="space-y-2 rounded-lg border border-emerald-300 bg-emerald-50 p-4 text-emerald-950">
              <p className="text-sm font-medium">{t("created", { email: state.data.email })}</p>
              <div className="flex items-center gap-2">
                <code data-testid="invitation-link" className="min-w-0 flex-1 truncate rounded bg-white px-2 py-1.5 text-xs">
                  {state.data.link}
                </code>
                <CopyButton value={state.data.link} copyLabel={t("copy")} copiedLabel={t("copied")} />
              </div>
            </div>
          ) : null}
        </>
      )}
    </ActionForm>
  );
}
