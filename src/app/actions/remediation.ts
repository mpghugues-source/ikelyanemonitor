"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { OsFamily, ScriptRuntime } from "@/generated/prisma/enums";
import { authorize } from "@/lib/auth/dal";
import { errorState, type FormState } from "@/lib/form-state";
import { getPrisma } from "@/lib/prisma";
import {
  createRemediationAction,
  deleteRemediationAction,
  type RemediationActionInput,
  setRemediationActionEnabled,
  updateRemediationAction,
} from "@/modules/remediation/actions";
import { ARG_NAME, MAX_ARGS, MAX_SCRIPT_BYTES } from "@/modules/remediation/constants";
import { approveExecution, cancelExecution, requestRun } from "@/modules/remediation/executions";

const idSchema = z.string().min(1).max(64);

/** One "NAME=value" per line; blank lines ignored. Invalid lines fail the whole form (invalid_args). */
const argsSchema = z
  .string()
  .max(20_000)
  .optional()
  .transform((text, ctx) => {
    const args: Record<string, string> = {};
    for (const line of (text ?? "").split(/\r?\n/)) {
      if (!line.trim()) continue;
      const eq = line.indexOf("=");
      const name = eq > 0 ? line.slice(0, eq).trim() : "";
      if (!ARG_NAME.test(name)) {
        ctx.addIssue({ code: "custom", message: "invalid_args" });
        return z.NEVER;
      }
      args[name] = line.slice(eq + 1);
    }
    if (Object.keys(args).length > MAX_ARGS) {
      ctx.addIssue({ code: "custom", message: "invalid_args" });
      return z.NEVER;
    }
    return args;
  });

const actionSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional(),
  runtime: z.enum(ScriptRuntime),
  // Normalize line endings: a script pasted from Windows would otherwise break bash with "\r".
  scriptBody: z.string().max(MAX_SCRIPT_BYTES).transform((script) => script.replace(/\r\n/g, "\n")),
  args: argsSchema,
  timeoutSec: z.coerce.number().int().min(1).max(3600),
  targetHostId: z.string().trim().max(64).optional(),
  allowedOsFamilies: z.array(z.enum(OsFamily)).optional(),
  requiresApproval: z.enum(["true"]).optional().transform((value) => value === "true"),
  cooldownSec: z.coerce.number().int().min(0).max(86_400),
  maxRunsPerHour: z.coerce.number().int().min(1).max(60),
});

function parseAction(formData: FormData): { ok: true; input: RemediationActionInput } | { ok: false; error: string } {
  const parsed = actionSchema.safeParse({ ...Object.fromEntries(formData), allowedOsFamilies: formData.getAll("allowedOsFamilies") });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: issue?.path[0] === "args" ? "invalid_args" : issue?.path[0] === "scriptBody" ? "invalid_script" : "generic" };
  }
  const data = parsed.data;
  return {
    ok: true,
    input: {
      name: data.name,
      description: data.description || null,
      runtime: data.runtime,
      scriptBody: data.scriptBody,
      args: data.args ?? {},
      timeoutSec: data.timeoutSec,
      targetHostId: data.targetHostId || null,
      allowedOsFamilies: data.allowedOsFamilies ?? [],
      requiresApproval: data.requiresApproval,
      cooldownSec: data.cooldownSec,
      maxRunsPerHour: data.maxRunsPerHour,
    },
  };
}

export async function createRemediationActionAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const auth = await authorize("remediation:write");
  if (!auth.ok) return errorState(auth.error);
  const parsed = parseAction(formData);
  if (!parsed.ok) return errorState(parsed.error);
  const result = await createRemediationAction(getPrisma(), auth.value.actor, parsed.input);
  if (!result.ok) return errorState(result.error);
  revalidatePath("/", "layout");
  return { status: "success" };
}

export async function updateRemediationActionAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const auth = await authorize("remediation:write");
  if (!auth.ok) return errorState(auth.error);
  const id = idSchema.safeParse(formData.get("id"));
  if (!id.success) return errorState("not_found");
  const parsed = parseAction(formData);
  if (!parsed.ok) return errorState(parsed.error);
  const result = await updateRemediationAction(getPrisma(), auth.value.actor, id.data, parsed.input);
  if (!result.ok) return errorState(result.error);
  revalidatePath("/", "layout");
  return { status: "success" };
}

export async function toggleRemediationActionAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const auth = await authorize("remediation:write");
  if (!auth.ok) return errorState(auth.error);
  const parsed = z.object({ id: idSchema, enabled: z.enum(["true", "false"]) }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) return errorState("not_found");
  const result = await setRemediationActionEnabled(getPrisma(), auth.value.actor, parsed.data.id, parsed.data.enabled === "true");
  if (!result.ok) return errorState(result.error);
  revalidatePath("/", "layout");
  return { status: "success" };
}

export async function deleteRemediationActionAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const auth = await authorize("remediation:write");
  if (!auth.ok) return errorState(auth.error);
  const id = idSchema.safeParse(formData.get("id"));
  if (!id.success) return errorState("not_found");
  const result = await deleteRemediationAction(getPrisma(), auth.value.actor, id.data);
  if (!result.ok) return errorState(result.error);
  revalidatePath("/", "layout");
  return { status: "success" };
}

/** Returns the outcome so the UI can say WHY a run was skipped (guard-rails, host policy). */
export async function runRemediationAction(_previous: FormState<{ status: string; reason: string | null }>, formData: FormData): Promise<FormState<{ status: string; reason: string | null }>> {
  const auth = await authorize("remediation:run");
  if (!auth.ok) return errorState(auth.error);
  const parsed = z.object({ actionId: idSchema, hostId: z.string().max(64).optional() }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) return errorState("not_found");
  const result = await requestRun(getPrisma(), auth.value.actor, parsed.data.actionId, parsed.data.hostId || null);
  if (!result.ok) return errorState(result.error);
  revalidatePath("/", "layout");
  return { status: "success", data: { status: result.value.status, reason: result.value.statusReason } };
}

export async function approveExecutionAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const auth = await authorize("remediation:run");
  if (!auth.ok) return errorState(auth.error);
  const id = idSchema.safeParse(formData.get("id"));
  if (!id.success) return errorState("not_found");
  const result = await approveExecution(getPrisma(), auth.value.actor, id.data);
  if (!result.ok) return errorState(result.error);
  revalidatePath("/", "layout");
  return { status: "success" };
}

export async function cancelExecutionAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const auth = await authorize("remediation:run");
  if (!auth.ok) return errorState(auth.error);
  const id = idSchema.safeParse(formData.get("id"));
  if (!id.success) return errorState("not_found");
  const result = await cancelExecution(getPrisma(), auth.value.actor, id.data);
  if (!result.ok) return errorState(result.error);
  revalidatePath("/", "layout");
  return { status: "success" };
}
