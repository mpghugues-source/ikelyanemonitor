import { describe, expect, it } from "vitest";
import {
  DatabaseMetricsSchema,
  SNMPDevicesSchema,
  SystemMetricsSchema,
  TelemetryPayloadSchema,
} from "@/lib/telemetry/schemas";

const T = "2026-09-21T20:00:00Z";

const system = {
  collectedAt: T,
  inventory: { osFamily: "linux", cpuCores: 8, ipAddresses: ["10.0.0.5", "fe80::1"] },
  cpu: { usagePercent: 42.5, loadAverage1m: 1.2 },
  memory: { usedPercent: 63, usedBytes: 5_000_000_000 },
  disks: [{ mount: "/", device: "nvme0n1", usedPercent: 71, readIops: 120, writeIops: 80 }],
  network: [{ name: "eth0", inBps: 1_000_000, outBps: 250_000 }],
  temperatures: [{ sensor: "cpu0", celsius: 55 }],
};

const snmp = {
  collectedAt: T,
  device: { ipAddress: "192.168.1.1", type: "router", reachable: true, latencyMs: 2.1 },
  interfaces: [{ ifIndex: 1, name: "Gi0/1", operStatus: "up", inBps: 1000, outBps: 2000, crcErrors: 3 }],
};

const database = {
  collectedAt: T,
  instance: { name: "main:5432", engine: "postgresql", endpoint: "10.0.0.9:5432" },
  metrics: { qps: 250, cacheHitRatio: 0.98, deadlocksPerMin: 0 },
  slowQueries: [{ capturedAt: T, fingerprint: "abc123", durationMs: 2300 }],
};

describe("SystemMetrics", () => {
  it("accepts a full realistic sample", () => {
    expect(SystemMetricsSchema.safeParse(system).success).toBe(true);
  });

  it("accepts a minimal sample (timestamp only)", () => {
    expect(SystemMetricsSchema.safeParse({ collectedAt: T }).success).toBe(true);
  });

  it.each([
    ["cpu over 100 %", { ...system, cpu: { usagePercent: 100.1 } }],
    ["negative memory percent", { ...system, memory: { usedPercent: -1 } }],
    ["unknown OS family", { ...system, inventory: { osFamily: "beos" } }],
    ["bad IP in inventory", { ...system, inventory: { osFamily: "linux", ipAddresses: ["999.1.1.1"] } }],
    ["impossible temperature", { ...system, temperatures: [{ sensor: "x", celsius: 9999 }] }],
    ["non-ISO timestamp", { ...system, collectedAt: "yesterday" }],
    ["timestamp without timezone", { ...system, collectedAt: "2026-09-21T20:00:00" }],
    ["negative throughput", { ...system, network: [{ name: "eth0", inBps: -5, outBps: 0 }] }],
    ["too many disks", { ...system, disks: Array.from({ length: 65 }, (_, i) => ({ mount: `/m${i}` })) }],
  ])("rejects %s", (_label, payload) => {
    expect(SystemMetricsSchema.safeParse(payload).success).toBe(false);
  });

  it("rejects non-finite numbers", () => {
    expect(SystemMetricsSchema.safeParse({ collectedAt: T, cpu: { usagePercent: Number.NaN } }).success).toBe(false);
    expect(SystemMetricsSchema.safeParse({ collectedAt: T, cpu: { usagePercent: Infinity } }).success).toBe(false);
  });

  it("strips unknown fields (forward compatibility) instead of failing or storing them", () => {
    const parsed = SystemMetricsSchema.parse({ ...system, futureField: "x" });
    expect(parsed).not.toHaveProperty("futureField");
  });
});

describe("SNMPDevices", () => {
  it("accepts a device with interfaces", () => {
    expect(SNMPDevicesSchema.safeParse([snmp]).success).toBe(true);
  });

  it("defaults to an empty interface list", () => {
    expect(SNMPDevicesSchema.parse([{ collectedAt: T, device: { ipAddress: "10.1.1.1", reachable: false } }])[0].interfaces).toEqual([]);
  });

  it.each([
    ["missing reachable flag", [{ collectedAt: T, device: { ipAddress: "10.1.1.1" } }]],
    ["hostname instead of IP", [{ collectedAt: T, device: { ipAddress: "router.local", reachable: true } }]],
    ["bad operStatus", [{ ...snmp, interfaces: [{ ...snmp.interfaces[0], operStatus: "sideways" }] }]],
    ["packet loss over 100 %", [{ ...snmp, interfaces: [{ ...snmp.interfaces[0], packetLossPercent: 101 }] }]],
    ["negative CRC counter", [{ ...snmp, interfaces: [{ ...snmp.interfaces[0], crcErrors: -1 }] }]],
    ["fractional counter", [{ ...snmp, interfaces: [{ ...snmp.interfaces[0], crcErrors: 1.5 }] }]],
    ["more than 200 devices", Array.from({ length: 201 }, () => snmp)],
  ])("rejects %s", (_label, payload) => {
    expect(SNMPDevicesSchema.safeParse(payload).success).toBe(false);
  });
});

describe("DatabaseMetrics", () => {
  it("accepts a database with slow queries", () => {
    expect(DatabaseMetricsSchema.safeParse([database]).success).toBe(true);
  });

  it("refuses credentials smuggled into the endpoint", () => {
    const bad = { ...database, instance: { ...database.instance, endpoint: "postgres://admin:hunter2@10.0.0.9/db" } };
    const result = DatabaseMetricsSchema.safeParse([bad]);
    expect(result.success).toBe(false);
  });

  it.each([
    ["cache hit ratio above 1 (percent sent instead of ratio)", { ...database, metrics: { cacheHitRatio: 98 } }],
    ["unknown engine", { ...database, instance: { ...database.instance, engine: "oracle" } }],
    ["negative slow-query duration", { ...database, slowQueries: [{ ...database.slowQueries[0], durationMs: -1 }] }],
    ["over 100 slow queries", { ...database, slowQueries: Array.from({ length: 101 }, () => database.slowQueries[0]) }],
    ["oversized query text", { ...database, slowQueries: [{ ...database.slowQueries[0], queryText: "x".repeat(4001) }] }],
  ])("rejects %s", (_label, payload) => {
    expect(DatabaseMetricsSchema.safeParse([payload]).success).toBe(false);
  });
});

describe("TelemetryPayload envelope", () => {
  const base = { schemaVersion: 1, sentAt: T, agent: { version: "0.1.0" } };

  it("accepts each section on its own and all together", () => {
    expect(TelemetryPayloadSchema.safeParse({ ...base, system }).success).toBe(true);
    expect(TelemetryPayloadSchema.safeParse({ ...base, snmpDevices: [snmp] }).success).toBe(true);
    expect(TelemetryPayloadSchema.safeParse({ ...base, databases: [database] }).success).toBe(true);
    expect(TelemetryPayloadSchema.safeParse({ ...base, system, snmpDevices: [snmp], databases: [database] }).success).toBe(true);
  });

  it("refuses an empty envelope", () => {
    expect(TelemetryPayloadSchema.safeParse(base).success).toBe(false);
    expect(TelemetryPayloadSchema.safeParse({ ...base, snmpDevices: [], databases: [] }).success).toBe(false);
  });

  it("refuses an unsupported schema version and a missing agent", () => {
    expect(TelemetryPayloadSchema.safeParse({ ...base, schemaVersion: 2, system }).success).toBe(false);
    expect(TelemetryPayloadSchema.safeParse({ schemaVersion: 1, sentAt: T, system }).success).toBe(false);
  });
});
