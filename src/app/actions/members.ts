"use server";

import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { Role } from "@/generated/prisma/enums";
import { redirect } from "@/i18n/navigation";
import { authorize, getBaseUrl } from "@/lib/auth/dal";
import { createInvitation, revokeInvitation } from "@/lib/auth/invitations";
import { changeMemberRole, removeMember } from "@/lib/auth/members";
import { errorState, type FormState } from "@/lib/form-state";
import { sendEmail } from "@/lib/notify/email";
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

/**
 * Best-effort: the invitation itself is already created and usable via its link (shown once in the
 * admin's UI, see components/settings/invite-member-form.tsx) before this ever runs — a failed send
 * must not fail `inviteMemberAction`, only be logged (see the try/catch at its call site).
 *
 * Composed here, in the Server Action, rather than in a `lib/` module: `getTranslations`/
 * `getFormatter` need the request's locale context (`next-intl/server`), which a framework-agnostic
 * business module must not depend on — see the similar reasoning in
 * src/modules/alerts/evaluate.ts for why that module builds its own app URL instead of reusing
 * src/lib/auth/dal.ts's request-bound getBaseUrl().
 */
async function sendInvitationEmail(input: { to: string; orgName: string; inviterEmail: string; role: Role; link: string; expiresAt: Date }): Promise<void> {
  const t = await getTranslations();
  const format = await getFormatter();
  const role = t(`roles.${input.role.toLowerCase() as Lowercase<Role>}`);

  const text = [
    t("invitationEmail.body", { inviterEmail: input.inviterEmail, orgName: input.orgName, role }),
    "",
    t("invitationEmail.cta"),
    input.link,
    "",
    t("invitationEmail.expires", { date: format.dateTime(input.expiresAt, { dateStyle: "long" }) }),
    t("invitationEmail.ignore"),
  ].join("\n");

  await sendEmail({ to: [input.to], subject: t("invitationEmail.subject", { orgName: input.orgName }), text });
}

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

  try {
    await sendInvitationEmail({
      to: parsed.data.email,
      orgName: auth.value.session.activeOrg?.orgName ?? "",
      inviterEmail: auth.value.actor.email,
      role: parsed.data.role,
      link,
      expiresAt: result.value.expiresAt,
    });
  } catch (error) {
    console.error("[members] invitation e-mail failed", error);
  }

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
