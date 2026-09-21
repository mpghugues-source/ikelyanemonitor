"use client";

import { useTranslations } from "next-intl";
import { changePasswordAction } from "@/app/actions/session";
import { ActionForm } from "@/components/forms/action-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PASSWORD_MIN_LENGTH } from "@/lib/auth/constants";

export function ChangePasswordForm() {
  const t = useTranslations();
  return (
    <ActionForm action={changePasswordAction} namespaces={["profile.password.errors", "auth.errors"]} className="max-w-md space-y-4">
      {({ pending, state }) => (
        <>
          <div className="space-y-2">
            <Label htmlFor="currentPassword">{t("auth.fields.currentPassword")}</Label>
            <Input id="currentPassword" name="currentPassword" type="password" autoComplete="current-password" required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="newPassword">{t("auth.fields.newPassword")}</Label>
            <Input id="newPassword" name="newPassword" type="password" autoComplete="new-password" minLength={PASSWORD_MIN_LENGTH} required />
            <p className="text-xs text-muted-foreground">{t("auth.fields.passwordHint", { min: PASSWORD_MIN_LENGTH })}</p>
          </div>
          <p className="text-xs text-muted-foreground">{t("profile.password.note")}</p>
          <Button type="submit" disabled={pending}>
            {pending ? t("profile.password.submitting") : t("profile.password.submit")}
          </Button>
          {state.status === "success" ? (
            <p role="status" className="text-sm font-medium text-emerald-600">
              {t("profile.password.success", { count: Number(state.params?.count ?? 0) })}
            </p>
          ) : null}
        </>
      )}
    </ActionForm>
  );
}
