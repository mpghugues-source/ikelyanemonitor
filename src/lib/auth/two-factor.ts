import type { PrismaClient } from "@/generated/prisma/client";
import type { Locale } from "@/generated/prisma/enums";
import { recordAudit } from "@/lib/auth/audit";
import { TOTP_CHALLENGE_TTL_SECONDS, TOTP_MAX_CHALLENGE_ATTEMPTS } from "@/lib/auth/constants";
import type { Db } from "@/lib/auth/db";
import { verifyPassword } from "@/lib/auth/password";
import { generateToken, hashToken, createSession } from "@/lib/auth/sessions";
import { checkLoginThrottle, recordLoginAttempt } from "@/lib/auth/throttle";
import { generateRecoveryCodes, generateTotpSecret, normalizeRecoveryCode, totpUri, verifyTotpCode } from "@/lib/auth/totp";
import { decryptSecret, encryptSecret, totpSecretAad } from "@/lib/crypto";
import { fail, ok, type Result } from "@/lib/result";

/**
 * Two-factor authentication (TOTP): setup/disable, and the login-time challenge that a password
 * alone is not enough to pass. See src/lib/auth/totp.ts for the algorithm itself and
 * src/lib/auth/login.ts (`signIn`) for where a challenge gets created.
 */

export interface TotpSetup {
  secret: string;
  otpauthUri: string;
}

/** Begin (or restart) setup: a fresh secret, stored but NOT yet active — see User.totpEnabledAt. */
export async function startTotpSetup(db: PrismaClient, userId: string, email: string): Promise<TotpSetup> {
  const secret = generateTotpSecret();
  await db.user.update({ where: { id: userId }, data: { totpSecretEnc: encryptSecret(secret, totpSecretAad(userId)) } });
  return { secret, otpauthUri: totpUri(secret, email) };
}

export type ConfirmTotpError = "no_pending_setup" | "invalid_code";

/** Prove the authenticator app was set up correctly, then turn 2FA on and issue recovery codes (shown once). */
export async function confirmTotpSetup(
  db: PrismaClient,
  userId: string,
  code: string,
  now: Date = new Date(),
): Promise<Result<{ recoveryCodes: string[] }, ConfirmTotpError>> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { totpSecretEnc: true } });
  if (!user?.totpSecretEnc) return fail("no_pending_setup");

  const secret = decryptSecret(user.totpSecretEnc, totpSecretAad(userId));
  if (!verifyTotpCode(secret, code.trim(), now)) return fail("invalid_code");

  const recoveryCodes = generateRecoveryCodes();
  await db.$transaction(async (tx) => {
    // A retried confirm (double submit) must not pile up a second batch of codes.
    await tx.totpRecoveryCode.deleteMany({ where: { userId } });
    await tx.totpRecoveryCode.createMany({ data: recoveryCodes.map((code) => ({ userId, codeHash: hashToken(normalizeRecoveryCode(code)) })) });
    await tx.user.update({ where: { id: userId }, data: { totpEnabledAt: now } });
    await recordAudit(tx, { action: "auth.totp_enabled", actorId: userId });
  });
  return ok({ recoveryCodes });
}

export type TotpCredentialError = "invalid_password" | "throttled" | "not_enabled";

/**
 * A hijacked session cookie alone must not be able to turn off 2FA or mint new recovery codes —
 * same reasoning as changePassword (src/lib/auth/users.ts): the current password is required, and
 * guessing it here is throttled exactly like a sign-in.
 */
async function verifyCurrentPassword(
  db: Db,
  userId: string,
  password: string,
  ip: string | null,
  now: Date,
): Promise<Result<{ email: string }, "invalid_password" | "throttled">> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { email: true, passwordHash: true } });
  if (!user) return fail("invalid_password");
  const throttle = await checkLoginThrottle(db, user.email, ip, now);
  if (!throttle.allowed) return fail("throttled");
  if (password.length > 1024 || !(await verifyPassword(password, user.passwordHash))) {
    await recordLoginAttempt(db, { email: user.email, ip, success: false, now });
    return fail("invalid_password");
  }
  return ok({ email: user.email });
}

