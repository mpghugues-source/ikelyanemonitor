import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import type { PrismaClient } from "@/generated/prisma/client";
import {
  type HealthStatus,
  NetworkDeviceType,
  type SnmpAuthProtocol,
  type SnmpPrivProtocol,
  type SnmpSecurityLevel,
  SnmpVersion,
} from "@/generated/prisma/enums";
import { recordAudit } from "@/lib/auth/audit";
import type { Actor, Db } from "@/lib/auth/db";
import { can } from "@/lib/auth/permissions";
import { encryptSecret } from "@/lib/crypto";
import { fail, ok, type Result } from "@/lib/result";

export { DEVICE_TYPES, SNMP_VERSIONS } from "./constants";

/** AAD binds a device's ciphertexts to its (stable, pre-generated) id and field. */
const deviceSecretAad = (deviceId: string, field: string) => `device:${deviceId}:${field}`;

function generateDeviceId(): string {
  return `dev_${randomBytes(12).toString("base64url")}`;
}

export interface DeviceRow {
  id: string;
  name: string;
  ipAddress: string;
  type: NetworkDeviceType;
  tags: string[];
  enabled: boolean;
  vendor: string | null;
  model: string | null;
  sysName: string | null;
  sysLocation: string | null;
  pollerHostId: string | null;
  pollerHostname: string | null;
  pollIntervalSec: number;
  snmpVersion: SnmpVersion;
  snmpPort: number;
  snmpTimeoutMs: number;
  snmpRetries: number;
  snmpV3Username: string | null;
  snmpV3SecurityLevel: SnmpSecurityLevel | null;
  hasSecret: boolean;
  status: HealthStatus;
  lastPolledAt: Date | null;
  createdAt: Date;
}

export async function listDevices(db: Db, actor: Actor): Promise<Result<DeviceRow[], "forbidden">> {
  if (!can(actor.role, "devices:read")) return fail("forbidden");
  const rows = await db.networkDevice.findMany({
    where: { orgId: actor.orgId },
    orderBy: { name: "asc" },
    select: {
      id: true, name: true, ipAddress: true, type: true, tags: true, enabled: true, vendor: true, model: true,
      sysName: true, sysLocation: true, pollerHostId: true, pollIntervalSec: true, snmpVersion: true, snmpPort: true,
      snmpTimeoutMs: true, snmpRetries: true,
      snmpV3Username: true, snmpV3SecurityLevel: true, snmpCommunityEnc: true, snmpV3AuthKeyEnc: true,
      status: true, lastPolledAt: true, createdAt: true,
      pollerHost: { select: { hostname: true } },
    },
  });
  return ok(
    rows.map(({ snmpCommunityEnc, snmpV3AuthKeyEnc, pollerHost, ...device }) => ({
      ...device,
      pollerHostname: pollerHost?.hostname ?? null,
      hasSecret: Boolean(snmpCommunityEnc || snmpV3AuthKeyEnc),
    })),
  );
}

export interface DeviceInput {
  name: string;
  ipAddress: string;
  type: NetworkDeviceType;
  tags: string[];
  pollerHostId: string | null;
  pollIntervalSec: number;
  snmpVersion: SnmpVersion;
  snmpPort: number;
  snmpTimeoutMs: number;
  snmpRetries: number;
  /** v1/v2c community string. Undefined = leave the stored value untouched on update. */
  snmpCommunity?: string;
  snmpV3Username?: string;
  snmpV3SecurityLevel?: SnmpSecurityLevel;
  snmpV3AuthProtocol?: SnmpAuthProtocol;
  snmpV3AuthKey?: string;
  snmpV3PrivProtocol?: SnmpPrivProtocol;
  snmpV3PrivKey?: string;
  snmpV3ContextName?: string;
}

export type DeviceWriteError = "forbidden" | "invalid_ip" | "ip_taken" | "invalid_poller" | "not_found";

async function resolvePoller(db: Db, orgId: string, pollerHostId: string | null) {
  if (!pollerHostId) return true;
  const host = await db.monitoredHost.findFirst({ where: { id: pollerHostId, orgId }, select: { id: true } });
  return Boolean(host);
}

function credentialFields(deviceId: string, input: DeviceInput) {
  return {
    snmpVersion: input.snmpVersion,
    snmpPort: input.snmpPort,
    snmpTimeoutMs: input.snmpTimeoutMs,
    snmpRetries: input.snmpRetries,
    snmpCommunityEnc: input.snmpCommunity ? encryptSecret(input.snmpCommunity, deviceSecretAad(deviceId, "community")) : undefined,
    snmpV3Username: input.snmpV3Username,
    snmpV3SecurityLevel: input.snmpV3SecurityLevel,
    snmpV3AuthProtocol: input.snmpV3AuthProtocol,
    snmpV3AuthKeyEnc: input.snmpV3AuthKey ? encryptSecret(input.snmpV3AuthKey, deviceSecretAad(deviceId, "authKey")) : undefined,
    snmpV3PrivProtocol: input.snmpV3PrivProtocol,
    snmpV3PrivKeyEnc: input.snmpV3PrivKey ? encryptSecret(input.snmpV3PrivKey, deviceSecretAad(deviceId, "privKey")) : undefined,
    snmpV3ContextName: input.snmpV3ContextName,
  };
}

