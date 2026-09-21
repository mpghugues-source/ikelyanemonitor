import { getTranslations, setRequestLocale } from "next-intl/server";
import { SettingsTabs } from "@/components/settings/settings-tabs";
import { requireSession } from "@/lib/auth/dal";
import { can } from "@/lib/auth/permissions";

export default async function SettingsLayout({ children, params }: LayoutProps<"/[locale]">) {
  const { locale } = await params;
  setRequestLocale(locale);
  const session = await requireSession();
  const t = await getTranslations("settings");

  const role = session.activeOrg?.role;
  const tabs = [
    { href: "/settings/profile", label: t("tabs.profile") },
    ...(role ? [{ href: "/settings/members", label: t("tabs.members") }] : []),
    // The tab is a convenience; the audit PAGE re-checks the permission on the server.
    ...(can(role, "audit:read") ? [{ href: "/settings/audit", label: t("tabs.audit") }] : []),
  ];

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="mb-4 text-2xl font-semibold tracking-tight">{t("title")}</h1>
      <SettingsTabs tabs={tabs} />
      {children}
    </div>
  );
}
