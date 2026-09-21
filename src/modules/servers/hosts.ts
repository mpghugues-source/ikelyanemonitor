import type { PrismaClient } from "@/generated/prisma/client";
import type { HealthStatus, OsFamily } from "@/generated/prisma/enums";
import { recordAudit } from "@/lib/auth/audit";
import type { Actor, Db } from "@/lib/auth/db";
import { can } from "@/lib/auth/permissions";
import { encryptSecret, generateAgentCredentials, hostSecretAad } from "@/lib/crypto";
import { fail, ok, type Result } from "@/lib/result";

/** How long the previous secret keeps working after a rotation, so agents can be updated. */
export const SECRET_ROTATION_GRACE_HOURS = 24;

const HOSTNAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/;

/** What a host row looks like to the UI: never the secret or its ciphertext. */
export interface HostRow {
  id: string;
  hostname: string;
  displayName: string | null;
  keyId: string;
  enabled: boolean;
  status: HealthStatus;
  osFamily: OsFamily;
  agentVersion: string | null;
  lastSeenAt: Date | null;
  createdAt: Date;
  /** A rotation is in its grace period: the old secret is still accepted. */
  rotationPending: boolean;
}

export async function listHosts(db: Db, actor: Actor, now: Date = new Date()): Promise<Result<HostRow[], "forbidden">> {
  if (!can(actor.role, "hosts:read")) return fail("forbidden");
  const rows = await db.monitoredHost.findMany({
    where: { orgId: actor.orgId },
    orderBy: { hostname: "asc" },
    select: {
      id: true, hostname: true, displayName: true, keyId: true, enabled: true, status: true, osFamily: true,
      agentVersion: true, lastSeenAt: true, createdAt: true, previousSecretExpiresAt: true,
    },
  });
  return ok(rows.map(({ previousSecretExpiresAt, ...host }) => ({ ...host, rotationPending: Boolean(previousSecretExpiresAt && previousSecretExpiresAt > now) })));
}

export type RegisterHostError = "forbidden" | "invalid_hostname" | "hostname_taken";

export interface HostCredentials {
  hostId: string;
  keyId: string;
  /** Shown to the operator ONCE; only its ciphertext is stored. */
  secret: string;
}

export async function registerHost(
  db: PrismaClient,
  actor: Actor,
  input: { hostname: string; displayName?: string | null },
): Promise<Result<HostCredentials, RegisterHostError>> {
  if (!can(actor.role, "hosts:write")) return fail("forbidden");
  const hostname = input.hostname.trim();
  if (!HOSTNAME.test(hostname)) return fail("invalid_hostname");

  const { keyId, secret } = generateAgentCredentials();

  return db.$transaction(async (tx) => {
    if (await tx.monitoredHost.findUnique({ where: { orgId_hostname: { orgId: actor.orgId, hostname } }, select: { id: true } })) {
      return fail("hostname_taken");
    }
    const host = await tx.monitoredHost.create({
      data: {
        orgId: actor.orgId,
        hostname,
        displayName: input.displayName?.trim().slice(0, 120) || null,
        keyId,
        hmacSecretEnc: encryptSecret(secret, hostSecretAad(keyId)),
      },
      select: { id: true },
    });
    await recordAudit(tx, {
      action: "host.registered",
      orgId: actor.orgId,
      actorId: actor.userId,
      actorEmail: actor.email,
      targetType: "host",
      targetId: host.id,
      ipAddress: actor.ip,
      metadata: { hostname },
    });
    return ok({ hostId: host.id, keyId, secret });
  });
}

export type RotateHostError = "forbidden" | "not_found";

/**
 * Issue a new secret for a host. The key id stays; the current ciphertext becomes the "previous"
 * secret, accepted for SECRET_ROTATION_GRACE_HOURS so the agent can be reconfigured without a gap.
 */
export async function rotateHostSecret(
  db: PrismaClient,
  actor: Actor,
  hostId: string,
  now: Date = new Date(),
): Promise<Result<HostCredentials, RotateHostError>> {
  if (!can(actor.role, "hosts:rotate-secret")) return fail("forbidden");

  return db.$transaction(async (tx) => {
    const host = await tx.monitoredHost.findFirst({
      where: { id: hostId, orgId: actor.orgId },
      select: { id: true, keyId: true, hmacSecretEnc: true, hostname: true },
    });
    if (!host) return fail("not_found");

    const { secret } = generateAgentCredentials();
    await tx.monitoredHost.update({
      where: { id: host.id },
      data: {
        // Both ciphertexts are bound to the SAME key id (AAD), so the previous one still decrypts.
        previousHmacSecretEnc: host.hmacSecretEnc,
        previousSecretExpiresAt: new Date(now.getTime() + SECRET_ROTATION_GRACE_HOURS * 3600 * 1000),
        hmacSecretEnc: encryptSecret(secret, hostSecretAad(host.keyId)),
        secretRotatedAt: now,
      },
    });
    await recordAudit(tx, {
      action: "host.secret_rotated",
      orgId: actor.orgId,
      actorId: actor.userId,
      actorEmail: actor.email,
      targetType: "host",
      targetId: host.id,
      ipAddress: actor.ip,
      metadata: { hostname: host.hostname, graceHours: SECRET_ROTATION_GRACE_HOURS },
    });
    return ok({ hostId: host.id, keyId: host.keyId, secret });
  });
}

export type SetHostEnabledError = "forbidden" | "not_found";

export async function setHostEnabled(
  db: PrismaClient,
  actor: Actor,
  hostId: string,
  enabled: boolean,
): Promise<Result<true, SetHostEnabledError>> {
  if (!can(actor.role, "hosts:write")) return fail("forbidden");

  return db.$transaction(async (tx) => {
    const result = await tx.monitoredHost.updateMany({ where: { id: hostId, orgId: actor.orgId }, data: { enabled } });
    if (result.count !== 1) return fail("not_found");
    await recordAudit(tx, {
      action: enabled ? "host.enabled" : "host.disabled",
      orgId: actor.orgId,
      actorId: actor.userId,
      actorEmail: actor.email,
      targetType: "host",
      targetId: hostId,
      ipAddress: actor.ip,
    });
    return ok(true as const);
  });
}
