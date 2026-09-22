import type { PrismaClient } from "@/generated/prisma/client";
import type { DatabaseEngine, HealthStatus } from "@/generated/prisma/enums";
import { recordAudit } from "@/lib/auth/audit";
import type { Actor, Db } from "@/lib/auth/db";
import { can } from "@/lib/auth/permissions";
import { fail, ok, type Result } from "@/lib/result";

/**
 * Database instances are auto-discovered by the agent (see modules/databases/ingest.ts): there is
 * no "register" here, only the settings an administrator may configure on top of what was
 * discovered (tags, slow-query threshold, enabled).
 */
export interface DatabaseRow {
  id: string;
  name: string;
  engine: DatabaseEngine;
  version: string | null;
  endpoint: string | null;
  isReplica: boolean;
  tags: string[];
  enabled: boolean;
  hostname: string | null;
  storageQuotaBytes: bigint | null;
  storageUsedBytes: bigint | null;
  maxConnections: number | null;
  activeConnections: number | null;
  cacheHitRatio: number | null;
  deadlocksTotal: bigint | null;
  replicationLagSeconds: number | null;
  slowQueryThresholdMs: number;
  status: HealthStatus;
  lastPolledAt: Date | null;
  createdAt: Date;
}

export async function listDatabases(db: Db, actor: Actor): Promise<Result<DatabaseRow[], "forbidden">> {
  if (!can(actor.role, "databases:read")) return fail("forbidden");
  const rows = await db.databaseInstance.findMany({
    where: { orgId: actor.orgId },
    orderBy: { name: "asc" },
    select: {
      id: true, name: true, engine: true, version: true, endpoint: true, isReplica: true, tags: true, enabled: true,
      storageQuotaBytes: true, storageUsedBytes: true, maxConnections: true, activeConnections: true, cacheHitRatio: true,
      deadlocksTotal: true, replicationLagSeconds: true, slowQueryThresholdMs: true, status: true, lastPolledAt: true, createdAt: true,
      host: { select: { hostname: true } },
    },
  });
  return ok(rows.map(({ host, ...row }) => ({ ...row, hostname: host?.hostname ?? null })));
}

export interface DatabaseSettingsInput {
  tags: string[];
  slowQueryThresholdMs: number;
}

export type DatabaseWriteError = "forbidden" | "not_found";

export async function updateDatabaseSettings(
  db: PrismaClient,
  actor: Actor,
  id: string,
  input: DatabaseSettingsInput,
): Promise<Result<true, DatabaseWriteError>> {
  if (!can(actor.role, "databases:write")) return fail("forbidden");
  return db.$transaction(async (tx) => {
    const result = await tx.databaseInstance.updateMany({
      where: { id, orgId: actor.orgId },
      data: { tags: input.tags, slowQueryThresholdMs: input.slowQueryThresholdMs },
    });
    if (result.count !== 1) return fail("not_found");
    await recordAudit(tx, {
      action: "database.updated",
      orgId: actor.orgId,
      actorId: actor.userId,
      actorEmail: actor.email,
      targetType: "database",
      targetId: id,
      ipAddress: actor.ip,
    });
    return ok(true as const);
  });
}

export async function setDatabaseEnabled(db: PrismaClient, actor: Actor, id: string, enabled: boolean): Promise<Result<true, DatabaseWriteError>> {
  if (!can(actor.role, "databases:write")) return fail("forbidden");
  return db.$transaction(async (tx) => {
    const result = await tx.databaseInstance.updateMany({ where: { id, orgId: actor.orgId }, data: { enabled } });
    if (result.count !== 1) return fail("not_found");
    await recordAudit(tx, {
      action: enabled ? "database.enabled" : "database.disabled",
      orgId: actor.orgId,
      actorId: actor.userId,
      actorEmail: actor.email,
      targetType: "database",
      targetId: id,
      ipAddress: actor.ip,
    });
    return ok(true as const);
  });
}
