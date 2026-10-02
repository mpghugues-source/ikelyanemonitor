import http from "node:http";
import https from "node:https";
import { assertLiteralTargetAllowed, BlockedTargetError, guardedLookup } from "@/lib/net/target-guard";

const REQUEST_TIMEOUT_MS = 10_000;
/** We never need the response body; read at most this much so a hostile endpoint cannot stream forever. */
const MAX_RESPONSE_BYTES = 64 * 1024;

/** Stable failure codes, translated by the UI (`alertsAdmin.testResult.*`) and stored on NOTIFIED events. */
export type WebhookErrorCode = "invalid_url" | "blocked_target" | "redirect" | "http_status" | "timeout" | "dns" | "connection";

export class WebhookError extends Error {
  constructor(readonly code: WebhookErrorCode, readonly detail: string | null = null) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "WebhookError";
  }
}

export interface PostJsonOptions {
  /** WEBHOOKS_ALLOW_PRIVATE_TARGETS — let the request reach loopback/private networks (self-hosted only). */
  allowPrivateTargets: boolean;
  timeoutMs?: number;
}

function classify(error: unknown): WebhookError {
  if (error instanceof WebhookError) return error;
  if (error instanceof BlockedTargetError) return new WebhookError("blocked_target", error.address);
  const code = (error as NodeJS.ErrnoException)?.code ?? "";
  if (code === "EBLOCKEDTARGET") return new WebhookError("blocked_target");
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "EAI_NODATA" || code === "EAI_NONAME") return new WebhookError("dns", code);
  if (code === "ABORT_ERR") return new WebhookError("timeout");
  return new WebhookError("connection", code || null);
}

/**
 * POST a JSON body to a tenant-configured URL (Slack/Teams incoming webhook, generic webhook) and throw a
 * `WebhookError` unless the endpoint answers 2xx.
 *
 * Not `fetch`: the URL is chosen by an organization admin but the request leaves from the platform's own
 * network, so — exactly like synthetic checks — every resolved address is vetted at connection time
 * (src/lib/net/target-guard.ts, anti DNS-rebinding), and redirects are NOT followed (a public URL
 * answering 307 → http://127.0.0.1:5441 would otherwise bypass the check; no webhook provider redirects
 * a POST). Bounded by a timeout so one slow endpoint cannot stall alert evaluation — callers treat this
 * as best-effort (see src/modules/alerts/notify.ts).
 */
export async function postJson(rawUrl: string, body: unknown, options: PostJsonOptions): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new WebhookError("invalid_url");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new WebhookError("invalid_url");
  try {
    assertLiteralTargetAllowed(url, options.allowPrivateTargets);
  } catch (error) {
    throw classify(error);
  }

  const payload = Buffer.from(JSON.stringify(body));
  const transport = url.protocol === "https:" ? https : http;

  await new Promise<void>((resolve, reject) => {
    const request = transport.request(
      url,
      {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": payload.length, "user-agent": "IkelyaneMonitor-Notifier/1.0" },
        lookup: guardedLookup(options.allowPrivateTargets),
        signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
      },
      (response) => {
        let received = 0;
        response.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (received > MAX_RESPONSE_BYTES) response.destroy();
        });
        response.on("error", () => undefined);
        response.on("close", () => {
          const status = response.statusCode ?? 0;
          if (status >= 200 && status < 300) resolve();
          else if (status >= 300 && status < 400) reject(new WebhookError("redirect", String(status)));
          else reject(new WebhookError("http_status", String(status)));
        });
      },
    );
    request.on("error", (error) => reject(classify(error)));
    request.end(payload);
  });
}

/**
 * Save-time check of a webhook URL (the real protection is the connection-time one above — a hostname can
 * be re-pointed after saving). Refuses non-http(s) URLs and IP literals in non-public ranges so an admin
 * gets immediate feedback instead of silent delivery failures.
 */
export function webhookUrlAllowed(rawUrl: string, allowPrivateTargets: boolean): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    const host = url.hostname.toLowerCase();
    if (!allowPrivateTargets && (host === "localhost" || host.endsWith(".localhost"))) return false;
    assertLiteralTargetAllowed(url, allowPrivateTargets);
    return true;
  } catch {
    return false;
  }
}
