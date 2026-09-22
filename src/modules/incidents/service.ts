import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { IncidentEventType, IncidentStatus, type MetricSource, type MetricType, type Severity } from "@/generated/prisma/enums";
import type { Actor, Db } from "@/lib/auth/db";
import { can } from "@/lib/auth/permissions";
import { fail, ok, type Result } from "@/lib/result";

export interface IncidentEventRow {
  id: string;
  type: IncidentEventType;
  message: string | null;
  actorId: string | null;
  actorEmail: string | null;
  data: Prisma.JsonValue;
  createdAt: Date;
}

export interface IncidentRow {
  id: string;
  title: string;
  severity: Severity;
  status: IncidentStatus;
  sourceKind: MetricSource | null;
  sourceLabel: string | null;
  metric: MetricType | null;
  triggerValue: number | null;
  peakValue: number | null;
  startedAt: Date;
  acknowledgedAt: Date | null;
  resolvedAt: Date | null;
  resolutionNote: string | null;
  events: IncidentEventRow[];
}

const EVENTS_PER_INCIDENT = 30;

const INCIDENT_SELECT = {
  id: true, title: true, severity: true, status: true, sourceKind: true, sourceLabel: true, metric: true,
  triggerValue: true, peakValue: true, startedAt: true, acknowledgedAt: true, resolvedAt: true, resolutionNote: true,
  events: { orderBy: { createdAt: "asc" as const }, take: EVENTS_PER_INCIDENT, select: { id: true, type: true, message: true, actorId: true, data: true, createdAt: true } },
} satisfies Prisma.IncidentSelect;

type IncidentPayload = Prisma.IncidentGetPayload<{ select: typeof INCIDENT_SELECT }>;

/** Attaches the e-mail of each event's actor (looked up in one batch), falling back to null when the user was deleted. */
async function toRows(db: Db, incidents: IncidentPayload[]): Promise<IncidentRow[]> {
  const actorIds = [...new Set(incidents.flatMap((incident) => incident.events.map((event) => event.actorId).filter((id): id is string => id !== null)))];
  const users = actorIds.length ? await db.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, email: true } }) : [];
  const emailById = new Map(users.map((user) => [user.id, user.email]));

  return incidents.map((incident) => ({
    ...incident,
    events: incident.events.map((event) => ({ ...event, actorEmail: event.actorId ? (emailById.get(event.actorId) ?? null) : null })),
  }));
}

/** Open or acknowledged incidents, most severe and most recent first. */
export async function listActiveIncidents(db: Db, actor: Actor): Promise<Result<IncidentRow[], "forbidden">> {
  if (!can(actor.role, "incidents:read")) return fail("forbidden");
  const rows = await db.incident.findMany({
    where: { orgId: actor.orgId, status: { not: IncidentStatus.RESOLVED } },
    orderBy: [{ severity: "desc" }, { startedAt: "desc" }],
    select: INCIDENT_SELECT,
  });
  return ok(await toRows(db, rows));
}

/** Most recently resolved incidents, capped. */
export async function listResolvedIncidents(db: Db, actor: Actor, limit = 50): Promise<Result<IncidentRow[], "forbidden">> {
  if (!can(actor.role, "incidents:read")) return fail("forbidden");
  const rows = await db.incident.findMany({
    where: { orgId: actor.orgId, status: IncidentStatus.RESOLVED },
    orderBy: { resolvedAt: "desc" },
    take: Math.min(Math.max(limit, 1), 200),
    select: INCIDENT_SELECT,
  });
  return ok(await toRows(db, rows));
}

export type IncidentWriteError = "forbidden" | "not_found" | "invalid_status";

async function ownedIncident(tx: Prisma.TransactionClient, orgId: string, id: string) {
  return tx.incident.findFirst({ where: { id, orgId }, select: { id: true, status: true } });
}

export async function acknowledgeIncident(db: PrismaClient, actor: Actor, id: string): Promise<Result<true, IncidentWriteError>> {
  if (!can(actor.role, "incidents:acknowledge")) return fail("forbidden");
  return db.$transaction(async (tx) => {
    const incident = await ownedIncident(tx, actor.orgId, id);
    if (!incident) return fail("not_found");
    if (incident.status !== IncidentStatus.OPEN) return fail("invalid_status");
    await tx.incident.update({ where: { id }, data: { status: IncidentStatus.ACKNOWLEDGED, acknowledgedAt: new Date(), acknowledgedBy: actor.userId } });
    await tx.incidentEvent.create({ data: { incidentId: id, type: IncidentEventType.ACKNOWLEDGED, actorId: actor.userId } });
    return ok(true as const);
  });
}

export async function resolveIncident(db: PrismaClient, actor: Actor, id: string, note: string | null): Promise<Result<true, IncidentWriteError>> {
  if (!can(actor.role, "incidents:acknowledge")) return fail("forbidden");
  return db.$transaction(async (tx) => {
    const incident = await ownedIncident(tx, actor.orgId, id);
    if (!incident) return fail("not_found");
    if (incident.status === IncidentStatus.RESOLVED) return fail("invalid_status");
    await tx.incident.update({
      where: { id },
      data: { status: IncidentStatus.RESOLVED, resolvedAt: new Date(), resolvedBy: actor.userId, resolutionNote: note },
    });
    await tx.incidentEvent.create({ data: { incidentId: id, type: IncidentEventType.RESOLVED, actorId: actor.userId, message: note } });
    return ok(true as const);
  });
}

export async function reopenIncident(db: PrismaClient, actor: Actor, id: string): Promise<Result<true, IncidentWriteError>> {
  if (!can(actor.role, "incidents:acknowledge")) return fail("forbidden");
  return db.$transaction(async (tx) => {
    const incident = await ownedIncident(tx, actor.orgId, id);
    if (!incident) return fail("not_found");
    if (incident.status !== IncidentStatus.RESOLVED) return fail("invalid_status");
    await tx.incident.update({
      where: { id },
      data: { status: IncidentStatus.OPEN, acknowledgedAt: null, acknowledgedBy: null, resolvedAt: null, resolvedBy: null, resolutionNote: null },
    });
    await tx.incidentEvent.create({ data: { incidentId: id, type: IncidentEventType.REOPENED, actorId: actor.userId } });
    return ok(true as const);
  });
}

export async function addIncidentNote(db: PrismaClient, actor: Actor, id: string, message: string): Promise<Result<true, IncidentWriteError>> {
  if (!can(actor.role, "incidents:acknowledge")) return fail("forbidden");
  return db.$transaction(async (tx) => {
    const incident = await ownedIncident(tx, actor.orgId, id);
    if (!incident) return fail("not_found");
    await tx.incidentEvent.create({ data: { incidentId: id, type: IncidentEventType.NOTE, actorId: actor.userId, message } });
    return ok(true as const);
  });
}
