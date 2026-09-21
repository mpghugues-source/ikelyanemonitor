"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorize } from "@/lib/auth/dal";
import { errorState, type FormState } from "@/lib/form-state";
import { getPrisma } from "@/lib/prisma";
import { registerHost, rotateHostSecret, setHostEnabled } from "@/modules/servers/hosts";

/** Agent credentials, returned ONCE to the form that asked for them. */
export interface IssuedCredentials {
  hostname: string;
  keyId: string;
  secret: string;
}

const idSchema = z.string().min(1).max(64);

export async function registerHostAction(
  _previous: FormState<IssuedCredentials>,
  formData: FormData,
): Promise<FormState<IssuedCredentials>> {
  const auth = await authorize("hosts:write");
  if (!auth.ok) return errorState(auth.error);

  const parsed = z
    .object({ hostname: z.string().trim().min(1).max(253), displayName: z.string().trim().max(120).optional() })
    .safeParse(Object.fromEntries(formData));
  if (!parsed.success) return errorState("invalid_hostname");

  const result = await registerHost(getPrisma(), auth.value.actor, parsed.data);
  if (!result.ok) return errorState(result.error);

  revalidatePath("/", "layout");
  return { status: "success", data: { hostname: parsed.data.hostname, keyId: result.value.keyId, secret: result.value.secret } };
}

export async function rotateSecretAction(
  _previous: FormState<IssuedCredentials>,
  formData: FormData,
): Promise<FormState<IssuedCredentials>> {
  const auth = await authorize("hosts:rotate-secret");
  if (!auth.ok) return errorState(auth.error);
  const hostId = idSchema.safeParse(formData.get("hostId"));
  if (!hostId.success) return errorState("not_found");

  const result = await rotateHostSecret(getPrisma(), auth.value.actor, hostId.data);
  if (!result.ok) return errorState(result.error);

  revalidatePath("/", "layout");
  const hostname = String(formData.get("hostname") ?? "");
  return { status: "success", data: { hostname, keyId: result.value.keyId, secret: result.value.secret } };
}

export async function toggleHostAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const auth = await authorize("hosts:write");
  if (!auth.ok) return errorState(auth.error);
  const parsed = z.object({ hostId: idSchema, enabled: z.enum(["true", "false"]) }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) return errorState("not_found");

  const result = await setHostEnabled(getPrisma(), auth.value.actor, parsed.data.hostId, parsed.data.enabled === "true");
  if (!result.ok) return errorState(result.error);
  revalidatePath("/", "layout");
  return { status: "success" };
}
