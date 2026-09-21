"use client";

import { Languages } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useTransition } from "react";
import { setLocalePreferenceAction } from "@/app/actions/session";
import { usePathname, useRouter } from "@/i18n/navigation";
import { routing, type AppLocale } from "@/i18n/routing";
import { cn } from "@/lib/utils";

/** EN | FR toggle. Keeps the current page: /en/servers → /fr/servers. */
/** `persist`: also save the choice on the signed-in user's profile (used inside the dashboard). */
export function LanguageSwitcher({ className, persist = false }: { className?: string; persist?: boolean }) {
  const t = useTranslations("language");
  const current = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();

  function switchTo(locale: AppLocale) {
    if (locale === current) return;
    startTransition(async () => {
      if (persist) await setLocalePreferenceAction(locale);
      router.replace(pathname, { locale });
    });
  }

  return (
    <div
      role="group"
      aria-label={t("switch")}
      className={cn("inline-flex items-center gap-1 rounded-lg border bg-card p-1 text-sm", className)}
    >
      <Languages className="ml-1 size-4 text-muted-foreground" aria-hidden />
      {routing.locales.map((locale) => (
        <button
          key={locale}
          type="button"
          lang={locale}
          aria-current={locale === current ? "true" : undefined}
          aria-label={t(locale)}
          disabled={pending}
          onClick={() => switchTo(locale)}
          className={cn(
            "rounded-md px-2.5 py-1 font-medium uppercase transition-colors",
            locale === current ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted",
          )}
        >
          {locale}
        </button>
      ))}
    </div>
  );
}
