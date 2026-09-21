import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { Role } from "@/generated/prisma/enums";
import type { Actor } from "@/lib/auth/db";

/**
 * Authentication and RBAC against a REAL PostgreSQL. Skipped unless DATABASE_URL and
 * IKELYANE_SECRET_KEY are set (see tests/integration/telemetry-route.test.ts).
 *
 * Fixtures are created directly with a pre-computed password hash (scrypt is deliberately slow) and
 * removed afterwards, together with everything that references them.
 */
const enabled = Boolean(process.env.DATABASE_URL && process.env.IKELYANE_SECRET_KEY);

describe.skipIf(!enabled)("authentication & authorization", () => {
  let db: PrismaClient;
  let m: {
    login: typeof import("@/lib/auth/login");
    sessions: typeof import("@/lib/auth/sessions");
    users: typeof import("@/lib/auth/users");
    invitations: typeof import("@/lib/auth/invitations");
    members: typeof import("@/lib/auth/members");
    hosts: typeof import("@/modules/servers/hosts");
    password: typeof import("@/lib/auth/password");
    telemetryAuth: typeof import("@/lib/telemetry/auth");
    signature: typeof import("@/lib/telemetry/signature");
    crypto: typeof import("@/lib/crypto");
  };

  const runId = randomBytes(4).toString("hex");
  const domain = `${runId}.test`;
  const PASSWORD = "correct horse battery staple";
  const IP = "203.0.113.7";
  let PASSWORD_HASH: string;

  const orgIds: string[] = [];
  const userIds: string[] = [];
  let counter = 0;

  interface Fixture {
    orgId: string;
    owner: Actor;
    admin: Actor;
    operator: Actor;
    viewer: Actor;
  }

  async function makeUser(label: string, extra: Record<string, unknown> = {}) {
    const email = `${label}-${++counter}@${domain}`;
    const user = await db.user.create({ data: { email, name: label, passwordHash: PASSWORD_HASH, ...extra } });
    userIds.push(user.id);
    return { id: user.id, email };
  }

  async function makeOrg(label: string): Promise<Fixture> {
    const org = await db.organization.create({ data: { name: `${label}-${runId}`, slug: `${label}-${runId}-${++counter}` } });
    orgIds.push(org.id);
    const actors = {} as Record<Role, Actor>;
    for (const role of ["OWNER", "ADMIN", "OPERATOR", "VIEWER"] as Role[]) {
      const user = await makeUser(`${label}-${role.toLowerCase()}`);
      await db.membership.create({ data: { userId: user.id, orgId: org.id, role } });
      actors[role] = { userId: user.id, email: user.email, orgId: org.id, role, ip: IP };
    }
    return { orgId: org.id, owner: actors.OWNER, admin: actors.ADMIN, operator: actors.OPERATOR, viewer: actors.VIEWER };
  }

  // Each sign-in comes from a fresh address by default: the per-address failure counter (30) would
  // otherwise accumulate across independent scenarios and throttle unrelated tests. Tests about
  // address throttling pass an explicit `ip`.
  let ipCounter = 0;
  const freshIp = () => `198.51.100.${(++ipCounter % 200) + 1}`;
  const signIn = (email: string, password = PASSWORD, extra: { ip?: string | null; now?: Date } = {}) =>
    m.login.signIn(db, { email, password, ip: extra.ip === undefined ? freshIp() : extra.ip, userAgent: "vitest", now: extra.now });

  beforeAll(async () => {
    db = (await import("@/lib/prisma")).getPrisma();
    m = {
      login: await import("@/lib/auth/login"),
      sessions: await import("@/lib/auth/sessions"),
      users: await import("@/lib/auth/users"),
      invitations: await import("@/lib/auth/invitations"),
      members: await import("@/lib/auth/members"),
      hosts: await import("@/modules/servers/hosts"),
      password: await import("@/lib/auth/password"),
      telemetryAuth: await import("@/lib/telemetry/auth"),
      signature: await import("@/lib/telemetry/signature"),
      crypto: await import("@/lib/crypto"),
    };
    PASSWORD_HASH = await m.password.hashPassword(PASSWORD);
  });

  afterAll(async () => {
    if (!db) return;
    await db.auditLog.deleteMany({ where: { OR: [{ orgId: { in: orgIds } }, { actorEmail: { endsWith: `@${domain}` } }, { actorId: { in: userIds } }] } });
    await db.loginAttempt.deleteMany({ where: { OR: [{ email: { endsWith: `@${domain}` } }, { ipAddress: { in: ["203.0.113.7"] } }, { ipAddress: { startsWith: "198.51.100." } }] } });
    await db.organization.deleteMany({ where: { id: { in: orgIds } } });
    await db.user.deleteMany({ where: { OR: [{ id: { in: userIds } }, { email: { endsWith: `@${domain}` } }] } });
  });

  // ── Sign-in ─────────────────────────────────────────────────────────────────────────────────

  describe("sign-in", () => {
    it("opens a session, and stores only a HASH of the token", async () => {
      const fx = await makeOrg("signin");
      const result = await signIn(fx.viewer.email, PASSWORD, { ip: IP });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.token.length).toBeGreaterThanOrEqual(43); // 256 bits, base64url

      expect(await db.session.count({ where: { tokenHash: result.token } })).toBe(0); // raw token is NOT stored
      const stored = await db.session.findUniqueOrThrow({ where: { tokenHash: m.sessions.hashToken(result.token) } });
      expect(stored).toMatchObject({ userId: fx.viewer.userId, activeOrgId: fx.orgId, revokedAt: null, ipAddress: IP });
      expect(stored.absoluteExpiresAt.getTime()).toBeGreaterThan(stored.expiresAt.getTime());
    });

    it("answers a wrong password and an unknown account IDENTICALLY, and audits the true reason", async () => {
      const fx = await makeOrg("generic");
      const wrong = await signIn(fx.viewer.email, "not the password at all");
      const unknown = await signIn(`nobody-${runId}@${domain}`);
      expect(wrong).toEqual({ ok: false, error: "invalid_credentials" });
      expect(unknown).toEqual(wrong);

      const reasons = await db.auditLog.findMany({ where: { action: "auth.login_failed", actorEmail: { in: [fx.viewer.email, `nobody-${runId}@${domain}`] } } });
      expect(reasons.map((r) => (r.metadata as { reason: string }).reason).sort()).toEqual(["unknown_account", "wrong_password"]);
    });

    it("does the same amount of hashing work for an unknown account (no timing oracle)", async () => {
      const start = performance.now();
      await signIn(`ghost-${runId}@${domain}`);
      expect(performance.now() - start).toBeGreaterThan(80); // a real scrypt ran, not an early return
    });

    it("refuses a disabled account even with the right password, without saying why", async () => {
      const user = await makeUser("disabled", { disabledAt: new Date() });
      expect(await signIn(user.email)).toEqual({ ok: false, error: "invalid_credentials" });
      const audit = await db.auditLog.findFirstOrThrow({ where: { action: "auth.login_failed", actorEmail: user.email } });
      expect((audit.metadata as { reason: string }).reason).toBe("account_disabled");
    });

    it("normalizes the e-mail (case and spaces)", async () => {
      const fx = await makeOrg("norm");
      expect((await signIn(`  ${fx.viewer.email.toUpperCase()} `)).ok).toBe(true);
    });

    it("treats an absurdly long password as a plain failure (no hashing DoS)", async () => {
      const fx = await makeOrg("long");
      const start = performance.now();
      expect(await signIn(fx.viewer.email, "x".repeat(50_000))).toEqual({ ok: false, error: "invalid_credentials" });
      expect(performance.now() - start).toBeLessThan(2000);
    });

    it("silently upgrades a hash made with weaker parameters", async () => {
      const fx = await makeOrg("rehash");
      const weak = "scrypt$16384$8$1$" + Buffer.from("saltsaltsaltsalt").toString("base64") + "$" +
        (await new Promise<string>((resolve, reject) =>
          import("node:crypto").then(({ scrypt }) =>
            scrypt(PASSWORD.normalize("NFKC"), Buffer.from("saltsaltsaltsalt"), 32, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? reject(e) : resolve(k.toString("base64")))),
          ),
        ));
      await db.user.update({ where: { id: fx.viewer.userId }, data: { passwordHash: weak } });
      expect((await signIn(fx.viewer.email)).ok).toBe(true);
      const after = await db.user.findUniqueOrThrow({ where: { id: fx.viewer.userId } });
      expect(after.passwordHash).not.toBe(weak);
      expect(m.password.needsRehash(after.passwordHash!)).toBe(false);
      expect(await m.password.verifyPassword(PASSWORD, after.passwordHash)).toBe(true);
    });
  });

  // ── Throttling ──────────────────────────────────────────────────────────────────────────────

  describe("throttling", () => {
    it("locks an account after 8 failures — even for the RIGHT password — then releases it", async () => {
      const fx = await makeOrg("throttle");
      const t0 = new Date();
      for (let i = 0; i < 8; i++) expect((await signIn(fx.viewer.email, "wrong password!!", { now: t0 })).ok).toBe(false);

      const blocked = await signIn(fx.viewer.email, PASSWORD, { now: t0 });
      expect(blocked.ok).toBe(false);
      if (!blocked.ok && blocked.error === "throttled") {
        expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
        expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(900);
      } else {
        throw new Error("expected throttled, got " + JSON.stringify(blocked));
      }

      // Another account is unaffected (limit is per e-mail).
      const other = await makeUser("unaffected");
      expect((await signIn(other.email, PASSWORD, { now: t0 })).ok).toBe(true);

      // Sixteen minutes later the window has passed.
      const later = new Date(t0.getTime() + 16 * 60 * 1000);
      expect((await signIn(fx.viewer.email, PASSWORD, { now: later })).ok).toBe(true);
    });

    it("a successful sign-in clears the failure streak", async () => {
      const fx = await makeOrg("streak");
      for (let i = 0; i < 5; i++) await signIn(fx.viewer.email, "wrong password!!");
      expect((await signIn(fx.viewer.email)).ok).toBe(true);
      // Five MORE failures would have hit the limit if the first five still counted.
      for (let i = 0; i < 5; i++) await signIn(fx.viewer.email, "wrong password!!");
      expect((await signIn(fx.viewer.email)).ok).toBe(true);
    });

    it("throttles a source address that sprays many accounts", async () => {
      const fx = await makeOrg("spray");
      const ip = "198.51.100.250"; // outside the range handed out by freshIp()
      const now = new Date();
      await db.loginAttempt.createMany({
        data: Array.from({ length: 30 }, (_, i) => ({ email: `spray-${i}@${domain}`, ipAddress: ip, success: false, createdAt: now })),
      });
      const result = await signIn(fx.viewer.email, PASSWORD, { ip, now });
      expect(result).toMatchObject({ ok: false, error: "throttled" });
      // The same account from an unrelated address is fine.
      expect((await signIn(fx.viewer.email, PASSWORD, { ip: "198.51.100.99", now })).ok).toBe(true);
    });

    it("computes the wait so the count falls back under the limit exactly when the right failure ages out", async () => {
      const { secondsUntilUnblocked } = await import("@/lib/auth/throttle");
      const now = new Date("2026-01-01T12:00:00Z");
      const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000);
      // 10 failures with limit 8: the count drops under 8 once the 3 oldest (14, 13, 12 min ago) expire,
      // i.e. when the 3rd-oldest (12 min ago) leaves the 15-minute window: in 3 minutes.
      const failures = [14, 13, 12, 10, 9, 8, 6, 5, 3, 1].map(at);
      expect(secondsUntilUnblocked(failures, 8, now)).toBe(180);
      expect(secondsUntilUnblocked(failures.slice(0, 7), 8, now)).toBe(0);
    });
  });

  // ── Sessions ────────────────────────────────────────────────────────────────────────────────

  describe("sessions", () => {
    async function open(fx: Fixture, who: Actor = fx.viewer) {
      const r = await signIn(who.email);
      if (!r.ok) throw new Error("sign-in failed");
      return r.token;
    }

    it("resolves a token into user, memberships and active organization", async () => {
      const fx = await makeOrg("ctx");
      const ctx = await m.sessions.validateSession(db, await open(fx, fx.admin));
      expect(ctx).toMatchObject({ user: { id: fx.admin.userId, email: fx.admin.email }, activeOrg: { orgId: fx.orgId, role: "ADMIN" } });
      expect(ctx!.memberships).toHaveLength(1);
      expect(ctx).not.toHaveProperty("user.passwordHash"); // DTO: no secrets leak upward
    });

    it.each([["garbage", "nope"], ["empty", ""], ["oversized", "x".repeat(1000)]])("refuses %s tokens", async (_n, token) => {
      expect(await m.sessions.validateSession(db, token)).toBeNull();
    });

    it("expires after the idle timeout, and slides forward while the user is active", async () => {
      const fx = await makeOrg("idle");
      const t0 = new Date();
      const r = await m.login.signIn(db, { email: fx.viewer.email, password: PASSWORD, ip: IP, userAgent: null, now: t0 });
      if (!r.ok) throw new Error("sign-in failed");
      const hours = (h: number) => new Date(t0.getTime() + h * 3600_000);

      expect(await m.sessions.validateSession(db, r.token, hours(6))).not.toBeNull(); // active at +6 h: extends to +18 h
      expect(await m.sessions.validateSession(db, r.token, hours(17))).not.toBeNull(); // would have expired at +12 h without the slide
      expect(await m.sessions.validateSession(db, r.token, hours(40))).toBeNull(); // idle for 23 h > 12 h
    });

    it("never outlives its absolute lifetime, however active the user is", async () => {
      const fx = await makeOrg("absolute");
      const token = await open(fx);
      await db.session.updateMany({ where: { tokenHash: m.sessions.hashToken(token) }, data: { absoluteExpiresAt: new Date(Date.now() - 1000) } });
      expect(await m.sessions.validateSession(db, token)).toBeNull();
    });

    it("is revocable: a revoked session is refused immediately", async () => {
      const fx = await makeOrg("revoke");
      const token = await open(fx);
      expect(await m.sessions.validateSession(db, token)).not.toBeNull();
      await m.sessions.revokeSessionByToken(db, token);
      expect(await m.sessions.validateSession(db, token)).toBeNull();
    });

    it("'sign out everywhere' spares only the current session", async () => {
      const fx = await makeOrg("everywhere");
      const [a, b, c] = [await open(fx), await open(fx), await open(fx)];
      const current = await m.sessions.validateSession(db, a);
      expect(await m.sessions.revokeAllSessions(db, fx.viewer.userId, { exceptSessionId: current!.sessionId })).toBe(2);
      expect(await m.sessions.validateSession(db, a)).not.toBeNull();
      expect(await m.sessions.validateSession(db, b)).toBeNull();
      expect(await m.sessions.validateSession(db, c)).toBeNull();
    });

    it("refuses the session of a user disabled AFTER signing in", async () => {
      const fx = await makeOrg("disable");
      const token = await open(fx);
      await db.user.update({ where: { id: fx.viewer.userId }, data: { disabledAt: new Date() } });
      expect(await m.sessions.validateSession(db, token)).toBeNull();
    });

    it("cuts access to an organization the moment the membership is removed", async () => {
      const fx = await makeOrg("removed");
      const other = await db.organization.create({ data: { name: `second-${runId}`, slug: `second-${runId}-${++counter}` } });
      orgIds.push(other.id);
      await db.membership.create({ data: { userId: fx.viewer.userId, orgId: other.id, role: "VIEWER" } });
      const token = await open(fx);
      expect((await m.sessions.validateSession(db, token))!.activeOrg!.orgId).toBe(fx.orgId);

      await db.membership.deleteMany({ where: { userId: fx.viewer.userId, orgId: fx.orgId } });
      const after = await m.sessions.validateSession(db, token);
      expect(after!.activeOrg!.orgId).toBe(other.id); // falls back to a remaining organization
      await db.membership.deleteMany({ where: { userId: fx.viewer.userId, orgId: other.id } });
      expect((await m.sessions.validateSession(db, token))!.activeOrg).toBeNull(); // no organization left
    });

    it("switches organization only to one the user belongs to", async () => {
      const a = await makeOrg("switch-a");
      const b = await makeOrg("switch-b");
      const token = await open(a);
      const ctx = (await m.sessions.validateSession(db, token))!;
      expect(await m.sessions.setActiveOrg(db, ctx.sessionId, a.viewer.userId, b.orgId)).toBe(false);
      expect((await m.sessions.validateSession(db, token))!.activeOrg!.orgId).toBe(a.orgId);
    });
  });

  // ── Accounts & passwords ────────────────────────────────────────────────────────────────────

  describe("accounts and passwords", () => {
    it("creates an account, normalizing the e-mail, and refuses duplicates in any letter case", async () => {
      const email = `New.User-${runId}@${domain}`;
      const first = await m.users.createUser(db, { email, password: "a-decent-passphrase-1", name: "  New  " });
      expect(first.ok).toBe(true);
      if (first.ok) userIds.push(first.value.id);
      const dup = await m.users.createUser(db, { email: email.toUpperCase(), password: "a-decent-passphrase-1" });
      expect(dup).toEqual({ ok: false, error: "email_taken" });
    });

    it("applies the password policy and validates the e-mail shape", async () => {
      expect(await m.users.createUser(db, { email: `a@${domain}`, password: "short" })).toEqual({ ok: false, error: "too_short" });
      expect(await m.users.createUser(db, { email: `b@${domain}`, password: "motdepasse123" })).toEqual({ ok: false, error: "common" });
      expect(await db.user.count({ where: { email: { in: [`a@${domain}`, `b@${domain}`] } } })).toBe(0); // nothing created
      expect(await m.users.createUser(db, { email: "not-an-email", password: "a-decent-passphrase-1" })).toEqual({ ok: false, error: "invalid_email" });
    });

    it("two simultaneous sign-ups for one address: exactly one wins", async () => {
      const email = `race-${runId}@${domain}`;
      const results = await Promise.all([
        m.users.createUser(db, { email, password: "a-decent-passphrase-1" }),
        m.users.createUser(db, { email, password: "another-decent-phrase-2" }),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok)[0]).toEqual({ ok: false, error: "email_taken" });
      const created = results.find((r) => r.ok);
      if (created?.ok) userIds.push(created.value.id);
    });

    it("creates an organization with a unique slug and its OWNER", async () => {
      const user = await makeUser("founder");
      const one = await m.users.createOrganization(db, { name: "Réseau Étoilé & Co", ownerUserId: user.id, ownerEmail: user.email });
      const two = await m.users.createOrganization(db, { name: "Réseau Étoilé & Co", ownerUserId: user.id, ownerEmail: user.email });
      orgIds.push(one.id, two.id);
      expect(one.slug).toBe("reseau-etoile-co");
      expect(two.slug).not.toBe(one.slug);
      expect(await db.membership.findFirst({ where: { orgId: one.id, userId: user.id } })).toMatchObject({ role: "OWNER" });
    });

    it("changing the password requires the current one and signs out every OTHER session", async () => {
      const fx = await makeOrg("chpw");
      const [a, b] = [await signIn(fx.viewer.email), await signIn(fx.viewer.email)];
      if (!a.ok || !b.ok) throw new Error("sign-in failed");
      const current = (await m.sessions.validateSession(db, a.token))!;

      const bad = await m.users.changePassword(db, { userId: fx.viewer.userId, currentPassword: "not my password", newPassword: "a-brand-new-passphrase-9", keepSessionId: current.sessionId });
      expect(bad).toEqual({ ok: false, error: "invalid_current_password" });
      const weak = await m.users.changePassword(db, { userId: fx.viewer.userId, currentPassword: PASSWORD, newPassword: "short", keepSessionId: current.sessionId });
      expect(weak).toEqual({ ok: false, error: "too_short" });

      const good = await m.users.changePassword(db, { userId: fx.viewer.userId, currentPassword: PASSWORD, newPassword: "a-brand-new-passphrase-9", keepSessionId: current.sessionId });
      expect(good).toEqual({ ok: true, value: { revokedSessions: 1 } });
      expect(await m.sessions.validateSession(db, a.token)).not.toBeNull(); // the one I am using stays
      expect(await m.sessions.validateSession(db, b.token)).toBeNull(); // the other device is signed out

      expect((await signIn(fx.viewer.email, PASSWORD)).ok).toBe(false); // old password is dead
      expect((await signIn(fx.viewer.email, "a-brand-new-passphrase-9")).ok).toBe(true);
    });

    it("guessing the current password through 'change password' is throttled like a sign-in", async () => {
      const fx = await makeOrg("chpw-throttle");
      const s = await signIn(fx.viewer.email);
      if (!s.ok) throw new Error("sign-in failed");
      const ctx = (await m.sessions.validateSession(db, s.token))!;
      const attempt = () => m.users.changePassword(db, { userId: fx.viewer.userId, currentPassword: "guess-guess-guess", newPassword: "a-brand-new-passphrase-9", keepSessionId: ctx.sessionId, ip: IP });
      for (let i = 0; i < 8; i++) expect((await attempt()).ok).toBe(false);
      expect(await attempt()).toEqual({ ok: false, error: "throttled" });
    });
  });

  // ── Invitations ─────────────────────────────────────────────────────────────────────────────

  describe("invitations", () => {
    const invite = (fx: Fixture, actor: Actor, email: string, role: Role) => m.invitations.createInvitation(db, actor, { email, role });

    it("an ADMIN invites a new person; the link is single-use and only its hash is stored", async () => {
      const fx = await makeOrg("inv");
      const email = `newbie-${runId}@${domain}`;
      const created = await invite(fx, fx.admin, email, "VIEWER");
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      expect(await db.invitation.count({ where: { tokenHash: created.value.token } })).toBe(0);

      expect(await m.invitations.previewInvitation(db, created.value.token)).toMatchObject({ email, role: "VIEWER", accountExists: false });

      const accepted = await m.invitations.acceptInvitation(db, { token: created.value.token, newAccount: { name: "Newbie", password: "a-decent-passphrase-1" } });
      expect(accepted.ok).toBe(true);
      if (!accepted.ok) return;
      userIds.push(accepted.value.userId);
      expect(accepted.value).toMatchObject({ orgId: fx.orgId, role: "VIEWER", createdAccount: true });
      expect(await db.membership.findFirst({ where: { userId: accepted.value.userId, orgId: fx.orgId } })).toMatchObject({ role: "VIEWER" });

      // Second use of the same link fails, and it is no longer previewable.
      expect(await m.invitations.acceptInvitation(db, { token: created.value.token, newAccount: { password: "a-decent-passphrase-1" } })).toEqual({ ok: false, error: "invalid_or_expired" });
      expect(await m.invitations.previewInvitation(db, created.value.token)).toBeNull();
    });

    it("cannot be used to escalate: an ADMIN may not invite an ADMIN or OWNER; lower roles may not invite at all", async () => {
      const fx = await makeOrg("inv-rbac");
      expect(await invite(fx, fx.admin, `x1-${runId}@${domain}`, "ADMIN")).toEqual({ ok: false, error: "role_not_allowed" });
      expect(await invite(fx, fx.admin, `x2-${runId}@${domain}`, "OWNER")).toEqual({ ok: false, error: "role_not_allowed" });
      expect(await invite(fx, fx.operator, `x3-${runId}@${domain}`, "VIEWER")).toEqual({ ok: false, error: "forbidden" });
      expect(await invite(fx, fx.viewer, `x4-${runId}@${domain}`, "VIEWER")).toEqual({ ok: false, error: "forbidden" });
      expect((await invite(fx, fx.owner, `x5-${runId}@${domain}`, "ADMIN")).ok).toBe(true); // an OWNER may
    });

    it("an invitation cannot be accepted by a stranger's e-mail, and an existing account must sign in first", async () => {
      const fx = await makeOrg("inv-existing");
      const target = await makeUser("existing-target");
      const stranger = await makeUser("stranger");
      const created = await invite(fx, fx.admin, target.email, "OPERATOR");
      if (!created.ok) throw new Error("invite failed");
      const token = created.value.token;

      expect(await m.invitations.previewInvitation(db, token)).toMatchObject({ accountExists: true });
      expect(await m.invitations.acceptInvitation(db, { token })).toEqual({ ok: false, error: "sign_in_required" });
      expect(await m.invitations.acceptInvitation(db, { token, signedInUserId: stranger.id })).toEqual({ ok: false, error: "email_mismatch" });
      expect(await m.invitations.acceptInvitation(db, { token, signedInUserId: target.id, newAccount: { password: "x".repeat(20) } })).toMatchObject({ ok: true, value: { role: "OPERATOR", createdAccount: false } });
      expect(await db.membership.count({ where: { orgId: fx.orgId, userId: stranger.id } })).toBe(0);
    });

    it("re-inviting replaces the old link; revoking, expiry and unknown tokens all fail the same way", async () => {
      const fx = await makeOrg("inv-life");
      const email = `life-${runId}@${domain}`;
      const first = await invite(fx, fx.admin, email, "VIEWER");
      const second = await invite(fx, fx.admin, email, "OPERATOR");
      if (!first.ok || !second.ok) throw new Error("invite failed");
      const attempt = (token: string) => m.invitations.acceptInvitation(db, { token, newAccount: { password: "a-decent-passphrase-1" } });

      expect(await attempt(first.value.token)).toEqual({ ok: false, error: "invalid_or_expired" }); // replaced
      expect(await m.invitations.revokeInvitation(db, fx.admin, second.value.invitationId)).toEqual({ ok: true, value: true });
      expect(await attempt(second.value.token)).toEqual({ ok: false, error: "invalid_or_expired" }); // revoked

      const third = await invite(fx, fx.admin, email, "VIEWER");
      if (!third.ok) throw new Error("invite failed");
      await db.invitation.update({ where: { id: third.value.invitationId }, data: { expiresAt: new Date(Date.now() - 1000) } });
      expect(await attempt(third.value.token)).toEqual({ ok: false, error: "invalid_or_expired" }); // expired
      expect(await attempt("totally-unknown-token")).toEqual({ ok: false, error: "invalid_or_expired" });
    });

    it("refuses to invite someone who is already a member", async () => {
      const fx = await makeOrg("inv-dup");
      expect(await invite(fx, fx.admin, fx.viewer.email, "VIEWER")).toEqual({ ok: false, error: "already_member" });
    });

    it("is ATOMIC: a weak password leaves the invitation usable and creates no account", async () => {
      const fx = await makeOrg("inv-atomic");
      const email = `atomic-${runId}@${domain}`;
      const created = await invite(fx, fx.admin, email, "VIEWER");
      if (!created.ok) throw new Error("invite failed");

      const weak = await m.invitations.acceptInvitation(db, { token: created.value.token, newAccount: { password: "short" } });
      expect(weak).toEqual({ ok: false, error: "too_short" });
      expect(await db.user.count({ where: { email } })).toBe(0);
      expect(await db.invitation.findUniqueOrThrow({ where: { id: created.value.invitationId } })).toMatchObject({ acceptedAt: null });

      const good = await m.invitations.acceptInvitation(db, { token: created.value.token, newAccount: { password: "a-decent-passphrase-1" } });
      expect(good.ok).toBe(true);
      if (good.ok) userIds.push(good.value.userId);
    });

    it("two simultaneous acceptances of one link: exactly one account is created", async () => {
      const fx = await makeOrg("inv-race");
      const email = `raceinv-${runId}@${domain}`;
      const created = await invite(fx, fx.admin, email, "VIEWER");
      if (!created.ok) throw new Error("invite failed");
      const attempt = () => m.invitations.acceptInvitation(db, { token: created.value.token, newAccount: { password: "a-decent-passphrase-1" } });

      const results = await Promise.all([attempt(), attempt(), attempt()]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(await db.user.count({ where: { email } })).toBe(1);
      expect(await db.membership.count({ where: { orgId: fx.orgId, user: { email } } })).toBe(1);
      const winner = results.find((r) => r.ok);
      if (winner?.ok) userIds.push(winner.value.userId);
    });

    it("an administrator of organization A cannot see or revoke organization B's invitations", async () => {
      const a = await makeOrg("inv-iso-a");
      const b = await makeOrg("inv-iso-b");
      const created = await invite(b, b.admin, `iso-${runId}@${domain}`, "VIEWER");
      if (!created.ok) throw new Error("invite failed");
      expect(await m.invitations.revokeInvitation(db, a.admin, created.value.invitationId)).toEqual({ ok: false, error: "not_found" });
      const pendingA = await m.members.listPendingInvitations(db, a.admin);
      expect(pendingA.ok && pendingA.value.map((p) => p.id)).not.toContain(created.value.invitationId);
    });
  });

  // ── Members & roles ─────────────────────────────────────────────────────────────────────────

  describe("member management", () => {
    const membershipOf = async (a: Actor) => (await db.membership.findFirstOrThrow({ where: { userId: a.userId, orgId: a.orgId } })).id;

    it("OWNER promotes freely; ADMIN manages only OPERATOR/VIEWER and cannot touch a peer or the owner", async () => {
      const fx = await makeOrg("roles");
      expect((await m.members.changeMemberRole(db, fx.owner, await membershipOf(fx.viewer), "ADMIN")).ok).toBe(true);

      const fx2 = await makeOrg("roles2");
      expect(await m.members.changeMemberRole(db, fx2.admin, await membershipOf(fx2.viewer), "OPERATOR")).toMatchObject({ ok: true, value: { from: "VIEWER", to: "OPERATOR" } });
      expect(await m.members.changeMemberRole(db, fx2.admin, await membershipOf(fx2.viewer), "ADMIN")).toEqual({ ok: false, error: "forbidden" }); // promote above own reach
      expect(await m.members.changeMemberRole(db, fx2.admin, await membershipOf(fx2.owner), "VIEWER")).toEqual({ ok: false, error: "forbidden" }); // touch the owner
      expect(await m.members.changeMemberRole(db, fx2.operator, await membershipOf(fx2.viewer), "VIEWER")).toEqual({ ok: false, error: "forbidden" });
      expect(await m.members.changeMemberRole(db, fx2.viewer, await membershipOf(fx2.operator), "VIEWER")).toEqual({ ok: false, error: "forbidden" });
    });

    it("nobody can change their own role", async () => {
      const fx = await makeOrg("self");
      expect(await m.members.changeMemberRole(db, fx.owner, await membershipOf(fx.owner), "VIEWER")).toEqual({ ok: false, error: "cannot_change_own_role" });
    });

    it("the LAST owner can be neither demoted nor removed; a second owner unlocks it", async () => {
      const fx = await makeOrg("lastowner");
      const co = await makeUser("co-owner");
      await db.membership.create({ data: { userId: co.id, orgId: fx.orgId, role: "OWNER" } });
      const co1: Actor = { userId: co.id, email: co.email, orgId: fx.orgId, role: "OWNER" };

      // Two owners: one may demote the other.
      expect((await m.members.changeMemberRole(db, fx.owner, await membershipOf(co1), "ADMIN")).ok).toBe(true);
      // Back to a single owner: the sole owner cannot be removed or demoted by anyone — including an admin acting up.
      expect(await m.members.removeMember(db, fx.owner, await membershipOf(fx.owner))).toEqual({ ok: false, error: "last_owner" });
      const demote = await m.members.changeMemberRole(db, { ...co1, role: "OWNER" }, await membershipOf(fx.owner), "ADMIN");
      expect(demote).toEqual({ ok: false, error: "last_owner" });
      expect(await db.membership.count({ where: { orgId: fx.orgId, role: "OWNER" } })).toBe(1);
    });

    it("two owners demoting each other at the same instant cannot leave the organization ownerless", async () => {
      const fx = await makeOrg("mutual");
      const co = await makeUser("mutual-co");
      await db.membership.create({ data: { userId: co.id, orgId: fx.orgId, role: "OWNER" } });
      const other: Actor = { userId: co.id, email: co.email, orgId: fx.orgId, role: "OWNER" };
      const [mA, mB] = [await membershipOf(fx.owner), await membershipOf(other)];

      const results = await Promise.all([
        m.members.changeMemberRole(db, fx.owner, mB, "VIEWER"),
        m.members.changeMemberRole(db, other, mA, "VIEWER"),
      ]);
      expect(await db.membership.count({ where: { orgId: fx.orgId, role: "OWNER" } })).toBe(1);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.find((r) => !r.ok)).toEqual({ ok: false, error: "last_owner" });
    });

    it("removes members within reach and lets anyone leave, but not across organizations", async () => {
      const a = await makeOrg("remove-a");
      const b = await makeOrg("remove-b");
      expect(await m.members.removeMember(db, a.admin, await membershipOf(b.viewer))).toEqual({ ok: false, error: "not_found" }); // other org
      expect(await m.members.removeMember(db, a.admin, await membershipOf(a.owner))).toEqual({ ok: false, error: "forbidden" });
      expect(await m.members.removeMember(db, a.viewer, await membershipOf(a.operator))).toEqual({ ok: false, error: "forbidden" });
      expect(await m.members.removeMember(db, a.admin, await membershipOf(a.operator))).toEqual({ ok: true, value: { left: false } });
      expect(await m.members.removeMember(db, a.viewer, await membershipOf(a.viewer))).toEqual({ ok: true, value: { left: true } });
    });

    it("cannot change a membership id that belongs to another organization", async () => {
      const a = await makeOrg("iso-role-a");
      const b = await makeOrg("iso-role-b");
      expect(await m.members.changeMemberRole(db, a.owner, await membershipOf(b.viewer), "ADMIN")).toEqual({ ok: false, error: "not_found" });
      expect((await db.membership.findFirstOrThrow({ where: { userId: b.viewer.userId } })).role).toBe("VIEWER");
    });

    it("lists only the caller's organization", async () => {
      const a = await makeOrg("list-a");
      await makeOrg("list-b");
      const listed = await m.members.listMembers(db, a.viewer);
      expect(listed.ok && listed.value).toHaveLength(4);
      expect(listed.ok && listed.value.every((r) => r.email.startsWith("list-a"))).toBe(true);
    });

    it("writes an audit record for every change, with who, what and where", async () => {
      const fx = await makeOrg("audit");
      await m.members.changeMemberRole(db, fx.owner, await membershipOf(fx.viewer), "OPERATOR");
      const entry = await db.auditLog.findFirstOrThrow({ where: { orgId: fx.orgId, action: "member.role_changed" } });
      expect(entry).toMatchObject({ actorId: fx.owner.userId, actorEmail: fx.owner.email, targetType: "user", targetId: fx.viewer.userId, ipAddress: IP });
      expect(entry.metadata).toMatchObject({ from: "VIEWER", to: "OPERATOR" });
    });
  });

  // ── Hosts (RBAC on a real resource) ─────────────────────────────────────────────────────────

  describe("host registration", () => {
    async function agentAcceptedBy(secret: string, keyId: string): Promise<boolean> {
      const body = "{}";
      const t = Math.floor(Date.now() / 1000);
      const header = `t=${t},v1=${m.signature.computeSignature(secret, t, body)}`;
      try {
        await m.telemetryAuth.authenticateAgent(db, { keyId, signatureHeader: header, rawBody: body, nowMs: Date.now(), maxSkewSeconds: 300 });
        return true;
      } catch {
        return false;
      }
    }

    it("only ADMIN and above may register; every role may list", async () => {
      const fx = await makeOrg("hosts");
      expect(await m.hosts.registerHost(db, fx.viewer, { hostname: "v.example" })).toEqual({ ok: false, error: "forbidden" });
      expect(await m.hosts.registerHost(db, fx.operator, { hostname: "o.example" })).toEqual({ ok: false, error: "forbidden" });
      const admin = await m.hosts.registerHost(db, fx.admin, { hostname: "web-01.example", displayName: " Web 01 " });
      expect(admin.ok).toBe(true);
      if (!admin.ok) return;
      for (const actor of [fx.viewer, fx.operator, fx.admin, fx.owner]) {
        const list = await m.hosts.listHosts(db, actor);
        expect(list.ok && list.value.map((h) => h.hostname)).toEqual(["web-01.example"]);
      }
    });

    it("returns credentials that really authenticate the agent, and stores the secret only encrypted", async () => {
      const fx = await makeOrg("hosts-secret");
      const reg = await m.hosts.registerHost(db, fx.admin, { hostname: "db-01.example" });
      if (!reg.ok) throw new Error("register failed");
      expect(await agentAcceptedBy(reg.value.secret, reg.value.keyId)).toBe(true);
      expect(await agentAcceptedBy("wrong", reg.value.keyId)).toBe(false);

      const row = await db.monitoredHost.findUniqueOrThrow({ where: { id: reg.value.hostId } });
      expect(row.hmacSecretEnc).not.toContain(reg.value.secret);
      expect(JSON.stringify(await db.auditLog.findMany({ where: { orgId: fx.orgId } }))).not.toContain(reg.value.secret);
      // The list DTO never carries secret material.
      const list = await m.hosts.listHosts(db, fx.viewer);
      expect(JSON.stringify(list)).not.toContain("hmacSecret");
      expect(JSON.stringify(list)).not.toContain(reg.value.secret);
    });

    it("validates hostnames and refuses duplicates within an organization (but not across)", async () => {
      const a = await makeOrg("hosts-dup-a");
      const b = await makeOrg("hosts-dup-b");
      expect(await m.hosts.registerHost(db, a.admin, { hostname: "bad host!" })).toEqual({ ok: false, error: "invalid_hostname" });
      expect(await m.hosts.registerHost(db, a.admin, { hostname: "" })).toEqual({ ok: false, error: "invalid_hostname" });
      expect((await m.hosts.registerHost(db, a.admin, { hostname: "same.example" })).ok).toBe(true);
      expect(await m.hosts.registerHost(db, a.admin, { hostname: "same.example" })).toEqual({ ok: false, error: "hostname_taken" });
      expect((await m.hosts.registerHost(db, b.admin, { hostname: "same.example" })).ok).toBe(true);
    });

    it("rotation: ADMIN only; the new secret works, the old one during the grace period, then no longer", async () => {
      const fx = await makeOrg("hosts-rotate");
      const reg = await m.hosts.registerHost(db, fx.admin, { hostname: "rot.example" });
      if (!reg.ok) throw new Error("register failed");

      expect(await m.hosts.rotateHostSecret(db, fx.operator, reg.value.hostId)).toEqual({ ok: false, error: "forbidden" });
      const rotated = await m.hosts.rotateHostSecret(db, fx.admin, reg.value.hostId);
      if (!rotated.ok) throw new Error("rotate failed");
      expect(rotated.value.keyId).toBe(reg.value.keyId); // same key id, new secret
      expect(rotated.value.secret).not.toBe(reg.value.secret);

      expect(await agentAcceptedBy(rotated.value.secret, reg.value.keyId)).toBe(true);
      expect(await agentAcceptedBy(reg.value.secret, reg.value.keyId)).toBe(true); // grace period
      const list = await m.hosts.listHosts(db, fx.viewer);
      expect(list.ok && list.value[0].rotationPending).toBe(true);

      await db.monitoredHost.update({ where: { id: reg.value.hostId }, data: { previousSecretExpiresAt: new Date(Date.now() - 1000) } });
      expect(await agentAcceptedBy(reg.value.secret, reg.value.keyId)).toBe(false);
      expect(await agentAcceptedBy(rotated.value.secret, reg.value.keyId)).toBe(true);
    });

    it("cannot act on another organization's host (rotate, disable, list)", async () => {
      const a = await makeOrg("hosts-iso-a");
      const b = await makeOrg("hosts-iso-b");
      const reg = await m.hosts.registerHost(db, b.admin, { hostname: "b-only.example" });
      if (!reg.ok) throw new Error("register failed");

      expect(await m.hosts.rotateHostSecret(db, a.owner, reg.value.hostId)).toEqual({ ok: false, error: "not_found" });
      expect(await m.hosts.setHostEnabled(db, a.owner, reg.value.hostId, false)).toEqual({ ok: false, error: "not_found" });
      const listA = await m.hosts.listHosts(db, a.owner);
      expect(listA.ok && listA.value).toEqual([]);
      expect(await agentAcceptedBy(reg.value.secret, reg.value.keyId)).toBe(true); // untouched
    });

    it("disabling a host makes the telemetry API refuse it; every action is audited", async () => {
      const fx = await makeOrg("hosts-disable");
      const reg = await m.hosts.registerHost(db, fx.admin, { hostname: "off.example" });
      if (!reg.ok) throw new Error("register failed");
      expect(await m.hosts.setHostEnabled(db, fx.viewer, reg.value.hostId, false)).toEqual({ ok: false, error: "forbidden" });
      expect((await m.hosts.setHostEnabled(db, fx.admin, reg.value.hostId, false)).ok).toBe(true);
      expect(await agentAcceptedBy(reg.value.secret, reg.value.keyId)).toBe(false); // host_disabled

      const actions = (await db.auditLog.findMany({ where: { orgId: fx.orgId }, orderBy: { createdAt: "asc" } })).map((e) => e.action);
      expect(actions).toEqual(expect.arrayContaining(["host.registered", "host.disabled"]));
    });
  });
});
