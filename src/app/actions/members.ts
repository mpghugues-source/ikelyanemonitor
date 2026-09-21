"use server";

import { getLocale } from "next-intl/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { redirect } from "@/i18n/navigation";
import { authorize, getBaseUrl } from "@/lib/auth/dal";
import { createInvitation, revokeInvitation } from "@/lib/auth/invitations";
import { changeMemberRole, removeMember } from "@/lib/auth/members";
import { errorState, type FormState } from "@/lib/form-state";
import { getPrisma } from "@/lib/prisma";

/**
 * Member administration. Every action:
 *  1. resolves the caller from the SESSION (never from form fields) and checks their permission;
 *  2. validates its input;
 *  3. delegates to a business function that checks the permission AGAIN and scopes by organization.
 * The form only supplies the id of the thing to act on — never who is acting or in which organization.
 */

const roleSchema = z.enum(["OWNER", "ADMIN", "OPERATOR", "VIEWER"]);
const idSchema = z.string().min(1).max(64);

export async function inviteMemberAction(
  _previous: FormState<{ link: string; email: string }>,
  formData: FormData,
): Promise<FormState<{ link: string; email: string }>> {
  const auth = await authorize("members:invite");
  if (!auth.ok) return errorState(auth.error);

  const parsed = z.object({ email: z.string().trim().min(1).max(254), role: roleSchema }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) return errorState("invalid_email");

  const result = await createInvitation(getPrisma(), auth.value.actor, parsed.data);
  if (!result.ok) return errorState(result.error);

  const link = `${await getBaseUrl()}/${await getLocale()}/invite/${result.value.token}`;
  revalidatePath("/", "layout");
  return { status: "success", data: { link, email: parsed.data.email } };
}

export async function revokeInvitationAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const auth = await authorize("members:invite");
  if (!auth.ok) return errorState(auth.error);
  const id = idSchema.safeParse(formData.get("invitationId"));
  if (!id.success) return errorState("not_found");

  const result = await revokeInvitation(getPrisma(), auth.value.actor, id.data);
  if (!result.ok) return errorState(result.error);
  revalidatePath("/", "layout");
  return { status: "success" };
}

export async function changeRoleAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const auth = await authorize("members:manage");
  if (!auth.ok) return errorState(auth.error);
  const parsed = z.object({ membershipId: idSchema, role: roleSchema }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) return errorState("generic");

  const result = await changeMemberRole(getPrisma(), auth.value.actor, parsed.data.membershipId, parsed.data.role);
  if (!result.ok) return errorState(result.error);
  revalidatePath("/", "layout");
  return { status: "success" };
}

/** Removing someone else needs `members:manage`; anyone may remove THEMSELVES (leave). */
export async function removeMemberAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const auth = await authorize();
  if (!auth.ok) return errorState(auth.error);
  const id = idSchema.safeParse(formData.get("membershipId"));
  if (!id.success) return errorState("not_found");

  const result = await removeMember(getPrisma(), auth.value.actor, id.data);
  if (!result.ok) return errorState(result.error);

  revalidatePath("/", "layout");
  if (result.value.left) return redirect({ href: "/", locale: await getLocale() });
  return { status: "success" };
}
