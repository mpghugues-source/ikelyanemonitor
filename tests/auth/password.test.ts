import { describe, expect, it } from "vitest";
import {
  hashPassword,
  needsRehash,
  validatePasswordPolicy,
  verifyAgainstDummy,
  verifyPassword,
} from "@/lib/auth/password";

const PW = "correct horse battery staple";

describe("password hashing (scrypt)", () => {
  it("verifies the right password and rejects a wrong one", async () => {
    const hash = await hashPassword(PW);
    expect(await verifyPassword(PW, hash)).toBe(true);
    expect(await verifyPassword(PW + "x", hash)).toBe(false);
    expect(await verifyPassword("", hash)).toBe(false);
  });

  it("stores the cost parameters and a random salt: same password, different hash", async () => {
    const [a, b] = await Promise.all([hashPassword(PW), hashPassword(PW)]);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^scrypt\$32768\$8\$3\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(a).not.toContain(PW);
  });

  it("treats visually identical Unicode forms as the same password (NFKC)", async () => {
    const composed = "caf\u00e9-secret-phrase"; // é as ONE code point
    const decomposed = "cafe\u0301-secret-phrase"; // e + COMBINING acute accent (different bytes)
    expect(composed).not.toBe(decomposed);
    const hash = await hashPassword(composed);
    expect(await verifyPassword(decomposed, hash)).toBe(true);
  });

  it("handles long and non-ASCII passwords", async () => {
    const long = "🔐пароль-".repeat(14); // 112 characters
    expect(await verifyPassword(long, await hashPassword(long))).toBe(true);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["empty", ""],
    ["garbage", "not-a-hash"],
    ["wrong scheme", "bcrypt$10$abc$def$ghi$jkl"],
    ["missing parts", "scrypt$32768$8$3$c2FsdA=="],
    ["absurd memory cost", "scrypt$1073741824$8$3$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2g="],
    ["zero parallelism", "scrypt$32768$8$0$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2g="],
    ["non-numeric cost", "scrypt$abc$8$3$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2g="],
  ])("a malformed stored hash (%s) verifies as false and never throws", async (_name, stored) => {
    await expect(verifyPassword(PW, stored as string | null | undefined)).resolves.toBe(false);
  });

  it("a tampered hash does not verify", async () => {
    const hash = await hashPassword(PW);
    const parts = hash.split("$");
    const flipped = Buffer.from(parts[5], "base64");
    flipped[0] ^= 0xff;
    parts[5] = flipped.toString("base64");
    expect(await verifyPassword(PW, parts.join("$"))).toBe(false);
  });

  it("flags weaker hashes for an upgrade at the next sign-in", async () => {
    expect(needsRehash(await hashPassword(PW))).toBe(false);
    expect(needsRehash("scrypt$16384$8$1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2g=")).toBe(true);
    expect(needsRehash("garbage")).toBe(true);
  });

  it("the dummy verification (unknown account) always returns false", async () => {
    await expect(verifyAgainstDummy(PW)).resolves.toBe(false);
  });

  it("costs a realistic amount of work (guards against accidentally weakening the parameters)", async () => {
    const start = performance.now();
    await hashPassword(PW);
    const ms = performance.now() - start;
    expect(ms).toBeGreaterThan(40); // far too fast would mean the cost was lowered
    expect(ms).toBeLessThan(5000);
  });
});

describe("password policy", () => {
  it("accepts a long passphrase and a strong random password", () => {
    expect(validatePasswordPolicy("correct horse battery staple")).toEqual({ ok: true });
    expect(validatePasswordPolicy("X7#kq9!Lm2$vRt8w")).toEqual({ ok: true });
  });

  it("requires at least 12 characters (counting characters, not bytes)", () => {
    expect(validatePasswordPolicy("Short1!")).toEqual({ ok: false, code: "too_short" });
    expect(validatePasswordPolicy("a1B2c3D4e5F")).toEqual({ ok: false, code: "too_short" }); // 11
    expect(validatePasswordPolicy("a1B2c3D4e5F6")).toEqual({ ok: true }); // 12
    expect(validatePasswordPolicy("🔐".repeat(6))).toEqual({ ok: false, code: "too_short" }); // 6 characters, 24 bytes
  });

  it("rejects passwords over 128 characters (prevents hashing-based denial of service)", () => {
    expect(validatePasswordPolicy("a1B2".repeat(33))).toEqual({ ok: false, code: "too_long" });
  });

  it("rejects the most common passwords, ignoring case and punctuation", () => {
    expect(validatePasswordPolicy("Password123")).toEqual({ ok: false, code: "too_short" });
    expect(validatePasswordPolicy("motdepasse123")).toEqual({ ok: false, code: "common" });
    expect(validatePasswordPolicy("Mot-De-Passe-123")).toEqual({ ok: false, code: "common" });
    expect(validatePasswordPolicy("IkelyaneMonitor")).toEqual({ ok: false, code: "common" });
  });

  it("rejects trivially repetitive passwords", () => {
    expect(validatePasswordPolicy("aaaaaaaaaaaa")).toEqual({ ok: false, code: "repetitive" });
    expect(validatePasswordPolicy("121212121212")).toEqual({ ok: false, code: "repetitive" });
  });

  it("rejects a password that contains the account's e-mail name", () => {
    expect(validatePasswordPolicy("marie.dupont-2026!", { email: "marie.dupont@example.com" })).toEqual({
      ok: false,
      code: "contains_email",
    });
    // Short local parts are ignored (they would match by chance).
    expect(validatePasswordPolicy("abc-long-secret-phrase", { email: "abc@example.com" })).toEqual({ ok: true });
  });
});
