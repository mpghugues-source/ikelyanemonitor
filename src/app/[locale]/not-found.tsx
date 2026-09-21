import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";

export default async function LocaleNotFound() {
  const t = await getTranslations("errors");
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-8 text-center">
      <p className="text-6xl font-semibold text-muted-foreground">404</p>
      <p>{t("notFound")}</p>
      <Link href="/" className="text-sm font-medium text-primary underline underline-offset-4">
        {(await getTranslations("nav"))("overview")}
      </Link>
    </main>
  );
}
