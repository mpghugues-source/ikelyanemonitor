import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { Role } from "@/generated/prisma/enums";
import type { Actor } from "@/lib/auth/db";

/**
 * Module business logic (databases, network, endpoints, topology) against a REAL PostgreSQL.
 * Skipped unless DATABASE_URL and IKELYANE_SECRET_KEY are set (see tests/integration/telemetry-route.test.ts).
 */
const enabled = Boolean(process.env.DATABASE_URL && process.env.IKELYANE_SECRET_KEY);

describe.skipIf(!enabled)("module business logic", () => {
  let db: PrismaClient;
  let m: {
    endpoints: typeof import("@/modules/saas/endpoints");
    devices: typeof import("@/modules/network/devices");
    databases: typeof import("@/modules/databases/instances");
    topology: typeof import("@/modules/topology/service");
  };

  const runId = randomBytes(4).toString("hex");
  const domain = `${runId}.test`;
  let counter = 0;

  const orgIds: string[] = [];

  interface Fixture {
    orgId: string;
    owner: Actor;
    admin: Actor;
    operator: Actor;
    viewer: Actor;
  }

  async function makeOrg(label: string): Promise<Fixture> {
    const org = await db.organization.create({ data: { name: `${label}-${runId}`, slug: `${label}-${runId}-${++counter}` } });
    orgIds.push(org.id);
    const actors = {} as Record<Role, Actor>;
    for (const role of ["OWNER", "ADMIN", "OPERATOR", "VIEWER"] as Role[]) {
      const email = `${label}-${role.toLowerCase()}-${++counter}@${domain}`;
      const user = await db.user.create({ data: { email, name: label, passwordHash: "x" } });
      await db.membership.create({ data: { userId: user.id, orgId: org.id, role } });
      actors[role] = { userId: user.id, email, orgId: org.id, role, ip: "203.0.113.9" };
    }
    return { orgId: org.id, owner: actors.OWNER, admin: actors.ADMIN, operator: actors.OPERATOR, viewer: actors.VIEWER };
  }

  beforeAll(async () => {
    db = (await import("@/lib/prisma")).getPrisma();
    m = {
      endpoints: await import("@/modules/saas/endpoints"),
      devices: await import("@/modules/network/devices"),
      databases: await import("@/modules/databases/instances"),
      topology: await import("@/modules/topology/service"),
    };
  });

  afterAll(async () => {
    if (!db) return;
    await db.auditLog.deleteMany({ where: { orgId: { in: orgIds } } });
    await db.organization.deleteMany({ where: { id: { in: orgIds } } });
    await db.user.deleteMany({ where: { email: { endsWith: `@${domain}` } } });
  });

  describe("endpoints (saas)", () => {
    const input = {
      name: "Public site",
      url: "https://example.com/health",
      method: "GET" as const,
      expectedStatus: 200,
      intervalSec: 60,
      timeoutMs: 5000,
      tags: ["prod"],
      followRedirects: true,
      verifySsl: true,
      slaTargetPercent: 99.9,
    };

    it("enforces write permission and rejects non-http(s) URLs", async () => {
      const fx = await makeOrg("ep-perm");
      expect(await m.endpoints.createEndpoint(db, fx.viewer, input)).toEqual({ ok: false, error: "forbidden" });
      expect(await m.endpoints.createEndpoint(db, fx.operator, input)).toEqual({ ok: false, error: "forbidden" });
      expect(await m.endpoints.createEndpoint(db, fx.admin, { ...input, url: "file:///etc/passwd" })).toEqual({ ok: false, error: "invalid_url" });
      expect(await m.endpoints.createEndpoint(db, fx.admin, { ...input, url: "not a url" })).toEqual({ ok: false, error: "invalid_url" });
    });

    it("creates, lists, updates, toggles and deletes, scoped by organization", async () => {
      const a = await makeOrg("ep-a");
      const b = await makeOrg("ep-b");

      const created = await m.endpoints.createEndpoint(db, a.admin, input);
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const listA = await m.endpoints.listEndpoints(db, a.viewer);
      expect(listA.ok && listA.value).toHaveLength(1);
      const listB = await m.endpoints.listEndpoints(db, b.viewer);
      expect(listB.ok && listB.value).toHaveLength(0);

      // Cross-tenant access is invisible, reported the same as "does not exist".
      expect(await m.endpoints.updateEndpoint(db, b.admin, created.value.id, input)).toEqual({ ok: false, error: "not_found" });
      expect(await m.endpoints.setEndpointEnabled(db, b.admin, created.value.id, false)).toEqual({ ok: false, error: "not_found" });
      expect(await m.endpoints.deleteEndpoint(db, b.admin, created.value.id)).toEqual({ ok: false, error: "not_found" });

      const updated = await m.endpoints.updateEndpoint(db, a.admin, created.value.id, { ...input, name: "Renamed", slaTargetPercent: 99.5 });
      expect(updated.ok).toBe(true);
      const afterUpdate = await m.endpoints.listEndpoints(db, a.admin);
      expect(afterUpdate.ok && afterUpdate.value[0]?.name).toBe("Renamed");
      expect(afterUpdate.ok && afterUpdate.value[0]?.slaTargetPercent).toBe(99.5);

      expect(await m.endpoints.setEndpointEnabled(db, a.operator, created.value.id, false)).toEqual({ ok: false, error: "forbidden" });
      const disabled = await m.endpoints.setEndpointEnabled(db, a.admin, created.value.id, false);
      expect(disabled.ok).toBe(true);
      const afterDisable = await m.endpoints.listEndpoints(db, a.admin);
      expect(afterDisable.ok && afterDisable.value[0]?.enabled).toBe(false);

      expect(await m.endpoints.deleteEndpoint(db, a.viewer, created.value.id)).toEqual({ ok: false, error: "forbidden" });
      const deleted = await m.endpoints.deleteEndpoint(db, a.admin, created.value.id);
      expect(deleted.ok).toBe(true);
      const afterDelete = await m.endpoints.listEndpoints(db, a.admin);
      expect(afterDelete.ok && afterDelete.value).toHaveLength(0);
    });
  });

  describe("network devices", () => {
    const input = {
      name: "core-switch-01",
      ipAddress: "10.20.0.1",
      type: "SWITCH" as const,
      tags: ["core"],
      pollerHostId: null,
      pollIntervalSec: 60,
      snmpVersion: "V2C" as const,
      snmpPort: 161,
      snmpTimeoutMs: 3000,
      snmpRetries: 1,
      snmpCommunity: "public",
    };

    it("enforces write permission and rejects invalid input", async () => {
      const fx = await makeOrg("dev-perm");
      expect(await m.devices.registerDevice(db, fx.viewer, input)).toEqual({ ok: false, error: "forbidden" });
      expect(await m.devices.registerDevice(db, fx.admin, { ...input, ipAddress: "not-an-ip" })).toEqual({ ok: false, error: "invalid_ip" });
      expect(await m.devices.registerDevice(db, fx.admin, { ...input, pollerHostId: "does-not-exist" })).toEqual({ ok: false, error: "invalid_poller" });
    });

    it("accepts a poller from the same org, and rejects one from another org", async () => {
      const a = await makeOrg("dev-a");
      const b = await makeOrg("dev-b");
      const hostA = await db.monitoredHost.create({
        data: { orgId: a.orgId, hostname: "poller-a.example", keyId: `ikm_${randomBytes(6).toString("hex")}`, hmacSecretEnc: "v1:aa:bb:cc" },
      });

      expect((await m.devices.registerDevice(db, a.admin, { ...input, ipAddress: "10.20.0.2", pollerHostId: hostA.id })).ok).toBe(true);
      expect(await m.devices.registerDevice(db, b.admin, { ...input, ipAddress: "10.20.0.3", pollerHostId: hostA.id })).toEqual({
        ok: false,
        error: "invalid_poller",
      });
    });

    it("registers, lists (secrets never exposed), updates, toggles and deletes, scoped by organization", async () => {
      const a = await makeOrg("dev-crud-a");
      const b = await makeOrg("dev-crud-b");

      const created = await m.devices.registerDevice(db, a.admin, input);
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const listA = await m.devices.listDevices(db, a.viewer);
      expect(listA.ok && listA.value).toHaveLength(1);
      expect(listA.ok && (listA.value[0] as unknown as { snmpCommunityEnc?: string }).snmpCommunityEnc).toBeUndefined();
      expect(listA.ok && listA.value[0]?.hasSecret).toBe(true);
      const listB = await m.devices.listDevices(db, b.viewer);
      expect(listB.ok && listB.value).toHaveLength(0);

      expect(await m.devices.updateDevice(db, b.admin, created.value.id, input)).toEqual({ ok: false, error: "not_found" });
      expect(await m.devices.deleteDevice(db, b.admin, created.value.id)).toEqual({ ok: false, error: "not_found" });

      const rename = await m.devices.updateDevice(db, a.admin, created.value.id, { ...input, name: "core-switch-01b" });
      expect(rename.ok).toBe(true);

      // Registering a second device on the same IP within the same org is rejected; a different org may reuse it.
      expect(await m.devices.registerDevice(db, a.admin, input)).toEqual({ ok: false, error: "ip_taken" });
      expect((await m.devices.registerDevice(db, b.admin, input)).ok).toBe(true);

      expect(await m.devices.setDeviceEnabled(db, a.operator, created.value.id, false)).toEqual({ ok: false, error: "forbidden" });
      expect((await m.devices.setDeviceEnabled(db, a.admin, created.value.id, false)).ok).toBe(true);

      const deleted = await m.devices.deleteDevice(db, a.admin, created.value.id);
      expect(deleted.ok).toBe(true);
      const afterDelete = await m.devices.listDevices(db, a.admin);
      expect(afterDelete.ok && afterDelete.value).toHaveLength(0);
    });
  });

  describe("database instances", () => {
    // Instances are auto-discovered by ingestion (modules/databases/ingest.ts): fixtures simulate
    // that upsert directly, there is no "register" business function to call here.
    it("lets an administrator adjust settings and scope by tenant, but never register or delete", async () => {
      const a = await makeOrg("db-a");
      const b = await makeOrg("db-b");
      const instance = await db.databaseInstance.create({
        data: { orgId: a.orgId, name: "main", engine: "POSTGRESQL", slowQueryThresholdMs: 1000 },
      });

      const listA = await m.databases.listDatabases(db, a.viewer);
      expect(listA.ok && listA.value).toHaveLength(1);
      const listB = await m.databases.listDatabases(db, b.viewer);
      expect(listB.ok && listB.value).toHaveLength(0);

      expect(await m.databases.updateDatabaseSettings(db, a.viewer, instance.id, { tags: [], slowQueryThresholdMs: 500 })).toEqual({
        ok: false,
        error: "forbidden",
      });
      expect(await m.databases.updateDatabaseSettings(db, b.admin, instance.id, { tags: [], slowQueryThresholdMs: 500 })).toEqual({
        ok: false,
        error: "not_found",
      });
      const updated = await m.databases.updateDatabaseSettings(db, a.admin, instance.id, { tags: ["critical"], slowQueryThresholdMs: 250 });
      expect(updated.ok).toBe(true);
      const afterUpdate = await m.databases.listDatabases(db, a.admin);
      expect(afterUpdate.ok && afterUpdate.value[0]).toMatchObject({ tags: ["critical"], slowQueryThresholdMs: 250 });

      expect((await m.databases.setDatabaseEnabled(db, a.admin, instance.id, false)).ok).toBe(true);
      const afterDisable = await m.databases.listDatabases(db, a.admin);
      expect(afterDisable.ok && afterDisable.value[0]?.enabled).toBe(false);
    });
  });

  describe("topology", () => {
    it("rejects a ref from another tenant, allows several logical nodes, and links dependencies within one org", async () => {
      const a = await makeOrg("topo-a");
      const b = await makeOrg("topo-b");
      const hostB = await db.monitoredHost.create({
        data: { orgId: b.orgId, hostname: "b-host.example", keyId: `ikm_${randomBytes(6).toString("hex")}`, hmacSecretEnc: "v1:aa:bb:cc" },
      });

      // A host that belongs to org B cannot become a node in org A.
      expect(await m.topology.createNode(db, a.admin, { kind: "HOST", refId: hostB.id, label: "x", positionX: 0, positionY: 0 })).toEqual({
        ok: false,
        error: "invalid_ref",
      });

      const web = await m.topology.createNode(db, a.admin, { kind: "SERVICE", refId: null, label: "web", positionX: 0, positionY: 0 });
      const api = await m.topology.createNode(db, a.admin, { kind: "SERVICE", refId: null, label: "api", positionX: 0, positionY: 0 });
      expect(web.ok && api.ok).toBe(true);
      if (!web.ok || !api.ok) return;

      expect(await m.topology.createNode(db, a.viewer, { kind: "SERVICE", refId: null, label: "nope", positionX: 0, positionY: 0 })).toEqual({
        ok: false,
        error: "forbidden",
      });

      const dependency = await m.topology.createDependency(db, a.admin, {
        parentNodeId: web.value.id,
        childNodeId: api.value.id,
        kind: "DEPENDS_ON",
        criticality: "CRITICAL",
      });
      expect(dependency.ok).toBe(true);
      expect(
        await m.topology.createDependency(db, a.admin, { parentNodeId: web.value.id, childNodeId: api.value.id, kind: "DEPENDS_ON", criticality: "WARNING" }),
      ).toEqual({ ok: false, error: "already_exists" });
      // A node from another org cannot be linked into this org's graph.
      const bNode = await m.topology.createNode(db, b.admin, { kind: "SERVICE", refId: null, label: "b-web", positionX: 0, positionY: 0 });
      expect(bNode.ok).toBe(true);
      if (bNode.ok) {
        expect(await m.topology.createDependency(db, a.admin, { parentNodeId: web.value.id, childNodeId: bNode.value.id, kind: "DEPENDS_ON", criticality: "INFO" })).toEqual(
          { ok: false, error: "invalid_ref" },
        );
      }

      const graph = await m.topology.listTopology(db, a.viewer);
      expect(graph.ok && graph.value.nodes).toHaveLength(2);
      expect(graph.ok && graph.value.edges).toHaveLength(1);

      if (dependency.ok) {
        expect(await m.topology.deleteDependency(db, a.viewer, dependency.value.id)).toEqual({ ok: false, error: "forbidden" });
        expect((await m.topology.deleteDependency(db, a.admin, dependency.value.id)).ok).toBe(true);
      }
      expect((await m.topology.deleteNode(db, a.admin, web.value.id)).ok).toBe(true);
      const afterDelete = await m.topology.listTopology(db, a.admin);
      expect(afterDelete.ok && afterDelete.value.nodes).toHaveLength(1);
    });

    it("persists a dragged node's position", async () => {
      const a = await makeOrg("topo-pos");
      const node = await m.topology.createNode(db, a.admin, { kind: "EXTERNAL", refId: null, label: "cdn", positionX: 0, positionY: 0 });
      expect(node.ok).toBe(true);
      if (!node.ok) return;
      expect((await m.topology.updateNodePosition(db, a.admin, node.value.id, 120, 340)).ok).toBe(true);
      const graph = await m.topology.listTopology(db, a.admin);
      expect(graph.ok && graph.value.nodes[0]).toMatchObject({ positionX: 120, positionY: 340 });
    });
  });
});
