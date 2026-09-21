"use client";

import { LayoutDashboard, Settings } from "lucide-react";
import { useTranslations } from "next-intl";
import { Link, usePathname } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import { MODULES } from "@/modules/registry";

/**
 * Main navigation. Vertical in the desktop sidebar, a horizontally scrollable strip on small
 * screens. `usePathname` from next-intl returns the path WITHOUT the locale prefix.
 */
export function SidebarNav({ orientation = "vertical" }: { orientation?: "vertical" | "horizontal" }) {
  const t = useTranslations("nav");
  const pathname = usePathname();

  const items = [
    { href: "/", label: t("overview"), icon: LayoutDashboard, active: pathname === "/" },
    ...MODULES.map((module) => ({
      href: module.href as string,
      label: t(module.key),
      icon: module.icon,
      active: pathname === module.href || pathname.startsWith(`${module.href}/`),
    })),
    { href: "/settings/profile", label: t("settings"), icon: Settings, active: pathname.startsWith("/settings") },
  ];

  return (
    <nav
      aria-label="Main"
      className={cn(orientation === "vertical" ? "flex flex-col gap-1" : "flex gap-1 overflow-x-auto pb-1")}
    >
      {items.map(({ href, label, icon: Icon, active }) => (
        <Link
          key={href}
          href={href}
          aria-current={active ? "page" : undefined}
          className={cn(
            "flex shrink-0 items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors",
            active
              ? "bg-sidebar-accent text-sidebar-accent-foreground"
              : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
          )}
        >
          <Icon className="size-4 shrink-0" aria-hidden />
          <span className="whitespace-nowrap">{label}</span>
        </Link>
      ))}
    </nav>
  );
}
