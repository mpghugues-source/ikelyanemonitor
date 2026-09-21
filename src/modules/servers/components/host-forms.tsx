"use client";

import { KeyRound, Power } from "lucide-react";
import { useTranslations } from "next-intl";
import { registerHostAction, rotateSecretAction, toggleHostAction, type IssuedCredentials } from "@/app/actions/hosts";
import { ActionForm, CopyButton } from "@/components/forms/action-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Agent credentials, shown right after they are issued. The secret exists in clear text only in
 * this response: the server keeps just its ciphertext and cannot show it again.
 */
export function CredentialsCard({ credentials }: { credentials: IssuedCredentials }) {
  const t = useTranslations("hostAdmin.credentials");
  return (
    <div role="status" data-testid="credentials" className="space-y-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-950">
      <p className="text-sm font-semibold">
        {t("title")} — {credentials.hostname}
      </p>
      <p className="text-sm">{t("warning")}</p>
      {(
        [
          ["keyId", credentials.keyId],
          ["secret", credentials.secret],
        ] as const
      ).map(([label, value]) => (
        <div key={label} className="flex items-center gap-2">
          <span className="w-20 shrink-0 text-xs font-medium uppercase">{t(label)}</span>
          <code data-testid={`credential-${label}`} className="min-w-0 flex-1 break-all rounded bg-white px-2 py-1.5 text-xs">
            {value}
          </code>
          <CopyButton value={value} copyLabel={t("copy")} copiedLabel={t("copied")} />
        </div>
      ))}
    </div>
  );
}

export function RegisterHostForm() {
  const t = useTranslations("hostAdmin");
  return (
    <ActionForm action={registerHostAction} namespaces={["hostAdmin.errors", "auth.errors"]} className="space-y-4">
      {({ pending, state }) => (
        <>
          <div className="grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <div className="space-y-2">
              <Label htmlFor="hostname">{t("hostname")}</Label>
              <Input id="hostname" name="hostname" required placeholder="web-01.example.com" aria-describedby="hostname-help" />
              <p id="hostname-help" className="text-xs text-muted-foreground">{t("hostnameHelp")}</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="displayName">{t("displayName")}</Label>
              <Input id="displayName" name="displayName" />
            </div>
            <Button type="submit" disabled={pending}>
              {pending ? t("registering") : t("register")}
            </Button>
          </div>
          {state.status === "success" && state.data ? <CredentialsCard credentials={state.data} /> : null}
        </>
      )}
    </ActionForm>
  );
}

/** Rotate / enable / disable a host. Only rendered for roles allowed to (the server enforces it). */
export function HostActions({
  hostId,
  hostname,
  enabled,
  canRotate,
  canWrite,
}: {
  hostId: string;
  hostname: string;
  enabled: boolean;
  canRotate: boolean;
  canWrite: boolean;
}) {
  const t = useTranslations("hostAdmin");
  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex gap-1">
        {canRotate ? (
          <ActionForm action={rotateSecretAction} namespaces={["hostAdmin.errors", "auth.errors"]} confirm={t("actions.rotateConfirm")}>
            {({ pending, state }) => (
              <>
                <input type="hidden" name="hostId" value={hostId} />
                <input type="hidden" name="hostname" value={hostname} />
                <Button type="submit" size="sm" variant="outline" disabled={pending}>
                  <KeyRound className="size-4" aria-hidden /> {t("actions.rotate")}
                </Button>
                {state.status === "success" && state.data ? (
                  <div className="mt-2 w-[28rem] max-w-[80vw] text-left"><CredentialsCard credentials={state.data} /></div>
                ) : null}
              </>
            )}
          </ActionForm>
        ) : null}
        {canWrite ? (
          <ActionForm action={toggleHostAction} namespaces={["hostAdmin.errors", "auth.errors"]}>
            {({ pending }) => (
              <>
                <input type="hidden" name="hostId" value={hostId} />
                <input type="hidden" name="enabled" value={String(!enabled)} />
                <Button type="submit" size="sm" variant="ghost" disabled={pending}>
                  <Power className="size-4" aria-hidden /> {enabled ? t("actions.disable") : t("actions.enable")}
                </Button>
              </>
            )}
          </ActionForm>
        ) : null}
      </div>
    </div>
  );
}
