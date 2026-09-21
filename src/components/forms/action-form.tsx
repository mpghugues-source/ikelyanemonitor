"use client";

import { Check, Copy } from "lucide-react";
import { useTranslations } from "next-intl";
import { useActionState, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { idle, type FormState } from "@/lib/form-state";
import { cn } from "@/lib/utils";

/**
 * Translated error for a form state. The server returns a stable error CODE; the message is looked
 * up in the given dictionary namespaces, in order, falling back to a generic message.
 */
export function ErrorText({ state, namespaces }: { state: FormState<unknown>; namespaces: string[] }) {
  const t = useTranslations();
  if (state.status !== "error") return null;
  const key = namespaces.map((namespace) => `${namespace}.${state.error}`).find((candidate) => t.has(candidate)) ?? "auth.errors.generic";
  return (
    <p role="alert" className="text-sm font-medium text-destructive">
      {t(key, state.params)}
    </p>
  );
}

interface ActionFormProps<T> {
  action: (previous: FormState<T>, formData: FormData) => Promise<FormState<T>>;
  /** Error dictionaries, most specific first, e.g. ["members.errors", "auth.errors"]. */
  namespaces: string[];
  /** Ask the user to confirm before the request is sent (destructive operations). */
  confirm?: string;
  className?: string;
  children: ReactNode | ((context: { pending: boolean; state: FormState<T> }) => ReactNode);
}

/** A <form> bound to a Server Action, with pending state, confirmation and translated errors. */
export function ActionForm<T = undefined>({ action, namespaces, confirm, className, children }: ActionFormProps<T>) {
  const [state, formAction, pending] = useActionState<FormState<T>, FormData>(action, idle as FormState<T>);
  return (
    <form
      action={formAction}
      className={className}
      onSubmit={confirm ? (event) => { if (!window.confirm(confirm)) event.preventDefault(); } : undefined}
    >
      {typeof children === "function" ? children({ pending, state }) : children}
      <ErrorText state={state} namespaces={namespaces} />
    </form>
  );
}

export function CopyButton({ value, copyLabel, copiedLabel, className }: { value: string; copyLabel: string; copiedLabel: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={cn("shrink-0", className)}
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
    >
      {copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
      {copied ? copiedLabel : copyLabel}
    </Button>
  );
}
