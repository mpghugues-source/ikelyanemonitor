import type { PrismaClient } from "@/generated/prisma/client";
import type { Locale, Role } from "@/generated/prisma/enums";
import { recordAudit } from "@/lib/auth/audit";
import { INVITATION_TTL_SECONDS } from "@/lib/auth/constants";
import type { Actor } from "@/lib/auth/db";
import { assignableRoles, can } from "@/lib/auth/permissions";
import { normalizeEmail } from "@/lib/auth/request";
import { generateToken, hashToken } from "@/lib/auth/sessions";
import { createUser, type CreateUserError } from "@/lib/auth/users";
import { fail, ok, type Result } from "@/lib/result";

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export type InviteError = "forbidden" | "invalid_email" | "role_not_allowed" | "already_member";

/**
 * Invite an e-mail address into the actor's organization with `role`.
 *
 * The returned token appears in the invitation link and is the ONLY time it exists in clear text:
 * the database stores its hash. Re-inviting the same address replaces the previous pending link.
 */
export async function createInvitation(
  db: PrismaClient,
  actor: Actor,
  input: { email: string; role: Role; now?: Date },
): Promise<Result<{ token: string; invitationId: string; expiresAt: Date }, InviteError>> {
  if (!can(actor.role, "members:invite")) return fail("forbidden");
  if (!assignableRoles(actor.role).includes(input.role)) return fail("role_not_allowed");

  const email = normalizeEmail(input.email);
  if (email.length > 254 || !EMAIL_SHAPE.test(email)) return fail("invalid_email");

  const now = input.now ?? new Date();

  return db.$transaction(async (tx) => {
    const existingMember = await tx.membership.findFirst({
      where: { orgId: actor.orgId, user: { email } },
      select: { id: true },
    });
    if (existingMember) return fail("already_member");

    // One live link per address: replacing it kills the old one.
    await tx.invitation.updateMany({
      where: { orgId: actor.orgId, email, acceptedAt: null, revokedAt: null },
      data: { revokedAt: now },
    });

    const token = generateToken();
    const expiresAt = new Date(now.getTime() + INVITATION_TTL_SECONDS * 1000);
    const invitation = await tx.invitation.create({
      data: { orgId: actor.orgId, email, role: input.role, tokenHash: hashToken(token), invitedById: actor.userId, expiresAt, createdAt: now },
      select: { id: true },
    });
    await recordAudit(tx, {
      action: "member.invited",
      orgId: actor.orgId,
      actorId: actor.userId,
      actorEmail: actor.email,
      targetType: "invitation",
      targetId: invitation.id,
      ipAddress: actor.ip,
      metadata: { email, role: input.role },
    });
    return ok({ token, invitationId: invitation.id, expiresAt });
  });
}

export type RevokeInvitationError = "forbidden" | "not_found";

export async function revokeInvitation(
  db: PrismaClient,
  actor: Actor,
  invitationId: string,
  now: Date = new Date(),
): Promise<Result<true, RevokeInvitationError>> {
  if (!can(actor.role, "members:invite")) return fail("forbidden");

  return db.$transaction(async (tx) => {
    // Scoped by the ACTOR's organization: an id from another organization simply does not match.
    const result = await tx.invitation.updateMany({
      where: { id: invitationId, orgId: actor.orgId, acceptedAt: null, revokedAt: null },
      data: { revokedAt: now },
    });
    if (result.count !== 1) return fail("not_found");
    await recordAudit(tx, {
      action: "member.invitation_revoked",
      orgId: actor.orgId,
      actorId: actor.userId,
      actorEmail: actor.email,
      targetType: "invitation",
      targetId: invitationId,
      ipAddress: actor.ip,
    });
    return ok(true as const);
  });
}

export interface InvitationPreview {
  orgName: string;
  email: string;
  role: Role;
  /** An account with this e-mail exists: the invitee must sign in rather than choose a password. */
  accountExists: boolean;
}

