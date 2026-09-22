import type { PrismaClient } from "@/generated/prisma/client";
import type { DependencyKind, Severity, TopologyNodeKind } from "@/generated/prisma/enums";
import { recordAudit } from "@/lib/auth/audit";
import type { Actor, Db } from "@/lib/auth/db";
import { can } from "@/lib/auth/permissions";
import { fail, ok, type Result } from "@/lib/result";

export interface TopologyNodeRow {
  id: string;
  kind: TopologyNodeKind;
  refId: string | null;
  label: string;
  positionX: number;
  positionY: number;
}

export interface TopologyEdgeRow {
  id: string;
  parentNodeId: string;
  childNodeId: string;
  kind: DependencyKind;
  criticality: Severity;
  label: string | null;
}

export interface TopologyGraph {
  nodes: TopologyNodeRow[];
  edges: TopologyEdgeRow[];
}

export async function listTopology(db: Db, actor: Actor): Promise<Result<TopologyGraph, "forbidden">> {
  if (!can(actor.role, "topology:read")) return fail("forbidden");
  const [nodes, edges] = await Promise.all([
    db.topologyNode.findMany({
      where: { orgId: actor.orgId },
      orderBy: { createdAt: "asc" },
      select: { id: true, kind: true, refId: true, label: true, positionX: true, positionY: true },
    }),
    db.serviceDependency.findMany({
      where: { orgId: actor.orgId },
      select: { id: true, parentNodeId: true, childNodeId: true, kind: true, criticality: true, label: true },
    }),
  ]);
  return ok({ nodes, edges });
}

export type TopologyWriteError = "forbidden" | "invalid_ref" | "already_exists" | "not_found";

export interface CreateNodeInput {
  kind: TopologyNodeKind;
  refId: string | null;
  label: string;
  positionX: number;
  positionY: number;
}

/** For entity-backed kinds, `refId` must be a real row of that kind in the org — never trusted blindly. */
async function refExists(db: Db, orgId: string, kind: TopologyNodeKind, refId: string): Promise<boolean> {
  switch (kind) {
    case "HOST":
      return Boolean(await db.monitoredHost.findFirst({ where: { id: refId, orgId }, select: { id: true } }));
    case "NETWORK_DEVICE":
      return Boolean(await db.networkDevice.findFirst({ where: { id: refId, orgId }, select: { id: true } }));
    case "DATABASE":
      return Boolean(await db.databaseInstance.findFirst({ where: { id: refId, orgId }, select: { id: true } }));
    case "ENDPOINT":
      return Boolean(await db.endpointCheck.findFirst({ where: { id: refId, orgId }, select: { id: true } }));
    case "SERVICE":
    case "EXTERNAL":
      return false;
  }
}

export async function createNode(db: PrismaClient, actor: Actor, input: CreateNodeInput): Promise<Result<{ id: string }, TopologyWriteError>> {
  if (!can(actor.role, "topology:write")) return fail("forbidden");
  const isLogical = input.kind === "SERVICE" || input.kind === "EXTERNAL";
  if (!isLogical) {
    if (!input.refId || !(await refExists(db, actor.orgId, input.kind, input.refId))) return fail("invalid_ref");
  }

  return db.$transaction(async (tx) => {
    // Entity-backed nodes are unique per (org, kind, ref): re-adding the same host twice is
    // rejected. Logical nodes (refId = null) have no such constraint — several unrelated services
    // legitimately share kind=SERVICE with refId=null, and Postgres treats each NULL as distinct.
    if (!isLogical && input.refId) {
      const existing = await tx.topologyNode.findUnique({
        where: { orgId_kind_refId: { orgId: actor.orgId, kind: input.kind, refId: input.refId } },
        select: { id: true },
      });
      if (existing) return fail("already_exists");
    }
    const refId = isLogical ? null : input.refId;
    const node = await tx.topologyNode.create({
      data: { orgId: actor.orgId, kind: input.kind, refId, label: input.label, positionX: input.positionX, positionY: input.positionY },
      select: { id: true },
    });
    await recordAudit(tx, {
      action: "topology.node_created",
      orgId: actor.orgId,
      actorId: actor.userId,
      actorEmail: actor.email,
      targetType: "topology_node",
      targetId: node.id,
      ipAddress: actor.ip,
      metadata: { kind: input.kind, label: input.label },
    });
    return ok(node);
  });
}

