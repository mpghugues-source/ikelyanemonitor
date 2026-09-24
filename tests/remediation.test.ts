import { describe, expect, it } from "vitest";
import { computeSignature, signResponse } from "@/lib/telemetry/signature";
import { MAX_OUTPUT_BYTES } from "@/modules/remediation/constants";
import { truncateOutput } from "@/modules/remediation/executions";
import { guardrailViolation, type GuardAction, type GuardHost } from "@/modules/remediation/guard";

const SHA = "a".repeat(64);
const now = new Date("2026-09-24T12:00:00Z");
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);

const action: GuardAction = { enabled: true, allowedOsFamilies: [], cooldownSec: 300, maxRunsPerHour: 3 };
const host: GuardHost = { enabled: true, osFamily: "LINUX", remediationMode: "any", remediationAllowlist: [] };

describe("guardrailViolation", () => {
  it("accepts a first run on a consenting host", () => {
    expect(guardrailViolation(action, host, SHA, [], now)).toBeNull();
  });

  it("the host's own policy comes first: unknown, disabled, allowlist", () => {
    expect(guardrailViolation(action, { ...host, remediationMode: null }, SHA, [], now)).toBe("host_not_accepting");
    expect(guardrailViolation(action, { ...host, remediationMode: "disabled" }, SHA, [], now)).toBe("host_not_accepting");
    expect(guardrailViolation(action, { ...host, remediationMode: "allowlist", remediationAllowlist: ["b".repeat(64)] }, SHA, [], now)).toBe("not_in_allowlist");
    expect(guardrailViolation(action, { ...host, remediationMode: "allowlist", remediationAllowlist: [SHA] }, SHA, [], now)).toBeNull();
  });

  it("action and host switches, OS restriction", () => {
    expect(guardrailViolation({ ...action, enabled: false }, host, SHA, [], now)).toBe("action_disabled");
    expect(guardrailViolation(action, { ...host, enabled: false }, SHA, [], now)).toBe("host_disabled");
    expect(guardrailViolation({ ...action, allowedOsFamilies: ["WINDOWS"] }, host, SHA, [], now)).toBe("os_not_allowed");
    expect(guardrailViolation({ ...action, allowedOsFamilies: ["WINDOWS", "LINUX"] }, host, SHA, [], now)).toBeNull();
  });

  it("no duplicate while one is waiting or running, then cooldown, then the hourly cap", () => {
    expect(guardrailViolation(action, host, SHA, [{ status: "AWAITING_APPROVAL", createdAt: minutesAgo(600) }], now)).toBe("already_queued");
    expect(guardrailViolation(action, host, SHA, [{ status: "RUNNING", createdAt: minutesAgo(1) }], now)).toBe("already_queued");
    expect(guardrailViolation(action, host, SHA, [{ status: "SUCCEEDED", createdAt: minutesAgo(2) }], now)).toBe("cooldown");
    const three = [10, 20, 30].map((m) => ({ status: "FAILED" as const, createdAt: minutesAgo(m) }));
    expect(guardrailViolation(action, host, SHA, three, now)).toBe("rate_limited");
    expect(guardrailViolation(action, host, SHA, three.slice(0, 2), now)).toBeNull();
  });

  it("skipped and cancelled runs count for nothing", () => {
    const noise = Array.from({ length: 10 }, () => ({ status: "SKIPPED" as const, createdAt: minutesAgo(1) }));
    expect(guardrailViolation(action, host, SHA, [...noise, { status: "CANCELLED", createdAt: minutesAgo(1) }], now)).toBeNull();
  });
});

describe("truncateOutput", () => {
  it("caps at 64 KiB without splitting a character", () => {
    expect(truncateOutput(undefined)).toBeNull();
    expect(truncateOutput("ok")).toBe("ok");
    const long = "é".repeat(MAX_OUTPUT_BYTES); // 2 bytes each
    const cut = truncateOutput(long) as string;
    expect(Buffer.byteLength(cut, "utf8")).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
    expect(cut.endsWith("�")).toBe(false);
  });
});

describe("signResponse", () => {
  it("uses the request scheme, one v1 per valid secret (what the agent's VerifyResponse accepts)", () => {
    const body = '{"execution":null}';
    const header = signResponse(["current", "previous"], body, 1_758_000_000_500);
    expect(header).toBe(`t=1758000000,v1=${computeSignature("current", 1758000000, body)},v1=${computeSignature("previous", 1758000000, body)}`);
  });
});
