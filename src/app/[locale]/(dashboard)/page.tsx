import { getTranslations, setRequestLocale } from "next-intl/server";
import { requireActor } from "@/lib/auth/dal";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Link } from "@/i18n/navigation";
import { MODULES } from "@/modules/registry";

const STEPS = ["createHost", "installAgent", "addDevices", "setAlerts"] as const;

export default async function OverviewPage({ params }: PageProps<"/[locale]">) {
  const { locale } = await params;
  setRequestLocale(locale);
  // Authorization is checked HERE, next to the data (the layout is not a security boundary).
  await requireActor();
  const t = await getTranslations();

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="text-3xl font-semibold tracking-tight">{t("dashboard.welcome")}</h1>
      <p className="mt-2 text-muted-foreground">{t("dashboard.welcomeSubtitle")}</p>

      <h2 className="mt-10 mb-4 text-lg font-semibold">{t("dashboard.modules")}</h2>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {MODULES.map(({ key, href, icon: Icon }) => (
          <Link key={key} href={href} className="group rounded-xl outline-offset-2 focus-visible:outline-2">
            <Card className="h-full transition-shadow group-hover:shadow-md">
              <CardHeader>
                <div className="mb-2 w-fit rounded-lg bg-primary/10 p-2 text-primary">
                  <Icon className="size-5" aria-hidden />
                </div>
                <CardTitle>{t(`nav.${key}`)}</CardTitle>
                <CardDescription>{t(`modules.${key}`)}</CardDescription>
              </CardHeader>
            </Card>
          </Link>
        ))}
      </div>

      <h2 className="mt-10 mb-4 text-lg font-semibold">{t("dashboard.gettingStarted")}</h2>
      <Card>
        <CardContent className="pt-6">
          <ol className="space-y-3">
            {STEPS.map((step, index) => (
              <li key={step} className="flex items-start gap-3 text-sm">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
                  {index + 1}
                </span>
                <span className="pt-0.5">{t(`dashboard.steps.${step}`)}</span>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>
    </div>
  );
}
