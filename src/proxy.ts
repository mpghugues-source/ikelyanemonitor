import createMiddleware from "next-intl/middleware";
import { NextResponse, type NextRequest } from "next/server";
import { PUBLIC_PATH_PREFIXES, SESSION_COOKIE_PLAIN, SESSION_COOKIE_SECURE } from "@/lib/auth/constants";
import { routing } from "@/i18n/routing";

/**
 * Next.js 16 renamed `middleware` to `proxy`. Two jobs, in this order:
 *  1. language negotiation (next-intl): "/" and unprefixed paths become /en or /fr;
 *  2. an OPTIMISTIC sign-in check: a page that needs a session and has no session cookie at all is
 *     redirected to the login page, remembering where the person was going.
 *
 * "Optimistic" is deliberate: the proxy only looks whether the cookie EXISTS (it runs on every
 * request, prefetches included, so it must stay cheap and never query the database). Whether the
 * session is genuinely valid, and what the user may do, is decided by the Data Access Layer
 * (src/lib/auth/dal.ts) in every page and Server Action. Never rely on this file alone.
 */
const intl = createMiddleware(routing);
const LOCALE_PREFIX = new RegExp(`^/(${routing.locales.join("|")})(?=/|$)`);

export default function proxy(request: NextRequest) {
  const response = intl(request);

  // A locale redirect ("/" -> "/en") is final: the next request will come back prefixed.
  if (response.headers.has("location")) return response;

  const { pathname, search } = request.nextUrl;
  const match = LOCALE_PREFIX.exec(pathname);
  if (!match) return response;

  const locale = match[1];
  const path = pathname.slice(match[0].length) || "/";
  const isPublic = PUBLIC_PATH_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
  if (isPublic) return response;

  const hasSessionCookie = request.cookies.has(SESSION_COOKIE_SECURE) || request.cookies.has(SESSION_COOKIE_PLAIN);
  if (hasSessionCookie) return response;

  const login = new URL(`/${locale}/login`, request.nextUrl.origin);
  login.searchParams.set("next", `${path}${search}`);
  return NextResponse.redirect(login);
}

export const config = {
  // Everything EXCEPT the API (agents must never be redirected), Next internals and static files.
  matcher: "/((?!api|_next|_vercel|.*\\..*).*)",
};
