"use server";

import { getLocale } from "next-intl/server";
import { revalidatePath } from "next/cache";
import QRCode from "qrcode";
import { z } from "zod";
import { redirect } from "@/i18n/navigation";
import { auditQuietly } from "@/lib/auth/audit";
import { getRequestMeta, getSession } from "@/lib/auth/dal";
import { signIn } from "@/lib/auth/login";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@/lib/auth/constants";
import { safeNextPath } from "@/lib/auth/request";
import {
  clearSessionCookie,
  clearTotpChallengeCookie,
  readSessionToken,
  readTotpChallengeToken,
  setSessionCookie,
  setTotpChallengeCookie,
} from "@/lib/auth/session-cookie";
import { revokeSessionByToken, setActiveOrg } from "@/lib/auth/sessions";
import { confirmTotpSetup, disableTotp, regenerateRecoveryCodes, startTotpSetup, verifyTotpChallenge } from "@/lib/auth/two-factor";
import { changePassword, setUserLocale } from "@/lib/auth/users";
import { errorState, type FormState } from "@/lib/form-state";
import { getPrisma } from "@/lib/prisma";

const loginSchema = z.object({
  email: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(1024),
  next: z.string().max(512).optional(),
});

/**
 * Sign in. On a 2FA-off account this sets the session cookie and redirects to `next`. On a 2FA-on
 * account the password alone is not enough: a short-lived challenge cookie is set instead and the
 * browser is sent to /totp (itself carrying `next` along inside the challenge row — see
 * src/lib/auth/two-factor.ts createTotpChallenge). Either way this function never returns a
 * "success" FormState: it always redirects or reports an error.
 */
export async function loginAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const parsed = loginSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return errorState("required");

  const { ip, userAgent } = await getRequestMeta();
  const locale = await getLocale();
  const result = await signIn(getPrisma(), {
    email: parsed.data.email,
    password: parsed.data.password,
    ip,
    userAgent,
    nextPath: safeNextPath(parsed.data.next),
  });

  if (!result.ok) {
    if (result.error === "throttled") return errorState("throttled", { minutes: Math.max(1, Math.ceil(result.retryAfterSeconds / 60)) });
    if (result.error === "totp_required") {
      await setTotpChallengeCookie(result.challengeToken, result.expiresAt);
      return redirect({ href: "/totp", locale });
    }
    return errorState("invalid_credentials");
  }

  await setSessionCookie(result.token, result.expiresAt);
  // `next` is user-controlled input: only same-site paths are honoured (open-redirect protection).
  return redirect({ href: safeNextPath(parsed.data.next), locale });
}

const totpCodeSchema = z.object({ code: z.string().trim().min(1).max(64) });

/** Second step of a 2FA sign-in: verify the code against the challenge cookie, never form input. */
export async function verifyTotpAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const challengeToken = await readTotpChallengeToken();
  if (!challengeToken) return errorState("totp_challenge_expired");

  const parsed = totpCodeSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return errorState("required");

  const { ip, userAgent } = await getRequestMeta();
  const result = await verifyTotpChallenge(getPrisma(), { token: challengeToken, code: parsed.data.code, ip, userAgent });
  if (!result.ok) {
    if (result.error !== "invalid_code") await clearTotpChallengeCookie();
    return errorState(result.error);
  }

  await clearTotpChallengeCookie();
  await setSessionCookie(result.value.token, result.value.expiresAt);
  return redirect({ href: safeNextPath(result.value.nextPath ?? undefined), locale: await getLocale() });
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

// ── Two-factor authentication (settings > profile) ──────────────────────────────────────────────

export interface TotpSetupData {
  secret: string;
  otpauthUri: string;
  /** Rendered server-side (the `qrcode` package): the secret never needs to leave the server as a
   * request to a third-party QR-image API, which would otherwise leak it in transit. */
  qrDataUrl: string;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- signature fixed by ActionForm's action prop; startTotpSetup needs no form input (see getSession() below).
export async function startTotpSetupAction(_previous: FormState<TotpSetupData>, _formData: FormData): Promise<FormState<TotpSetupData>> {
  const session = await getSession();
  if (!session) return errorState("unauthenticated");
  const setup = await startTotpSetup(getPrisma(), session.user.id, session.user.email);
  const qrDataUrl = await QRCode.toDataURL(setup.otpauthUri, { margin: 1, width: 240 });
  return { status: "success", data: { ...setup, qrDataUrl } };
}

const totpConfirmSchema = z.object({ code: z.string().trim().min(1).max(64) });

export async function confirmTotpSetupAction(_previous: FormState<{ recoveryCodes: string[] }>, formData: FormData): Promise<FormState<{ recoveryCodes: string[] }>> {
  const session = await getSession();
  if (!session) return errorState("unauthenticated");
  const parsed = totpConfirmSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return errorState("required");

  const result = await confirmTotpSetup(getPrisma(), session.user.id, parsed.data.code);
  if (!result.ok) return errorState(result.error);
  revalidatePath("/", "layout");
  return { status: "success", data: result.value };
}

const totpPasswordSchema = z.object({ password: z.string().min(1).max(1024) });

export async function disableTotpAction(_previous: FormState, formData: FormData): Promise<FormState> {
  const session = await getSession();
  if (!session) return errorState("unauthenticated");
  const parsed = totpPasswordSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return errorState("required");

  const { ip } = await getRequestMeta();
  const result = await disableTotp(getPrisma(), { userId: session.user.id, password: parsed.data.password, ip });
  if (!result.ok) return errorState(result.error);
  revalidatePath("/", "layout");
  return { status: "success" };
}

export async function regenerateRecoveryCodesAction(
  _previous: FormState<{ recoveryCodes: string[] }>,
  formData: FormData,
): Promise<FormState<{ recoveryCodes: string[] }>> {
  const session = await getSession();
  if (!session) return errorState("unauthenticated");
  const parsed = totpPasswordSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return errorState("required");

  const { ip } = await getRequestMeta();
  const result = await regenerateRecoveryCodes(getPrisma(), { userId: session.user.id, password: parsed.data.password, ip });
  if (!result.ok) return errorState(result.error);
  return { status: "success", data: result.value };
}
