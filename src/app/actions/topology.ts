"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { DependencyKind, Severity, TopologyNodeKind } from "@/generated/prisma/enums";
import { authorize } from "@/lib/auth/dal";
import { errorState, type FormState } from "@/lib/form-state";
import { getPrisma } from "@/lib/prisma";
import { createDependency, createNode, deleteDependency, deleteNode, MAX_LAYOUT_NODES, updateNodePosition, updateNodePositions } from "@/modules/topology/service";

const idSchema = z.string().min(1).max(64);
const coordinate = z.number().finite().min(-1e6).max(1e6);

export async function createNodeAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const auth = await authorize("topology:write");
  if (!auth.ok) return errorState(auth.error);

  const parsed = z
    .object({
      kind: z.enum(TopologyNodeKind),
      refId: z.string().trim().max(64).optional(),
      label: z.string().trim().min(1).max(120),
    })
    .safeParse(Object.fromEntries(formData));
  if (!parsed.success) return errorState("invalid_ref");

  const result = await createNode(getPrisma(), auth.value.actor, {
    kind: parsed.data.kind,
    refId: parsed.data.refId || null,
    label: parsed.data.label,
    positionX: Math.random() * 500,
    positionY: Math.random() * 400,
  });
  if (!result.ok) return errorState(result.error);

  revalidatePath("/", "layout");
  return { status: "success" };
}

export async function deleteNodeAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const auth = await authorize("topology:write");
  if (!auth.ok) return errorState(auth.error);
  const id = idSchema.safeParse(formData.get("id"));
  if (!id.success) return errorState("not_found");

  const result = await deleteNode(getPrisma(), auth.value.actor, id.data);
  if (!result.ok) return errorState(result.error);
  revalidatePath("/", "layout");
  return { status: "success" };
}

export async function createDependencyAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const auth = await authorize("topology:write");
  if (!auth.ok) return errorState(auth.error);

  const parsed = z
    .object({
      parentNodeId: idSchema,
      childNodeId: idSchema,
      kind: z.enum(DependencyKind),
      criticality: z.enum(Severity),
      label: z.string().trim().max(120).optional(),
    })
    .safeParse(Object.fromEntries(formData));
  if (!parsed.success) return errorState("invalid_ref");

  const result = await createDependency(getPrisma(), auth.value.actor, parsed.data);
  if (!result.ok) return errorState(result.error);

  revalidatePath("/", "layout");
  return { status: "success" };
}

export async function deleteDependencyAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const auth = await authorize("topology:write");
  if (!auth.ok) return errorState(auth.error);
  const id = idSchema.safeParse(formData.get("id"));
  if (!id.success) return errorState("not_found");

  const result = await deleteDependency(getPrisma(), auth.value.actor, id.data);
  if (!result.ok) return errorState(result.error);
  revalidatePath("/", "layout");
  return { status: "success" };
}

export async function updateNodePositionAction(id: string, positionX: number, positionY: number): Promise<void> {
  const auth = await authorize("topology:write");
  if (!auth.ok) return;
  const parsed = z.tuple([idSchema, coordinate, coordinate]).safeParse([id, positionX, positionY]);
  if (!parsed.success) return;
  await updateNodePosition(getPrisma(), auth.value.actor, ...parsed.data);
}

/** Dependency drawn on the canvas (handle to handle): same checks as the form, sensible defaults. */
export async function connectNodesAction(parentNodeId: string, childNodeId: string): Promise<FormState> {
  const auth = await authorize("topology:write");
  if (!auth.ok) return errorState(auth.error);
  const ids = z.tuple([idSchema, idSchema]).safeParse([parentNodeId, childNodeId]);
  if (!ids.success) return errorState("invalid_ref");

  const result = await createDependency(getPrisma(), auth.value.actor, {
    parentNodeId: ids.data[0],
    childNodeId: ids.data[1],
    kind: DependencyKind.DEPENDS_ON,
    criticality: Severity.WARNING,
  });
  if (!result.ok) return errorState(result.error);
  revalidatePath("/", "layout");
  return { status: "success" };
}

export async function saveLayoutAction(positions: Array<{ id: string; x: number; y: number }>): Promise<FormState> {
  const auth = await authorize("topology:write");
  if (!auth.ok) return errorState(auth.error);
  const parsed = z
    .array(z.object({ id: idSchema, x: coordinate, y: coordinate }))
    .max(MAX_LAYOUT_NODES)
    .safeParse(positions);
  if (!parsed.success) return errorState("invalid_ref");

  const result = await updateNodePositions(getPrisma(), auth.value.actor, parsed.data);
  if (!result.ok) return errorState(result.error);
  revalidatePath("/", "layout");
  return { status: "success" };
}
