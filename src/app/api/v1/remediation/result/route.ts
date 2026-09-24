import { NextResponse } from "next/server";
import { z } from "zod";
import { getEnv } from "@/lib/env";
import { getPrisma } from "@/lib/prisma";
import { authenticateAgent } from "@/lib/telemetry/auth";
import { TelemetryHttpError } from "@/lib/telemetry/errors";
import { KEY_ID_HEADER, SIGNATURE_HEADER } from "@/lib/telemetry/signature";
import { STATUS_REASONS } from "@/modules/remediation/constants";
import { recordExecutionResult } from "@/modules/remediation/executions";

/**
 * POST /api/v1/remediation/result — the outcome of a job delivered by /next, signed like telemetry.
 * Only the host the job was delivered to may report it, and only once (409 otherwise).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" } as const;
/** stdout + stderr are capped at 64 KiB each by the agent (and again server-side). */
const MAX_BODY_BYTES = 256 * 1024;

const ResultSchema = z.object({
  executionId: z.string().min(1).max(64),
  status: z.enum(["succeeded", "failed", "timed_out", "skipped"]),
  reason: z.enum(STATUS_REASONS).nullish(),
  exitCode: z.number().int().min(-2_147_483_648).max(2_147_483_647).nullish(),
  durationMs: z.number().int().min(0).max(24 * 3600 * 1000).nullish(),
  stdout: z.string().max(MAX_BODY_BYTES).optional(),
  stderr: z.string().max(MAX_BODY_BYTES).optional(),
});

function errorResponse(error: TelemetryHttpError): NextResponse {
  return NextResponse.json(
    { status: "error", error: { code: error.code, message: error.message, details: error.details } },
    { status: error.status, headers: noStore },
  );
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const env = getEnv();
    const db = getPrisma();
    const now = new Date();
    const rawBody = await request.text();
    if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) throw new TelemetryHttpError(413, "payload_too_large", "Result body too large.");

    const agent = await authenticateAgent(db, {
      keyId: request.headers.get(KEY_ID_HEADER),
      signatureHeader: request.headers.get(SIGNATURE_HEADER),
      rawBody,
      nowMs: now.getTime(),
      maxSkewSeconds: env.TELEMETRY_MAX_CLOCK_SKEW_SECONDS,
    });

    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      throw new TelemetryHttpError(400, "invalid_json", "Body must be JSON.");
    }
    const parsed = ResultSchema.safeParse(json);
    if (!parsed.success) throw new TelemetryHttpError(422, "invalid_payload", "Invalid result.", parsed.error.issues.slice(0, 10));

    const outcome = await recordExecutionResult(db, agent.orgId, agent.hostId, parsed.data, now);
    if (outcome === "not_found") throw new TelemetryHttpError(409, "not_running", "No running execution with this id for this host.");
    return NextResponse.json({ status: "ok" }, { status: 200, headers: noStore });
  } catch (error) {
    if (error instanceof TelemetryHttpError) return errorResponse(error);
    console.error("[remediation/result] unexpected error", error);
    return errorResponse(new TelemetryHttpError(500, "internal_error", "Internal error. Retry later."));
  }
}
