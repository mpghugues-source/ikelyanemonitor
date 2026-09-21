"use server";

import { getLocale } from "next-intl/server";
import { z } from "zod";
import { redirect } from "@/i18n/navigation";
import { auditQuietly } from "@/lib/auth/audit";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@/lib/auth/constants";
import { getRequestMeta, getSession, registrationOpen } from "@/lib/auth/dal";
import { acceptInvitation } from "@/lib/auth/invitations";
import { setSessionCookie } from "@/lib/auth/session-cookie";
import { createSession, setActiveOrg } from "@/lib/auth/sessions";
import { createOrganization, createUser } from "@/lib/auth/users";
import { errorState, type FormState } from "@/lib/form-state";
import { getPrisma } from "@/lib/prisma";

const policyParams = { min: PASSWORD_MIN_LENGTH, max: PASSWORD_MAX_LENGTH };

const localeToPrisma = (locale: string) => (locale === "fr" ? ("FR" as const) : ("EN" as const));

const registerSchema = z.object({
  name: z.string().trim().min(1).max(120),
  organization: z.string().trim().min(1).max(120),
  email: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(1024),
});

/** Open self-service sign-up: only available when AUTH_ALLOW_REGISTRATION=true. */
export async function registerAction(_previous: FormState, formData: FormData): Promise<FormState> {
  if (!registrationOpen()) return errorState("forbidden");
  const parsed = registerSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return errorState("required");

  const db = getPrisma();
  const locale = await getLocale();
  const { ip, userAgent } = await getRequestMeta();

  const user = await createUser(db, { email: parsed.data.email, name: parsed.data.name, password: parsed.data.password, locale: localeToPrisma(locale) });
  if (!user.ok) return errorState(user.error, policyParams);

  const org = await createOrganization(db, { name: parsed.data.organization, ownerUserId: user.value.id, ownerEmail: user.value.email, ip });
  await auditQuietly(db, { action: "auth.register", orgId: org.id, actorId: user.value.id, actorEmail: user.value.email, ipAddress: ip });

  const session = await createSession(db, { userId: user.value.id, ip, userAgent });
  await setSessionCookie(session.token, session.expiresAt);
  return redirect({ href: "/", locale });
}

const acceptSchema = z.object({
  token: z.string().min(1).max(256),
  name: z.string().trim().max(120).optional(),
  password: z.string().max(1024).optional(),
});

/**
 * Accept an invitation. New invitee: creates the account and signs them in. Existing account: the
 * person must ALREADY be signed in as that account (enforced in acceptInvitation).
 */
export async function acceptInvitationAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const parsed = acceptSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return errorState("required");

  const db = getPrisma();
  const locale = await getLocale();
  const { ip, userAgent } = await getRequestMeta();
  const current = await getSession();

  const result = await acceptInvitation(db, {
    token: parsed.data.token,
    ip,
    signedInUserId: current?.user.id ?? null,
    newAccount: parsed.data.password ? { name: parsed.data.name, password: parsed.data.password, locale: localeToPrisma(locale) } : undefined,
  });
  if (!result.ok) return errorState(result.error, policyParams);

  if (result.value.createdAccount) {
    const session = await createSession(db, { userId: result.value.userId, ip, userAgent });
    await setSessionCookie(session.token, session.expiresAt);
  } else if (current) {
    await setActiveOrg(db, current.sessionId, current.user.id, result.value.orgId);
  }
  return redirect({ href: "/", locale });
}
