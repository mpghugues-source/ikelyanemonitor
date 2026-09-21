import { Activity } from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { LanguageSwitcher } from "@/components/language-switcher";
import { SidebarNav } from "@/components/sidebar-nav";
import { UserMenu } from "@/components/user-menu";
import { requireSession } from "@/lib/auth/dal";

/**
 * Application shell for signed-in users. It resolves the session to show WHO is signed in, but it
 * is not the security boundary: layouts are not re-rendered on client navigation, so each page and
 * Server Action checks authorization itself (requireActor / authorize).
 */
export default async function DashboardLayout({ children, params }: LayoutProps<"/[locale]">) {
  const { locale } = await params;
  setRequestLocale(locale);
  const session = await requireSession();
  const t = await getTranslations();

  const brand = (
    <div className="flex items-center gap-2 font-semibold tracking-tight">
      <span className="rounded-md bg-primary p-1.5 text-primary-foreground">
        <Activity className="size-4" aria-hidden />
      </span>
      {t("meta.appName")}
    </div>
  );

  const active = session.activeOrg;
  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-64 shrink-0 flex-col gap-6 border-r bg-sidebar p-4 md:flex">
        {brand}
        <SidebarNav />
        <p className="mt-auto text-xs text-muted-foreground">{t("meta.tagline")}</p>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-3 border-b px-4 py-3">
          <div className="md:hidden">{brand}</div>
          <div className="ml-auto flex items-center gap-3">
            <LanguageSwitcher persist />
            <UserMenu
              displayName={session.user.name ?? session.user.email}
              email={session.user.email}
              roleLabel={active ? t(`roles.${active.role.toLowerCase()}`) : null}
              organizations={session.memberships.map((m) => ({ id: m.orgId, name: m.orgName }))}
              activeOrgId={active?.orgId ?? null}
            />
          </div>
        </header>
        <div className="border-b px-4 py-2 md:hidden">
          <SidebarNav orientation="horizontal" />
        </div>
        <main className="flex-1 px-4 py-6 md:px-8">{children}</main>
      </div>
    </div>
  );
}
