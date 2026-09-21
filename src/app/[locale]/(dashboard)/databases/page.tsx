import { Database } from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { requireActor } from "@/lib/auth/dal";
import { ModulePlaceholder } from "@/components/module-placeholder";
import { PageHeader } from "@/components/page-header";

export default async function Page({ params }: PageProps<"/[locale]/databases">) {
  const { locale } = await params;
  setRequestLocale(locale);
  // Authorization is checked HERE, next to the data (the layout is not a security boundary).
  await requireActor("databases:read");
  const t = await getTranslations();

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader icon={Database} title={t("database.title")} subtitle={t("database.subtitle")} />
      <ModulePlaceholder description={t("modules.databases")} comingSoon={t("common.comingSoon")} />
    </div>
  );
}
