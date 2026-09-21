import { Leaf } from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { requireActor } from "@/lib/auth/dal";
import { ModulePlaceholder } from "@/components/module-placeholder";
import { PageHeader } from "@/components/page-header";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const INDICATORS = ["wastedSpend", "energyKwh", "co2eKgPerMonth"] as const;

export default async function FinOpsPage({ params }: PageProps<"/[locale]/finops">) {
  const { locale } = await params;
  setRequestLocale(locale);
  // Authorization is checked HERE, next to the data (the layout is not a security boundary).
  await requireActor("finops:read");
  const t = await getTranslations("finops");

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader icon={Leaf} title={t("title")} subtitle={t("subtitle")} />
      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        {INDICATORS.map((key) => (
          <Card key={key}>
            <CardHeader>
              <CardDescription>{t(key)}</CardDescription>
              <CardTitle className="text-2xl text-muted-foreground">—</CardTitle>
            </CardHeader>
          </Card>
        ))}
      </div>
      <ModulePlaceholder description={t("estimateNote")} comingSoon={t("estimated")} />
    </div>
  );
}
