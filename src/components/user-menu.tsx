"use client";

import { LogOut } from "lucide-react";
import { useTranslations } from "next-intl";
import { logoutAction, switchOrganizationAction } from "@/app/actions/session";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";

export interface UserMenuProps {
  displayName: string;
  email: string;
  roleLabel: string | null;
  organizations: { id: string; name: string }[];
  activeOrgId: string | null;
}

/** Signed-in identity, organization switcher (when there are several) and sign-out. */
export function UserMenu({ displayName, email, roleLabel, organizations, activeOrgId }: UserMenuProps) {
  const t = useTranslations("auth");
  return (
    <div className="flex items-center gap-3">
      {organizations.length > 1 ? (
        <form action={switchOrganizationAction}>
          <NativeSelect
            name="orgId"
            defaultValue={activeOrgId ?? undefined}
            aria-label={t("userMenu.organization")}
            onChange={(event) => event.currentTarget.form?.requestSubmit()}
            className="h-8 max-w-44"
          >
            {organizations.map((org) => (
              <option key={org.id} value={org.id}>
                {org.name}
              </option>
            ))}
          </NativeSelect>
        </form>
      ) : organizations[0] ? (
        <span className="hidden text-sm font-medium sm:inline" data-testid="org-name">{organizations[0].name}</span>
      ) : null}

      <div className="hidden text-right leading-tight md:block">
        <p className="text-sm font-medium" data-testid="user-name">{displayName}</p>
        <p className="text-xs text-muted-foreground">{email}</p>
      </div>
      {roleLabel ? <Badge variant="secondary" data-testid="role-badge">{roleLabel}</Badge> : null}

      <form action={logoutAction}>
        <Button type="submit" variant="outline" size="sm">
          <LogOut className="size-4" aria-hidden />
          <span className="hidden sm:inline">{t("logout")}</span>
        </Button>
      </form>
    </div>
  );
}
