"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { DependencyKind, Severity, TopologyNodeKind } from "@/generated/prisma/enums";
import { authorize } from "@/lib/auth/dal";
import { errorState, type FormState } from "@/lib/form-state";
import { getPrisma } from "@/lib/prisma";
import { createDependency, createNode, deleteDependency, deleteNode, updateNodePosition } from "@/modules/topology/service";

const idSchema = z.string().min(1).max(64);

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
  await updateNodePosition(getPrisma(), auth.value.actor, id, positionX, positionY);
}
