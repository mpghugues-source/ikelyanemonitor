import { describe, expect, it } from "vitest";
import {
  computeSignature,
  isTimestampFresh,
  parseSignatureHeader,
  verifySignature,
} from "@/lib/telemetry/signature";

const SECRET = "s3cret-value";
const BODY = '{"schemaVersion":1}';
const TS = 1_758_000_000;

describe("computeSignature / verifySignature", () => {
  it("is a 64-char lower-case hex HMAC-SHA256", () => {
    expect(computeSignature(SECRET, TS, BODY)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("matches an independently computed reference vector (protocol pin)", () => {
    // Produced OUTSIDE this codebase, so the test cannot agree with itself by construction:
    //   printf '1758000000.{"schemaVersion":1}' | openssl dgst -sha256 -hmac 's3cret-value'
    // Any agent implementation (Go, Rust, shell) must produce exactly this value.
    expect(computeSignature(SECRET, TS, BODY)).toBe(
      "07aa1d93786628978c587392dbeff781224052a62006514beac26bc3a9c0b219",
    );
  });

  it("accepts the right secret, body and timestamp", () => {
    const parsed = parseSignatureHeader(`t=${TS},v1=${computeSignature(SECRET, TS, BODY)}`)!;
    expect(verifySignature([SECRET], parsed, BODY)).toBe(true);
  });

  it("rejects a wrong secret", () => {
    const parsed = parseSignatureHeader(`t=${TS},v1=${computeSignature("other", TS, BODY)}`)!;
    expect(verifySignature([SECRET], parsed, BODY)).toBe(false);
  });

  it("rejects a tampered body", () => {
    const parsed = parseSignatureHeader(`t=${TS},v1=${computeSignature(SECRET, TS, BODY)}`)!;
    expect(verifySignature([SECRET], parsed, BODY + " ")).toBe(false);
  });

  it("rejects a re-targeted timestamp (the timestamp is part of the signed message)", () => {
    const sig = computeSignature(SECRET, TS, BODY);
    const parsed = parseSignatureHeader(`t=${TS + 1},v1=${sig}`)!;
    expect(verifySignature([SECRET], parsed, BODY)).toBe(false);
  });

  it("accepts any of several secrets (rotation) and any of several v1 values", () => {
    const parsed = parseSignatureHeader(
      `t=${TS},v1=${computeSignature("stale", TS, BODY)},v1=${computeSignature("old-secret", TS, BODY)}`,
    )!;
    expect(verifySignature(["new-secret", "old-secret"], parsed, BODY)).toBe(true);
  });
});

describe("parseSignatureHeader", () => {
  const good = computeSignature(SECRET, TS, BODY);

  it("parses the canonical form", () => {
    expect(parseSignatureHeader(`t=${TS},v1=${good}`)).toEqual({ timestamp: TS, signatures: [good] });
  });

  it("tolerates spaces and upper-case hex", () => {
    expect(parseSignatureHeader(` t=${TS} , v1=${good.toUpperCase()} `)).toEqual({ timestamp: TS, signatures: [good] });
  });

  it("ignores unknown scheme versions", () => {
    expect(parseSignatureHeader(`t=${TS},v2=abcd,v1=${good}`)?.signatures).toEqual([good]);
  });

  it.each([
    ["null", null],
    ["empty", ""],
    ["no timestamp", `v1=${good}`],
    ["no signature", `t=${TS}`],
    ["non-numeric timestamp", `t=yesterday,v1=${good}`],
    ["milliseconds instead of seconds", `t=${TS * 1000},v1=${good}`],
    ["short hex", `t=${TS},v1=abcd`],
    ["not hex", `t=${TS},v1=${"z".repeat(64)}`],
    ["garbage", "hello"],
    ["oversized", `t=${TS},v1=${good},` + "x".repeat(600)],
    ["too many signatures", `t=${TS},` + Array(5).fill(`v1=${good}`).join(",")],
  ])("rejects %s", (_name, header) => {
    expect(parseSignatureHeader(header as string | null)).toBeNull();
  });
});

describe("isTimestampFresh", () => {
  const now = TS * 1000;
  it("accepts within tolerance, in both directions", () => {
    expect(isTimestampFresh(TS, now, 300)).toBe(true);
    expect(isTimestampFresh(TS - 299, now, 300)).toBe(true);
    expect(isTimestampFresh(TS + 299, now, 300)).toBe(true);
  });
  it("rejects outside tolerance (replay of an old capture, or an agent clock far ahead)", () => {
    expect(isTimestampFresh(TS - 301, now, 300)).toBe(false);
    expect(isTimestampFresh(TS + 301, now, 300)).toBe(false);
  });
});
