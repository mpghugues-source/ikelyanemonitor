import { Activity } from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { LanguageSwitcher } from "@/components/language-switcher";

/** Centered card layout for the pages people see BEFORE signing in. */
export default async function AuthLayout({ children, params }: LayoutProps<"/[locale]">) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("meta");

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-muted/30 p-4">
      <div className="flex w-full max-w-md items-center justify-between">
        <div className="flex items-center gap-2 font-semibold tracking-tight">
          <span className="rounded-md bg-primary p-1.5 text-primary-foreground">
            <Activity className="size-4" aria-hidden />
          </span>
          {t("appName")}
        </div>
        <LanguageSwitcher />
      </div>
      <div className="w-full max-w-md rounded-xl border bg-card p-6 shadow-sm sm:p-8">{children}</div>
    </div>
  );
}
