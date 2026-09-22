import type { PrismaClient } from "@/generated/prisma/client";
import { HealthStatus, HttpMethod } from "@/generated/prisma/enums";
import { recordAudit } from "@/lib/auth/audit";
import type { Actor, Db } from "@/lib/auth/db";
import { can } from "@/lib/auth/permissions";
import { fail, ok, type Result } from "@/lib/result";

export interface EndpointRow {
  id: string;
  name: string;
  url: string;
  method: HttpMethod;
  expectedStatus: number;
  expectedBodyContains: string | null;
  intervalSec: number;
  timeoutMs: number;
  regions: string[];
  tags: string[];
  enabled: boolean;
  followRedirects: boolean;
  verifySsl: boolean;
  slaTargetPercent: number;
  sslExpiresAt: Date | null;
  sslIssuer: string | null;
  status: HealthStatus;
  lastCheckedAt: Date | null;
  lastStatusCode: number | null;
  lastResponseMs: number | null;
  consecutiveFailures: number;
  createdAt: Date;
}

const SELECT = {
  id: true, name: true, url: true, method: true, expectedStatus: true, expectedBodyContains: true,
  intervalSec: true, timeoutMs: true, regions: true, tags: true, enabled: true, followRedirects: true,
  verifySsl: true, slaTargetPercent: true, sslExpiresAt: true, sslIssuer: true, status: true,
  lastCheckedAt: true, lastStatusCode: true, lastResponseMs: true, consecutiveFailures: true, createdAt: true,
} as const;

export async function listEndpoints(db: Db, actor: Actor): Promise<Result<EndpointRow[], "forbidden">> {
  if (!can(actor.role, "endpoints:read")) return fail("forbidden");
  const rows = await db.endpointCheck.findMany({ where: { orgId: actor.orgId }, orderBy: { name: "asc" }, select: SELECT });
  return ok(rows);
}

export interface EndpointInput {
  name: string;
  url: string;
  method: HttpMethod;
  expectedStatus: number;
  expectedBodyContains?: string | null;
  intervalSec: number;
  timeoutMs: number;
  tags: string[];
  followRedirects: boolean;
  verifySsl: boolean;
  slaTargetPercent: number;
}

export type EndpointWriteError = "forbidden" | "invalid_url" | "not_found";

/** Only http(s) targets: anything else (file:, data:, internal schemes) is rejected up front. */
function normalizeUrl(input: string): string | null {
  try {
    const url = new URL(input);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

export async function createEndpoint(db: PrismaClient, actor: Actor, input: EndpointInput): Promise<Result<{ id: string }, EndpointWriteError>> {
  if (!can(actor.role, "endpoints:write")) return fail("forbidden");
  const url = normalizeUrl(input.url);
  if (!url) return fail("invalid_url");

  return db.$transaction(async (tx) => {
    const endpoint = await tx.endpointCheck.create({
      data: {
        orgId: actor.orgId,
        name: input.name,
        url,
        method: input.method,
        expectedStatus: input.expectedStatus,
        expectedBodyContains: input.expectedBodyContains || null,
        intervalSec: input.intervalSec,
        timeoutMs: input.timeoutMs,
        tags: input.tags,
        followRedirects: input.followRedirects,
        verifySsl: input.verifySsl,
        slaTargetPercent: input.slaTargetPercent,
      },
      select: { id: true },
    });
    await recordAudit(tx, {
      action: "endpoint.created",
      orgId: actor.orgId,
      actorId: actor.userId,
      actorEmail: actor.email,
      targetType: "endpoint",
      targetId: endpoint.id,
      ipAddress: actor.ip,
      metadata: { name: input.name, url },
    });
    return ok(endpoint);
  });
}

export async function updateEndpoint(db: PrismaClient, actor: Actor, id: string, input: EndpointInput): Promise<Result<true, EndpointWriteError>> {
  if (!can(actor.role, "endpoints:write")) return fail("forbidden");
  const url = normalizeUrl(input.url);
  if (!url) return fail("invalid_url");

  return db.$transaction(async (tx) => {
    const result = await tx.endpointCheck.updateMany({
      where: { id, orgId: actor.orgId },
      data: {
        name: input.name,
        url,
        method: input.method,
        expectedStatus: input.expectedStatus,
        expectedBodyContains: input.expectedBodyContains || null,
        intervalSec: input.intervalSec,
        timeoutMs: input.timeoutMs,
        tags: input.tags,
        followRedirects: input.followRedirects,
        verifySsl: input.verifySsl,
        slaTargetPercent: input.slaTargetPercent,
      },
    });
    if (result.count !== 1) return fail("not_found");
    await recordAudit(tx, {
      action: "endpoint.updated",
      orgId: actor.orgId,
      actorId: actor.userId,
      actorEmail: actor.email,
      targetType: "endpoint",
      targetId: id,
      ipAddress: actor.ip,
      metadata: { name: input.name, url },
    });
    return ok(true as const);
  });
}

export async function setEndpointEnabled(db: PrismaClient, actor: Actor, id: string, enabled: boolean): Promise<Result<true, EndpointWriteError>> {
  if (!can(actor.role, "endpoints:write")) return fail("forbidden");
  return db.$transaction(async (tx) => {
    const result = await tx.endpointCheck.updateMany({ where: { id, orgId: actor.orgId }, data: { enabled } });
    if (result.count !== 1) return fail("not_found");
    await recordAudit(tx, {
      action: enabled ? "endpoint.enabled" : "endpoint.disabled",
      orgId: actor.orgId,
      actorId: actor.userId,
      actorEmail: actor.email,
      targetType: "endpoint",
      targetId: id,
      ipAddress: actor.ip,
    });
    return ok(true as const);
  });
}

export async function deleteEndpoint(db: PrismaClient, actor: Actor, id: string): Promise<Result<true, EndpointWriteError>> {
  if (!can(actor.role, "endpoints:write")) return fail("forbidden");
  return db.$transaction(async (tx) => {
    const result = await tx.endpointCheck.deleteMany({ where: { id, orgId: actor.orgId } });
    if (result.count !== 1) return fail("not_found");
    await recordAudit(tx, {
      action: "endpoint.deleted",
      orgId: actor.orgId,
      actorId: actor.userId,
      actorEmail: actor.email,
      targetType: "endpoint",
      targetId: id,
      ipAddress: actor.ip,
    });
    return ok(true as const);
  });
}

export const HTTP_METHODS: readonly HttpMethod[] = [
  HttpMethod.GET, HttpMethod.HEAD, HttpMethod.POST, HttpMethod.PUT, HttpMethod.PATCH, HttpMethod.DELETE, HttpMethod.OPTIONS,
];
