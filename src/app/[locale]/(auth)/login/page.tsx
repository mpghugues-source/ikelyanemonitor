import { getTranslations, setRequestLocale } from "next-intl/server";
import { LoginForm } from "@/components/auth/login-form";
import { Link, redirect } from "@/i18n/navigation";
import { getSession, registrationOpen } from "@/lib/auth/dal";
import { safeNextPath } from "@/lib/auth/request";

export default async function LoginPage({ params, searchParams }: PageProps<"/[locale]/login">) {
  const { locale } = await params;
  setRequestLocale(locale);
  const query = await searchParams;
  const next = typeof query.next === "string" ? safeNextPath(query.next) : undefined;

  // Already signed in: nothing to do here.
  if (await getSession()) return redirect({ href: next ?? "/", locale });

  const t = await getTranslations("auth");
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("login.title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("login.subtitle")}</p>
      </div>
      <LoginForm next={next} />
      <p className="text-center text-sm text-muted-foreground">
        {registrationOpen() ? (
          <Link href="/register" className="font-medium text-primary underline underline-offset-4">
            {t("login.createAccount")}
          </Link>
        ) : (
          t("login.invitationOnly")
        )}
      </p>
    </div>
  );
}