export async function disableTotp(
  db: PrismaClient,
  input: { userId: string; password: string; ip?: string | null; now?: Date },
): Promise<Result<true, TotpCredentialError>> {
  const now = input.now ?? new Date();
  const passwordCheck = await verifyCurrentPassword(db, input.userId, input.password, input.ip ?? null, now);
  if (!passwordCheck.ok) return passwordCheck;

  const user = await db.user.findUnique({ where: { id: input.userId }, select: { totpEnabledAt: true } });
  if (!user?.totpEnabledAt) return fail("not_enabled");

  await db.$transaction(async (tx) => {
    await tx.user.update({ where: { id: input.userId }, data: { totpSecretEnc: null, totpEnabledAt: null } });
    await tx.totpRecoveryCode.deleteMany({ where: { userId: input.userId } });
    await tx.totpChallenge.deleteMany({ where: { userId: input.userId } });
    await recordAudit(tx, { action: "auth.totp_disabled", actorId: input.userId, actorEmail: passwordCheck.value.email, ipAddress: input.ip });
  });
  return ok(true as const);
}

export async function regenerateRecoveryCodes(
  db: PrismaClient,
  input: { userId: string; password: string; ip?: string | null; now?: Date },
): Promise<Result<{ recoveryCodes: string[] }, TotpCredentialError>> {
  const now = input.now ?? new Date();
  const passwordCheck = await verifyCurrentPassword(db, input.userId, input.password, input.ip ?? null, now);
  if (!passwordCheck.ok) return passwordCheck;

  const user = await db.user.findUnique({ where: { id: input.userId }, select: { totpEnabledAt: true } });
  if (!user?.totpEnabledAt) return fail("not_enabled");

  const recoveryCodes = generateRecoveryCodes();
  await db.$transaction(async (tx) => {
    await tx.totpRecoveryCode.deleteMany({ where: { userId: input.userId } });
    await tx.totpRecoveryCode.createMany({ data: recoveryCodes.map((code) => ({ userId: input.userId, codeHash: hashToken(normalizeRecoveryCode(code)) })) });
    await recordAudit(tx, { action: "auth.totp_recovery_codes_regenerated", actorId: input.userId, actorEmail: passwordCheck.value.email, ipAddress: input.ip });
  });
  return ok({ recoveryCodes });
}

// ── Login-time challenge ─────────────────────────────────────────────────────────────────────

/**
 * Opened by `signIn` (src/lib/auth/login.ts) once the password checks out for a 2FA-enabled
 * account. Deliberately a separate table from `Session`, not a "pending" flag on one: a row here
 * can never be mistaken for an authenticated session by code that forgets to check a flag.
 */
export async function createTotpChallenge(
  db: Db,
  input: { userId: string; ip: string | null; userAgent: string | null; nextPath?: string | null; now?: Date },
): Promise<{ token: string; expiresAt: Date }> {
  const now = input.now ?? new Date();
  const token = generateToken();
  const expiresAt = new Date(now.getTime() + TOTP_CHALLENGE_TTL_SECONDS * 1000);
  await db.totpChallenge.create({
    data: {
      userId: input.userId,
      tokenHash: hashToken(token),
      nextPath: input.nextPath ?? null,
      ipAddress: input.ip,
      userAgent: input.userAgent?.slice(0, 255) ?? null,
      expiresAt,
      createdAt: now,
    },
  });
  return { token, expiresAt };
}

export interface TotpChallengePreview {
  email: string;
  nextPath: string | null;
}

/** For the /totp page: who is this for, and is the challenge still usable? Never a database write. */
export async function previewTotpChallenge(db: Db, token: string, now: Date = new Date()): Promise<TotpChallengePreview | null> {
  if (!token || token.length > 256) return null;
  const challenge = await db.totpChallenge.findUnique({
    where: { tokenHash: hashToken(token) },
    select: { expiresAt: true, nextPath: true, user: { select: { email: true } } },
  });
  if (!challenge || challenge.expiresAt <= now) return null;
  return { email: challenge.user.email, nextPath: challenge.nextPath };
}