export async function registerDevice(db: PrismaClient, actor: Actor, input: DeviceInput): Promise<Result<{ id: string }, DeviceWriteError>> {
  if (!can(actor.role, "devices:write")) return fail("forbidden");
  if (isIP(input.ipAddress) === 0) return fail("invalid_ip");

  return db.$transaction(async (tx) => {
    if (!(await resolvePoller(tx, actor.orgId, input.pollerHostId))) return fail("invalid_poller");
    if (await tx.networkDevice.findUnique({ where: { orgId_ipAddress: { orgId: actor.orgId, ipAddress: input.ipAddress } }, select: { id: true } })) {
      return fail("ip_taken");
    }

    const id = generateDeviceId();
    const device = await tx.networkDevice.create({
      data: {
        id,
        orgId: actor.orgId,
        name: input.name,
        ipAddress: input.ipAddress,
        type: input.type,
        tags: input.tags,
        pollerHostId: input.pollerHostId,
        pollIntervalSec: input.pollIntervalSec,
        ...credentialFields(id, input),
      },
      select: { id: true },
    });
    await recordAudit(tx, {
      action: "device.registered",
      orgId: actor.orgId,
      actorId: actor.userId,
      actorEmail: actor.email,
      targetType: "device",
      targetId: device.id,
      ipAddress: actor.ip,
      metadata: { name: input.name, ipAddress: input.ipAddress },
    });
    return ok(device);
  });
}

export async function updateDevice(db: PrismaClient, actor: Actor, id: string, input: DeviceInput): Promise<Result<true, DeviceWriteError>> {
  if (!can(actor.role, "devices:write")) return fail("forbidden");
  if (isIP(input.ipAddress) === 0) return fail("invalid_ip");

  return db.$transaction(async (tx) => {
    const existing = await tx.networkDevice.findFirst({ where: { id, orgId: actor.orgId }, select: { id: true } });
    if (!existing) return fail("not_found");
    if (!(await resolvePoller(tx, actor.orgId, input.pollerHostId))) return fail("invalid_poller");

    const conflict = await tx.networkDevice.findUnique({ where: { orgId_ipAddress: { orgId: actor.orgId, ipAddress: input.ipAddress } }, select: { id: true } });
    if (conflict && conflict.id !== id) return fail("ip_taken");

    await tx.networkDevice.update({
      where: { id },
      data: {
        name: input.name,
        ipAddress: input.ipAddress,
        type: input.type,
        tags: input.tags,
        pollerHostId: input.pollerHostId,
        pollIntervalSec: input.pollIntervalSec,
        ...credentialFields(id, input),
      },
    });
    await recordAudit(tx, {
      action: "device.updated",
      orgId: actor.orgId,
      actorId: actor.userId,
      actorEmail: actor.email,
      targetType: "device",
      targetId: id,
      ipAddress: actor.ip,
      metadata: { name: input.name, ipAddress: input.ipAddress },
    });
    return ok(true as const);
  });
}

export async function setDeviceEnabled(db: PrismaClient, actor: Actor, id: string, enabled: boolean): Promise<Result<true, DeviceWriteError>> {
  if (!can(actor.role, "devices:write")) return fail("forbidden");
  return db.$transaction(async (tx) => {
    const result = await tx.networkDevice.updateMany({ where: { id, orgId: actor.orgId }, data: { enabled } });
    if (result.count !== 1) return fail("not_found");
    await recordAudit(tx, {
      action: enabled ? "device.enabled" : "device.disabled",
      orgId: actor.orgId,
      actorId: actor.userId,
      actorEmail: actor.email,
      targetType: "device",
      targetId: id,
      ipAddress: actor.ip,
    });
    return ok(true as const);
  });
}

export async function deleteDevice(db: PrismaClient, actor: Actor, id: string): Promise<Result<true, DeviceWriteError>> {
  if (!can(actor.role, "devices:write")) return fail("forbidden");
  return db.$transaction(async (tx) => {
    const result = await tx.networkDevice.deleteMany({ where: { id, orgId: actor.orgId } });
    if (result.count !== 1) return fail("not_found");
    await recordAudit(tx, {
      action: "device.deleted",
      orgId: actor.orgId,
      actorId: actor.userId,
      actorEmail: actor.email,
      targetType: "device",
      targetId: id,
      ipAddress: actor.ip,
    });
    return ok(true as const);
  });
}

