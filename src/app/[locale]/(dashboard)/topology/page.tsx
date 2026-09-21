import { Workflow } from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { requireActor } from "@/lib/auth/dal";
import { PageHeader } from "@/components/page-header";
import { TopologyPreview } from "@/modules/topology/topology-preview";

export default async function TopologyPage({ params }: PageProps<"/[locale]/topology">) {
  const { locale } = await params;
  setRequestLocale(locale);
  // Authorization is checked HERE, next to the data (the layout is not a security boundary).
  await requireActor("topology:read");
  const t = await getTranslations("topology");

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader icon={Workflow} title={t("title")} subtitle={t("subtitle")} />
      <TopologyPreview note={t("sampleData")} />
    </div>
  );
}