export type VerifyTotpError = "totp_challenge_expired" | "invalid_code" | "too_many_attempts";

export interface VerifiedTotpChallenge {
  token: string;
  expiresAt: Date;
  user: { id: string; email: string; locale: Locale };
  nextPath: string | null;
  usedRecoveryCode: boolean;
}

/**
 * Accepts either a 6-digit TOTP code or a recovery code (auto-detected by shape). Wrong guesses are
 * capped at `TOTP_MAX_CHALLENGE_ATTEMPTS`: past that the challenge is thrown away rather than left
 * guessable — a 6-digit code is only ~1e6 possibilities, so unlimited attempts within the 5-minute
 * window would make it brute-forceable.
 */
export async function verifyTotpChallenge(
  db: PrismaClient,
  input: { token: string; code: string; ip: string | null; userAgent: string | null; now?: Date },
): Promise<Result<VerifiedTotpChallenge, VerifyTotpError>> {
  const now = input.now ?? new Date();
  if (!input.token || input.token.length > 256) return fail("totp_challenge_expired");

  const challenge = await db.totpChallenge.findUnique({
    where: { tokenHash: hashToken(input.token) },
    include: { user: { select: { id: true, email: true, locale: true, totpSecretEnc: true, disabledAt: true } } },
  });
  if (!challenge || challenge.expiresAt <= now || challenge.user.disabledAt) return fail("totp_challenge_expired");

  const code = input.code.trim();
  const isTotpShaped = /^\d{6}$/.test(code);

  let matchedRecoveryCodeId: string | null = null;
  let valid = false;

  if (isTotpShaped && challenge.user.totpSecretEnc) {
    valid = verifyTotpCode(decryptSecret(challenge.user.totpSecretEnc, totpSecretAad(challenge.user.id)), code, now);
  } else if (!isTotpShaped) {
    const recoveryCode = await db.totpRecoveryCode.findUnique({
      where: { codeHash: hashToken(normalizeRecoveryCode(code)) },
      select: { id: true, userId: true, usedAt: true },
    });
    if (recoveryCode && recoveryCode.userId === challenge.userId && !recoveryCode.usedAt) {
      valid = true;
      matchedRecoveryCodeId = recoveryCode.id;
    }
  }

  if (!valid) {
    const attempts = challenge.failedAttempts + 1;
    if (attempts >= TOTP_MAX_CHALLENGE_ATTEMPTS) {
      await db.totpChallenge.delete({ where: { id: challenge.id } });
      return fail("too_many_attempts");
    }
    await db.totpChallenge.update({ where: { id: challenge.id }, data: { failedAttempts: attempts } });
    return fail("invalid_code");
  }

  return db.$transaction(async (tx) => {
    // Single use either way: the challenge is spent, and a matched recovery code cannot be reused.
    await tx.totpChallenge.delete({ where: { id: challenge.id } });
    if (matchedRecoveryCodeId) await tx.totpRecoveryCode.update({ where: { id: matchedRecoveryCodeId }, data: { usedAt: now } });

    const session = await createSession(tx, { userId: challenge.user.id, ip: input.ip, userAgent: input.userAgent, now });
    await recordAudit(tx, {
      action: "auth.login",
      orgId: session.activeOrgId,
      actorId: challenge.user.id,
      actorEmail: challenge.user.email,
      ipAddress: input.ip,
      metadata: { via: matchedRecoveryCodeId ? "totp_recovery_code" : "totp" },
    });

    return ok({
      token: session.token,
      expiresAt: session.expiresAt,
      user: { id: challenge.user.id, email: challenge.user.email, locale: challenge.user.locale },
      nextPath: challenge.nextPath,
      usedRecoveryCode: Boolean(matchedRecoveryCodeId),
    });
  });
}