export async function deleteNode(db: PrismaClient, actor: Actor, id: string): Promise<Result<true, TopologyWriteError>> {
  if (!can(actor.role, "topology:write")) return fail("forbidden");
  return db.$transaction(async (tx) => {
    const result = await tx.topologyNode.deleteMany({ where: { id, orgId: actor.orgId } });
    if (result.count !== 1) return fail("not_found");
    await recordAudit(tx, {
      action: "topology.node_deleted",
      orgId: actor.orgId,
      actorId: actor.userId,
      actorEmail: actor.email,
      targetType: "topology_node",
      targetId: id,
      ipAddress: actor.ip,
    });
    return ok(true as const);
  });
}

export async function updateNodePosition(db: PrismaClient, actor: Actor, id: string, positionX: number, positionY: number): Promise<Result<true, "forbidden" | "not_found">> {
  if (!can(actor.role, "topology:write")) return fail("forbidden");
  const result = await db.topologyNode.updateMany({ where: { id, orgId: actor.orgId }, data: { positionX, positionY } });
  if (result.count !== 1) return fail("not_found");
  return ok(true as const);
}

export interface CreateDependencyInput {
  parentNodeId: string;
  childNodeId: string;
  kind: DependencyKind;
  criticality: Severity;
  label?: string | null;
}

export async function createDependency(db: PrismaClient, actor: Actor, input: CreateDependencyInput): Promise<Result<{ id: string }, TopologyWriteError>> {
  if (!can(actor.role, "topology:write")) return fail("forbidden");
  if (input.parentNodeId === input.childNodeId) return fail("invalid_ref");

  return db.$transaction(async (tx) => {
    const [parent, child] = await Promise.all([
      tx.topologyNode.findFirst({ where: { id: input.parentNodeId, orgId: actor.orgId }, select: { id: true } }),
      tx.topologyNode.findFirst({ where: { id: input.childNodeId, orgId: actor.orgId }, select: { id: true } }),
    ]);
    if (!parent || !child) return fail("invalid_ref");

    if (
      await tx.serviceDependency.findUnique({
        where: { parentNodeId_childNodeId_kind: { parentNodeId: input.parentNodeId, childNodeId: input.childNodeId, kind: input.kind } },
        select: { id: true },
      })
    ) {
      return fail("already_exists");
    }

    const dependency = await tx.serviceDependency.create({
      data: {
        orgId: actor.orgId,
        parentNodeId: input.parentNodeId,
        childNodeId: input.childNodeId,
        kind: input.kind,
        criticality: input.criticality,
        label: input.label || null,
      },
      select: { id: true },
    });
    await recordAudit(tx, {
      action: "topology.dependency_created",
      orgId: actor.orgId,
      actorId: actor.userId,
      actorEmail: actor.email,
      targetType: "service_dependency",
      targetId: dependency.id,
      ipAddress: actor.ip,
    });
    return ok(dependency);
  });
}

export async function deleteDependency(db: PrismaClient, actor: Actor, id: string): Promise<Result<true, TopologyWriteError>> {
  if (!can(actor.role, "topology:write")) return fail("forbidden");
  return db.$transaction(async (tx) => {
    const result = await tx.serviceDependency.deleteMany({ where: { id, orgId: actor.orgId } });
    if (result.count !== 1) return fail("not_found");
    await recordAudit(tx, {
      action: "topology.dependency_deleted",
      orgId: actor.orgId,
      actorId: actor.userId,
      actorEmail: actor.email,
      targetType: "service_dependency",
      targetId: id,
      ipAddress: actor.ip,
    });
    return ok(true as const);
  });
}
