import { ShieldAlert } from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { buttonVariants } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { requireSession } from "@/lib/auth/dal";

export default async function ForbiddenPage({ params }: PageProps<"/[locale]/forbidden">) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requireSession();
  const t = await getTranslations("access");

  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 py-16 text-center">
      <ShieldAlert className="size-10 text-destructive" aria-hidden />
      <h1 className="text-xl font-semibold">{t("forbidden.title")}</h1>
      <p className="text-sm text-muted-foreground">{t("forbidden.text")}</p>
      <Link href="/" className={buttonVariants({ variant: "outline" })}>{t("back")}</Link>
    </div>
  );
}
