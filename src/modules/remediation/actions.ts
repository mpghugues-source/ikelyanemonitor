import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import type { OsFamily, ScriptRuntime } from "@/generated/prisma/enums";
import { recordAudit } from "@/lib/auth/audit";
import type { Actor, Db } from "@/lib/auth/db";
import { can } from "@/lib/auth/permissions";
import { fail, ok, type Result } from "@/lib/result";
import { ARG_NAME, MAX_ARGS, MAX_SCRIPT_BYTES } from "@/modules/remediation/constants";

/**
 * Remediation actions: scripts the AGENT runs on a monitored host, by hand or when an alert fires.
 *
 * This is remote code execution by design, so: only administrators (remediation:write) create or edit
 * them; every change is audited with the script's SHA-256; executions run a frozen snapshot (see
 * executions.ts); and nothing runs on a host unless its own agent config allows it (agent/README.md).
 */

export function scriptSha256(script: string): string {
  return createHash("sha256").update(script, "utf8").digest("hex");
}

export interface RemediationActionRow {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  runtime: ScriptRuntime;
  scriptBody: string;
  scriptSha256: string;
  args: Record<string, string>;
  timeoutSec: number;
  targetHostId: string | null;
  targetHostLabel: string | null;
  allowedOsFamilies: OsFamily[];
  requiresApproval: boolean;
  cooldownSec: number;
  maxRunsPerHour: number;
  createdAt: Date;
  updatedAt: Date;
}

/** EndpointCheck-style defensive read of the free-form JSON column. */
export function readArgs(value: Prisma.JsonValue | null): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => ARG_NAME.test(entry[0]) && typeof entry[1] === "string"));
}

export async function listRemediationActions(db: Db, actor: Actor): Promise<Result<RemediationActionRow[], "forbidden">> {
  if (!can(actor.role, "remediation:read")) return fail("forbidden");
  const rows = await db.remediationAction.findMany({
    where: { orgId: actor.orgId },
    orderBy: { name: "asc" },
    select: {
      id: true, name: true, description: true, enabled: true, runtime: true, scriptBody: true, args: true, timeoutSec: true,
      targetHostId: true, allowedOsFamilies: true, requiresApproval: true, cooldownSec: true, maxRunsPerHour: true,
      createdAt: true, updatedAt: true, targetHost: { select: { hostname: true, displayName: true } },
    },
  });
  return ok(
    rows.map(({ targetHost, args, ...row }) => ({
      ...row,
      args: readArgs(args),
      scriptSha256: scriptSha256(row.scriptBody),
      targetHostLabel: targetHost ? (targetHost.displayName ?? targetHost.hostname) : null,
    })),
  );
}

export interface RemediationActionInput {
  name: string;
  description: string | null;
  runtime: ScriptRuntime;
  scriptBody: string;
  args: Record<string, string>;
  timeoutSec: number;
  targetHostId: string | null;
  allowedOsFamilies: OsFamily[];
  requiresApproval: boolean;
  cooldownSec: number;
  maxRunsPerHour: number;
}

export type RemediationWriteError = "forbidden" | "not_found" | "invalid_host" | "invalid_script" | "invalid_args";

function validate(input: RemediationActionInput): RemediationWriteError | null {
  if (!input.scriptBody.trim() || Buffer.byteLength(input.scriptBody, "utf8") > MAX_SCRIPT_BYTES || input.scriptBody.includes("\0")) return "invalid_script";
  const entries = Object.entries(input.args);
  if (entries.length > MAX_ARGS || entries.some(([name, value]) => !ARG_NAME.test(name) || typeof value !== "string" || value.length > 1000 || value.includes("\0"))) return "invalid_args";
  return null;
}

async function hostInOrg(db: Db, orgId: string, hostId: string | null): Promise<boolean> {
  if (!hostId) return true;
  return (await db.monitoredHost.count({ where: { id: hostId, orgId } })) === 1;
}

