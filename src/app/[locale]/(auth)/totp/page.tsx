import { getTranslations, setRequestLocale } from "next-intl/server";
import { TotpChallengeForm } from "@/components/auth/totp-challenge-form";
import { Link } from "@/i18n/navigation";
import { readTotpChallengeToken } from "@/lib/auth/session-cookie";
import { previewTotpChallenge } from "@/lib/auth/two-factor";
import { getPrisma } from "@/lib/prisma";

/**
 * Deliberately never redirect()s away when there is no valid challenge — after ANY Server Action
 * submitted from this page (a wrong code, hitting the attempt cap), Next.js automatically refetches
 * this same route; a redirect() here would then fire on top of that refetch and wipe the just-set
 * form error before it can render (confirmed with a real browser: the error text never appeared,
 * the page just landed back on /login). Showing the same "expired" state in place instead of
 * navigating away sidesteps the race entirely.
 */
export default async function TotpChallengePage({ params }: PageProps<"/[locale]/totp">) {
  const { locale } = await params;
  setRequestLocale(locale);

  const token = await readTotpChallengeToken();
  const preview = token ? await previewTotpChallenge(getPrisma(), token) : null;

  const t = await getTranslations("auth.totp");
  if (!preview) {
    const te = await getTranslations("auth.errors");
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{te("totp_challenge_expired")}</p>
        <Link href="/login" className="text-sm font-medium text-primary underline underline-offset-4">
          {t("backToLogin")}
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("subtitleFor", { email: preview.email })}</p>
      </div>
      <TotpChallengeForm />
    </div>
  );
}
