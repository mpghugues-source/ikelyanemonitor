import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * End-to-end test of POST /api/v1/telemetry against a REAL PostgreSQL + TimescaleDB.
 * Skipped unless DATABASE_URL and IKELYANE_SECRET_KEY are set:
 *
 *   DATABASE_URL=postgresql://… IKELYANE_SECRET_KEY=$(openssl rand -base64 32) npm test
 *
 * The route handler is called directly with real `Request` objects (no HTTP server), signed with
 * the real protocol. Every test organization is deleted afterwards.
 */
const enabled = Boolean(process.env.DATABASE_URL && process.env.IKELYANE_SECRET_KEY);

describe.skipIf(!enabled)("POST /api/v1/telemetry", () => {
  // Imported lazily: these modules read the environment.
  let POST: (r: Request) => Promise<Response>;
  let GET: () => Response;
  let db: import("@/generated/prisma/client").PrismaClient;
  let crypto: typeof import("@/lib/crypto");
  let sig: typeof import("@/lib/telemetry/signature");

  const runId = randomBytes(4).toString("hex");
  const orgIds: string[] = [];

  interface Agent {
    hostId: string;
    orgId: string;
    keyId: string;
    secret: string;
  }

  async function createAgent(name: string, overrides: Record<string, unknown> = {}): Promise<Agent> {
    const org = await db.organization.create({ data: { name: `t-${runId}-${name}`, slug: `t-${runId}-${name}` } });
    orgIds.push(org.id);
    const { keyId, secret } = crypto.generateAgentCredentials();
    const host = await db.monitoredHost.create({
      data: {
        orgId: org.id,
        hostname: `${name}.example`,
        keyId,
        hmacSecretEnc: crypto.encryptSecret(secret, crypto.hostSecretAad(keyId)),
        ...overrides,
      },
    });
    return { hostId: host.id, orgId: org.id, keyId, secret };
  }

  /** Build a request exactly like an agent would. */
  function signed(
    agent: { keyId: string; secret: string },
    body: unknown,
    opts: { timestamp?: number; rawBody?: string; signBody?: string } = {},
  ): Request {
    const raw = opts.rawBody ?? JSON.stringify(body);
    const ts = opts.timestamp ?? Math.floor(Date.now() / 1000);
    const signature = sig.computeSignature(agent.secret, ts, opts.signBody ?? raw);
    return new Request("http://localhost/api/v1/telemetry", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [sig.KEY_ID_HEADER]: agent.keyId,
        [sig.SIGNATURE_HEADER]: `t=${ts},v1=${signature}`,
      },
      body: raw,
    });
  }

  const iso = (offsetSeconds = 0) => new Date(Date.now() + offsetSeconds * 1000).toISOString();

  function payload(collectedAt = iso(-5), extra: Record<string, unknown> = {}) {
    return {
      schemaVersion: 1,
      sentAt: iso(),
      agent: { version: "0.1.0-test" },
      system: {
        collectedAt,
        inventory: { osFamily: "linux", osName: "AlmaLinux", cpuCores: 8, memoryTotalBytes: 16_000_000_000, ipAddresses: ["10.0.0.5"] },
        cpu: { usagePercent: 42.5, loadAverage1m: 1.2 },
        memory: { usedPercent: 63, usedBytes: 10_000_000_000 },
        disks: [{ mount: "/", device: "nvme0n1", usedPercent: 71, readIops: 120, writeIops: 80 }],
        network: [{ name: "eth0", inBps: 1_000_000, outBps: 250_000 }],
        temperatures: [{ sensor: "cpu0", celsius: 55 }],
      },
      snmpDevices: [
        {
          collectedAt,
          device: { ipAddress: "192.168.1.1", type: "router", reachable: true, latencyMs: 2.1, vendor: "MikroTik" },
          interfaces: [
            { ifIndex: 1, name: "ether1", alias: "uplink", operStatus: "up", inBps: 5_000, outBps: 9_000, crcErrors: 3 },
          ],
        },
      ],
      databases: [
        {
          collectedAt,
          instance: { name: "main:5432", engine: "postgresql", version: "17.2", maxConnections: 100 },
          metrics: { qps: 250, activeConnections: 25, cacheHitRatio: 0.98, deadlocksPerMin: 0 },
          slowQueries: [{ capturedAt: collectedAt, fingerprint: "fp-1", queryText: "SELECT * FROM t WHERE id = ?", durationMs: 2300 }],
        },
      ],
      ...extra,
    };
  }

  interface ApiBody {
    status: string;
    error: { code: string; message: string; details?: { issues: { path: string; message: string }[] } };
    [key: string]: unknown;
  }
  const json = async (response: Response) => (await response.json()) as ApiBody;

  beforeAll(async () => {
    ({ POST, GET } = await import("@/app/api/v1/telemetry/route"));
    crypto = await import("@/lib/crypto");
    sig = await import("@/lib/telemetry/signature");
    db = (await import("@/lib/prisma")).getPrisma();
  });

  afterAll(async () => {
    if (!db) return;
    // metric_entries has no foreign key (hypertable): clean it explicitly. The rest cascades from the organization.
    await db.metricEntry.deleteMany({ where: { orgId: { in: orgIds } } });
    await db.organization.deleteMany({ where: { id: { in: orgIds } } });
  });

  // ── Authentication ──────────────────────────────────────────────────────────────────────────

  describe("authentication", () => {
    let agent: Agent;
    beforeAll(async () => {
      agent = await createAgent("auth");
    });

    it("refuses a request without headers", async () => {
      const res = await POST(new Request("http://localhost/api/v1/telemetry", { method: "POST", body: "{}" }));
      expect(res.status).toBe(401);
      expect((await json(res)).error.code).toBe("missing_key_id");
    });

    it("refuses a key id without a signature", async () => {
      const res = await POST(
        new Request("http://localhost/api/v1/telemetry", { method: "POST", body: "{}", headers: { [sig.KEY_ID_HEADER]: agent.keyId } }),
      );
      expect((await json(res)).error.code).toBe("missing_signature");
    });

    it("refuses a malformed signature header", async () => {
      const res = await POST(
        new Request("http://localhost/api/v1/telemetry", {
          method: "POST",
          body: "{}",
          headers: { [sig.KEY_ID_HEADER]: agent.keyId, [sig.SIGNATURE_HEADER]: "nonsense" },
        }),
      );
      expect((await json(res)).error.code).toBe("malformed_signature");
    });

    it("refuses a wrong secret", async () => {
      const res = await POST(signed({ keyId: agent.keyId, secret: "not-the-secret" }, payload()));
      expect(res.status).toBe(401);
      expect((await json(res)).error.code).toBe("invalid_signature");
    });

    it("answers an UNKNOWN key exactly like a wrong signature (no key-id enumeration)", async () => {
      const unknown = await POST(signed({ keyId: "ikm_doesNotExist000000000", secret: "x" }, payload()));
      const wrong = await POST(signed({ keyId: agent.keyId, secret: "x" }, payload()));
      expect(unknown.status).toBe(wrong.status);
      expect(await json(unknown)).toEqual(await json(wrong));
    });

    it("refuses a body modified after signing", async () => {
      const original = JSON.stringify(payload());
      const res = await POST(signed(agent, null, { rawBody: original.replace("42.5", "99.9"), signBody: original }));
      expect((await json(res)).error.code).toBe("invalid_signature");
    });

    it("refuses a replayed (stale) request", async () => {
      const res = await POST(signed(agent, payload(), { timestamp: Math.floor(Date.now() / 1000) - 3600 }));
      expect(res.status).toBe(401);
      expect((await json(res)).error.code).toBe("timestamp_out_of_tolerance");
    });

    it("refuses a disabled host — but only after a valid signature", async () => {
      const disabled = await createAgent("disabled", { enabled: false });
      const ok = await POST(signed(disabled, payload()));
      expect(ok.status).toBe(403);
      expect((await json(ok)).error.code).toBe("host_disabled");
      const forged = await POST(signed({ ...disabled, secret: "guess" }, payload()));
      expect(forged.status).toBe(401); // does not reveal that the host exists nor that it is disabled
    });

    it("accepts the previous secret during a rotation grace period, and refuses it afterwards", async () => {
      const rotating = await createAgent("rotating");
      const oldSecret = "the-old-secret-value";
      const aad = crypto.hostSecretAad(rotating.keyId);
      await db.monitoredHost.update({
        where: { id: rotating.hostId },
        data: {
          previousHmacSecretEnc: crypto.encryptSecret(oldSecret, aad),
          previousSecretExpiresAt: new Date(Date.now() + 3600_000),
        },
      });
      expect((await POST(signed({ ...rotating, secret: oldSecret }, payload()))).status).toBe(200);
      expect((await POST(signed(rotating, payload(iso(-3))))).status).toBe(200); // new secret still works

      await db.monitoredHost.update({ where: { id: rotating.hostId }, data: { previousSecretExpiresAt: new Date(Date.now() - 1000) } });
      expect((await POST(signed({ ...rotating, secret: oldSecret }, payload(iso(-4))))).status).toBe(401);
    });

    it("rejects a ciphertext copied onto another host (AAD binding) instead of authenticating", async () => {
      const a = await createAgent("aad-a");
      const b = await createAgent("aad-b");
      const stolen = (await db.monitoredHost.findUniqueOrThrow({ where: { id: a.hostId } })).hmacSecretEnc;
      await db.monitoredHost.update({ where: { id: b.hostId }, data: { hmacSecretEnc: stolen } });
      const res = await POST(signed({ ...b, secret: a.secret }, payload()));
      expect(res.status).toBe(500); // decryption fails closed; never a successful login
    });
  });

  // ── Payload handling ────────────────────────────────────────────────────────────────────────

  describe("payload validation", () => {
    let agent: Agent;
    beforeAll(async () => {
      agent = await createAgent("payload");
    });

    it("answers 405 to GET", async () => {
      expect(GET().status).toBe(405);
    });

    it("refuses invalid JSON (but signed correctly) with 400", async () => {
      const res = await POST(signed(agent, null, { rawBody: "{not json" }));
      expect(res.status).toBe(400);
      expect((await json(res)).error.code).toBe("invalid_json");
    });

    it("refuses a schema violation with 422 and points at the field", async () => {
      const valid = payload();
      const bad = { ...valid, system: { ...valid.system, cpu: { usagePercent: 250 } } };
      const res = await POST(signed(agent, bad));
      expect(res.status).toBe(422);
      const body = await json(res);
      expect(body.error.code).toBe("invalid_payload");
      expect(body.error.details?.issues.some((i) => i.path === "system.cpu.usagePercent")).toBe(true);
    });

    it("refuses a body over the size limit with 413", async () => {
      const res = await POST(signed(agent, null, { rawBody: JSON.stringify({ padding: "x".repeat(1_200_000) }) }));
      expect(res.status).toBe(413);
    });

    it("refuses data points that are too old or in the future with 422", async () => {
      for (const offset of [-30 * 86400, 3600]) {
        const res = await POST(signed(agent, payload(iso(offset))));
        expect(res.status).toBe(422);
        expect((await json(res)).error.code).toBe("timestamp_out_of_range");
      }
    });

    it("is ATOMIC: one bad section stores nothing at all", async () => {
      const valid = payload(iso(-5));
      // valid system section + a database section whose timestamp is far too old
      const mixed = { ...valid, databases: [{ ...valid.databases[0], collectedAt: iso(-30 * 86400) }] };
      const res = await POST(signed(agent, mixed));
      expect(res.status).toBe(422);
      expect(await db.metricEntry.count({ where: { orgId: agent.orgId } })).toBe(0);
      const host = await db.monitoredHost.findUniqueOrThrow({ where: { id: agent.hostId } });
      expect(host.status).toBe("UNKNOWN"); // the heartbeat was rolled back too
      expect(host.lastSeenAt).toBeNull();
      expect(await db.networkDevice.count({ where: { orgId: agent.orgId } })).toBe(0);
    });
  });

  // ── Storage ─────────────────────────────────────────────────────────────────────────────────

  describe("storage", () => {
    let agent: Agent;
    const firstAt = iso(-60);
    beforeAll(async () => {
      agent = await createAgent("storage");
    });

    it("stores a full request: host, network device + ports, database + slow query, time series", async () => {
      const res = await POST(signed(agent, payload(firstAt)));
      const body = await json(res);
      expect(res.status, JSON.stringify(body)).toBe(200);

      // system(10) + snmp(latency + 2 bandwidth = 3) + database(qps, connections, usage %, cache, deadlocks = 5) = 18
      expect(body).toMatchObject({ status: "ok", metricsReceived: 18, metricsStored: 18, devices: 1, interfaces: 1, databases: 1, slowQueriesStored: 1 });

      const host = await db.monitoredHost.findUniqueOrThrow({ where: { id: agent.hostId } });
      expect(host).toMatchObject({ status: "UP", osFamily: "LINUX", osName: "AlmaLinux", cpuCores: 8, agentVersion: "0.1.0-test" });
      expect(host.memoryTotalBytes).toBe(16_000_000_000n);
      expect(host.ipAddresses).toEqual(["10.0.0.5"]);
      expect(host.firstSeenAt).not.toBeNull();

      const device = await db.networkDevice.findFirstOrThrow({ where: { orgId: agent.orgId }, include: { interfaces: true } });
      expect(device).toMatchObject({ ipAddress: "192.168.1.1", type: "ROUTER", vendor: "MikroTik", status: "UP", pollerHostId: agent.hostId });
      expect(device.name).toBe("192.168.1.1"); // no name reported: falls back to the address
      expect(device.interfaces).toHaveLength(1);
      expect(device.interfaces[0]).toMatchObject({ ifIndex: 1, name: "ether1", alias: "uplink", operStatus: "UP", inBps: 5000n, outBps: 9000n, crcErrors: 3n });

      const database = await db.databaseInstance.findFirstOrThrow({ where: { orgId: agent.orgId }, include: { slowQueries: true } });
      expect(database).toMatchObject({ engine: "POSTGRESQL", version: "17.2", status: "UP", cacheHitRatio: 0.98, maxConnections: 100 });
      expect(database.slowQueries).toHaveLength(1);

      // Series carry the right source and instance.
      const disk = await db.metricEntry.findFirstOrThrow({ where: { orgId: agent.orgId, metric: "DISK_READ_IOPS" } });
      expect(disk).toMatchObject({ sourceKind: "HOST", sourceId: agent.hostId, instance: "nvme0n1", value: 120 });
      const port = await db.metricEntry.findFirstOrThrow({ where: { orgId: agent.orgId, metric: "BANDWIDTH_IN_BPS" } });
      expect(port).toMatchObject({ sourceKind: "NETWORK_DEVICE", sourceId: device.id, instance: "ether1", value: 5000 });
      const usage = await db.metricEntry.findFirstOrThrow({ where: { orgId: agent.orgId, metric: "DB_CONNECTION_USAGE_PERCENT" } });
      expect(usage.value).toBe(25); // derived: 25 active / 100 max
    });

    it("is IDEMPOTENT: replaying the same batch (an agent retry) stores nothing new", async () => {
      const before = await db.metricEntry.count({ where: { orgId: agent.orgId } });
      const res = await POST(signed(agent, payload(firstAt)));
      const body = await json(res);
      expect(res.status).toBe(200);
      expect(body).toMatchObject({ metricsReceived: 18, metricsStored: 0, slowQueriesStored: 0 });
      expect(await db.metricEntry.count({ where: { orgId: agent.orgId } })).toBe(before);
      expect(await db.networkDevice.count({ where: { orgId: agent.orgId } })).toBe(1);
      expect(await db.databaseInstance.count({ where: { orgId: agent.orgId } })).toBe(1);
    });

    it("updates snapshots on the next poll and keeps values the agent did not resend", async () => {
      const first = payload(iso(-30));
      // Second poll: `alias` and `crcErrors` are NOT resent, throughput changed, the port went down,
      // and the host inventory is omitted (agents only send it when it changes).
      const next = {
        ...first,
        system: { ...first.system, inventory: undefined },
        snmpDevices: [
          {
            ...first.snmpDevices[0],
            interfaces: [{ ifIndex: 1, name: "ether1", operStatus: "down", inBps: 77_000, outBps: 9_000 }],
          },
        ],
      };
      const res = await POST(signed(agent, next));
      expect(res.status, JSON.stringify(await json(res.clone()))).toBe(200);

      const updated = await db.networkInterface.findFirstOrThrow({ where: { device: { orgId: agent.orgId } } });
      expect(updated).toMatchObject({ inBps: 77000n, operStatus: "DOWN", alias: "uplink", crcErrors: 3n });
      const host = await db.monitoredHost.findUniqueOrThrow({ where: { id: agent.hostId } });
      expect(host.cpuCores).toBe(8); // inventory kept
    });

    it("marks an unreachable device DOWN and skips its port metrics", async () => {
      const req = payload(iso(-20), {
        system: undefined,
        databases: undefined,
        snmpDevices: [{ collectedAt: iso(-20), device: { ipAddress: "192.168.1.1", reachable: false }, interfaces: [] }],
      });
      const res = await POST(signed(agent, req));
      expect(res.status).toBe(200);
      expect((await json(res)).metricsReceived).toBe(0);
      const device = await db.networkDevice.findFirstOrThrow({ where: { orgId: agent.orgId } });
      expect(device.status).toBe("DOWN");
    });

    it("keeps two organizations completely separate", async () => {
      const other = await createAgent("storage-other");
      await POST(signed(other, payload(iso(-40))));
      // The same device IP / database name exist in both organizations without colliding.
      expect(await db.networkDevice.count({ where: { ipAddress: "192.168.1.1", orgId: { in: [agent.orgId, other.orgId] } } })).toBe(2);
      const mine = await db.metricEntry.findMany({ where: { orgId: agent.orgId }, select: { sourceId: true }, distinct: ["sourceId"] });
      const theirs = await db.metricEntry.findMany({ where: { orgId: other.orgId }, select: { sourceId: true }, distinct: ["sourceId"] });
      const mineIds = new Set(mine.map((m) => m.sourceId));
      expect(theirs.every((t) => !mineIds.has(t.sourceId))).toBe(true);
    });

    it("stores rows in the TimescaleDB hypertable (a chunk exists for the data)", async () => {
      const chunks = await db.$queryRaw<{ n: bigint }[]>`
        SELECT count(*)::bigint AS n FROM timescaledb_information.chunks WHERE hypertable_name = 'metric_entries'`;
      expect(Number(chunks[0].n)).toBeGreaterThan(0);
    });
  });
});