export async function createRemediationAction(db: PrismaClient, actor: Actor, input: RemediationActionInput): Promise<Result<{ id: string }, RemediationWriteError>> {
  if (!can(actor.role, "remediation:write")) return fail("forbidden");
  const invalid = validate(input);
  if (invalid) return fail(invalid);
  if (!(await hostInOrg(db, actor.orgId, input.targetHostId))) return fail("invalid_host");

  return db.$transaction(async (tx) => {
    const action = await tx.remediationAction.create({ data: { orgId: actor.orgId, createdBy: actor.userId, ...input }, select: { id: true } });
    await recordAudit(tx, {
      action: "remediation_action.created",
      orgId: actor.orgId,
      actorId: actor.userId,
      actorEmail: actor.email,
      targetType: "remediation_action",
      targetId: action.id,
      ipAddress: actor.ip,
      metadata: { name: input.name, runtime: input.runtime, scriptSha256: scriptSha256(input.scriptBody) },
    });
    return ok(action);
  });
}

export async function updateRemediationAction(db: PrismaClient, actor: Actor, id: string, input: RemediationActionInput): Promise<Result<true, RemediationWriteError>> {
  if (!can(actor.role, "remediation:write")) return fail("forbidden");
  const invalid = validate(input);
  if (invalid) return fail(invalid);
  if (!(await hostInOrg(db, actor.orgId, input.targetHostId))) return fail("invalid_host");

  return db.$transaction(async (tx) => {
    const previous = await tx.remediationAction.findFirst({ where: { id, orgId: actor.orgId }, select: { scriptBody: true } });
    if (!previous) return fail("not_found");
    await tx.remediationAction.update({ where: { id }, data: input });
    await recordAudit(tx, {
      action: "remediation_action.updated",
      orgId: actor.orgId,
      actorId: actor.userId,
      actorEmail: actor.email,
      targetType: "remediation_action",
      targetId: id,
      ipAddress: actor.ip,
      metadata: { name: input.name, runtime: input.runtime, scriptSha256: scriptSha256(input.scriptBody), previousScriptSha256: scriptSha256(previous.scriptBody) },
    });
    return ok(true as const);
  });
}

export async function setRemediationActionEnabled(db: PrismaClient, actor: Actor, id: string, enabled: boolean): Promise<Result<true, RemediationWriteError>> {
  if (!can(actor.role, "remediation:write")) return fail("forbidden");
  return db.$transaction(async (tx) => {
    const result = await tx.remediationAction.updateMany({ where: { id, orgId: actor.orgId }, data: { enabled } });
    if (result.count !== 1) return fail("not_found");
    await recordAudit(tx, {
      action: enabled ? "remediation_action.enabled" : "remediation_action.disabled",
      orgId: actor.orgId,
      actorId: actor.userId,
      actorEmail: actor.email,
      targetType: "remediation_action",
      targetId: id,
      ipAddress: actor.ip,
    });
    return ok(true as const);
  });
}

export async function deleteRemediationAction(db: PrismaClient, actor: Actor, id: string): Promise<Result<true, RemediationWriteError>> {
  if (!can(actor.role, "remediation:write")) return fail("forbidden");
  return db.$transaction(async (tx) => {
    const result = await tx.remediationAction.deleteMany({ where: { id, orgId: actor.orgId } });
    if (result.count !== 1) return fail("not_found");
    await recordAudit(tx, {
      action: "remediation_action.deleted",
      orgId: actor.orgId,
      actorId: actor.userId,
      actorEmail: actor.email,
      targetType: "remediation_action",
      targetId: id,
      ipAddress: actor.ip,
    });
    return ok(true as const);
  });
}

export interface RemediationHostRow {
  id: string;
  label: string;
  enabled: boolean;
  osFamily: OsFamily;
  /** "disabled" | "allowlist" | "any" as reported by the agent, or null when never reported. */
  remediationMode: string | null;
  remediationAllowlist: string[];
}

/** Hosts with their agent-reported remediation policy (the "run on" choices and the policy table). */
export async function listRemediationHosts(db: Db, actor: Actor): Promise<Result<RemediationHostRow[], "forbidden">> {
  if (!can(actor.role, "remediation:read")) return fail("forbidden");
  const rows = await db.monitoredHost.findMany({
    where: { orgId: actor.orgId },
    orderBy: { hostname: "asc" },
    select: { id: true, hostname: true, displayName: true, enabled: true, osFamily: true, remediationMode: true, remediationAllowlist: true },
  });
  return ok(rows.map(({ hostname, displayName, ...row }) => ({ ...row, label: displayName ?? hostname })));
}
