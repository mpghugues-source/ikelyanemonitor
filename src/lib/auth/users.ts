import { randomBytes } from "node:crypto";
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import type { Locale } from "@/generated/prisma/enums";
import { recordAudit } from "@/lib/auth/audit";
import type { Db } from "@/lib/auth/db";
import { hashPassword, validatePasswordPolicy, verifyPassword, type PasswordPolicyResult } from "@/lib/auth/password";
import { normalizeEmail } from "@/lib/auth/request";
import { revokeAllSessions } from "@/lib/auth/sessions";
import { checkLoginThrottle, recordLoginAttempt } from "@/lib/auth/throttle";
import { fail, ok, type Result } from "@/lib/result";

type PolicyFailure = Extract<PasswordPolicyResult, { ok: false }>["code"];

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export type CreateUserError = "invalid_email" | "email_taken" | PolicyFailure;

/**
 * Create an account. The e-mail is normalized and must be unique; the password must satisfy the
 * policy. Accounts belong to NO organization until a membership is created.
 */
export async function createUser(
  db: Db,
  input: { email: string; name?: string | null; password: string; locale?: Locale },
): Promise<Result<{ id: string; email: string }, CreateUserError>> {
  const email = normalizeEmail(input.email);
  if (email.length > 254 || !EMAIL_SHAPE.test(email)) return fail("invalid_email");

  const policy = validatePasswordPolicy(input.password, { email });
  if (!policy.ok) return fail(policy.code);

  const existing = await db.user.findUnique({ where: { email }, select: { id: true } });
  if (existing) return fail("email_taken");

  try {
    const user = await db.user.create({
      data: {
        email,
        name: input.name?.trim().slice(0, 120) || null,
        passwordHash: await hashPassword(input.password),
        passwordChangedAt: new Date(),
        locale: input.locale ?? "EN",
      },
      select: { id: true, email: true },
    });
    return ok(user);
  } catch (error) {
    // Two simultaneous sign-ups for the same address: the unique index arbitrates.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return fail("email_taken");
    throw error;
  }
}

/** "Acme Réseau & Co" -> "acme-reseau-co" */
export function slugify(name: string): string {
  const base = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip combining accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return base.length >= 2 ? base : "org";
}

/** Create an organization and make `ownerUserId` its OWNER, atomically. */
export async function createOrganization(
  db: PrismaClient,
  input: { name: string; ownerUserId: string; ownerEmail: string; ip?: string | null },
): Promise<{ id: string; slug: string }> {
  const name = input.name.trim().slice(0, 120) || "My organization";
  const base = slugify(name);

  return db.$transaction(async (tx) => {
    // Free slug: the plain one first, then with a random suffix.
    let slug = base;
    for (let attempt = 0; attempt < 6; attempt++) {
      if (!(await tx.organization.findUnique({ where: { slug }, select: { id: true } }))) break;
      slug = `${base}-${randomBytes(2).toString("hex")}`;
    }
    const org = await tx.organization.create({
      data: { name, slug, memberships: { create: { userId: input.ownerUserId, role: "OWNER" } } },
      select: { id: true, slug: true },
    });
    await recordAudit(tx, {
      action: "org.created",
      orgId: org.id,
      actorId: input.ownerUserId,
      actorEmail: input.ownerEmail,
      targetType: "organization",
      targetId: org.id,
      ipAddress: input.ip,
    });
    return org;
  });
}

export type ChangePasswordError = "invalid_current_password" | "throttled" | "not_found" | PolicyFailure;

/**
 * Change the password of the signed-in user. The current password is required (a hijacked session
 * alone cannot take over the account) and guessing it is throttled like a sign-in. On success every
 * OTHER session is revoked: whoever else was signed in with the old password is signed out.
 */
export async function changePassword(
  db: PrismaClient,
  input: { userId: string; currentPassword: string; newPassword: string; keepSessionId: string; ip?: string | null; now?: Date },
): Promise<Result<{ revokedSessions: number }, ChangePasswordError>> {
  const now = input.now ?? new Date();
  const user = await db.user.findUnique({ where: { id: input.userId }, select: { id: true, email: true, passwordHash: true } });
  if (!user) return fail("not_found");

  const throttle = await checkLoginThrottle(db, user.email, input.ip ?? null, now);
  if (!throttle.allowed) return fail("throttled");

  if (input.currentPassword.length > 1024 || !(await verifyPassword(input.currentPassword, user.passwordHash))) {
    await recordLoginAttempt(db, { email: user.email, ip: input.ip ?? null, success: false, now });
    return fail("invalid_current_password");
  }

  const policy = validatePasswordPolicy(input.newPassword, { email: user.email });
  if (!policy.ok) return fail(policy.code);

  const passwordHash = await hashPassword(input.newPassword);
  const revoked = await db.$transaction(async (tx) => {
    await tx.user.update({ where: { id: user.id }, data: { passwordHash, passwordChangedAt: now } });
    const count = await revokeAllSessions(tx, user.id, { exceptSessionId: input.keepSessionId, now });
    await recordAudit(tx, {
      action: "auth.password_changed",
      actorId: user.id,
      actorEmail: user.email,
      ipAddress: input.ip,
      metadata: { revokedSessions: count },
    });
    return count;
  });
  return ok({ revokedSessions: revoked });
}

export async function setUserLocale(db: Db, userId: string, locale: Locale): Promise<void> {
  await db.user.update({ where: { id: userId }, data: { locale } });
}
