"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { verifyTotpAction } from "@/app/actions/session";
import { ActionForm } from "@/components/forms/action-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Link } from "@/i18n/navigation";

export function TotpChallengeForm() {
  const t = useTranslations("auth.totp");
  const [useRecoveryCode, setUseRecoveryCode] = useState(false);

  return (
    <ActionForm action={verifyTotpAction} namespaces={["auth.errors"]} className="space-y-4">
      {({ pending }) => (
        <>
          <div className="space-y-2">
            <Label htmlFor="code">{useRecoveryCode ? t("recoveryCodeLabel") : t("codeLabel")}</Label>
            {useRecoveryCode ? (
              <Input id="code" name="code" required autoFocus autoComplete="one-time-code" maxLength={19} placeholder={t("recoveryCodePlaceholder")} />
            ) : (
              <Input
                id="code"
                name="code"
                required
                autoFocus
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                autoComplete="one-time-code"
                placeholder={t("codePlaceholder")}
              />
            )}
          </div>
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? t("submitting") : t("submit")}
          </Button>
          <div className="flex items-center justify-between text-sm">
            <button type="button" className="font-medium text-primary underline underline-offset-4" onClick={() => setUseRecoveryCode((v) => !v)}>
              {useRecoveryCode ? t("useAuthenticatorCode") : t("useRecoveryCode")}
            </button>
            <Link href="/login" className="text-muted-foreground underline underline-offset-4">
              {t("backToLogin")}
            </Link>
          </div>
        </>
      )}
    </ActionForm>
  );
}
