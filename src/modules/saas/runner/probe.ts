import http from "node:http";
import https from "node:https";
import type { TLSSocket } from "node:tls";
import { PROBE_ERROR_CODES, type ProbeErrorCode } from "@/modules/saas/runner/error-codes";
import { assertLiteralTargetAllowed, BlockedTargetError, guardedLookup } from "@/modules/saas/runner/target-guard";

/**
 * One synthetic HTTP(S) check: request, follow redirects (each hop re-vetted), assert status and body,
 * capture timing and the TLS certificate. Never throws — every failure becomes a stable error code.
 */

export { PROBE_ERROR_CODES, type ProbeErrorCode };

export interface ProbeRequest {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string | null;
  expectedStatus: number;
  expectedBodyContains?: string | null;
  followRedirects: boolean;
  verifySsl: boolean;
  timeoutMs: number;
}

export interface ProbeOptions {
  /** CHECKS_ALLOW_PRIVATE_TARGETS: let checks reach loopback/private networks (self-hosted LAN monitoring). */
  allowPrivateTargets: boolean;
  userAgent?: string;
}

export interface TlsInfo {
  validTo: Date;
  issuer: string | null;
}

export interface ProbeResult {
  passed: boolean;
  /** Status of the final response, when one was received. */
  statusCode: number | null;
  /** Wall-clock time from the first request to the end of the (capped) final body, all hops included. */
  responseMs: number | null;
  error: ProbeErrorCode | null;
  /** Short technical hint for the UI ("HTTP 503", "CERT_HAS_EXPIRED"…). Never contains response body. */
  errorDetail: string | null;
  /** Certificate of the first HTTPS hop — the endpoint's own certificate. */
  tls: TlsInfo | null;
}

export const MAX_REDIRECTS = 5;
/** "Body contains" is evaluated against at most this much of the response. */
export const MAX_BODY_BYTES = 1024 * 1024;
const METHODS_WITH_BODY = new Set(["POST", "PUT", "PATCH", "DELETE"]);

interface HopResponse {
  statusCode: number;
  location: string | undefined;
  body: string | null;
  tls: TlsInfo | null;
}

class ProbeFailure extends Error {
  constructor(readonly code: ProbeErrorCode, readonly detail: string | null = null) {
    super(code);
  }
}

function classifyNetworkError(error: unknown): ProbeFailure {
  if (error instanceof ProbeFailure) return error;
  if (error instanceof BlockedTargetError) return new ProbeFailure("blocked_target", error.address);
  const code = (error as NodeJS.ErrnoException)?.code ?? "";
  if (code === "EBLOCKEDTARGET") return new ProbeFailure("blocked_target", null);
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "EAI_NODATA" || code === "EAI_NONAME") return new ProbeFailure("dns", code);
  if (/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)|HOSTNAME|ERR_TLS/i.test(code)) return new ProbeFailure("tls", code);
  if (code === "ABORT_ERR") return new ProbeFailure("timeout", null);
  return new ProbeFailure("connection", code || null);
}

function certificateOf(socket: TLSSocket): TlsInfo | null {
  const cert = socket.getPeerCertificate?.();
  if (!cert || !cert.valid_to) return null;
  const validTo = new Date(cert.valid_to);
  if (Number.isNaN(validTo.getTime())) return null;
  const issuer = cert.issuer ? (cert.issuer.O || cert.issuer.CN || null) : null;
  return { validTo, issuer: Array.isArray(issuer) ? issuer[0] : issuer };
}

