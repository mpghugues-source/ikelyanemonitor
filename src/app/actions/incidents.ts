"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorize } from "@/lib/auth/dal";
import { errorState, type FormState } from "@/lib/form-state";
import { getPrisma } from "@/lib/prisma";
import { acknowledgeIncident, addIncidentNote, reanalyzeIncident, reopenIncident, resolveIncident } from "@/modules/incidents/service";

const idSchema = z.string().min(1).max(64);

export async function acknowledgeIncidentAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const auth = await authorize("incidents:acknowledge");
  if (!auth.ok) return errorState(auth.error);
  const id = idSchema.safeParse(formData.get("id"));
  if (!id.success) return errorState("not_found");

  const result = await acknowledgeIncident(getPrisma(), auth.value.actor, id.data);
  if (!result.ok) return errorState(result.error);
  revalidatePath("/", "layout");
  return { status: "success" };
}

export async function resolveIncidentAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const auth = await authorize("incidents:acknowledge");
  if (!auth.ok) return errorState(auth.error);
  const parsed = z.object({ id: idSchema, note: z.string().trim().max(2000).optional() }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) return errorState("not_found");

  const result = await resolveIncident(getPrisma(), auth.value.actor, parsed.data.id, parsed.data.note || null);
  if (!result.ok) return errorState(result.error);
  revalidatePath("/", "layout");
  return { status: "success" };
}

export async function reopenIncidentAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const auth = await authorize("incidents:acknowledge");
  if (!auth.ok) return errorState(auth.error);
  const id = idSchema.safeParse(formData.get("id"));
  if (!id.success) return errorState("not_found");

  const result = await reopenIncident(getPrisma(), auth.value.actor, id.data);
  if (!result.ok) return errorState(result.error);
  revalidatePath("/", "layout");
  return { status: "success" };
}

export async function addIncidentNoteAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const auth = await authorize("incidents:acknowledge");
  if (!auth.ok) return errorState(auth.error);
  const parsed = z.object({ id: idSchema, message: z.string().trim().min(1).max(2000) }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) return errorState("generic");

  const result = await addIncidentNote(getPrisma(), auth.value.actor, parsed.data.id, parsed.data.message);
  if (!result.ok) return errorState(result.error);
  revalidatePath("/", "layout");
  return { status: "success" };
}

export async function reanalyzeIncidentAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const auth = await authorize("incidents:acknowledge");
  if (!auth.ok) return errorState(auth.error);
  const id = idSchema.safeParse(formData.get("id"));
  if (!id.success) return errorState("not_found");

  const result = await reanalyzeIncident(getPrisma(), auth.value.actor, id.data);
  if (!result.ok) return errorState(result.error);
  revalidatePath("/", "layout");
  return { status: "success" };
}
