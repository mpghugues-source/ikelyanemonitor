import { Building2 } from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { requireSession } from "@/lib/auth/dal";

/** A valid account that belongs to no organization (e.g. it was removed from the last one). */
export default async function NoOrganizationPage({ params }: PageProps<"/[locale]/no-organization">) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requireSession();
  const t = await getTranslations("access");

  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 py-16 text-center">
      <Building2 className="size-10 text-muted-foreground" aria-hidden />
      <h1 className="text-xl font-semibold">{t("noOrganization.title")}</h1>
      <p className="text-sm text-muted-foreground">{t("noOrganization.text")}</p>
    </div>
  );
}