function requestOnce(url: URL, method: string, headers: Record<string, string>, body: string | null, request: ProbeRequest, options: ProbeOptions, signal: AbortSignal, readBody: boolean): Promise<HopResponse> {
  return new Promise((resolve, reject) => {
    const isHttps = url.protocol === "https:";
    const transport = isHttps ? https : http;
    const req = transport.request(
      url,
      {
        method,
        headers: { "user-agent": options.userAgent ?? "IkelyaneMonitor-SyntheticCheck/1.0", accept: "*/*", ...headers },
        lookup: guardedLookup(options.allowPrivateTargets) as unknown as typeof import("node:dns").lookup,
        // A fresh connection per check: no pooled socket may carry one check's TLS/DNS state into another.
        agent: false,
        signal,
        ...(isHttps ? { rejectUnauthorized: request.verifySsl } : {}),
      },
      (res) => {
        const tls = isHttps ? certificateOf(res.socket as TLSSocket) : null;
        const statusCode = res.statusCode ?? 0;
        const location = typeof res.headers.location === "string" ? res.headers.location : undefined;
        if (!readBody) {
          res.resume();
          res.on("end", () => resolve({ statusCode, location, body: null, tls }));
          res.on("error", reject);
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          if (size >= MAX_BODY_BYTES) return;
          chunks.push(chunk.subarray(0, MAX_BODY_BYTES - size));
          size += chunk.length;
          if (size >= MAX_BODY_BYTES) {
            // Enough to evaluate the assertion: stop downloading (a huge or endless body must not
            // hold the runner until the timeout).
            resolve({ statusCode, location, body: Buffer.concat(chunks).toString("utf8"), tls });
            res.destroy();
          }
        });
        res.on("end", () => resolve({ statusCode, location, body: Buffer.concat(chunks).toString("utf8"), tls }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (body !== null) req.end(body);
    else req.end();
  });
}

export async function probe(request: ProbeRequest, options: ProbeOptions): Promise<ProbeResult> {
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs);
  let tls: TlsInfo | null = null;
  let statusCode: number | null = null;

  const result = (partial: Partial<ProbeResult> & Pick<ProbeResult, "passed">): ProbeResult => ({
    statusCode, responseMs: null, error: null, errorDetail: null, tls, ...partial,
  });

  try {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return result({ passed: false, error: "invalid_url" });
    }
    let method = request.method.toUpperCase();
    let body = METHODS_WITH_BODY.has(method) && request.body ? request.body : null;
    let headers = request.headers ?? {};
    const needBody = Boolean(request.expectedBodyContains) && method !== "HEAD";

    for (let hop = 0; ; hop++) {
      if (url.protocol !== "http:" && url.protocol !== "https:") return result({ passed: false, error: "invalid_url", errorDetail: url.protocol });
      assertLiteralTargetAllowed(url, options.allowPrivateTargets);

      const isRedirect = (code: number) => [301, 302, 303, 307, 308].includes(code);
      // Bodies are only downloaded when there is a "contains" assertion to evaluate (capped).
      const response = await requestOnce(url, method, headers, body, request, options, controller.signal, needBody);
      tls ??= response.tls;
      statusCode = response.statusCode;

      if (request.followRedirects && isRedirect(response.statusCode) && response.location) {
        if (hop >= MAX_REDIRECTS) return result({ passed: false, error: "too_many_redirects", errorDetail: `> ${MAX_REDIRECTS}` });
        let next: URL;
        try {
          next = new URL(response.location, url);
        } catch {
          return result({ passed: false, error: "invalid_url", errorDetail: "Location" });
        }
        // Configured headers may carry credentials (Authorization, API keys): like browsers, never
        // forward them to a different origin than the one they were configured for.
        if (next.origin !== url.origin) headers = {};
        url = next;
        // Browser semantics: 303 always, and 301/302 for anything but GET/HEAD, continue as a GET without body.
        if (response.statusCode === 303 || ((response.statusCode === 301 || response.statusCode === 302) && method !== "GET" && method !== "HEAD")) {
          method = method === "HEAD" ? "HEAD" : "GET";
          body = null;
        }
        continue;
      }

      const responseMs = performance.now() - started;
      if (response.statusCode !== request.expectedStatus) {
        return result({ passed: false, responseMs, error: "status_mismatch", errorDetail: `HTTP ${response.statusCode}` });
      }
      if (needBody && !(response.body ?? "").includes(request.expectedBodyContains as string)) {
        return result({ passed: false, responseMs, error: "body_mismatch" });
      }
      return result({ passed: true, responseMs });
    }
  } catch (error) {
    if (controller.signal.aborted) return result({ passed: false, error: "timeout", errorDetail: `${request.timeoutMs} ms` });
    const failure = classifyNetworkError(error);
    return result({ passed: false, error: failure.code, errorDetail: failure.detail });
  } finally {
    clearTimeout(timer);
  }
}
