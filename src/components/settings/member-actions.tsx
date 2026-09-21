"use client";

import { useTranslations } from "next-intl";
import { changeRoleAction, removeMemberAction, revokeInvitationAction } from "@/app/actions/members";
import { ActionForm } from "@/components/forms/action-form";
import type { RoleOption } from "@/components/settings/invite-member-form";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";

/** Role picker for a member. `options` only lists roles the current user may set for THIS member. */
export function ChangeRoleForm({ membershipId, current, options }: { membershipId: string; current: string; options: RoleOption[] }) {
  const t = useTranslations("members");
  return (
    <ActionForm action={changeRoleAction} namespaces={["members.errors", "auth.errors"]} className="flex items-center gap-2">
      {({ pending }) => (
        <>
          <input type="hidden" name="membershipId" value={membershipId} />
          <NativeSelect name="role" defaultValue={current} aria-label={t("changeRole")} disabled={pending} className="h-8 w-40">
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </NativeSelect>
          <Button type="submit" size="sm" variant="outline" disabled={pending}>
            {t("save")}
          </Button>
        </>
      )}
    </ActionForm>
  );
}

export function RemoveMemberForm({ membershipId, name, self }: { membershipId: string; name: string; self: boolean }) {
  const t = useTranslations("members");
  return (
    <ActionForm
      action={removeMemberAction}
      namespaces={["members.errors", "auth.errors"]}
      confirm={self ? t("confirmLeave") : t("confirmRemove", { name })}
    >
      {({ pending }) => (
        <>
          <input type="hidden" name="membershipId" value={membershipId} />
          <Button type="submit" size="sm" variant="ghost" className="text-destructive" disabled={pending}>
            {self ? t("leave") : t("remove")}
          </Button>
        </>
      )}
    </ActionForm>
  );
}

export function RevokeInvitationForm({ invitationId }: { invitationId: string }) {
  const t = useTranslations("members.pending");
  return (
    <ActionForm action={revokeInvitationAction} namespaces={["members.errors", "auth.errors"]}>
      {({ pending }) => (
        <>
          <input type="hidden" name="invitationId" value={invitationId} />
          <Button type="submit" size="sm" variant="ghost" className="text-destructive" disabled={pending}>
            {t("revoke")}
          </Button>
        </>
      )}
    </ActionForm>
  );
}