/** What the accept page may show for a token. Returns null for unknown / used / revoked / expired. */
export async function previewInvitation(db: PrismaClient, token: string, now: Date = new Date()): Promise<InvitationPreview | null> {
  if (!token || token.length > 256) return null;
  const invitation = await db.invitation.findUnique({
    where: { tokenHash: hashToken(token) },
    select: { email: true, role: true, expiresAt: true, acceptedAt: true, revokedAt: true, org: { select: { name: true } } },
  });
  if (!invitation || invitation.acceptedAt || invitation.revokedAt || invitation.expiresAt <= now) return null;
  const user = await db.user.findUnique({ where: { email: invitation.email }, select: { id: true } });
  return { orgName: invitation.org.name, email: invitation.email, role: invitation.role, accountExists: Boolean(user) };
}

export type AcceptError = "invalid_or_expired" | "sign_in_required" | "email_mismatch" | "account_required" | CreateUserError;

export interface AcceptInput {
  token: string;
  now?: Date;
  ip?: string | null;
  /** The signed-in user, if any. Required when an account already exists for the invited e-mail. */
  signedInUserId?: string | null;
  /** Details for a NEW account (used only when no account exists for the invited e-mail). */
  newAccount?: { name?: string; password: string; locale?: Locale };
}

/**
 * Accept an invitation. Single use, race-safe (the conditional update on `acceptedAt` lets exactly
 * one of two simultaneous requests win).
 *
 *  • No account for the invited e-mail → one is created with the chosen password. Holding the link
 *    is the proof of owning the address (it was delivered there).
 *  • An account exists → the invitee must be SIGNED IN as that account. A link alone must never
 *    attach an existing account to an organization.
 */
export async function acceptInvitation(
  db: PrismaClient,
  input: AcceptInput,
): Promise<Result<{ userId: string; orgId: string; role: Role; createdAccount: boolean }, AcceptError>> {
  const now = input.now ?? new Date();
  if (!input.token || input.token.length > 256) return fail("invalid_or_expired");

  const invitation = await db.invitation.findUnique({ where: { tokenHash: hashToken(input.token) } });
  if (!invitation || invitation.acceptedAt || invitation.revokedAt || invitation.expiresAt <= now) {
    return fail("invalid_or_expired");
  }

  const existing = await db.user.findUnique({ where: { email: invitation.email }, select: { id: true, email: true, disabledAt: true } });

  if (existing) {
    if (existing.disabledAt) return fail("invalid_or_expired");
    if (!input.signedInUserId) return fail("sign_in_required");
    if (input.signedInUserId !== existing.id) return fail("email_mismatch");
  } else if (!input.newAccount) {
    return fail("account_required");
  }

  // Everything below is ONE transaction: claiming the invitation, creating the account and the
  // membership succeed together or not at all. (A `return fail(...)` would still COMMIT the work
  // done so far, so failures after the first write are signalled by throwing `Abort`.)
  try {
    return await db.$transaction(async (tx) => {
    // Claim the invitation. If a concurrent request already did, count is 0 and we stop.
    const claimed = await tx.invitation.updateMany({
      where: { id: invitation.id, acceptedAt: null, revokedAt: null },
      data: { acceptedAt: now },
    });
    if (claimed.count !== 1) throw new Abort("invalid_or_expired");

    let userId: string;
    let createdAccount = false;
    if (existing) {
      userId = existing.id;
    } else {
      const account = input.newAccount as NonNullable<AcceptInput["newAccount"]>;
      const created = await createUser(tx, { email: invitation.email, name: account.name, password: account.password, locale: account.locale });
      if (!created.ok) throw new Abort(created.error);
      userId = created.value.id;
      createdAccount = true;
    }

    // Already a member (e.g. invited twice): keep the existing role, never downgrade silently.
    const membership = await tx.membership.upsert({
      where: { userId_orgId: { userId, orgId: invitation.orgId } },
      create: { userId, orgId: invitation.orgId, role: invitation.role },
      update: {},
      select: { role: true },
    });
    await recordAudit(tx, {
      action: "member.joined",
      orgId: invitation.orgId,
      actorId: userId,
      actorEmail: invitation.email,
      targetType: "user",
      targetId: userId,
      ipAddress: input.ip,
      metadata: { role: membership.role, invitedBy: invitation.invitedById, createdAccount },
    });
    return ok({ userId, orgId: invitation.orgId, role: membership.role, createdAccount });
    });
  } catch (error) {
    if (error instanceof Abort) return fail(error.code);
    throw error;
  }
}

/** Thrown inside the accept transaction to roll it back with a specific business error. */
class Abort extends Error {
  constructor(readonly code: AcceptError) {
    super(code);
  }
}
