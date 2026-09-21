import { describe, expect, it } from "vitest";
import { clientIpFromHeaders, normalizeEmail, safeNextPath } from "@/lib/auth/request";

describe("safeNextPath (open-redirect protection)", () => {
  it("keeps ordinary in-app paths, including query strings", () => {
    expect(safeNextPath("/servers")).toBe("/servers");
    expect(safeNextPath("/settings/members?tab=pending")).toBe("/settings/members?tab=pending");
    expect(safeNextPath("/")).toBe("/");
  });

  it.each([
    ["absolute URL", "https://evil.example/phish"],
    ["protocol-relative URL", "//evil.example"],
    ["backslash trick", "/\\evil.example"],
    ["javascript scheme", "javascript:alert(1)"],
    ["data scheme", "data:text/html,<script>1</script>"],
    ["no leading slash", "servers"],
    ["empty", ""],
    ["header injection (CR LF)", "/ok\r\nSet-Cookie: x=1"],
    ["NUL byte", "/ok\u0000.evil"],
    ["embedded backslash", "/ok\\..\\evil"],
    ["overlong", "/" + "a".repeat(600)],
  ])("falls back for %s", (_name, value) => {
    expect(safeNextPath(value)).toBe("/");
  });

  it("falls back for null/undefined and honours a custom fallback", () => {
    expect(safeNextPath(null)).toBe("/");
    expect(safeNextPath(undefined, "/home")).toBe("/home");
  });
});

describe("clientIpFromHeaders", () => {
  it("takes the LAST X-Forwarded-For entry (added by our proxy), ignoring forged earlier ones", () => {
    expect(clientIpFromHeaders("6.6.6.6, 203.0.113.9", true)).toBe("203.0.113.9");
    expect(clientIpFromHeaders("203.0.113.9", true)).toBe("203.0.113.9");
  });

  it("supports IPv6", () => {
    expect(clientIpFromHeaders("2001:db8::1", true)).toBe("2001:db8::1");
  });

  it("returns null when the proxy is not trusted or the header is absent/garbage", () => {
    expect(clientIpFromHeaders("203.0.113.9", false)).toBeNull();
    expect(clientIpFromHeaders(null, true)).toBeNull();
    expect(clientIpFromHeaders("", true)).toBeNull();
    expect(clientIpFromHeaders("1.1.1.1, <script>", true)).toBeNull();
    expect(clientIpFromHeaders("x".repeat(100), true)).toBeNull();
  });
});

describe("normalizeEmail", () => {
  it("trims and lower-cases", () => {
    expect(normalizeEmail("  Marie.Dupont@Example.COM ")).toBe("marie.dupont@example.com");
  });
});
