import { redirect } from "@/i18n/navigation";

export default async function SettingsIndex({ params }: PageProps<"/[locale]/settings">) {
  const { locale } = await params;
  return redirect({ href: "/settings/profile", locale });
}
