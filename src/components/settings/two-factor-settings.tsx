"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import {
  confirmTotpSetupAction,
  disableTotpAction,
  regenerateRecoveryCodesAction,
  startTotpSetupAction,
  type TotpSetupData,
} from "@/app/actions/session";
import { ActionForm, CopyButton } from "@/components/forms/action-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useRouter } from "@/i18n/navigation";

const CREDENTIAL_NAMESPACES = ["profile.totp.errors", "auth.errors"];

function RecoveryCodesReveal({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const t = useTranslations("profile.totp.recoveryCodes");
  return (
    <div role="status" data-testid="totp-recovery-codes" className="space-y-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-950">
      <p className="text-sm font-semibold">{t("title")}</p>
      <p className="text-sm">{t("help")}</p>
      <div className="grid grid-cols-2 gap-2">
        {codes.map((code) => (
          <code key={code} className="rounded bg-white px-2 py-1.5 text-center text-xs">{code}</code>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <CopyButton value={codes.join("\n")} copyLabel={t("copy")} copiedLabel={t("copied")} />
        <Button type="button" onClick={onDone}>{t("done")}</Button>
      </div>
    </div>
  );
}

function ConfirmSetupForm({ setup, onConfirmed, onCancel }: { setup: TotpSetupData; onConfirmed: (codes: string[]) => void; onCancel: () => void }) {
  const t = useTranslations("profile.totp.setup");
  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm font-medium">{t("title")}</p>
        <p className="mt-1 text-sm text-muted-foreground">{t("help")}</p>
      </div>
      {/* eslint-disable-next-line @next/next/no-img-element -- a data: URI rendered once, an <Image> loader would add nothing */}
      <img src={setup.qrDataUrl} alt="" width={240} height={240} className="rounded-lg border" />
      <div className="space-y-1">
        <p className="text-xs text-muted-foreground">{t("manualEntry")}</p>
        <code data-testid="totp-secret" className="block break-all rounded bg-muted px-2 py-1.5 text-xs">{setup.secret}</code>
      </div>
      <ActionForm<{ recoveryCodes: string[] }>
        action={async (previous, formData) => {
          const result = await confirmTotpSetupAction(previous, formData);
          if (result.status === "success" && result.data) onConfirmed(result.data.recoveryCodes);
          return result;
        }}
        namespaces={CREDENTIAL_NAMESPACES}
        className="space-y-3"
      >
        {({ pending }) => (
          <>
            <div className="space-y-2">
              <Label htmlFor="totp-confirm-code">{t("codeLabel")}</Label>
              <Input id="totp-confirm-code" name="code" required inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" autoFocus />
            </div>
            <div className="flex gap-2">
              <Button type="submit" disabled={pending}>{pending ? t("confirming") : t("confirm")}</Button>
              <Button type="button" variant="ghost" onClick={onCancel}>{t("cancel")}</Button>
            </div>
          </>
        )}
      </ActionForm>
    </div>
  );
}

function DisableTotpForm() {
  const t = useTranslations("profile.totp.disable");
  const ta = useTranslations("auth.fields");
  const router = useRouter();
  return (
    <ActionForm
      action={async (previous, formData) => {
        const result = await disableTotpAction(previous, formData);
        if (result.status === "success") router.refresh();
        return result;
      }}
      namespaces={CREDENTIAL_NAMESPACES}
      className="space-y-3 max-w-sm"
    >
      {({ pending }) => (
        <>
          <div className="space-y-2">
            <Label htmlFor="disable-totp-password">{ta("currentPassword")}</Label>
            <Input id="disable-totp-password" name="password" type="password" autoComplete="current-password" required />
          </div>
          <Button type="submit" variant="destructive" disabled={pending}>{pending ? t("submitting") : t("submit")}</Button>
        </>
      )}
    </ActionForm>
  );
}

function RegenerateRecoveryCodesForm() {
  const t = useTranslations("profile.totp.regenerate");
  const ta = useTranslations("auth.fields");
  const [codes, setCodes] = useState<string[] | null>(null);

  if (codes) return <RecoveryCodesReveal codes={codes} onDone={() => setCodes(null)} />;

  return (
    <ActionForm<{ recoveryCodes: string[] }>
      action={async (previous, formData) => {
        const result = await regenerateRecoveryCodesAction(previous, formData);
        if (result.status === "success" && result.data) setCodes(result.data.recoveryCodes);
        return result;
      }}
      namespaces={CREDENTIAL_NAMESPACES}
      className="space-y-3 max-w-sm"
    >
      {({ pending }) => (
        <>
          <div className="space-y-2">
            <Label htmlFor="regen-totp-password">{ta("currentPassword")}</Label>
            <Input id="regen-totp-password" name="password" type="password" autoComplete="current-password" required />
          </div>
          <Button type="submit" variant="outline" disabled={pending}>{pending ? t("submitting") : t("submit")}</Button>
        </>
      )}
    </ActionForm>
  );
}

export function TwoFactorSettings({ enabled }: { enabled: boolean }) {
  const t = useTranslations("profile.totp");
  const router = useRouter();
  const [setup, setSetup] = useState<TotpSetupData | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  if (recoveryCodes) {
    return <RecoveryCodesReveal codes={recoveryCodes} onDone={() => { setRecoveryCodes(null); setSetup(null); router.refresh(); }} />;
  }

  if (setup) {
    return <ConfirmSetupForm setup={setup} onConfirmed={setRecoveryCodes} onCancel={() => setSetup(null)} />;
  }

  if (!enabled) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">{t("notEnabled")}</p>
        <ActionForm<TotpSetupData>
          action={async (previous, formData) => {
            const result = await startTotpSetupAction(previous, formData);
            if (result.status === "success" && result.data) setSetup(result.data);
            return result;
          }}
          namespaces={["auth.errors"]}
        >
          {({ pending }) => <Button type="submit" disabled={pending}>{t("enable")}</Button>}
        </ActionForm>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Badge>{t("enabledSince")}</Badge>
      <div className="space-y-2">
        <p className="text-sm font-medium">{t("regenerate.title")}</p>
        <p className="text-sm text-muted-foreground">{t("regenerate.help")}</p>
        <RegenerateRecoveryCodesForm />
      </div>
      <div className="space-y-2 border-t pt-4">
        <p className="text-sm font-medium">{t("disable.title")}</p>
        <p className="text-sm text-muted-foreground">{t("disable.help")}</p>
        <DisableTotpForm />
      </div>
    </div>
  );
}
