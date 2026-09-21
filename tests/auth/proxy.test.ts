import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import proxy, { config } from "@/proxy";

const request = (path: string, cookie?: string) =>
  new NextRequest(`http://app.test${path}`, { headers: cookie ? { cookie } : {} });

const location = (response: Response) => response.headers.get("location");

describe("proxy: language negotiation", () => {
  it("sends the root and unprefixed paths to a locale", () => {
    expect(location(proxy(request("/")))).toBe("http://app.test/en");
    expect(location(proxy(request("/servers", "ikm_session=x")))).toBe("http://app.test/en/servers");
  });

  it("honours Accept-Language", () => {
    const response = proxy(new NextRequest("http://app.test/", { headers: { "accept-language": "fr-FR,fr;q=0.9" } }));
    expect(location(response)).toBe("http://app.test/fr");
  });
});

describe("proxy: optimistic sign-in check", () => {
  it("redirects a visitor without a session cookie to the login page, remembering the destination", () => {
    expect(location(proxy(request("/en")))).toBe("http://app.test/en/login?next=%2F");
    expect(location(proxy(request("/fr/servers?tab=all")))).toBe("http://app.test/fr/login?next=%2Fservers%3Ftab%3Dall");
    expect(location(proxy(request("/en/settings/members")))).toBe("http://app.test/en/login?next=%2Fsettings%2Fmembers");
  });

  it("lets through any request that carries a session cookie (validity is checked later, against the database)", () => {
    expect(location(proxy(request("/en/servers", "ikm_session=anything")))).toBeNull();
    expect(location(proxy(request("/en/servers", "__Host-ikm_session=anything")))).toBeNull();
  });

  it("does not treat an unrelated cookie as a session", () => {
    expect(location(proxy(request("/en/servers", "other=1; ikm_sess=1")))).toContain("/en/login");
  });

  it.each(["/en/login", "/fr/login", "/en/register", "/en/invite/abc123", "/fr/invite/xyz/"])("keeps %s public", (path) => {
    expect(location(proxy(request(path)))).toBeNull();
  });

  it("does not open a hole through look-alike paths", () => {
    // "/loginx" and "/invitee" are NOT the public pages.
    expect(location(proxy(request("/en/loginx")))).toContain("/en/login");
    expect(location(proxy(request("/en/invitee/abc")))).toContain("/en/login");
    expect(location(proxy(request("/en/settings/login")))).toContain("/en/login?next=");
  });
});

describe("proxy matcher", () => {
  const matches = (path: string) => new RegExp(`^${(config.matcher as string).replace(/^\//, "\\/")}$`).test(path);

  it("never intercepts the agent API, Next internals or static files", () => {
    expect(matches("/api/v1/telemetry")).toBe(false);
    expect(matches("/_next/static/chunk.js")).toBe(false);
    expect(matches("/favicon.ico")).toBe(false);
    expect(matches("/en/servers")).toBe(true);
    expect(matches("/")).toBe(true);
  });
});
