import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_BODY_BYTES, probe, type ProbeRequest } from "@/modules/saas/runner/probe";
import { nextHealth, resultMetricRows, sanitizeHeaders } from "@/modules/saas/runner/runner";
import { assertLiteralTargetAllowed, guardedLookup, isPublicAddress } from "@/modules/saas/runner/target-guard";

describe("isPublicAddress", () => {
  it.each([
    "127.0.0.1", "127.8.9.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254",
    "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1", "192.0.2.10",
    "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:8.8.8.8",
    "64:ff9b::7f00:1", "2002:7f00:1::1", "ff02::1", "2001:db8::1", "not-an-ip",
  ])("refuses %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(["8.8.8.8", "1.1.1.1", "144.91.103.251", "172.32.0.1", "100.128.0.1", "2a00:1450:4007:80e::200e", "2606:4700:4700::1111"])(
    "allows %s",
    (address) => {
      expect(isPublicAddress(address)).toBe(true);
    },
  );
});

describe("target guard", () => {
  it("rejects private IP literals in URLs unless private targets are allowed", () => {
    expect(() => assertLiteralTargetAllowed(new URL("http://127.0.0.1:5440/"), false)).toThrow(/non-public/);
    expect(() => assertLiteralTargetAllowed(new URL("http://[::1]/"), false)).toThrow(/non-public/);
    expect(() => assertLiteralTargetAllowed(new URL("http://[::ffff:127.0.0.1]/"), false)).toThrow(/non-public/);
    expect(() => assertLiteralTargetAllowed(new URL("http://169.254.169.254/latest/meta-data/"), false)).toThrow(/non-public/);
    expect(() => assertLiteralTargetAllowed(new URL("http://127.0.0.1/"), true)).not.toThrow();
    expect(() => assertLiteralTargetAllowed(new URL("https://8.8.8.8/"), false)).not.toThrow();
    // Hostnames are left to the connection-time lookup.
    expect(() => assertLiteralTargetAllowed(new URL("http://localhost/"), false)).not.toThrow();
  });

  it("refuses a hostname that resolves to loopback, in both lookup call shapes", async () => {
    const lookup = guardedLookup(false);
    const single = await new Promise<NodeJS.ErrnoException | null>((resolve) => lookup("localhost", {}, (err) => resolve(err)));
    expect(single?.code).toBe("EBLOCKEDTARGET");
    const all = await new Promise<NodeJS.ErrnoException | null>((resolve) => lookup("localhost", { all: true }, (err) => resolve(err)));
    expect(all?.code).toBe("EBLOCKEDTARGET");
  });

  it("resolves normally when private targets are allowed", async () => {
    const lookup = guardedLookup(true);
    const address = await new Promise<string>((resolve, reject) =>
      lookup("localhost", {}, (err, addr) => (err ? reject(err) : resolve(addr as string))),
    );
    expect(isPublicAddress(address)).toBe(false);
  });
});

describe("nextHealth", () => {
  it("goes DEGRADED on the first failure, DOWN on the second, UP (and resets) on success", () => {
    expect(nextHealth(false, 0)).toEqual({ status: "DEGRADED", consecutiveFailures: 1 });
    expect(nextHealth(false, 1)).toEqual({ status: "DOWN", consecutiveFailures: 2 });
    expect(nextHealth(false, 7)).toEqual({ status: "DOWN", consecutiveFailures: 8 });
    expect(nextHealth(true, 7)).toEqual({ status: "UP", consecutiveFailures: 0 });
  });
});

describe("sanitizeHeaders", () => {
  it("keeps well-formed string headers only", () => {
    expect(
      sanitizeHeaders({ Authorization: "Bearer x", "X-Ok": "1", "bad name": "v", "X-Num": 3, "X-Split": "a\r\nInjected: 1" }),
    ).toEqual({ authorization: "Bearer x", "x-ok": "1" });
    expect(sanitizeHeaders(null)).toEqual({});
    expect(sanitizeHeaders(["a"])).toEqual({});
    expect(sanitizeHeaders("x")).toEqual({});
  });
});

describe("resultMetricRows", () => {
  const now = new Date("2026-09-23T12:00:00Z");
  it("always records availability; response time and TLS days only when known", () => {
    const failed = resultMetricRows("org", "ep", { passed: false, statusCode: null, responseMs: null, error: "timeout", errorDetail: null, tls: null }, now);
    expect(failed.map((r) => [r.metric, r.value])).toEqual([["ENDPOINT_AVAILABLE", 0]]);

    const ok = resultMetricRows(
      "org",
      "ep",
      { passed: true, statusCode: 200, responseMs: 123.456, error: null, errorDetail: null, tls: { validTo: new Date("2026-10-23T12:00:00Z"), issuer: "CA" } },
      now,
    );
    expect(ok.map((r) => [r.metric, r.value])).toEqual([
      ["ENDPOINT_AVAILABLE", 1],
      ["ENDPOINT_RESPONSE_MS", 123.5],
      ["ENDPOINT_SSL_DAYS_LEFT", 30],
    ]);
    expect(ok.every((r) => r.sourceKind === "ENDPOINT" && r.sourceId === "ep" && r.instance === "")).toBe(true);
  });
});

