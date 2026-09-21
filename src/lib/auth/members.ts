import type { PrismaClient } from "@/generated/prisma/client";
import type { Role } from "@/generated/prisma/enums";
import { recordAudit } from "@/lib/auth/audit";
import type { Actor, Db } from "@/lib/auth/db";
import { can, canChangeRole, canManageMember } from "@/lib/auth/permissions";
import { fail, ok, type Result } from "@/lib/result";

export interface MemberRow {
  membershipId: string;
  userId: string;
  email: string;
  name: string | null;
  role: Role;
  joinedAt: Date;
  disabled: boolean;
}

export interface PendingInvitationRow {
  id: string;
  email: string;
  role: Role;
  expiresAt: Date;
  createdAt: Date;
}

/** Members of an organization (read-only view for everyone who belongs to it). */
export async function listMembers(db: Db, actor: Actor): Promise<Result<MemberRow[], "forbidden">> {
  if (!can(actor.role, "members:read")) return fail("forbidden");
  const rows = await db.membership.findMany({
    where: { orgId: actor.orgId },
    orderBy: { createdAt: "asc" },
    select: { id: true, role: true, createdAt: true, user: { select: { id: true, email: true, name: true, disabledAt: true } } },
  });
  return ok(
    rows.map((m) => ({
      membershipId: m.id,
      userId: m.user.id,
      email: m.user.email,
      name: m.user.name,
      role: m.role,
      joinedAt: m.createdAt,
      disabled: Boolean(m.user.disabledAt),
    })),
  );
}

export async function listPendingInvitations(
  db: Db,
  actor: Actor,
  now: Date = new Date(),
): Promise<Result<PendingInvitationRow[], "forbidden">> {
  if (!can(actor.role, "members:invite")) return fail("forbidden");
  const rows = await db.invitation.findMany({
    where: { orgId: actor.orgId, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } },
    orderBy: { createdAt: "desc" },
    select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
  });
  return ok(rows);
}

export type MemberError = "forbidden" | "not_found" | "last_owner" | "cannot_change_own_role";

/**
 * Serialize concurrent membership changes of ONE organization. Without this lock two owners could
 * demote each other at the same moment, each seeing "another owner still exists", and leave the
 * organization with none. `FOR UPDATE` makes the second transaction wait, then re-count.
 */
async function lockOrganizationMemberships(tx: Db, orgId: string): Promise<void> {
  await (tx as PrismaClient).$queryRaw`SELECT id FROM memberships WHERE "orgId" = ${orgId} FOR UPDATE`;
}

export async function changeMemberRole(
  db: PrismaClient,
  actor: Actor,
  membershipId: string,
  newRole: Role,
): Promise<Result<{ from: Role; to: Role }, MemberError>> {
  if (!can(actor.role, "members:manage")) return fail("forbidden");

  return db.$transaction(async (tx) => {
    await lockOrganizationMemberships(tx, actor.orgId);

    // Scoped by the actor's organization: a membership id from elsewhere is "not found".
    const target = await tx.membership.findFirst({
      where: { id: membershipId, orgId: actor.orgId },
      select: { id: true, userId: true, role: true, user: { select: { email: true } } },
    });
    if (!target) return fail("not_found");

    if (target.userId === actor.userId) return fail("cannot_change_own_role");
    if (!canChangeRole(actor.role, target.role, newRole)) return fail("forbidden");
    if (target.role === newRole) return ok({ from: target.role, to: newRole });

    if (target.role === "OWNER") {
      const owners = await tx.membership.count({ where: { orgId: actor.orgId, role: "OWNER" } });
      if (owners <= 1) return fail("last_owner");
    }

    await tx.membership.update({ where: { id: target.id }, data: { role: newRole } });
    await recordAudit(tx, {
      action: "member.role_changed",
      orgId: actor.orgId,
      actorId: actor.userId,
      actorEmail: actor.email,
      targetType: "user",
      targetId: target.userId,
      ipAddress: actor.ip,
      metadata: { email: target.user.email, from: target.role, to: newRole },
    });
    return ok({ from: target.role, to: newRole });
  });
}

/**
 * Remove a member — or let someone leave (removing oneself is always allowed, subject to the
 * last-owner rule). Removing a member does not delete their account; it only ends their access
 * to THIS organization, effective on their next request.
 */
export async function removeMember(
  db: PrismaClient,
  actor: Actor,
  membershipId: string,
): Promise<Result<{ left: boolean }, MemberError>> {
  return db.$transaction(async (tx) => {
    await lockOrganizationMemberships(tx, actor.orgId);

    const target = await tx.membership.findFirst({
      where: { id: membershipId, orgId: actor.orgId },
      select: { id: true, userId: true, role: true, user: { select: { email: true } } },
    });
    if (!target) return fail("not_found");

    const leaving = target.userId === actor.userId;
    if (!leaving && !canManageMember(actor.role, target.role)) return fail("forbidden");

    if (target.role === "OWNER") {
      const owners = await tx.membership.count({ where: { orgId: actor.orgId, role: "OWNER" } });
      if (owners <= 1) return fail("last_owner");
    }

    await tx.membership.delete({ where: { id: target.id } });
    await recordAudit(tx, {
      action: leaving ? "member.left" : "member.removed",
      orgId: actor.orgId,
      actorId: actor.userId,
      actorEmail: actor.email,
      targetType: "user",
      targetId: target.userId,
      ipAddress: actor.ip,
      metadata: { email: target.user.email, role: target.role },
    });
    return ok({ left: leaving });
  });
}
