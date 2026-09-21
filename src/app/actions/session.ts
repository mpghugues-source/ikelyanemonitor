"use server";

import { getLocale } from "next-intl/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { redirect } from "@/i18n/navigation";
import { auditQuietly } from "@/lib/auth/audit";
import { getRequestMeta, getSession } from "@/lib/auth/dal";
import { signIn } from "@/lib/auth/login";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@/lib/auth/constants";
import { safeNextPath } from "@/lib/auth/request";
import { clearSessionCookie, readSessionToken, setSessionCookie } from "@/lib/auth/session-cookie";
import { revokeSessionByToken, setActiveOrg } from "@/lib/auth/sessions";
import { changePassword, setUserLocale } from "@/lib/auth/users";
import { errorState, type FormState } from "@/lib/form-state";
import { getPrisma } from "@/lib/prisma";

const loginSchema = z.object({
  email: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(1024),
  next: z.string().max(512).optional(),
});

/** Sign in. On success sets the session cookie and redirects (this function then never returns). */
export async function loginAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const parsed = loginSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return errorState("required");

  const { ip, userAgent } = await getRequestMeta();
  const result = await signIn(getPrisma(), { email: parsed.data.email, password: parsed.data.password, ip, userAgent });

  if (!result.ok) {
    if (result.error === "throttled") return errorState("throttled", { minutes: Math.max(1, Math.ceil(result.retryAfterSeconds / 60)) });
    return errorState("invalid_credentials");
  }

  await setSessionCookie(result.token, result.expiresAt);
  // `next` is user-controlled input: only same-site paths are honoured (open-redirect protection).
  return redirect({ href: safeNextPath(parsed.data.next), locale: await getLocale() });
}

export async function logoutAction(): Promise<void> {
  const token = await readSessionToken();
  const session = await getSession();
  if (token) await revokeSessionByToken(getPrisma(), token);
  if (session) {
    const { ip } = await getRequestMeta();
    await auditQuietly(getPrisma(), {
      action: "auth.logout",
      orgId: session.activeOrg?.orgId,
      actorId: session.user.id,
      actorEmail: session.user.email,
      ipAddress: ip,
    });
  }
  await clearSessionCookie();
  return redirect({ href: "/login", locale: await getLocale() });
}

/** Switch the working organization; only organizations the user belongs to are accepted. */
export async function switchOrganizationAction(formData: FormData): Promise<void> {
  const session = await getSession();
  const orgId = z.string().min(1).max(64).safeParse(formData.get("orgId"));
  if (session && orgId.success) {
    await setActiveOrg(getPrisma(), session.sessionId, session.user.id, orgId.data);
  }
  revalidatePath("/", "layout");
  return redirect({ href: "/", locale: await getLocale() });
}

/** Remember the language chosen with the switcher, for signed-in users. Best effort, no result. */
export async function setLocalePreferenceAction(locale: string): Promise<void> {
  const parsed = z.enum(["en", "fr"]).safeParse(locale);
  const session = await getSession();
  if (!parsed.success || !session) return;
  await setUserLocale(getPrisma(), session.user.id, parsed.data === "fr" ? "FR" : "EN");
}

const passwordSchema = z.object({
  currentPassword: z.string().min(1).max(1024),
  newPassword: z.string().min(1).max(1024),
});

export async function changePasswordAction(_previous: FormState<{ revokedSessions: number }>, formData: FormData): Promise<FormState<{ revokedSessions: number }>> {
  const session = await getSession();
  if (!session) return errorState("unauthenticated");
  const parsed = passwordSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return errorState("required");

  const { ip } = await getRequestMeta();
  const result = await changePassword(getPrisma(), {
    userId: session.user.id,
    currentPassword: parsed.data.currentPassword,
    newPassword: parsed.data.newPassword,
    keepSessionId: session.sessionId,
    ip,
  });
  if (!result.ok) return errorState(result.error, { min: PASSWORD_MIN_LENGTH, max: PASSWORD_MAX_LENGTH });
  return { status: "success", data: result.value, params: { count: result.value.revokedSessions } };
}
