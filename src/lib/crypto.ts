import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { getEnv } from "@/lib/env";

/**
 * Encryption at rest for secrets stored in the database (agent HMAC secrets, SNMP community
 * strings and v3 keys).
 *
 * Format: `v1:<iv>:<auth tag>:<ciphertext>` (base64url), AES-256-GCM, 96-bit random IV.
 *
 * `aad` (additional authenticated data) binds a ciphertext to its owner, e.g. `host:<keyId>`: a
 * ciphertext copied onto another row fails authentication instead of silently decrypting.
 * The prefix `v1` leaves room for key rotation / algorithm changes.
 */
const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;

function masterKey(): Buffer {
  return Buffer.from(getEnv().IKELYANE_SECRET_KEY, "base64");
}

export function encryptSecret(plaintext: string, aad: string, key: Buffer = masterKey()): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(":");
}

export function decryptSecret(payload: string, aad: string, key: Buffer = masterKey()): string {
  const [version, iv, tag, ciphertext, ...rest] = payload.split(":");
  if (version !== VERSION || !iv || !tag || ciphertext === undefined || rest.length > 0) {
    throw new Error("Unsupported or malformed encrypted secret");
  }
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, "base64url"));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
}

/** AAD used for the HMAC secret of an agent key. */
export const hostSecretAad = (keyId: string): string => `host:${keyId}`;

/** AAD used for a user's TOTP secret. */
export const totpSecretAad = (userId: string): string => `user:${userId}:totp`;

/**
 * Credentials for a new agent. `keyId` is public (sent in a header, like an access-key id);
 * `secret` is shown to the operator ONCE and stored only encrypted.
 */
export function generateAgentCredentials(): { keyId: string; secret: string } {
  return {
    keyId: `ikm_${randomBytes(18).toString("base64url")}`,
    secret: randomBytes(32).toString("base64url"),
  };
}
