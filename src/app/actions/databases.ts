"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorize } from "@/lib/auth/dal";
import { errorState, type FormState } from "@/lib/form-state";
import { getPrisma } from "@/lib/prisma";
import { setDatabaseEnabled, updateDatabaseSettings } from "@/modules/databases/instances";

const idSchema = z.string().min(1).max(64);

export async function updateDatabaseSettingsAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const auth = await authorize("databases:write");
  if (!auth.ok) return errorState(auth.error);

  const id = idSchema.safeParse(formData.get("id"));
  if (!id.success) return errorState("not_found");
  const parsed = z
    .object({ tags: z.string().trim().max(300).optional(), slowQueryThresholdMs: z.coerce.number().int().min(1).max(600000) })
    .safeParse(Object.fromEntries(formData));
  if (!parsed.success) return errorState("generic");

  const result = await updateDatabaseSettings(getPrisma(), auth.value.actor, id.data, {
    tags: parsed.data.tags ? parsed.data.tags.split(",").map((tag) => tag.trim()).filter(Boolean) : [],
    slowQueryThresholdMs: parsed.data.slowQueryThresholdMs,
  });
  if (!result.ok) return errorState(result.error);

  revalidatePath("/", "layout");
  return { status: "success" };
}

export async function toggleDatabaseAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const auth = await authorize("databases:write");
  if (!auth.ok) return errorState(auth.error);
  const parsed = z.object({ id: idSchema, enabled: z.enum(["true", "false"]) }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) return errorState("not_found");

  const result = await setDatabaseEnabled(getPrisma(), auth.value.actor, parsed.data.id, parsed.data.enabled === "true");
  if (!result.ok) return errorState(result.error);
  revalidatePath("/", "layout");
  return { status: "success" };
}
