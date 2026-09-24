import { NextResponse } from "next/server";
import { getEnv } from "@/lib/env";
import { getPrisma } from "@/lib/prisma";
import { authenticateAgent } from "@/lib/telemetry/auth";
import { TelemetryHttpError } from "@/lib/telemetry/errors";
import { KEY_ID_HEADER, SIGNATURE_HEADER, signResponse } from "@/lib/telemetry/signature";
import { claimNextExecution } from "@/modules/remediation/executions";

/**
 * GET /api/v1/remediation/next — the next remediation job for the calling host, if any.
 *
 * Auth: same HMAC scheme as /poller-config (signature over an EMPTY body). The RESPONSE is signed too
 * (X-Ikelyane-Signature over the exact response body, see signResponse): the agent refuses a job it
 * cannot verify. Taking a job marks it RUNNING — the agent must report it to /result.
 *
 * Response: 200 { execution: null | { id, runtime, script, sha256, args, timeoutSec, incidentId } }
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" } as const;

function errorResponse(error: TelemetryHttpError): NextResponse {
  return NextResponse.json(
    { status: "error", error: { code: error.code, message: error.message, details: error.details } },
    { status: error.status, headers: noStore },
  );
}

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const env = getEnv();
    const db = getPrisma();
    const now = new Date();
    const agent = await authenticateAgent(db, {
      keyId: request.headers.get(KEY_ID_HEADER),
      signatureHeader: request.headers.get(SIGNATURE_HEADER),
      rawBody: "",
      nowMs: now.getTime(),
      maxSkewSeconds: env.TELEMETRY_MAX_CLOCK_SKEW_SECONDS,
    });

    const job = await claimNextExecution(db, agent.orgId, agent.hostId, now);
    const body = JSON.stringify({
      execution: job ? { ...job, runtime: job.runtime.toLowerCase() } : null,
    });
    return new NextResponse(body, {
      status: 200,
      headers: { ...noStore, "Content-Type": "application/json", [SIGNATURE_HEADER]: signResponse(agent.responseSecrets, body, now.getTime()) },
    });
  } catch (error) {
    if (error instanceof TelemetryHttpError) return errorResponse(error);
    console.error("[remediation/next] unexpected error", error);
    return errorResponse(new TelemetryHttpError(500, "internal_error", "Internal error. Retry later."));
  }
}

export function POST(): NextResponse {
  return NextResponse.json(
    { status: "error", error: { code: "method_not_allowed", message: "Use GET." } },
    { status: 405, headers: { ...noStore, Allow: "GET" } },
  );
}
