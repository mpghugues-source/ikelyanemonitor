import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * TOTP (RFC 6238, built on HOTP / RFC 4226) — hand-rolled on Node's built-in `crypto`, the same
 * choice as scrypt password hashing (src/lib/auth/password.ts) and the telemetry HMAC signature:
 * the algorithm is compact and well specified, so a dependency buys little here. `qrcode` (a real
 * dependency) is used only for rendering, where hand-rolling would mean implementing Reed-Solomon
 * error correction — a completely different order of complexity.
 */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_SECONDS = 30;
const DIGITS = 6;
/** Accept the previous and next 30 s step too, so a little clock drift doesn't lock people out. */
const ALLOWED_DRIFT_STEPS = 1;

function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  return output;
}

function base32Decode(encoded: string): Buffer {
  const clean = encoded.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** A fresh random secret, base32-encoded for display and for the `otpauth://` URI. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

function hotp(secret: Buffer, counter: number): string {
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", secret).update(counterBuffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24) | ((digest[offset + 1] & 0xff) << 16) | ((digest[offset + 2] & 0xff) << 8) | (digest[offset + 3] & 0xff);
  return String(binary % 10 ** DIGITS).padStart(DIGITS, "0");
}

function currentStep(time: Date): number {
  return Math.floor(time.getTime() / 1000 / STEP_SECONDS);
}

/** For display during setup / for tests. Production verification always goes through `verifyTotpCode`. */
export function generateTotpCode(base32Secret: string, time: Date = new Date()): string {
  return hotp(base32Decode(base32Secret), currentStep(time));
}

/** Constant-time, tolerates ±1 step of clock drift. Malformed input verifies as false, never throws. */
export function verifyTotpCode(base32Secret: string, code: string, time: Date = new Date()): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const secret = base32Decode(base32Secret);
  const step = currentStep(time);
  const candidate = Buffer.from(code);
  for (let drift = -ALLOWED_DRIFT_STEPS; drift <= ALLOWED_DRIFT_STEPS; drift++) {
    if (timingSafeEqual(Buffer.from(hotp(secret, step + drift)), candidate)) return true;
  }
  return false;
}

/** The `otpauth://` URI an authenticator app scans (as a QR code) or accepts pasted in. */
export function totpUri(secret: string, email: string, issuer = "IkelyaneMonitor"): string {
  const label = encodeURIComponent(`${issuer}:${email}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: "SHA1", digits: String(DIGITS), period: String(STEP_SECONDS) });
  return `otpauth://totp/${label}?${params.toString()}`;
}

export const RECOVERY_CODE_COUNT = 10;

/** "XXXX-XXXX-XXXX-XXXX", base32 (no ambiguous 0/1 digits) — 80 bits of entropy per code. */
export function generateRecoveryCode(): string {
  const raw = base32Encode(randomBytes(10)).slice(0, 16);
  return raw.match(/.{1,4}/g)?.join("-") ?? raw;
}

export function generateRecoveryCodes(count: number = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => generateRecoveryCode());
}

/**
 * Canonical, dash-free, uppercased form — what actually gets hashed and compared (both when a code
 * is generated and stored, and when the user later types it back with or without the dashes, in
 * whatever case). Hashing anything other than this exact output would make a correctly-typed code
 * fail to match its stored hash.
 */
export function normalizeRecoveryCode(input: string): string {
  return input.trim().toUpperCase().replace(/[^A-Z2-7]/g, "");
}
