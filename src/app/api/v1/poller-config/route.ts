import { NextResponse } from "next/server";
import { getEnv } from "@/lib/env";
import { getPrisma } from "@/lib/prisma";
import { authenticateAgent } from "@/lib/telemetry/auth";
import { TelemetryHttpError } from "@/lib/telemetry/errors";
import { KEY_ID_HEADER, SIGNATURE_HEADER } from "@/lib/telemetry/signature";
import { listDevicesForPoller } from "@/modules/network/devices";

/**
 * GET /api/v1/poller-config — network devices assigned to the calling host (NetworkDevice.pollerHostId),
 * with their SNMP credentials DECRYPTED for this one response.
 *
 * Auth: same HMAC-SHA256 scheme as POST /api/v1/telemetry (docs/telemetry.md), but over an EMPTY
 * body — there being no request body to sign, `t=<unix seconds>,v1=hex(HMAC(secret, "<t>."))`.
 *
 * Response: 200 { devices: [...] }   see PollerConfigDevice below
 *           401/403                 same codes as the telemetry endpoint
 *           500 internal_error
 *
 * This is the ONLY place SNMP credentials ever leave the server in clear text, and only to the
 * exact host authorized to poll each device — never to a browser/session, see
 * src/modules/network/devices.ts listDevicesForPoller's doc comment.
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

interface PollerConfigDevice {
  id: string;
  ipAddress: string;
  type: string; // lower-case, matches src/lib/telemetry/schemas.ts DEVICE_TYPES
  pollIntervalSec: number;
  snmp: {
    version: string; // "v1" | "v2c" | "v3", matches schemas.ts SNMP_VERSIONS
    port: number;
    timeoutMs: number;
    retries: number;
    community: string | null;
    v3: {
      username: string | null;
      securityLevel: string | null;
      authProtocol: string | null;
      authKey: string | null;
      privProtocol: string | null;
      privKey: string | null;
      contextName: string | null;
    } | null;
  };
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

    const devices = await listDevicesForPoller(db, agent.orgId, agent.hostId);

    const response: { devices: PollerConfigDevice[] } = {
      devices: devices.map((d) => ({
        id: d.id,
        ipAddress: d.ipAddress,
        type: d.type.toLowerCase(),
        pollIntervalSec: d.pollIntervalSec,
        snmp: {
          version: d.snmpVersion.toLowerCase(),
          port: d.snmpPort,
          timeoutMs: d.snmpTimeoutMs,
          retries: d.snmpRetries,
          community: d.snmpCommunity,
          v3: d.snmpVersion === "V3" ? d.snmpV3 : null,
        },
      })),
    };
    return NextResponse.json(response, { status: 200, headers: noStore });
  } catch (error) {
    if (error instanceof TelemetryHttpError) return errorResponse(error);
    console.error("[poller-config] unexpected error", error);
    return errorResponse(new TelemetryHttpError(500, "internal_error", "Internal error. Retry later."));
  }
}

/** The endpoint is read-only: everything else is answered explicitly rather than with a 404 page. */
export function POST(): NextResponse {
  return NextResponse.json(
    { status: "error", error: { code: "method_not_allowed", message: "Use GET." } },
    { status: 405, headers: { ...noStore, Allow: "GET" } },
  );
}
