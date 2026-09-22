import { getTranslations, setRequestLocale } from "next-intl/server";
import { ChangePasswordForm } from "@/components/settings/change-password-form";
import { TwoFactorSettings } from "@/components/settings/two-factor-settings";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireSession } from "@/lib/auth/dal";

export default async function ProfilePage({ params }: PageProps<"/[locale]/settings/profile">) {
  const { locale } = await params;
  setRequestLocale(locale);
  const session = await requireSession();
  const t = await getTranslations();
  const active = session.activeOrg;

  const rows: [string, React.ReactNode][] = [
    [t("profile.name"), session.user.name ?? "—"],
    [t("profile.email"), <span key="email" data-testid="profile-email">{session.user.email}</span>],
    [t("profile.language"), <span key="lang">{t(`language.${locale}`)} — <span className="text-muted-foreground">{t("profile.languageHelp")}</span></span>],
    ...(active
      ? ([[t("profile.role", { org: active.orgName }), <Badge key="role" variant="secondary">{t(`roles.${active.role.toLowerCase()}`)}</Badge>]] as [string, React.ReactNode][])
      : []),
  ];

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{t("profile.account")}</CardTitle>
          <CardDescription>{t("profile.subtitle")}</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-3 text-sm sm:grid-cols-[14rem_1fr]">
            {rows.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-muted-foreground">{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("profile.password.title")}</CardTitle>
        </CardHeader>
        <CardContent>
          <ChangePasswordForm />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("profile.totp.title")}</CardTitle>
        </CardHeader>
        <CardContent>
          <TwoFactorSettings enabled={Boolean(session.user.totpEnabledAt)} />
        </CardContent>
      </Card>
    </div>
  );
}
