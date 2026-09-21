import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@/lib/auth/constants";

/**
 * Password hashing with scrypt (Node's built-in implementation: no native dependency to install).
 *
 * Stored format:  scrypt$<N>$<r>$<p>$<salt base64>$<hash base64>
 * The cost parameters are stored WITH each hash, so they can be raised later: `needsRehash`
 * tells the sign-in code to silently upgrade a hash made with weaker parameters.
 *
 * Parameters: N=2^15, r=8, p=3 — one of the OWASP-recommended equivalent scrypt configurations
 * (32 MiB, roughly a couple of hundred milliseconds on a modern core).
 */
const PARAMS = { N: 2 ** 15, r: 8, p: 3, keylen: 32 } as const;
const SALT_BYTES = 16;
const MAX_MEMORY = 256 * 1024 * 1024;

interface ScryptParams {
  N: number;
  r: number;
  p: number;
  keylen: number;
}

function derive(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // NFKC: visually identical passwords typed on different keyboards/OSes hash identically.
    scryptCallback(
      password.normalize("NFKC"),
      salt,
      params.keylen,
      { N: params.N, r: params.r, p: params.p, maxmem: MAX_MEMORY },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await derive(password, salt, PARAMS);
  return ["scrypt", PARAMS.N, PARAMS.r, PARAMS.p, salt.toString("base64"), hash.toString("base64")].join("$");
}

function parse(stored: string): { params: ScryptParams; salt: Buffer; hash: Buffer } | null {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const [N, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  // Refuse absurd parameters from a corrupted/hostile row: they would exhaust memory or CPU.
  if (![N, r, p].every(Number.isInteger) || N < 2 ** 12 || N > 2 ** 20 || r < 1 || r > 32 || p < 1 || p > 16) return null;
  const salt = Buffer.from(parts[4], "base64");
  const hash = Buffer.from(parts[5], "base64");
  if (salt.length < 8 || hash.length < 16) return null;
  return { params: { N, r, p, keylen: hash.length }, salt, hash };
}

/** Constant-time verification. Malformed or unsupported hashes verify as false, never throw. */
export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false;
  const parsed = parse(stored);
  if (!parsed) return false;
  const candidate = await derive(password, parsed.salt, parsed.params);
  return candidate.length === parsed.hash.length && timingSafeEqual(candidate, parsed.hash);
}

/** True when `stored` was made with weaker parameters than today's (re-hash at the next sign-in). */
export function needsRehash(stored: string): boolean {
  const parsed = parse(stored);
  if (!parsed) return true;
  const { N, r, p } = parsed.params;
  return N < PARAMS.N || r < PARAMS.r || p < PARAMS.p;
}

let dummyHash: Promise<string> | undefined;

/**
 * Burn the same CPU as a real verification when the account does not exist, so that response time
 * does not reveal which e-mail addresses are registered.
 */
export async function verifyAgainstDummy(password: string): Promise<false> {
  dummyHash ??= hashPassword("ikelyane-dummy-password-for-constant-work");
  await verifyPassword(password, await dummyHash);
  return false;
}

// ── Policy ────────────────────────────────────────────────────────────────────────────────────

export type PasswordPolicyResult =
  | { ok: true }
  | { ok: false; code: "too_short" | "too_long" | "common" | "contains_email" | "repetitive" };

// A short list of the most common choices — a floor, not a substitute for a breached-password check.
const COMMON = new Set([
  "password", "passw0rd", "password1", "password123", "123456789012", "1234567890123", "qwertyuiop12",
  "azertyuiop12", "azerty123456", "qwerty123456", "letmein12345", "welcome12345", "administrator",
  "iloveyou1234", "changeme1234", "motdepasse12", "motdepasse123", "abc123456789", "monitoring12",
  "ikelyanemonitor", "adminadmin12", "admin1234567", "1q2w3e4r5t6y", "0123456789ab",
]);

export function validatePasswordPolicy(password: string, context: { email?: string } = {}): PasswordPolicyResult {
  if ([...password].length < PASSWORD_MIN_LENGTH) return { ok: false, code: "too_short" };
  if (password.length > PASSWORD_MAX_LENGTH) return { ok: false, code: "too_long" };

  const flattened = password.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (COMMON.has(password.toLowerCase()) || COMMON.has(flattened)) return { ok: false, code: "common" };

  // "aaaaaaaaaaaa", "121212121212", "abcdefghijkl"…
  const distinct = new Set(password.toLowerCase()).size;
  if (distinct <= 3) return { ok: false, code: "repetitive" };

  const local = context.email?.split("@")[0]?.toLowerCase();
  if (local && local.length >= 4 && password.toLowerCase().includes(local)) return { ok: false, code: "contains_email" };

  return { ok: true };
}
