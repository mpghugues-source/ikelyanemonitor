import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Request signing for the telemetry API.
 *
 *   X-Ikelyane-Key-Id:     ikm_xxxxxxxxxxxxxxxxxxxxxxxx          (public identifier of the agent key)
 *   X-Ikelyane-Signature:  t=<unix seconds>,v1=<hex>
 *
 *   v1 = HMAC-SHA256(key = secret (UTF-8 bytes of the secret string),
 *                    message = "<t>.<raw request body>")
 *
 * Signing the timestamp together with the body means a captured request cannot be replayed later
 * (the server rejects timestamps outside the tolerance window) and cannot be re-targeted with a
 * different timestamp. Several `v1=` values may be present (an agent may sign with both the new and
 * the previous secret during a rotation); the request is accepted if ANY of them verifies.
 */

export const KEY_ID_HEADER = "x-ikelyane-key-id";
export const SIGNATURE_HEADER = "x-ikelyane-signature";

export interface ParsedSignature {
  /** Unix time in seconds, as signed by the agent. */
  timestamp: number;
  /** Lower-case hex HMACs (64 characters each). */
  signatures: string[];
}

const HEX_SHA256 = /^[0-9a-f]{64}$/;

export function parseSignatureHeader(header: string | null): ParsedSignature | null {
  if (!header || header.length > 512) return null;

  let timestamp: number | undefined;
  const signatures: string[] = [];

  for (const part of header.split(",")) {
    const separator = part.indexOf("=");
    if (separator < 0) return null;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();

    if (name === "t") {
      if (!/^\d{9,12}$/.test(value)) return null;
      timestamp = Number(value);
    } else if (name === "v1") {
      const hex = value.toLowerCase();
      if (!HEX_SHA256.test(hex)) return null;
      signatures.push(hex);
    }
    // Unknown scheme versions (v2=…) are ignored on purpose: forward compatibility.
  }

  if (timestamp === undefined || signatures.length === 0 || signatures.length > 4) return null;
  return { timestamp, signatures };
}

/** The signature an agent must send. Exported so agents' reference code and tests share it. */
export function computeSignature(secret: string, timestamp: number, rawBody: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest("hex");
}

/** Constant-time check of the provided signatures against every candidate secret. */
export function verifySignature(secrets: readonly string[], parsed: ParsedSignature, rawBody: string): boolean {
  let valid = false;
  for (const secret of secrets) {
    const expected = Buffer.from(computeSignature(secret, parsed.timestamp, rawBody), "hex");
    for (const candidate of parsed.signatures) {
      // Both are 32 bytes (candidate validated as 64 hex chars), so timingSafeEqual never throws.
      // No early exit: the loop cost does not depend on which value matched.
      if (timingSafeEqual(expected, Buffer.from(candidate, "hex"))) valid = true;
    }
  }
  return valid;
}

export function isTimestampFresh(timestampSeconds: number, nowMs: number, maxSkewSeconds: number): boolean {
  return Math.abs(nowMs / 1000 - timestampSeconds) <= maxSkewSeconds;
}

/**
 * Signature header for a RESPONSE the agent must be able to trust (remediation jobs): same scheme as
 * requests, one `v1=` per valid host secret so an agent mid-rotation verifies with whichever it holds.
 * Protects against anything between the agent and the platform that is not the platform (a TLS
 * interception proxy, a mistyped plain-http URL), not against a compromised platform — that is what the
 * agent's local remediation policy is for.
 */
export function signResponse(secrets: readonly string[], rawBody: string, nowMs: number): string {
  const t = Math.floor(nowMs / 1000);
  return [`t=${t}`, ...secrets.map((secret) => `v1=${computeSignature(secret, t, rawBody)}`)].join(",");
}
