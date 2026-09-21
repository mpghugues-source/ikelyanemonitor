import "server-only";
import { cookies } from "next/headers";
import { sessionCookieName } from "@/lib/auth/constants";

/**
 * Cookies are only secure over HTTPS. Production is always behind TLS; `AUTH_COOKIE_SECURE=false`
 * exists solely to test a production build over plain http on localhost.
 */
export function cookiesAreSecure(): boolean {
  const override = process.env.AUTH_COOKIE_SECURE;
  if (override === "true") return true;
  if (override === "false") return false;
  return process.env.NODE_ENV === "production";
}

export async function readSessionToken(): Promise<string | null> {
  const jar = await cookies();
  return jar.get(sessionCookieName(cookiesAreSecure()))?.value ?? null;
}

/**
 * HttpOnly (invisible to JavaScript, so an XSS cannot steal it), SameSite=Lax (not sent on
 * cross-site POSTs: a first line of CSRF defence next to Server Actions' Origin check), Path=/ and
 * — over HTTPS — Secure with the `__Host-` prefix. The cookie's own expiry mirrors the session's.
 */
export async function setSessionCookie(token: string, expiresAt: Date): Promise<void> {
  const secure = cookiesAreSecure();
  (await cookies()).set(sessionCookieName(secure), token, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export async function clearSessionCookie(): Promise<void> {
  (await cookies()).delete(sessionCookieName(cookiesAreSecure()));
}
