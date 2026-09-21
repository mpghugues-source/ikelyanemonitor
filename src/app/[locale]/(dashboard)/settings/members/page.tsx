import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";
import { InviteMemberForm } from "@/components/settings/invite-member-form";
import { ChangeRoleForm, RemoveMemberForm, RevokeInvitationForm } from "@/components/settings/member-actions";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireActor } from "@/lib/auth/dal";
import { listMembers, listPendingInvitations } from "@/lib/auth/members";
import { assignableRoles, canChangeRole, canManageMember, ROLES } from "@/lib/auth/permissions";
import { getPrisma } from "@/lib/prisma";

export default async function MembersPage({ params }: PageProps<"/[locale]/settings/members">) {
  const { locale } = await params;
  setRequestLocale(locale);
  const { actor } = await requireActor("members:read");
  const t = await getTranslations();
  const format = await getFormatter();
  const db = getPrisma();

  const members = await listMembers(db, actor);
  const pending = await listPendingInvitations(db, actor); // forbidden for roles that cannot invite: shown as empty section
  if (!members.ok) return null;

  const roleLabel = (role: string) => t(`roles.${role.toLowerCase()}`);
  const grantable = assignableRoles(actor.role);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{t("members.title")}</CardTitle>
          <CardDescription>{t("members.subtitle")}</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("members.table.member")}</TableHead>
                <TableHead>{t("members.table.role")}</TableHead>
                <TableHead>{t("members.table.joined")}</TableHead>
                <TableHead className="text-right">{t("members.table.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.value.map((member) => {
                const self = member.userId === actor.userId;
                const options = ROLES.filter((role) => canChangeRole(actor.role, member.role, role)).map((role) => ({ value: role, label: roleLabel(role) }));
                const canEditRole = !self && options.length > 0;
                const canRemove = self || canManageMember(actor.role, member.role);
                return (
                  <TableRow key={member.membershipId} data-testid={`member-${member.email}`}>
                    <TableCell>
                      <div className="font-medium">
                        {member.name ?? member.email}
                        {self ? <Badge variant="outline" className="ml-2">{t("members.you")}</Badge> : null}
                        {member.disabled ? <Badge variant="destructive" className="ml-2">{t("members.disabled")}</Badge> : null}
                      </div>
                      <div className="text-xs text-muted-foreground">{member.email}</div>
                    </TableCell>
                    <TableCell>
                      {canEditRole ? (
                        <ChangeRoleForm membershipId={member.membershipId} current={member.role} options={options} />
                      ) : (
                        <Badge variant="secondary">{roleLabel(member.role)}</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{format.dateTime(member.joinedAt, { dateStyle: "medium" })}</TableCell>
                    <TableCell className="text-right">
                      {canRemove ? <RemoveMemberForm membershipId={member.membershipId} name={member.name ?? member.email} self={self} /> : null}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("members.invite.title")}</CardTitle>
          <CardDescription>{grantable.length > 0 ? t("members.invite.help") : t("members.invite.readOnly")}</CardDescription>
        </CardHeader>
        {grantable.length > 0 ? (
          <CardContent className="space-y-6">
            <InviteMemberForm roles={grantable.map((role) => ({ value: role, label: roleLabel(role) }))} />

            <div>
              <h3 className="mb-2 text-sm font-semibold">{t("members.pending.title")}</h3>
              {pending.ok && pending.value.length > 0 ? (
                <ul className="divide-y rounded-lg border">
                  {pending.value.map((invitation) => (
                    <li key={invitation.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                      <div>
                        <span className="font-medium">{invitation.email}</span>{" "}
                        <Badge variant="secondary">{roleLabel(invitation.role)}</Badge>
                        <div className="text-xs text-muted-foreground">
                          {t("members.pending.expires", { date: format.dateTime(invitation.expiresAt, { dateStyle: "medium" }) })}
                        </div>
                      </div>
                      <RevokeInvitationForm invitationId={invitation.id} />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">{t("members.pending.empty")}</p>
              )}
            </div>
          </CardContent>
        ) : null}
      </Card>
    </div>
  );
}
