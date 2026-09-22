import type { PrismaClient } from "@/generated/prisma/client";
import type { Locale } from "@/generated/prisma/enums";
import { auditQuietly } from "@/lib/auth/audit";
import { needsRehash, hashPassword, verifyAgainstDummy, verifyPassword } from "@/lib/auth/password";
import { normalizeEmail } from "@/lib/auth/request";
import { createSession, purgeDeadSessions } from "@/lib/auth/sessions";
import { checkLoginThrottle, clearEmailFailures, purgeOldAttempts, recordLoginAttempt } from "@/lib/auth/throttle";
import { createTotpChallenge } from "@/lib/auth/two-factor";

export type SignInResult =
  | { ok: true; token: string; expiresAt: Date; user: { id: string; email: string; locale: Locale } }
  | { ok: false; error: "invalid_credentials" }
  | { ok: false; error: "throttled"; retryAfterSeconds: number }
  /** Password checked out, but the account has 2FA on: no session yet — see src/lib/auth/two-factor.ts. */
  | { ok: false; error: "totp_required"; challengeToken: string; expiresAt: Date };

/** Upper bound on the password length we are willing to hash (the policy maximum is 128). */
const MAX_PASSWORD_INPUT = 1024;

/**
 * Verify credentials and open a session.
 *
 * Security properties:
 *  • one generic failure ("invalid_credentials") for unknown account, wrong password AND disabled
 *    account — the response never reveals which;
 *  • the same amount of hashing work happens when the account does not exist (no timing oracle);
 *  • attempts are throttled per e-mail and per source address, and recorded even for unknown
 *    accounts;
 *  • the true reason is written to the audit trail for administrators.
 */
export async function signIn(
  db: PrismaClient,
  input: { email: string; password: string; ip: string | null; userAgent: string | null; nextPath?: string | null; now?: Date },
): Promise<SignInResult> {
  const now = input.now ?? new Date();
  const email = normalizeEmail(input.email);

  const throttle = await checkLoginThrottle(db, email, input.ip, now);
  if (!throttle.allowed) {
    await auditQuietly(db, { action: "auth.login_throttled", actorEmail: email, ipAddress: input.ip });
    return { ok: false, error: "throttled", retryAfterSeconds: throttle.retryAfterSeconds };
  }

  const user = await db.user.findUnique({
    where: { email },
    select: { id: true, email: true, passwordHash: true, disabledAt: true, locale: true, totpEnabledAt: true },
  });

  const passwordOk =
    input.password.length > 0 && input.password.length <= MAX_PASSWORD_INPUT && user?.passwordHash
      ? await verifyPassword(input.password, user.passwordHash)
      : await verifyAgainstDummy(input.password.slice(0, MAX_PASSWORD_INPUT));

  if (!user || !passwordOk || user.disabledAt) {
    await recordLoginAttempt(db, { email, ip: input.ip, success: false, now });
    await auditQuietly(db, {
      action: "auth.login_failed",
      actorId: user?.id,
      actorEmail: email,
      ipAddress: input.ip,
      // Internal only (audit trail); never sent back to the client.
      metadata: { reason: !user ? "unknown_account" : user.disabledAt ? "account_disabled" : "wrong_password" },
    });
    return { ok: false, error: "invalid_credentials" };
  }

  await recordLoginAttempt(db, { email, ip: input.ip, success: true, now });
  await clearEmailFailures(db, email);

  // Upgrade the stored hash if the cost parameters have been raised since it was made.
  const passwordHash = user.passwordHash && needsRehash(user.passwordHash) ? await hashPassword(input.password) : undefined;
  await db.user.update({ where: { id: user.id }, data: { lastLoginAt: now, ...(passwordHash ? { passwordHash } : {}) } });

  if (user.totpEnabledAt) {
    const challenge = await createTotpChallenge(db, { userId: user.id, ip: input.ip, userAgent: input.userAgent, nextPath: input.nextPath, now });
    return { ok: false, error: "totp_required", challengeToken: challenge.token, expiresAt: challenge.expiresAt };
  }

  const session = await createSession(db, { userId: user.id, ip: input.ip, userAgent: input.userAgent, now });
  await auditQuietly(db, {
    action: "auth.login",
    orgId: session.activeOrgId,
    actorId: user.id,
    actorEmail: user.email,
    ipAddress: input.ip,
  });

  // Housekeeping, spread across requests instead of needing a scheduler.
  if (Math.random() < 0.05) {
    await Promise.allSettled([purgeOldAttempts(db, now), purgeDeadSessions(db, now)]);
  }

  return { ok: true, token: session.token, expiresAt: session.expiresAt, user: { id: user.id, email: user.email, locale: user.locale } };
}
