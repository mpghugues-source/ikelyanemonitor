import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, generateAgentCredentials, hostSecretAad } from "@/lib/crypto";

const KEY = randomBytes(32);

describe("encryptSecret / decryptSecret (AES-256-GCM)", () => {
  it("round-trips, including non-ASCII", () => {
    for (const secret of ["hunter2", "clé-secrète-🔐", "x".repeat(10_000)]) {
      expect(decryptSecret(encryptSecret(secret, "aad", KEY), "aad", KEY)).toBe(secret);
    }
  });

  it("uses a fresh IV each time: the same secret never encrypts to the same text", () => {
    expect(encryptSecret("same", "aad", KEY)).not.toBe(encryptSecret("same", "aad", KEY));
  });

  it("has the documented format v1:iv:tag:ciphertext and never contains the plaintext", () => {
    const encrypted = encryptSecret("plaintext-secret-value", "aad", KEY);
    expect(encrypted.split(":")).toHaveLength(4);
    expect(encrypted.startsWith("v1:")).toBe(true);
    expect(encrypted).not.toContain("plaintext-secret-value");
  });

  it("refuses a ciphertext moved to another owner (AAD binding)", () => {
    const encrypted = encryptSecret("secret", hostSecretAad("ikm_A"), KEY);
    expect(() => decryptSecret(encrypted, hostSecretAad("ikm_B"), KEY)).toThrow();
  });

  it("refuses a tampered ciphertext or tag (authenticated encryption)", () => {
    const [v, iv, tag, ct] = encryptSecret("secret", "aad", KEY).split(":");
    const flip = (s: string) => (s[0] === "A" ? "B" : "A") + s.slice(1);
    expect(() => decryptSecret([v, iv, tag, flip(ct)].join(":"), "aad", KEY)).toThrow();
    expect(() => decryptSecret([v, iv, flip(tag), ct].join(":"), "aad", KEY)).toThrow();
  });

  it("refuses the wrong master key", () => {
    const encrypted = encryptSecret("secret", "aad", KEY);
    expect(() => decryptSecret(encrypted, "aad", randomBytes(32))).toThrow();
  });

  it.each(["", "garbage", "v2:a:b:c", "v1:a:b", "v1:a:b:c:d"])("refuses malformed input %j", (payload) => {
    expect(() => decryptSecret(payload, "aad", KEY)).toThrow();
  });
});

describe("generateAgentCredentials", () => {
  it("returns a public key id and a long random secret", () => {
    const { keyId, secret } = generateAgentCredentials();
    expect(keyId).toMatch(/^ikm_[A-Za-z0-9_-]{24}$/);
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 random bytes, base64url
  });

  it("never repeats", () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateAgentCredentials().keyId));
    expect(seen.size).toBe(200);
  });
});