// ── probe() against real local servers ─────────────────────────────────────────────────────────

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void;

function listen(server: http.Server | https.Server): Promise<string> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(String((server.address() as AddressInfo).port))));
}

function withBody(handler: Handler) {
  return (req: http.IncomingMessage, res: http.ServerResponse) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => handler(req, res, body));
  };
}

describe("probe", () => {
  const seen: Array<{ path: string; method: string; headers: http.IncomingHttpHeaders; body: string; server: "a" | "b" }> = [];
  let a: http.Server;
  let b: http.Server;
  let tlsServer: https.Server;
  let A = "";
  let B = "";
  let T = "";

  const LOCAL = { allowPrivateTargets: true };
  const base: Omit<ProbeRequest, "url"> = {
    method: "GET", expectedStatus: 200, followRedirects: true, verifySsl: true, timeoutMs: 3000,
  };

  beforeAll(async () => {
    const route = (server: "a" | "b"): Handler => (req, res, body) => {
      seen.push({ path: req.url ?? "", method: req.method ?? "", headers: req.headers, body, server });
      const url = req.url ?? "/";
      if (url === "/ok") return res.end("hello healthy world");
      if (url === "/503") { res.statusCode = 503; return res.end("down"); }
      if (url === "/redirect") { res.writeHead(302, { location: "/ok" }); return res.end(); }
      if (url === "/see-other") { res.writeHead(303, { location: "/echo" }); return res.end(); }
      if (url === "/echo") return res.end(`${req.method}:${body}`);
      if (url.startsWith("/loop")) { res.writeHead(302, { location: `/loop${url.length}` }); return res.end(); }
      if (url === "/cross") { res.writeHead(307, { location: `http://127.0.0.1:${B}/ok` }); return res.end(); }
      if (url === "/to-ftp") { res.writeHead(302, { location: "ftp://127.0.0.1/" }); return res.end(); }
      if (url === "/slow") { setTimeout(() => res.end("late"), 2000); return; }
      if (url === "/endless") {
        res.write("MARKER");
        const chunk = "x".repeat(64 * 1024);
        const timer = setInterval(() => res.write(chunk), 1);
        res.on("close", () => clearInterval(timer));
        return;
      }
      res.statusCode = 404;
      res.end();
    };
    a = http.createServer(withBody(route("a")));
    b = http.createServer(withBody(route("b")));
    A = await listen(a);
    B = await listen(b);

    // A self-signed certificate, generated for this run (never committed).
    const dir = mkdtempSync(join(tmpdir(), "ikm-checks-"));
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "30", "-subj", "/CN=localhost/O=Ikelyane Test CA",
      "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"),
    ], { stdio: "ignore" });
    tlsServer = https.createServer({ key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) }, (_req, res) => res.end("secure"));
    T = await listen(tlsServer);
  });

  afterAll(() => {
    a?.close();
    b?.close();
    tlsServer?.close();
  });

  it("passes on the expected status and body", async () => {
    const result = await probe({ ...base, url: `http://127.0.0.1:${A}/ok`, expectedBodyContains: "healthy" }, LOCAL);
    expect(result).toMatchObject({ passed: true, statusCode: 200, error: null, tls: null });
    expect(result.responseMs).toBeGreaterThan(0);
  });

  it("fails with status_mismatch / body_mismatch", async () => {
    expect(await probe({ ...base, url: `http://127.0.0.1:${A}/503` }, LOCAL)).toMatchObject({ passed: false, statusCode: 503, error: "status_mismatch", errorDetail: "HTTP 503" });
    const body = await probe({ ...base, url: `http://127.0.0.1:${A}/ok`, expectedBodyContains: "absent" }, LOCAL);
    expect(body).toMatchObject({ passed: false, statusCode: 200, error: "body_mismatch" });
    expect(body.errorDetail).toBeNull(); // never echoes response content
  });

  it("follows redirects, or reports the redirect itself when told not to", async () => {
    expect(await probe({ ...base, url: `http://127.0.0.1:${A}/redirect` }, LOCAL)).toMatchObject({ passed: true, statusCode: 200 });
    expect(await probe({ ...base, url: `http://127.0.0.1:${A}/redirect`, followRedirects: false, expectedStatus: 302 }, LOCAL)).toMatchObject({ passed: true, statusCode: 302 });
  });

  it("turns a POST into a body-less GET on 303", async () => {
    const result = await probe({ ...base, method: "POST", body: "payload", url: `http://127.0.0.1:${A}/see-other`, expectedBodyContains: "GET:" }, LOCAL);
    expect(result.passed).toBe(true);
    expect(seen.filter((r) => r.path === "/echo").at(-1)).toMatchObject({ method: "GET", body: "" });
  });

  it("sends configured headers and body, but never forwards headers to another origin", async () => {
    await probe({ ...base, method: "POST", body: "payload", headers: { authorization: "Bearer s3cret" }, url: `http://127.0.0.1:${A}/echo` }, LOCAL);
    expect(seen.at(-1)).toMatchObject({ server: "a", method: "POST", body: "payload" });
    expect(seen.at(-1)?.headers.authorization).toBe("Bearer s3cret");

    const result = await probe({ ...base, headers: { authorization: "Bearer s3cret" }, url: `http://127.0.0.1:${A}/cross` }, LOCAL);
    expect(result.passed).toBe(true);
    const hop = seen.at(-1);
    expect(hop?.server).toBe("b");
    expect(hop?.headers.authorization).toBeUndefined();
  });

  it("stops redirect loops and non-http redirects", async () => {
    expect(await probe({ ...base, url: `http://127.0.0.1:${A}/loop` }, LOCAL)).toMatchObject({ passed: false, error: "too_many_redirects" });
    expect(await probe({ ...base, url: `http://127.0.0.1:${A}/to-ftp` }, LOCAL)).toMatchObject({ passed: false, error: "invalid_url" });
  });

  it("times out", async () => {
    const started = Date.now();
    expect(await probe({ ...base, url: `http://127.0.0.1:${A}/slow`, timeoutMs: 300 }, LOCAL)).toMatchObject({ passed: false, error: "timeout" });
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("stops reading an endless body once the cap is reached", async () => {
    const result = await probe({ ...base, url: `http://127.0.0.1:${A}/endless`, expectedBodyContains: "MARKER", timeoutMs: 10_000 }, LOCAL);
    expect(result).toMatchObject({ passed: true });
    expect(MAX_BODY_BYTES).toBe(1024 * 1024);
  });

  it("reports connection and DNS failures", async () => {
    const closed = http.createServer();
    const port = await listen(closed);
    await new Promise((resolve) => closed.close(resolve));
    expect(await probe({ ...base, url: `http://127.0.0.1:${port}/` }, LOCAL)).toMatchObject({ passed: false, error: "connection", errorDetail: "ECONNREFUSED" });
    expect(await probe({ ...base, url: "http://does-not-exist.invalid/" }, LOCAL)).toMatchObject({ passed: false, error: "dns" });
  });

  it("refuses private targets by default — IP literal, hostname and redirect hop alike", async () => {
    const before = seen.length;
    expect(await probe({ ...base, url: `http://127.0.0.1:${A}/ok` }, { allowPrivateTargets: false })).toMatchObject({ passed: false, error: "blocked_target", errorDetail: "127.0.0.1" });
    expect(await probe({ ...base, url: `http://localhost:${A}/ok` }, { allowPrivateTargets: false })).toMatchObject({ passed: false, error: "blocked_target" });
    expect(await probe({ ...base, url: "http://169.254.169.254/latest/meta-data/" }, { allowPrivateTargets: false })).toMatchObject({ passed: false, error: "blocked_target" });
    expect(seen.length).toBe(before); // nothing reached the server
  });

  it("verifies TLS certificates unless told not to, and captures the certificate", async () => {
    const strict = await probe({ ...base, url: `https://localhost:${T}/` }, LOCAL);
    expect(strict).toMatchObject({ passed: false, error: "tls" });
    expect(strict.errorDetail).toMatch(/SELF_SIGNED|UNABLE_TO_VERIFY/);

    const lax = await probe({ ...base, url: `https://localhost:${T}/`, verifySsl: false, expectedBodyContains: "secure" }, LOCAL);
    expect(lax).toMatchObject({ passed: true, statusCode: 200 });
    expect(lax.tls?.issuer).toBe("Ikelyane Test CA");
    const days = ((lax.tls?.validTo.getTime() ?? 0) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThanOrEqual(30.01);
  });

  it("never throws on a malformed URL", async () => {
    expect(await probe({ ...base, url: "not a url" }, LOCAL)).toMatchObject({ passed: false, error: "invalid_url" });
  });
});
