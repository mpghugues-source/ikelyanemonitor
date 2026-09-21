import { Globe } from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { requireActor } from "@/lib/auth/dal";
import { ModulePlaceholder } from "@/components/module-placeholder";
import { PageHeader } from "@/components/page-header";

export default async function Page({ params }: PageProps<"/[locale]/saas">) {
  const { locale } = await params;
  setRequestLocale(locale);
  // Authorization is checked HERE, next to the data (the layout is not a security boundary).
  await requireActor("endpoints:read");
  const t = await getTranslations();

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader icon={Globe} title={t("saas.title")} subtitle={t("saas.subtitle")} />
      <ModulePlaceholder description={t("modules.saas")} comingSoon={t("common.comingSoon")} />
    </div>
  );
}
