"use client";

import { useTranslations } from "next-intl";
import { registerAction } from "@/app/actions/onboarding";
import { ActionForm } from "@/components/forms/action-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PASSWORD_MIN_LENGTH } from "@/lib/auth/constants";

export function RegisterForm() {
  const t = useTranslations("auth");
  return (
    <ActionForm action={registerAction} namespaces={["auth.errors"]} className="space-y-4">
      {({ pending }) => (
        <>
          <div className="space-y-2">
            <Label htmlFor="name">{t("fields.name")}</Label>
            <Input id="name" name="name" autoComplete="name" required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="organization">{t("register.organization")}</Label>
            <Input id="organization" name="organization" required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="email">{t("fields.email")}</Label>
            <Input id="email" name="email" type="email" autoComplete="username" required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">{t("fields.password")}</Label>
            <Input id="password" name="password" type="password" autoComplete="new-password" minLength={PASSWORD_MIN_LENGTH} required />
            <p className="text-xs text-muted-foreground">{t("fields.passwordHint", { min: PASSWORD_MIN_LENGTH })}</p>
          </div>
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? t("register.submitting") : t("register.submit")}
          </Button>
        </>
      )}
    </ActionForm>
  );
}
