import type { PrismaClient } from "@/generated/prisma/client";
import { decryptSecret, hostSecretAad } from "@/lib/crypto";
import { TelemetryHttpError } from "@/lib/telemetry/errors";
import { isTimestampFresh, parseSignatureHeader, verifySignature } from "@/lib/telemetry/signature";

/** The agent (= monitored host) that signed a request. */
export interface AuthenticatedAgent {
  hostId: string;
  orgId: string;
  hostname: string;
  keyId: string;
  firstSeenAt: Date | null;
  /**
   * The host's valid HMAC secret(s), to SIGN responses the agent must be able to trust (remediation
   * jobs). Never log, never serialize.
   */
  responseSecrets: readonly string[];
}

export interface AuthInput {
  keyId: string | null;
  signatureHeader: string | null;
  rawBody: string;
  nowMs: number;
  maxSkewSeconds: number;
}

/**
 * Placeholder secret verified against when the key id is unknown, so that "unknown key" and
 * "wrong signature" cost the same and return the same error (no key-id enumeration).
 */
const DUMMY_SECRET = "ikelyane-dummy-secret-for-constant-work";

const INVALID_SIGNATURE = () =>
  new TelemetryHttpError(401, "invalid_signature", "Signature verification failed.");

/**
 * Authenticate a telemetry request. Throws TelemetryHttpError (401/403) when it must be refused.
 *
 * Order matters:
 *  1. header presence/shape       → 401 (cheap, no database access)
 *  2. timestamp freshness         → 401 (cheap; blocks replays before any database access)
 *  3. host lookup by key id       → unknown key handled like a bad signature
 *  4. HMAC (current secret, and the previous one during a rotation grace period)
 *  5. host enabled?               → 403, only revealed to a correctly signed request
 */
export async function authenticateAgent(db: PrismaClient, input: AuthInput): Promise<AuthenticatedAgent> {
  if (!input.keyId) {
    throw new TelemetryHttpError(401, "missing_key_id", "The X-Ikelyane-Key-Id header is required.");
  }
  if (!input.signatureHeader) {
    throw new TelemetryHttpError(401, "missing_signature", "The X-Ikelyane-Signature header is required.");
  }
  const parsed = parseSignatureHeader(input.signatureHeader);
  if (!parsed) {
    throw new TelemetryHttpError(
      401,
      "malformed_signature",
      "X-Ikelyane-Signature must look like 't=<unix seconds>,v1=<hex hmac-sha256>'.",
    );
  }
  if (!isTimestampFresh(parsed.timestamp, input.nowMs, input.maxSkewSeconds)) {
    throw new TelemetryHttpError(
      401,
      "timestamp_out_of_tolerance",
      `The signed timestamp differs from server time by more than ${input.maxSkewSeconds} seconds. Check the agent's clock.`,
    );
  }

  const host = await db.monitoredHost.findUnique({
    where: { keyId: input.keyId },
    select: {
      id: true,
      orgId: true,
      hostname: true,
      keyId: true,
      enabled: true,
      firstSeenAt: true,
      hmacSecretEnc: true,
      previousHmacSecretEnc: true,
      previousSecretExpiresAt: true,
    },
  });

  if (!host) {
    verifySignature([DUMMY_SECRET], parsed, input.rawBody); // burn the same CPU as a real check
    throw INVALID_SIGNATURE();
  }

  const aad = hostSecretAad(host.keyId);
  const secrets = [decryptSecret(host.hmacSecretEnc, aad)];
  const previousStillValid =
    host.previousHmacSecretEnc && host.previousSecretExpiresAt && host.previousSecretExpiresAt.getTime() > input.nowMs;
  if (previousStillValid) secrets.push(decryptSecret(host.previousHmacSecretEnc as string, aad));

  if (!verifySignature(secrets, parsed, input.rawBody)) throw INVALID_SIGNATURE();

  if (!host.enabled) {
    throw new TelemetryHttpError(403, "host_disabled", "This host is disabled in IkelyaneMonitor.");
  }

  return {
    hostId: host.id,
    orgId: host.orgId,
    hostname: host.hostname,
    keyId: host.keyId,
    firstSeenAt: host.firstSeenAt,
    responseSecrets: secrets,
  };
}
