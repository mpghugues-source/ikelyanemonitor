"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { NetworkDeviceType, SnmpAuthProtocol, SnmpPrivProtocol, SnmpSecurityLevel, SnmpVersion } from "@/generated/prisma/enums";
import { authorize } from "@/lib/auth/dal";
import { errorState, type FormState } from "@/lib/form-state";
import { getPrisma } from "@/lib/prisma";
import { deleteDevice, registerDevice, setDeviceEnabled, updateDevice, type DeviceInput } from "@/modules/network/devices";

const idSchema = z.string().min(1).max(64);

const deviceSchema = z.object({
  name: z.string().trim().min(1).max(120),
  ipAddress: z.string().trim().min(1).max(45),
  type: z.enum(NetworkDeviceType),
  tags: z.string().trim().max(300).optional(),
  pollerHostId: z.string().trim().max(64).optional(),
  pollIntervalSec: z.coerce.number().int().min(10).max(86400),
  snmpVersion: z.enum(SnmpVersion),
  snmpPort: z.coerce.number().int().min(1).max(65535),
  snmpTimeoutMs: z.coerce.number().int().min(100).max(60000),
  snmpRetries: z.coerce.number().int().min(0).max(10),
  snmpCommunity: z.string().trim().max(255).optional(),
  snmpV3Username: z.string().trim().max(255).optional(),
  snmpV3SecurityLevel: z.enum(SnmpSecurityLevel).optional(),
  snmpV3AuthProtocol: z.enum(SnmpAuthProtocol).optional(),
  snmpV3AuthKey: z.string().trim().max(255).optional(),
  snmpV3PrivProtocol: z.enum(SnmpPrivProtocol).optional(),
  snmpV3PrivKey: z.string().trim().max(255).optional(),
  snmpV3ContextName: z.string().trim().max(255).optional(),
});

function toInput(parsed: z.infer<typeof deviceSchema>): DeviceInput {
  return {
    name: parsed.name,
    ipAddress: parsed.ipAddress,
    type: parsed.type,
    tags: parsed.tags ? parsed.tags.split(",").map((tag) => tag.trim()).filter(Boolean) : [],
    pollerHostId: parsed.pollerHostId || null,
    pollIntervalSec: parsed.pollIntervalSec,
    snmpVersion: parsed.snmpVersion,
    snmpPort: parsed.snmpPort,
    snmpTimeoutMs: parsed.snmpTimeoutMs,
    snmpRetries: parsed.snmpRetries,
    snmpCommunity: parsed.snmpCommunity || undefined,
    snmpV3Username: parsed.snmpV3Username || undefined,
    snmpV3SecurityLevel: parsed.snmpV3SecurityLevel,
    snmpV3AuthProtocol: parsed.snmpV3AuthProtocol,
    snmpV3AuthKey: parsed.snmpV3AuthKey || undefined,
    snmpV3PrivProtocol: parsed.snmpV3PrivProtocol,
    snmpV3PrivKey: parsed.snmpV3PrivKey || undefined,
    snmpV3ContextName: parsed.snmpV3ContextName || undefined,
  };
}

export async function registerDeviceAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const auth = await authorize("devices:write");
  if (!auth.ok) return errorState(auth.error);

  const parsed = deviceSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return errorState("invalid_ip");

  const result = await registerDevice(getPrisma(), auth.value.actor, toInput(parsed.data));
  if (!result.ok) return errorState(result.error);

  revalidatePath("/", "layout");
  return { status: "success" };
}

export async function updateDeviceAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const auth = await authorize("devices:write");
  if (!auth.ok) return errorState(auth.error);

  const id = idSchema.safeParse(formData.get("id"));
  if (!id.success) return errorState("not_found");
  const parsed = deviceSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return errorState("invalid_ip");

  const result = await updateDevice(getPrisma(), auth.value.actor, id.data, toInput(parsed.data));
  if (!result.ok) return errorState(result.error);

  revalidatePath("/", "layout");
  return { status: "success" };
}

export async function toggleDeviceAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const auth = await authorize("devices:write");
  if (!auth.ok) return errorState(auth.error);
  const parsed = z.object({ id: idSchema, enabled: z.enum(["true", "false"]) }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) return errorState("not_found");

  const result = await setDeviceEnabled(getPrisma(), auth.value.actor, parsed.data.id, parsed.data.enabled === "true");
  if (!result.ok) return errorState(result.error);
  revalidatePath("/", "layout");
  return { status: "success" };
}

export async function deleteDeviceAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const auth = await authorize("devices:write");
  if (!auth.ok) return errorState(auth.error);
  const id = idSchema.safeParse(formData.get("id"));
  if (!id.success) return errorState("not_found");

  const result = await deleteDevice(getPrisma(), auth.value.actor, id.data);
  if (!result.ok) return errorState(result.error);
  revalidatePath("/", "layout");
  return { status: "success" };
}
