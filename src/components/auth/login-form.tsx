"use client";

import { useTranslations } from "next-intl";
import { loginAction } from "@/app/actions/session";
import { ActionForm } from "@/components/forms/action-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function LoginForm({ next }: { next?: string }) {
  const t = useTranslations("auth");
  return (
    <ActionForm action={loginAction} namespaces={["auth.errors"]} className="space-y-4">
      {({ pending }) => (
        <>
          {next ? <input type="hidden" name="next" value={next} /> : null}
          <div className="space-y-2">
            <Label htmlFor="email">{t("fields.email")}</Label>
            <Input id="email" name="email" type="email" autoComplete="username" required autoFocus />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">{t("fields.password")}</Label>
            <Input id="password" name="password" type="password" autoComplete="current-password" required />
          </div>
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? t("login.submitting") : t("login.submit")}
          </Button>
        </>
      )}
    </ActionForm>
  );
}
