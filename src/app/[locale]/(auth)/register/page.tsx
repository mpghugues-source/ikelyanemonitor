import { getTranslations, setRequestLocale } from "next-intl/server";
import { RegisterForm } from "@/components/auth/register-form";
import { Link, redirect } from "@/i18n/navigation";
import { getSession, registrationOpen } from "@/lib/auth/dal";

export default async function RegisterPage({ params }: PageProps<"/[locale]/register">) {
  const { locale } = await params;
  setRequestLocale(locale);
  if (await getSession()) return redirect({ href: "/", locale });

  const t = await getTranslations("auth");
  const signIn = (
    <Link href="/login" className="font-medium text-primary underline underline-offset-4">
      {t("login.submit")}
    </Link>
  );

  // Self-service sign-up is off by default (AUTH_ALLOW_REGISTRATION): accounts come by invitation.
  if (!registrationOpen()) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">{t("register.title")}</h1>
        <p role="status" className="text-sm text-muted-foreground">{t("register.closed")}</p>
        <p className="text-sm">{signIn}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("register.title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("register.subtitle")}</p>
      </div>
      <RegisterForm />
      <p className="text-center text-sm text-muted-foreground">
        {t("register.haveAccount")} {signIn}
      </p>
    </div>
  );
}
