import { createHash, randomBytes } from "node:crypto";
import type { Locale, Role } from "@/generated/prisma/enums";
import {
  SESSION_ABSOLUTE_SECONDS,
  SESSION_IDLE_SECONDS,
  SESSION_REFRESH_INTERVAL_SECONDS,
} from "@/lib/auth/constants";
import type { Db } from "@/lib/auth/db";

/**
 * Database-backed sessions.
 *
 * The browser holds an opaque random token (256 bits). The database stores only its SHA-256, so
 * neither a database leak nor a backup exposes usable sessions. Because the token is high-entropy
 * random data, a fast hash is enough here (unlike passwords).
 *
 * Every request re-reads the session, the user and the memberships: revoking a session, disabling
 * a user or removing a member takes effect on the very next request — there is no signed,
 * self-contained token that would stay valid until it expires.
 */

export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");
export const generateToken = (): string => randomBytes(32).toString("base64url");

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  locale: Locale;
  timezone: string;
}

export interface SessionMembership {
  orgId: string;
  orgName: string;
  orgSlug: string;
  role: Role;
}

/** What the rest of the application may know about the signed-in user (a DTO: no hashes, no tokens). */
export interface SessionContext {
  sessionId: string;
  user: SessionUser;
  memberships: SessionMembership[];
  /** The organization the user is working in, or null if they belong to none. */
  activeOrg: SessionMembership | null;
  expiresAt: Date;
}

const seconds = (n: number) => n * 1000;

export async function createSession(
  db: Db,
  params: { userId: string; ip?: string | null; userAgent?: string | null; now?: Date },
): Promise<{ token: string; sessionId: string; expiresAt: Date; activeOrgId: string | null }> {
  const now = params.now ?? new Date();
  const token = generateToken();
  const absoluteExpiresAt = new Date(now.getTime() + seconds(SESSION_ABSOLUTE_SECONDS));
  const expiresAt = new Date(Math.min(now.getTime() + seconds(SESSION_IDLE_SECONDS), absoluteExpiresAt.getTime()));

  const firstMembership = await db.membership.findFirst({
    where: { userId: params.userId },
    orderBy: { createdAt: "asc" },
    select: { orgId: true },
  });

  const session = await db.session.create({
    data: {
      userId: params.userId,
      tokenHash: hashToken(token),
      activeOrgId: firstMembership?.orgId ?? null,
      createdAt: now,
      lastUsedAt: now,
      expiresAt,
      absoluteExpiresAt,
      ipAddress: params.ip ?? null,
      // Bounded: a hostile client could send a huge header.
      userAgent: params.userAgent?.slice(0, 255) ?? null,
    },
    select: { id: true },
  });
  return { token, sessionId: session.id, expiresAt, activeOrgId: firstMembership?.orgId ?? null };
}

/**
 * Resolve a cookie token into a session context, or null if it must be refused.
 * A session is refused when it is unknown, revoked, idle- or absolutely-expired, or when its user
 * is disabled. Valid sessions get their idle expiry pushed forward (at most every few minutes).
 */
export async function validateSession(db: Db, token: string, now: Date = new Date()): Promise<SessionContext | null> {
  if (!token || token.length > 256) return null;

  const session = await db.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          name: true,
          locale: true,
          timezone: true,
          disabledAt: true,
          memberships: {
            orderBy: { createdAt: "asc" },
            select: { role: true, org: { select: { id: true, name: true, slug: true } } },
          },
        },
      },
    },
  });

  if (!session || session.revokedAt) return null;
  if (session.expiresAt <= now || session.absoluteExpiresAt <= now) return null;
  if (session.user.disabledAt) return null;

  const memberships: SessionMembership[] = session.user.memberships.map((m) => ({
    orgId: m.org.id,
    orgName: m.org.name,
    orgSlug: m.org.slug,
    role: m.role,
  }));

  // The stored active organization is only a preference: it is re-validated against the CURRENT
  // memberships, so removing someone from an organization cuts their access immediately.
  const active = memberships.find((m) => m.orgId === session.activeOrgId) ?? memberships[0] ?? null;

  const idleFor = now.getTime() - session.lastUsedAt.getTime();
  const activeOrgChanged = (active?.orgId ?? null) !== session.activeOrgId;
  if (idleFor > seconds(SESSION_REFRESH_INTERVAL_SECONDS) || activeOrgChanged) {
    const expiresAt = new Date(Math.min(now.getTime() + seconds(SESSION_IDLE_SECONDS), session.absoluteExpiresAt.getTime()));
    await db.session.update({
      where: { id: session.id },
      data: { lastUsedAt: now, expiresAt, activeOrgId: active?.orgId ?? null },
    });
    session.expiresAt = expiresAt;
  }

  return {
    sessionId: session.id,
    user: {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
      locale: session.user.locale,
      timezone: session.user.timezone,
    },
    memberships,
    activeOrg: active,
    expiresAt: session.expiresAt,
  };
}

/** Switch the working organization — only to one the user is a member of. */
export async function setActiveOrg(db: Db, sessionId: string, userId: string, orgId: string): Promise<boolean> {
  const membership = await db.membership.findUnique({ where: { userId_orgId: { userId, orgId } }, select: { id: true } });
  if (!membership) return false;
  const result = await db.session.updateMany({
    where: { id: sessionId, userId, revokedAt: null },
    data: { activeOrgId: orgId },
  });
  return result.count === 1;
}

export async function revokeSessionByToken(db: Db, token: string, now: Date = new Date()): Promise<void> {
  await db.session.updateMany({ where: { tokenHash: hashToken(token), revokedAt: null }, data: { revokedAt: now } });
}

/** Sign a user out everywhere (optionally sparing the current session). Returns how many were revoked. */
export async function revokeAllSessions(
  db: Db,
  userId: string,
  options: { exceptSessionId?: string; now?: Date } = {},
): Promise<number> {
  const result = await db.session.updateMany({
    where: {
      userId,
      revokedAt: null,
      ...(options.exceptSessionId ? { id: { not: options.exceptSessionId } } : {}),
    },
    data: { revokedAt: options.now ?? new Date() },
  });
  return result.count;
}

/** Housekeeping: dead sessions carry no value. */
export async function purgeDeadSessions(db: Db, now: Date = new Date()): Promise<void> {
  const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  await db.session.deleteMany({
    where: { OR: [{ absoluteExpiresAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }] },
  });
}
