"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { HttpMethod } from "@/generated/prisma/enums";
import { authorize } from "@/lib/auth/dal";
import { errorState, type FormState } from "@/lib/form-state";
import { getPrisma } from "@/lib/prisma";
import { createEndpoint, deleteEndpoint, requestEndpointCheck, setEndpointEnabled, updateEndpoint, type EndpointInput } from "@/modules/saas/endpoints";

const idSchema = z.string().min(1).max(64);

const endpointSchema = z.object({
  name: z.string().trim().min(1).max(120),
  url: z.string().trim().min(1).max(2048),
  method: z.enum(HttpMethod),
  expectedStatus: z.coerce.number().int().min(100).max(599),
  expectedBodyContains: z.string().trim().max(500).optional(),
  intervalSec: z.coerce.number().int().min(10).max(86400),
  timeoutMs: z.coerce.number().int().min(100).max(120000),
  tags: z.string().trim().max(300).optional(),
  followRedirects: z.enum(["true", "false"]).optional(),
  verifySsl: z.enum(["true", "false"]).optional(),
  slaTargetPercent: z.coerce.number().min(0).max(100),
});

function toInput(parsed: z.infer<typeof endpointSchema>): EndpointInput {
  return {
    name: parsed.name,
    url: parsed.url,
    method: parsed.method,
    expectedStatus: parsed.expectedStatus,
    expectedBodyContains: parsed.expectedBodyContains,
    intervalSec: parsed.intervalSec,
    timeoutMs: parsed.timeoutMs,
    tags: parsed.tags ? parsed.tags.split(",").map((tag) => tag.trim()).filter(Boolean) : [],
    followRedirects: parsed.followRedirects !== "false",
    verifySsl: parsed.verifySsl !== "false",
    slaTargetPercent: parsed.slaTargetPercent,
  };
}

export async function createEndpointAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const auth = await authorize("endpoints:write");
  if (!auth.ok) return errorState(auth.error);

  const parsed = endpointSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return errorState("invalid_url");

  const result = await createEndpoint(getPrisma(), auth.value.actor, toInput(parsed.data));
  if (!result.ok) return errorState(result.error);

  revalidatePath("/", "layout");
  return { status: "success" };
}

export async function updateEndpointAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const auth = await authorize("endpoints:write");
  if (!auth.ok) return errorState(auth.error);

  const id = idSchema.safeParse(formData.get("id"));
  if (!id.success) return errorState("not_found");
  const parsed = endpointSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return errorState("invalid_url");

  const result = await updateEndpoint(getPrisma(), auth.value.actor, id.data, toInput(parsed.data));
  if (!result.ok) return errorState(result.error);

  revalidatePath("/", "layout");
  return { status: "success" };
}

export async function toggleEndpointAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const auth = await authorize("endpoints:write");
  if (!auth.ok) return errorState(auth.error);
  const parsed = z.object({ id: idSchema, enabled: z.enum(["true", "false"]) }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) return errorState("not_found");

  const result = await setEndpointEnabled(getPrisma(), auth.value.actor, parsed.data.id, parsed.data.enabled === "true");
  if (!result.ok) return errorState(result.error);
  revalidatePath("/", "layout");
  return { status: "success" };
}

export async function deleteEndpointAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const auth = await authorize("endpoints:write");
  if (!auth.ok) return errorState(auth.error);
  const id = idSchema.safeParse(formData.get("id"));
  if (!id.success) return errorState("not_found");

  const result = await deleteEndpoint(getPrisma(), auth.value.actor, id.data);
  if (!result.ok) return errorState(result.error);
  revalidatePath("/", "layout");
  return { status: "success" };
}

export async function checkEndpointNowAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const auth = await authorize("endpoints:check");
  if (!auth.ok) return errorState(auth.error);
  const id = idSchema.safeParse(formData.get("id"));
  if (!id.success) return errorState("not_found");

  const result = await requestEndpointCheck(getPrisma(), auth.value.actor, id.data);
  if (!result.ok) return errorState(result.error);
  revalidatePath("/", "layout");
  return { status: "success" };
}
