import "server-only";
import { getLocale } from "next-intl/server";
import { headers } from "next/headers";
import { cache } from "react";
import { redirect } from "@/i18n/navigation";
import type { Actor } from "@/lib/auth/db";
import { can, type Permission } from "@/lib/auth/permissions";
import { clientIpFromHeaders } from "@/lib/auth/request";
import { readSessionToken } from "@/lib/auth/session-cookie";
import { validateSession, type SessionContext } from "@/lib/auth/sessions";
import { getPrisma } from "@/lib/prisma";
import { fail, ok, type Result } from "@/lib/result";

/**
 * Data Access Layer for authentication — the ONLY place that turns a cookie into an identity.
 *
 * Every page and every Server Action calls into here. Layouts are NOT a security boundary (Next.js
 * does not re-render them on client-side navigation, and they do not gate the pages below them),
 * so authorization is checked next to the data it protects, never only in a layout.
 */

/** Behind Apache the socket peer is the proxy: read the client from X-Forwarded-For. */
function trustProxyHeaders(): boolean {
  return process.env.AUTH_TRUST_PROXY_HEADERS !== "false";
}

export async function getRequestMeta(): Promise<{ ip: string | null; userAgent: string | null }> {
  const h = await headers();
  return {
    ip: clientIpFromHeaders(h.get("x-forwarded-for"), trustProxyHeaders()),
    userAgent: h.get("user-agent"),
  };
}

/**
 * Public base URL of the application, used to build links that leave the app (invitations).
 * Set APP_BASE_URL in production. The fallback rebuilds it from the request headers, which a
 * reverse proxy must forward (ProxyPreserveHost / X-Forwarded-Proto).
 */
export async function getBaseUrl(): Promise<string> {
  const configured = process.env.APP_BASE_URL?.trim().replace(/\/+$/, "");
  if (configured) return configured;
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (/^(localhost|127\.0\.0\.1)/.test(host) ? "http" : "https");
  return `${proto}://${host}`;
}

/** Whether people may create their own account + organization (default: closed, invitation only). */
export function registrationOpen(): boolean {
  return process.env.AUTH_ALLOW_REGISTRATION === "true";
}

/** The current session, validated against the database. Memoized for the duration of one request. */
export const getSession = cache(async (): Promise<SessionContext | null> => {
  const token = await readSessionToken();
  if (!token) return null;
  return validateSession(getPrisma(), token);
});

export interface ActorContext {
  session: SessionContext;
  actor: Actor;
}

export type AuthorizationError = "unauthenticated" | "no_organization" | "forbidden";

/**
 * Who is calling, in which organization, with which role — or why not. Never redirects, so Server
 * Actions can turn the error into a form message. `permission` is checked against the role the
 * user holds in the ACTIVE organization, as stored in the database right now.
 */
export async function authorize(permission?: Permission): Promise<Result<ActorContext, AuthorizationError>> {
  const session = await getSession();
  if (!session) return fail("unauthenticated");
  if (!session.activeOrg) return fail("no_organization");
  if (permission && !can(session.activeOrg.role, permission)) return fail("forbidden");

  const { ip } = await getRequestMeta();
  return ok({
    session,
    actor: {
      userId: session.user.id,
      email: session.user.email,
      orgId: session.activeOrg.orgId,
      role: session.activeOrg.role,
      ip,
    },
  });
}

/** For pages: redirect (localized) instead of returning an error. */
export async function requireActor(permission?: Permission): Promise<ActorContext> {
  const result = await authorize(permission);
  if (result.ok) return result.value;

  const locale = await getLocale();
  const href = { unauthenticated: "/login", no_organization: "/no-organization", forbidden: "/forbidden" }[result.error];
  return redirect({ href, locale });
}

/** For pages that need a signed-in user but not necessarily an organization (e.g. profile). */
export async function requireSession(): Promise<SessionContext> {
  const session = await getSession();
  if (session) return session;
  return redirect({ href: "/login", locale: await getLocale() });
}
