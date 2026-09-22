import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * End-to-end test of GET /api/v1/poller-config against a REAL PostgreSQL. Skipped unless
 * DATABASE_URL and IKELYANE_SECRET_KEY are set (see tests/integration/telemetry-route.test.ts).
 *
 * Same HMAC scheme and route-handler-called-directly approach as that file, with one difference
 * this endpoint is built around: the signature covers an EMPTY body (a GET has none) — see
 * src/app/api/v1/poller-config/route.ts's doc comment.
 */
const enabled = Boolean(process.env.DATABASE_URL && process.env.IKELYANE_SECRET_KEY);

describe.skipIf(!enabled)("GET /api/v1/poller-config", () => {
  let GET: (r: Request) => Promise<Response>;
  let POST: () => Response;
  let db: import("@/generated/prisma/client").PrismaClient;
  let crypto: typeof import("@/lib/crypto");
  let sig: typeof import("@/lib/telemetry/signature");

  const runId = randomBytes(4).toString("hex");
  const orgIds: string[] = [];
  let counter = 0;

  interface Agent {
    hostId: string;
    orgId: string;
    keyId: string;
    secret: string;
  }

  async function createOrgAndPoller(name: string): Promise<Agent> {
    const org = await db.organization.create({ data: { name: `t-${runId}-${name}`, slug: `t-${runId}-${name}-${++counter}` } });
    orgIds.push(org.id);
    const { keyId, secret } = crypto.generateAgentCredentials();
    const host = await db.monitoredHost.create({
      data: { orgId: org.id, hostname: `${name}.example`, keyId, hmacSecretEnc: crypto.encryptSecret(secret, crypto.hostSecretAad(keyId)) },
    });
    return { hostId: host.id, orgId: org.id, keyId, secret };
  }

  function request(agent: { keyId: string; secret: string }, timestamp?: number): Request {
    const ts = timestamp ?? Math.floor(Date.now() / 1000);
    const signature = sig.computeSignature(agent.secret, ts, "");
    return new Request("http://localhost/api/v1/poller-config", {
      method: "GET",
      headers: { [sig.KEY_ID_HEADER]: agent.keyId, [sig.SIGNATURE_HEADER]: `t=${ts},v1=${signature}` },
    });
  }

  beforeAll(async () => {
    ({ GET, POST } = await import("@/app/api/v1/poller-config/route"));
    crypto = await import("@/lib/crypto");
    sig = await import("@/lib/telemetry/signature");
    db = (await import("@/lib/prisma")).getPrisma();
  });

  afterAll(async () => {
    if (!db) return;
    await db.organization.deleteMany({ where: { id: { in: orgIds } } });
  });

  it("returns an empty list for a poller with no assigned devices", async () => {
    const poller = await createOrgAndPoller("empty");
    const res = await GET(request(poller));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ devices: [] });
  });

  it("returns a v2c device's community string decrypted, with lower-cased type/version", async () => {
    const poller = await createOrgAndPoller("v2c");
    const device = await db.networkDevice.create({
      data: {
        id: "dev_v2c_test",
        orgId: poller.orgId,
        name: "core-switch",
        ipAddress: "10.20.0.1",
        type: "SWITCH",
        pollerHostId: poller.hostId,
        pollIntervalSec: 30,
        snmpVersion: "V2C",
        snmpPort: 161,
        snmpCommunityEnc: crypto.encryptSecret("public-community", "device:dev_v2c_test:community"),
      },
    });

    const res = await GET(request(poller));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.devices).toEqual([
      {
        id: device.id,
        ipAddress: "10.20.0.1",
        type: "switch",
        pollIntervalSec: 30,
        snmp: { version: "v2c", port: 161, timeoutMs: 3000, retries: 1, community: "public-community", v3: null },
      },
    ]);
  });

  it("returns v3 credentials decrypted, only when the device is actually configured for v3", async () => {
    const poller = await createOrgAndPoller("v3");
    await db.networkDevice.create({
      data: {
        id: "dev_v3_test",
        orgId: poller.orgId,
        name: "core-router",
        ipAddress: "10.20.0.2",
        type: "ROUTER",
        pollerHostId: poller.hostId,
        snmpVersion: "V3",
        snmpV3Username: "monitor",
        snmpV3SecurityLevel: "AUTH_PRIV",
        snmpV3AuthProtocol: "SHA256",
        snmpV3AuthKeyEnc: crypto.encryptSecret("auth-secret", "device:dev_v3_test:authKey"),
        snmpV3PrivProtocol: "AES",
        snmpV3PrivKeyEnc: crypto.encryptSecret("priv-secret", "device:dev_v3_test:privKey"),
        snmpV3ContextName: "monitoring",
      },
    });

    const res = await GET(request(poller));
    const body = await res.json();
    expect(body.devices).toHaveLength(1);
    expect(body.devices[0].snmp).toEqual({
      version: "v3",
      port: 161,
      timeoutMs: 3000,
      retries: 1,
      community: null,
      v3: {
        username: "monitor",
        securityLevel: "AUTH_PRIV",
        authProtocol: "SHA256",
        authKey: "auth-secret",
        privProtocol: "AES",
        privKey: "priv-secret",
        contextName: "monitoring",
      },
    });
  });

  it("excludes disabled devices and devices assigned to a different poller", async () => {
    const poller = await createOrgAndPoller("scoping");
    const otherPoller = await createOrgAndPoller("scoping-other");

    await db.networkDevice.create({
      data: { orgId: poller.orgId, name: "disabled-dev", ipAddress: "10.20.0.3", type: "OTHER", pollerHostId: poller.hostId, enabled: false },
    });
    await db.networkDevice.create({
      data: { orgId: poller.orgId, name: "not-mine", ipAddress: "10.20.0.4", type: "OTHER", pollerHostId: otherPoller.hostId },
    });
    await db.networkDevice.create({
      data: { orgId: poller.orgId, name: "unassigned", ipAddress: "10.20.0.5", type: "OTHER" }, // pollerHostId null
    });

    const res = await GET(request(poller));
    const body = await res.json();
    expect(body.devices).toEqual([]);
  });

  it("refuses a request with a wrong signature (401), same as the telemetry endpoint", async () => {
    const poller = await createOrgAndPoller("badsig");
    const badRequest = new Request("http://localhost/api/v1/poller-config", {
      method: "GET",
      headers: { [sig.KEY_ID_HEADER]: poller.keyId, [sig.SIGNATURE_HEADER]: `t=${Math.floor(Date.now() / 1000)},v1=${"0".repeat(64)}` },
    });
    const res = await GET(badRequest);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_signature");
  });

  it("answers POST with 405", () => {
    const res = POST();
    expect(res.status).toBe(405);
  });
});
