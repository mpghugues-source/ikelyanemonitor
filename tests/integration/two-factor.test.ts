import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { generateTotpCode } from "@/lib/auth/totp";

/**
 * Two-factor authentication (setup/disable, and the login-time challenge) against a REAL
 * PostgreSQL. Skipped unless DATABASE_URL and IKELYANE_SECRET_KEY are set (see
 * tests/integration/telemetry-route.test.ts). The algorithm itself (RFC 6238 vectors, drift,
 * recovery-code formatting) is unit-tested in tests/totp.test.ts — this file is about the database
 * side: setup state transitions, credential re-checks, and the challenge's brute-force cap.
 */
const enabled = Boolean(process.env.DATABASE_URL && process.env.IKELYANE_SECRET_KEY);

describe.skipIf(!enabled)("two-factor authentication", () => {
  let db: PrismaClient;
  let m: {
    login: typeof import("@/lib/auth/login");
    twoFactor: typeof import("@/lib/auth/two-factor");
  };

  const runId = randomBytes(4).toString("hex");
  const domain = `${runId}.test`;
  const PASSWORD = "correct horse battery staple";
  const IP = "203.0.113.11";
  let PASSWORD_HASH: string;

  const userIds: string[] = [];
  let counter = 0;

  async function makeUser(label: string) {
    const email = `${label}-${++counter}@${domain}`;
    const user = await db.user.create({ data: { email, name: label, passwordHash: PASSWORD_HASH } });
    userIds.push(user.id);
    return { id: user.id, email };
  }

  /** Runs setup end to end (start -> confirm with a freshly computed code) and returns the secret + codes. */
  async function enrollUser(label: string) {
    const user = await makeUser(label);
    const setup = await m.twoFactor.startTotpSetup(db, user.id, user.email);
    const confirmed = await m.twoFactor.confirmTotpSetup(db, user.id, generateTotpCode(setup.secret));
    if (!confirmed.ok) throw new Error("setup confirmation unexpectedly failed");
    return { ...user, secret: setup.secret, recoveryCodes: confirmed.value.recoveryCodes };
  }

  beforeAll(async () => {
    db = (await import("@/lib/prisma")).getPrisma();
    m = { login: await import("@/lib/auth/login"), twoFactor: await import("@/lib/auth/two-factor") };
    const { hashPassword } = await import("@/lib/auth/password");
    PASSWORD_HASH = await hashPassword(PASSWORD);
  });

  afterAll(async () => {
    if (!db) return;
    await db.totpChallenge.deleteMany({ where: { userId: { in: userIds } } });
    await db.totpRecoveryCode.deleteMany({ where: { userId: { in: userIds } } });
    await db.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
  });

  describe("setup", () => {
    it("rejects a wrong code and requires starting setup before confirming", async () => {
      const user = await makeUser("setup-wrong");
      expect(await m.twoFactor.confirmTotpSetup(db, user.id, "000000")).toEqual({ ok: false, error: "no_pending_setup" });

      const setup = await m.twoFactor.startTotpSetup(db, user.id, user.email);
      expect(setup.secret).toMatch(/^[A-Z2-7]{32}$/);
      expect(setup.otpauthUri).toContain(encodeURIComponent(user.email));

      expect(await m.twoFactor.confirmTotpSetup(db, user.id, "000000")).toEqual({ ok: false, error: "invalid_code" });
      // Not yet active: sign-in still only needs the password.
      const before = await db.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(before.totpEnabledAt).toBeNull();
    });

    it("activates 2FA and issues 10 distinct recovery codes on the right code", async () => {
      const user = await enrollUser("setup-ok");
      expect(user.recoveryCodes).toHaveLength(10);
      expect(new Set(user.recoveryCodes).size).toBe(10);

      const after = await db.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(after.totpEnabledAt).not.toBeNull();
      expect(after.totpSecretEnc).not.toBeNull();
      expect(await db.totpRecoveryCode.count({ where: { userId: user.id, usedAt: null } })).toBe(10);

      const audit = await db.auditLog.findFirstOrThrow({ where: { action: "auth.totp_enabled", actorId: user.id } });
      expect(audit).toBeTruthy();
    });

    it("re-confirming (double submit) replaces the recovery codes rather than adding a second batch", async () => {
      const user = await enrollUser("setup-double");
      const setup2 = await m.twoFactor.startTotpSetup(db, user.id, user.email);
      const confirmed2 = await m.twoFactor.confirmTotpSetup(db, user.id, generateTotpCode(setup2.secret));
      expect(confirmed2.ok).toBe(true);
      expect(await db.totpRecoveryCode.count({ where: { userId: user.id } })).toBe(10);
    });
  });

  describe("disable and regenerate", () => {
    it("requires the correct current password, and requires 2FA to already be enabled", async () => {
      const user = await enrollUser("manage-perm");
      expect(await m.twoFactor.disableTotp(db, { userId: user.id, password: "wrong password", ip: IP })).toEqual({ ok: false, error: "invalid_password" });

      const notEnrolled = await makeUser("manage-not-enrolled");
      expect(await m.twoFactor.disableTotp(db, { userId: notEnrolled.id, password: PASSWORD, ip: IP })).toEqual({ ok: false, error: "not_enabled" });
      expect(await m.twoFactor.regenerateRecoveryCodes(db, { userId: notEnrolled.id, password: PASSWORD, ip: IP })).toEqual({ ok: false, error: "not_enabled" });
    });

    it("disabling clears the secret, the flag, all recovery codes, and any pending challenge", async () => {
      const user = await enrollUser("disable-ok");
      await db.totpChallenge.create({
        data: { userId: user.id, tokenHash: `leftover-${user.id}`, expiresAt: new Date(Date.now() + 60_000) },
      });

      const result = await m.twoFactor.disableTotp(db, { userId: user.id, password: PASSWORD, ip: IP });
      expect(result.ok).toBe(true);

      const after = await db.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(after.totpEnabledAt).toBeNull();
      expect(after.totpSecretEnc).toBeNull();
      expect(await db.totpRecoveryCode.count({ where: { userId: user.id } })).toBe(0);
      expect(await db.totpChallenge.count({ where: { userId: user.id } })).toBe(0);

      // Sign-in is back to password-only.
      const signIn = await m.login.signIn(db, { email: user.email, password: PASSWORD, ip: IP, userAgent: "vitest" });
      expect(signIn.ok).toBe(true);
    });

    it("regenerating invalidates every old code and issues 10 fresh ones", async () => {
      const user = await enrollUser("regen-ok");
      const oldCodes = user.recoveryCodes;

      const result = await m.twoFactor.regenerateRecoveryCodes(db, { userId: user.id, password: PASSWORD, ip: IP });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.recoveryCodes).toHaveLength(10);
      expect(result.value.recoveryCodes.some((code) => oldCodes.includes(code))).toBe(false);

      // An old code can no longer complete a challenge (verified in the login-challenge suite below).
      expect(await db.totpRecoveryCode.count({ where: { userId: user.id } })).toBe(10);
    });
  });

  describe("login-time challenge", () => {
    it("sign-in with the right password returns totp_required, not a session", async () => {
      const user = await enrollUser("login-required");
      const result = await m.login.signIn(db, { email: user.email, password: PASSWORD, ip: IP, userAgent: "vitest" });
      expect(result.ok).toBe(false);
      if (result.ok || result.error !== "totp_required") throw new Error("expected totp_required");
      expect(result.challengeToken.length).toBeGreaterThanOrEqual(20);
      expect(await db.session.count({ where: { userId: user.id } })).toBe(0);
    });

    it("a correct TOTP code completes the sign-in and the challenge is single-use", async () => {
      const user = await enrollUser("login-totp-ok");
      const started = await m.login.signIn(db, { email: user.email, password: PASSWORD, ip: IP, userAgent: "vitest", nextPath: "/incidents" });
      if (started.ok || started.error !== "totp_required") throw new Error("expected totp_required");

      const verified = await m.twoFactor.verifyTotpChallenge(db, {
        token: started.challengeToken,
        code: generateTotpCode(user.secret),
        ip: IP,
        userAgent: "vitest",
      });
      expect(verified.ok).toBe(true);
      if (!verified.ok) return;
      expect(verified.value.usedRecoveryCode).toBe(false);
      expect(verified.value.nextPath).toBe("/incidents");

      const stored = await db.session.findFirst({ where: { userId: user.id } });
      expect(stored).toBeTruthy();

      // Replaying the same (now-deleted) challenge fails.
      const replay = await m.twoFactor.verifyTotpChallenge(db, { token: started.challengeToken, code: generateTotpCode(user.secret), ip: IP, userAgent: "vitest" });
      expect(replay).toEqual({ ok: false, error: "totp_challenge_expired" });
    });

    it("a recovery code completes the sign-in and cannot be reused", async () => {
      const user = await enrollUser("login-recovery-ok");
      const code = user.recoveryCodes[0];
      if (!code) throw new Error("no recovery code");

      const started = await m.login.signIn(db, { email: user.email, password: PASSWORD, ip: IP, userAgent: "vitest" });
      if (started.ok || started.error !== "totp_required") throw new Error("expected totp_required");

      const verified = await m.twoFactor.verifyTotpChallenge(db, { token: started.challengeToken, code, ip: IP, userAgent: "vitest" });
      expect(verified.ok).toBe(true);
      if (verified.ok) expect(verified.value.usedRecoveryCode).toBe(true);

      // A second sign-in, same recovery code: rejected (not just "already used this challenge" — the code itself is spent).
      const started2 = await m.login.signIn(db, { email: user.email, password: PASSWORD, ip: IP, userAgent: "vitest" });
      if (started2.ok || started2.error !== "totp_required") throw new Error("expected totp_required");
      const reuse = await m.twoFactor.verifyTotpChallenge(db, { token: started2.challengeToken, code, ip: IP, userAgent: "vitest" });
      expect(reuse).toEqual({ ok: false, error: "invalid_code" });
    });

    it("rejects a recovery code that belongs to a different user", async () => {
      const userA = await enrollUser("cross-a");
      const userB = await enrollUser("cross-b");
      const codeFromB = userB.recoveryCodes[0];
      if (!codeFromB) throw new Error("no recovery code");

      const started = await m.login.signIn(db, { email: userA.email, password: PASSWORD, ip: IP, userAgent: "vitest" });
      if (started.ok || started.error !== "totp_required") throw new Error("expected totp_required");

      const result = await m.twoFactor.verifyTotpChallenge(db, { token: started.challengeToken, code: codeFromB, ip: IP, userAgent: "vitest" });
      expect(result).toEqual({ ok: false, error: "invalid_code" });
    });

    it("caps wrong attempts and then throws the challenge away, forcing a fresh sign-in", async () => {
      const user = await enrollUser("login-cap");
      const started = await m.login.signIn(db, { email: user.email, password: PASSWORD, ip: IP, userAgent: "vitest" });
      if (started.ok || started.error !== "totp_required") throw new Error("expected totp_required");

      // 4 wrong guesses (cap is 5): still a live challenge, still "invalid_code".
      for (let i = 0; i < 4; i++) {
        const attempt = await m.twoFactor.verifyTotpChallenge(db, { token: started.challengeToken, code: "000000", ip: IP, userAgent: "vitest" });
        expect(attempt).toEqual({ ok: false, error: "invalid_code" });
      }
      // 5th wrong guess: capped, challenge gone.
      const capped = await m.twoFactor.verifyTotpChallenge(db, { token: started.challengeToken, code: "000000", ip: IP, userAgent: "vitest" });
      expect(capped).toEqual({ ok: false, error: "too_many_attempts" });
      expect(await db.totpChallenge.count({ where: { userId: user.id } })).toBe(0);

      // The correct code no longer works against the destroyed challenge.
      const tooLate = await m.twoFactor.verifyTotpChallenge(db, { token: started.challengeToken, code: generateTotpCode(user.secret), ip: IP, userAgent: "vitest" });
      expect(tooLate).toEqual({ ok: false, error: "totp_challenge_expired" });
    });

    it("an expired challenge is refused even with the right code", async () => {
      const user = await enrollUser("login-expired");
      const now = new Date("2026-01-01T00:00:00Z");
      const started = await m.login.signIn(db, { email: user.email, password: PASSWORD, ip: IP, userAgent: "vitest", now });
      if (started.ok || started.error !== "totp_required") throw new Error("expected totp_required");

      const tenMinutesLater = new Date(now.getTime() + 10 * 60 * 1000);
      const result = await m.twoFactor.verifyTotpChallenge(db, {
        token: started.challengeToken,
        code: generateTotpCode(user.secret, tenMinutesLater),
        ip: IP,
        userAgent: "vitest",
        now: tenMinutesLater,
      });
      expect(result).toEqual({ ok: false, error: "totp_challenge_expired" });
    });
  });
});
