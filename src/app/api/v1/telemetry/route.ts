import { NextResponse } from "next/server";
import { z } from "zod";
import { getEnv } from "@/lib/env";
import { getPrisma } from "@/lib/prisma";
import { authenticateAgent } from "@/lib/telemetry/auth";
import { TelemetryHttpError } from "@/lib/telemetry/errors";
import { ingestTelemetry } from "@/lib/telemetry/ingest";
import { TelemetryPayloadSchema } from "@/lib/telemetry/schemas";
import { KEY_ID_HEADER, SIGNATURE_HEADER } from "@/lib/telemetry/signature";

/**
 * POST /api/v1/telemetry — ingestion endpoint for `ikelyane-agent`.
 *
 * Request:  JSON body (see src/lib/telemetry/schemas.ts) signed with HMAC-SHA256:
 *             X-Ikelyane-Key-Id:    ikm_…
 *             X-Ikelyane-Signature: t=<unix seconds>,v1=<hex(HMAC(secret, "<t>.<raw body>"))>
 * Response: 200 { status: "ok", … counts }    stored (duplicates of a retry are ignored)
 *           400 invalid_json                  body is not JSON
 *           401 …                             missing/invalid signature, stale timestamp, unknown key
 *           403 host_disabled                 valid signature but the host is switched off
 *           413 payload_too_large             body over TELEMETRY_MAX_BODY_BYTES
 *           422 invalid_payload | timestamp_out_of_range
 *           500 internal_error                nothing stored; the agent should retry with backoff
 *
 * Full protocol, including reference signing code: docs/telemetry.md
 */

// Needs Node.js APIs (crypto, pg driver) and must never be cached or statically rendered.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" } as const;

function errorResponse(error: TelemetryHttpError): NextResponse {
  return NextResponse.json(
    { status: "error", error: { code: error.code, message: error.message, details: error.details } },
    { status: error.status, headers: noStore },
  );
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const env = getEnv();

    // 1. Size guard — before reading the body. Content-Length can be absent or lie, so the real
    //    length is checked again after reading.
    const declaredLength = Number(request.headers.get("content-length") ?? "0");
    if (declaredLength > env.TELEMETRY_MAX_BODY_BYTES) {
      throw new TelemetryHttpError(413, "payload_too_large", `Body exceeds ${env.TELEMETRY_MAX_BODY_BYTES} bytes.`);
    }

    // 2. The signature covers the RAW bytes: read the text once and reuse it, never re-serialize.
    const rawBody = await request.text();
    if (Buffer.byteLength(rawBody, "utf8") > env.TELEMETRY_MAX_BODY_BYTES) {
      throw new TelemetryHttpError(413, "payload_too_large", `Body exceeds ${env.TELEMETRY_MAX_BODY_BYTES} bytes.`);
    }

    // 3. Authenticate BEFORE parsing: an unauthenticated caller must not be able to make the
    //    server spend time validating arbitrary JSON.
    const db = getPrisma();
    const now = new Date();
    const agent = await authenticateAgent(db, {
      keyId: request.headers.get(KEY_ID_HEADER),
      signatureHeader: request.headers.get(SIGNATURE_HEADER),
      rawBody,
      nowMs: now.getTime(),
      maxSkewSeconds: env.TELEMETRY_MAX_CLOCK_SKEW_SECONDS,
    });

    // 4. Parse + validate.
    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      throw new TelemetryHttpError(400, "invalid_json", "The request body is not valid JSON.");
    }
    const parsed = TelemetryPayloadSchema.safeParse(json);
    if (!parsed.success) {
      throw new TelemetryHttpError(422, "invalid_payload", "The payload does not match the telemetry schema.", {
        // Cap the list: a hostile payload could otherwise produce a huge error response.
        issues: parsed.error.issues.slice(0, 20).map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
        truncated: parsed.error.issues.length > 20,
      });
    }

    // 5. Store.
    const result = await ingestTelemetry(db, agent, parsed.data, {
      now,
      maxBackfillMs: env.TELEMETRY_MAX_BACKFILL_DAYS * 24 * 60 * 60 * 1000,
      maxSkewMs: env.TELEMETRY_MAX_CLOCK_SKEW_SECONDS * 1000,
    });

    return NextResponse.json(
      { status: "ok", receivedAt: now.toISOString(), host: agent.hostname, ...result },
      { status: 200, headers: noStore },
    );
  } catch (error) {
    if (error instanceof TelemetryHttpError) return errorResponse(error);
    if (error instanceof z.ZodError) {
      return errorResponse(new TelemetryHttpError(422, "invalid_payload", "The payload is invalid."));
    }
    // Never leak internals (SQL, stack, config) to the caller; log for operators.
    console.error("[telemetry] unexpected error", error);
    return errorResponse(new TelemetryHttpError(500, "internal_error", "Internal error. Retry later."));
  }
}

/** The endpoint is write-only: everything else is answered explicitly rather than with a 404 page. */
export function GET(): NextResponse {
  return NextResponse.json(
    { status: "error", error: { code: "method_not_allowed", message: "Use POST." } },
    { status: 405, headers: { ...noStore, Allow: "POST" } },
  );
}
