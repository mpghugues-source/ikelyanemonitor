/**
 * Stable failure codes of a synthetic check, stored in EndpointCheck.lastError and translated by the UI
 * (`saas.checkError.*`). Kept apart from probe.ts, which imports Node builtins, so UI code can import
 * these values without pulling node:http into a bundle.
 */
export const PROBE_ERROR_CODES = [
  "invalid_url",
  "blocked_target",
  "dns",
  "connection",
  "tls",
  "timeout",
  "too_many_redirects",
  "status_mismatch",
  "body_mismatch",
] as const;

export type ProbeErrorCode = (typeof PROBE_ERROR_CODES)[number];
