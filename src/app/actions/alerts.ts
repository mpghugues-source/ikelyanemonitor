"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { AlertOperator, MetricSource, MetricType, NotificationChannel, Severity } from "@/generated/prisma/enums";
import { authorize } from "@/lib/auth/dal";
import { errorState, type FormState } from "@/lib/form-state";
import { getPrisma } from "@/lib/prisma";
import { createAlertRule, deleteAlertRule, setAlertRuleEnabled, updateAlertRule } from "@/modules/alerts/rules";

const idSchema = z.string().min(1).max(64);

const emailListSchema = z
  .string()
  .trim()
  .max(1000)
  .optional()
  .transform((value) => (value ? value.split(",").map((email) => email.trim()).filter(Boolean) : []));

const ruleSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional(),
  sourceKind: z.enum(MetricSource),
  sourceId: z.string().trim().max(64).optional(),
  metric: z.enum(MetricType),
  instanceFilter: z.string().trim().max(200).optional(),
  operator: z.enum(AlertOperator),
  threshold: z.coerce.number().finite(),
  durationSec: z.coerce.number().int().min(0).max(86400),
  severity: z.enum(Severity),
  channels: z.array(z.enum(NotificationChannel)).optional(),
  notifyEmails: emailListSchema,
  webhookUrl: z.string().trim().url().max(500).optional(),
  cooldownSec: z.coerce.number().int().min(60).max(86400),
});

function readForm(formData: FormData) {
  return {
    ...Object.fromEntries(formData),
    channels: formData.getAll("channels"),
  };
}

export async function createAlertRuleAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const auth = await authorize("alerts:write");
  if (!auth.ok) return errorState(auth.error);

  const parsed = ruleSchema.safeParse(readForm(formData));
  if (!parsed.success) return errorState("generic");

  const result = await createAlertRule(getPrisma(), auth.value.actor, {
    ...parsed.data,
    description: parsed.data.description || null,
    sourceId: parsed.data.sourceId || null,
    instanceFilter: parsed.data.instanceFilter || null,
    webhookUrl: parsed.data.webhookUrl || null,
    channels: parsed.data.channels ?? [],
  });
  if (!result.ok) return errorState(result.error);

  revalidatePath("/", "layout");
  return { status: "success" };
}

export async function updateAlertRuleAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const auth = await authorize("alerts:write");
  if (!auth.ok) return errorState(auth.error);

  const id = idSchema.safeParse(formData.get("id"));
  if (!id.success) return errorState("not_found");
  const parsed = ruleSchema.safeParse(readForm(formData));
  if (!parsed.success) return errorState("generic");

  const result = await updateAlertRule(getPrisma(), auth.value.actor, id.data, {
    ...parsed.data,
    description: parsed.data.description || null,
    sourceId: parsed.data.sourceId || null,
    instanceFilter: parsed.data.instanceFilter || null,
    webhookUrl: parsed.data.webhookUrl || null,
    channels: parsed.data.channels ?? [],
  });
  if (!result.ok) return errorState(result.error);

  revalidatePath("/", "layout");
  return { status: "success" };
}

export async function toggleAlertRuleAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const auth = await authorize("alerts:write");
  if (!auth.ok) return errorState(auth.error);
  const parsed = z.object({ id: idSchema, enabled: z.enum(["true", "false"]) }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) return errorState("not_found");

  const result = await setAlertRuleEnabled(getPrisma(), auth.value.actor, parsed.data.id, parsed.data.enabled === "true");
  if (!result.ok) return errorState(result.error);
  revalidatePath("/", "layout");
  return { status: "success" };
}

export async function deleteAlertRuleAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const auth = await authorize("alerts:write");
  if (!auth.ok) return errorState(auth.error);
  const id = idSchema.safeParse(formData.get("id"));
  if (!id.success) return errorState("not_found");

  const result = await deleteAlertRule(getPrisma(), auth.value.actor, id.data);
  if (!result.ok) return errorState(result.error);
  revalidatePath("/", "layout");
  return { status: "success" };
}
