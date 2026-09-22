/**
 * Authentication constants. No imports: this file is safe to load from the proxy, server code and tests.
 */

/**
 * Session cookie names. Over HTTPS the `__Host-` prefix makes browsers refuse the cookie unless it
 * is Secure, has Path=/ and NO Domain attribute — so a sibling sub-domain cannot overwrite it.
 * Over plain HTTP (local development) the prefix is not allowed, hence the second name.
 */
export const SESSION_COOKIE_SECURE = "__Host-ikm_session";
export const SESSION_COOKIE_PLAIN = "ikm_session";

export function sessionCookieName(secure: boolean): string {
  return secure ? SESSION_COOKIE_SECURE : SESSION_COOKIE_PLAIN;
}

/** Holds a pending TotpChallenge token — a completely different cookie from the session one, so
 * the two can never be confused with each other by code that reads the wrong one. */
export const TOTP_COOKIE_SECURE = "__Host-ikm_totp";
export const TOTP_COOKIE_PLAIN = "ikm_totp";

export function totpCookieName(secure: boolean): string {
  return secure ? TOTP_COOKIE_SECURE : TOTP_COOKIE_PLAIN;
}

/** A session ends after this long without activity… */
export const SESSION_IDLE_SECONDS = 12 * 60 * 60;
/** …and, whatever the activity, this long after sign-in. */
export const SESSION_ABSOLUTE_SECONDS = 7 * 24 * 60 * 60;
/** The idle expiry is pushed forward at most this often (avoids a database write on every request). */
export const SESSION_REFRESH_INTERVAL_SECONDS = 5 * 60;

export const INVITATION_TTL_SECONDS = 7 * 24 * 60 * 60;

/** How long a password-verified, second-factor-pending challenge stays usable. */
export const TOTP_CHALLENGE_TTL_SECONDS = 5 * 60;
/** Wrong codes allowed against one challenge before it is thrown away (bounds brute force of a 6-digit code). */
export const TOTP_MAX_CHALLENGE_ATTEMPTS = 5;

/** Sign-in throttling: failures allowed per e-mail / per source address within the window. */
export const LOGIN_WINDOW_SECONDS = 15 * 60;
export const LOGIN_MAX_FAILURES_PER_EMAIL = 8;
export const LOGIN_MAX_FAILURES_PER_IP = 30;

/** Path prefixes (after the locale) reachable without a session. Used by the proxy. */
export const PUBLIC_PATH_PREFIXES = ["/login", "/register", "/invite", "/totp"] as const;

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;
