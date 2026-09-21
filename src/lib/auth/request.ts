/**
 * Small helpers that read request metadata. Pure (take plain values), so they are unit-testable.
 */

/**
 * Only same-site relative paths may be used as a post-login destination. Anything else
 * ("https://evil.example", "//evil.example", "/\\evil.example", "javascript:…") would turn the
 * sign-in page into an open redirect used for phishing.
 */
export function safeNextPath(value: string | null | undefined, fallback = "/"): string {
  if (!value || value.length > 512) return fallback;
  if (!value.startsWith("/")) return fallback;
  if (value.startsWith("//") || value.startsWith("/\\")) return fallback;
  // Control characters (incl. CR/LF, which enable header injection) and backslashes are refused.
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return fallback;
  return value;
}

/**
 * Client address for throttling and audit.
 *
 * Behind a reverse proxy (Apache here) the TCP peer is the proxy; the real client is the entry the
 * proxy appended to X-Forwarded-For — the LAST one. Earlier entries are supplied by the client and
 * can be forged, so they are ignored. When the header is absent the address is unknown (null).
 */
export function clientIpFromHeaders(forwardedFor: string | null | undefined, trustProxy: boolean): string | null {
  if (!trustProxy || !forwardedFor) return null;
  const last = forwardedFor.split(",").at(-1)?.trim();
  if (!last || last.length > 45) return null; // longest IPv6 text form
  return /^[0-9a-fA-F:.]+$/.test(last) ? last : null;
}

/** Trimmed, lower-cased e-mail — the canonical form used for lookups, uniqueness and throttling. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
