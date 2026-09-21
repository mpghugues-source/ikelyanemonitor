import type { Prisma } from "@/generated/prisma/client";
import type { Actor, Db } from "@/lib/auth/db";
import { can } from "@/lib/auth/permissions";
import { fail, ok, type Result } from "@/lib/result";

/** Every audited event. Adding one here makes it available (and typo-proof) everywhere. */
export type AuditAction =
  | "auth.login"
  | "auth.login_failed"
  | "auth.login_throttled"
  | "auth.logout"
  | "auth.password_changed"
  | "auth.sessions_revoked"
  | "auth.register"
  | "org.created"
  | "member.invited"
  | "member.invitation_revoked"
  | "member.joined"
  | "member.role_changed"
  | "member.removed"
  | "member.left"
  | "host.registered"
  | "host.secret_rotated"
  | "host.enabled"
  | "host.disabled";

export interface AuditEntry {
  action: AuditAction;
  orgId?: string | null;
  actorId?: string | null;
  actorEmail?: string | null;
  targetType?: string;
  targetId?: string;
  ipAddress?: string | null;
  /** Small, non-sensitive context (old/new role, hostname…). NEVER passwords, tokens or secrets. */
  metadata?: Prisma.InputJsonValue;
}

/**
 * Append an audit record. Throws on failure: inside a transaction an audit failure must abort the
 * operation (a security-relevant change without a trace is worse than a failed request). For
 * best-effort logging outside a transaction use `auditQuietly`.
 */
export async function recordAudit(db: Db, entry: AuditEntry): Promise<void> {
  await db.auditLog.create({
    data: {
      action: entry.action,
      orgId: entry.orgId ?? null,
      actorId: entry.actorId ?? null,
      actorEmail: entry.actorEmail ?? null,
      targetType: entry.targetType,
      targetId: entry.targetId,
      ipAddress: entry.ipAddress ?? null,
      metadata: entry.metadata,
    },
  });
}

/** Best-effort variant for events that must never break the request (e.g. a failed sign-in). */
export async function auditQuietly(db: Db, entry: AuditEntry): Promise<void> {
  try {
    await recordAudit(db, entry);
  } catch (error) {
    console.error("[audit] could not record", entry.action, error);
  }
}

export interface AuditRow {
  id: string;
  action: string;
  actorEmail: string | null;
  targetType: string | null;
  targetId: string | null;
  ipAddress: string | null;
  metadata: Prisma.JsonValue;
  createdAt: Date;
}

/** Most recent events of the actor's organization. Reading the trail is an administrator privilege. */
export async function listAuditLog(db: Db, actor: Actor, limit = 100): Promise<Result<AuditRow[], "forbidden">> {
  if (!can(actor.role, "audit:read")) return fail("forbidden");
  const rows = await db.auditLog.findMany({
    where: { orgId: actor.orgId },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(limit, 1), 500),
    select: { id: true, action: true, actorEmail: true, targetType: true, targetId: true, ipAddress: true, metadata: true, createdAt: true },
  });
  return ok(rows);
}
