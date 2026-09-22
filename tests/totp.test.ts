import { describe, expect, it } from "vitest";
import {
  generateRecoveryCode,
  generateRecoveryCodes,
  generateTotpCode,
  generateTotpSecret,
  normalizeRecoveryCode,
  totpUri,
  verifyTotpCode,
} from "@/lib/auth/totp";

// base32("12345678901234567890"), the seed from RFC 6238 Appendix B — the expected codes below are
// the last 6 digits of the RFC's published 8-digit test vectors (the truncation formula computes
// `binary % 10**digits`, so the 6-digit code is always `eightDigitCode % 1_000_000`), independently
// re-derived with Python's stdlib hmac/hashlib rather than copied, as a real cross-check of the
// hand-rolled algorithm against the RFC reference — not just self-consistency.
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("TOTP — RFC 6238 test vectors", () => {
  it.each([
    [59, "287082"],
    [1111111109, "081804"],
    [1234567890, "005924"],
  ])("T=%i -> %s", (unixSeconds, expected) => {
    const time = new Date(unixSeconds * 1000);
    expect(generateTotpCode(RFC_SECRET, time)).toBe(expected);
    expect(verifyTotpCode(RFC_SECRET, expected, time)).toBe(true);
  });
});

describe("verifyTotpCode", () => {
  it("rejects a wrong code, an empty string, and anything not exactly 6 digits", () => {
    const time = new Date(59_000);
    expect(verifyTotpCode(RFC_SECRET, "000000", time)).toBe(false);
    expect(verifyTotpCode(RFC_SECRET, "", time)).toBe(false);
    expect(verifyTotpCode(RFC_SECRET, "12345", time)).toBe(false);
    expect(verifyTotpCode(RFC_SECRET, "1234567", time)).toBe(false);
    expect(verifyTotpCode(RFC_SECRET, "28708a", time)).toBe(false);
  });

  it("tolerates one 30s step of clock drift either way, but not two", () => {
    const t0 = new Date(1_111_111_109_000); // counter 37037036
    const codeAtT0 = generateTotpCode(RFC_SECRET, t0);

    expect(verifyTotpCode(RFC_SECRET, codeAtT0, new Date(t0.getTime() + 30_000))).toBe(true);
    expect(verifyTotpCode(RFC_SECRET, codeAtT0, new Date(t0.getTime() - 30_000))).toBe(true);
    expect(verifyTotpCode(RFC_SECRET, codeAtT0, new Date(t0.getTime() + 60_000))).toBe(false);
    expect(verifyTotpCode(RFC_SECRET, codeAtT0, new Date(t0.getTime() - 60_000))).toBe(false);
  });

  it("round-trips a freshly generated secret", () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    const now = new Date();
    expect(verifyTotpCode(secret, generateTotpCode(secret, now), now)).toBe(true);
  });
});

describe("totpUri", () => {
  it("builds a parseable otpauth:// URI carrying the secret, issuer and account", () => {
    const uri = totpUri(RFC_SECRET, "alice@example.com", "IkelyaneMonitor");
    expect(uri).toMatch(/^otpauth:\/\/totp\//);
    const parsed = new URL(uri);
    expect(parsed.searchParams.get("secret")).toBe(RFC_SECRET);
    expect(parsed.searchParams.get("issuer")).toBe("IkelyaneMonitor");
    expect(parsed.searchParams.get("digits")).toBe("6");
    expect(parsed.searchParams.get("period")).toBe("30");
    expect(decodeURIComponent(parsed.pathname)).toContain("alice@example.com");
  });
});

describe("recovery codes", () => {
  it("generates the requested count, each shaped XXXX-XXXX-XXXX-XXXX with no ambiguous characters", () => {
    const codes = generateRecoveryCodes(10);
    expect(codes).toHaveLength(10);
    for (const code of codes) expect(code).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/);
  });

  it("generates codes that are all distinct", () => {
    const codes = generateRecoveryCodes(20);
    expect(new Set(codes).size).toBe(20);
  });

  it("normalizes to the same dash-free, uppercased form whether or not the dashes were typed", () => {
    const code = generateRecoveryCode();
    const canonical = code.replaceAll("-", "");
    expect(normalizeRecoveryCode(code)).toBe(canonical);
    expect(normalizeRecoveryCode(` ${code.toLowerCase()} `)).toBe(canonical);
    expect(normalizeRecoveryCode(canonical.toLowerCase())).toBe(canonical);
  });
});
