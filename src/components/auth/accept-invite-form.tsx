"use client";

import { useTranslations } from "next-intl";
import { acceptInvitationAction } from "@/app/actions/onboarding";
import { ActionForm } from "@/components/forms/action-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PASSWORD_MIN_LENGTH } from "@/lib/auth/constants";

/**
 * `mode="new"`: the invitee has no account yet and chooses a name and password.
 * `mode="existing"`: the invitee is already signed in as the invited account; one click joins.
 */
export function AcceptInviteForm({ token, mode, email }: { token: string; mode: "new" | "existing"; email: string }) {
  const t = useTranslations("auth");
  return (
    <ActionForm action={acceptInvitationAction} namespaces={["auth.errors"]} className="space-y-4">
      {({ pending }) => (
        <>
          <input type="hidden" name="token" value={token} />
          {mode === "new" ? (
            <>
              <p className="text-sm text-muted-foreground">{t("invite.createAccount")}</p>
              <div className="space-y-2">
                <Label htmlFor="email">{t("fields.email")}</Label>
                <Input id="email" value={email} readOnly disabled />
              </div>
              <div className="space-y-2">
                <Label htmlFor="name">{t("fields.name")}</Label>
                <Input id="name" name="name" autoComplete="name" required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">{t("fields.password")}</Label>
                <Input id="password" name="password" type="password" autoComplete="new-password" minLength={PASSWORD_MIN_LENGTH} required />
                <p className="text-xs text-muted-foreground">{t("fields.passwordHint", { min: PASSWORD_MIN_LENGTH })}</p>
              </div>
            </>
          ) : null}
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? t("invite.submitting") : mode === "new" ? t("invite.submit") : t("invite.acceptExisting", { email })}
          </Button>
        </>
      )}
    </ActionForm>
  );
}
