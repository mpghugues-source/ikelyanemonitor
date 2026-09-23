"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { AlertOperator, AnomalySensitivity, MetricSource, MetricType, NotificationChannel, Severity } from "@/generated/prisma/enums";
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
  .transform((value) => (value ? value.split(",").map((email) => email.trim()).filter(Boolean) : []))
  .refine((emails) => emails.every((email) => z.email().safeParse(email).success), "invalid email");

const httpUrlSchema = z
  .string()
  .trim()
  .max(500)
  .optional()
  .transform((value) => (value ? value : undefined))
  .refine((value) => !value || (/^https?:\/\//i.test(value) && z.url().safeParse(value).success), "must be a valid http(s) URL");

const ruleSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional(),
  sourceKind: z.enum(MetricSource),
  sourceId: z.string().trim().max(64).optional(),
  metric: z.enum(MetricType),
  instanceFilter: z.string().trim().max(200).optional(),
  // Empty operator = no threshold (anomaly-only rule); the business function checks that SOME condition is set.
  operator: z.union([z.enum(AlertOperator), z.literal("")]).optional().transform((value) => value || null),
  threshold: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value ? Number(value) : null))
    .refine((value) => value === null || Number.isFinite(value), "must be a number"),
  anomalyDetection: z.enum(["true"]).optional().transform((value) => value === "true"),
  anomalySensitivity: z.enum(AnomalySensitivity).default("MEDIUM"),
  durationSec: z.coerce.number().int().min(0).max(86400),
  severity: z.enum(Severity),
  channels: z.array(z.enum(NotificationChannel)).optional(),
  notifyEmails: emailListSchema,
  webhookUrl: httpUrlSchema,
  cooldownSec: z.coerce.number().int().min(60).max(86400),
});

/**
 * Form → business input. The operator select keeps a value even when the threshold field is left
 * empty: an empty threshold means "no threshold", whatever the operator shows.
 */
function toInput(data: z.infer<typeof ruleSchema>) {
  return {
    ...data,
    operator: data.threshold === null ? null : data.operator,
    description: data.description || null,
    sourceId: data.sourceId || null,
    instanceFilter: data.instanceFilter || null,
    webhookUrl: data.webhookUrl || null,
    channels: data.channels ?? [],
  };
}

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

  const result = await createAlertRule(getPrisma(), auth.value.actor, toInput(parsed.data));
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

  const result = await updateAlertRule(getPrisma(), auth.value.actor, id.data, toInput(parsed.data));
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
