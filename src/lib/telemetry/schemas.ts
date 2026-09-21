import { z } from "zod";

/**
 * Wire format of the telemetry sent by `ikelyane-agent` (schemaVersion 1).
 *
 * Rules that apply everywhere:
 *  • Every collection is BOUNDED (max array length / string length): the body size limit protects
 *    the parser, these limits protect the database and the UI from a misbehaving agent.
 *  • Numbers must be finite. Percentages are 0–100, ratios 0–1, byte counts safe integers.
 *  • Unknown extra fields are ignored (forward compatibility with newer agents), never stored.
 *  • Enumerations are lower-case on the wire; they are mapped to the Prisma enums on ingestion.
 */

// ── Primitives ────────────────────────────────────────────────────────────────────────────────

const timestamp = z.iso.datetime({ offset: true });
const percent = z.number().min(0).max(100);
const ratio = z.number().min(0).max(1);
const nonNegative = z.number().min(0);
const bytes = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const shortText = z.string().trim().min(1).max(255);
const longText = z.string().max(2000);

/** Counters read from devices (SNMP Counter64) — cumulative, non-negative, JS-safe integers. */
const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

// ── SystemMetrics — one host, reported by its own agent ───────────────────────────────────────

export const OS_FAMILIES = ["windows", "linux", "macos", "unix", "other"] as const;

export const HostInventorySchema = z.object({
  osFamily: z.enum(OS_FAMILIES),
  osName: shortText.optional(),
  osVersion: shortText.optional(),
  kernelVersion: shortText.optional(),
  arch: z.string().trim().min(1).max(32).optional(),
  cpuModel: shortText.optional(),
  cpuCores: z.number().int().min(1).max(4096).optional(),
  cpuThreads: z.number().int().min(1).max(8192).optional(),
  cpuFrequencyMhz: z.number().int().min(1).max(20000).optional(),
  memoryTotalBytes: bytes.optional(),
  diskTotalBytes: bytes.optional(),
  ipAddresses: z.array(z.union([z.ipv4(), z.ipv6()])).max(32).optional(),
  macAddress: z.string().trim().max(64).optional(),
  virtualization: z.string().trim().max(64).optional(),
  cloudProvider: z.string().trim().max(64).optional(),
  cloudRegion: z.string().trim().max(64).optional(),
  agentVersion: z.string().trim().max(64).optional(),
});

export const SystemMetricsSchema = z.object({
  collectedAt: timestamp,
  /** Sent at startup and whenever it changes; optional on regular samples. */
  inventory: HostInventorySchema.optional(),
  cpu: z
    .object({
      usagePercent: percent,
      loadAverage1m: nonNegative.optional(),
    })
    .optional(),
  memory: z
    .object({
      usedPercent: percent.optional(),
      usedBytes: bytes.optional(),
      swapUsedPercent: percent.optional(),
    })
    .optional(),
  disks: z
    .array(
      z.object({
        /** Mount point ("/", "C:\\") — becomes the metric `instance`. */
        mount: z.string().trim().min(1).max(255),
        /** Block device ("sda", "nvme0n1"); used as `instance` for IOPS/throughput when present. */
        device: z.string().trim().min(1).max(128).optional(),
        usedPercent: percent.optional(),
        usedBytes: bytes.optional(),
        readIops: nonNegative.optional(),
        writeIops: nonNegative.optional(),
        readBps: nonNegative.optional(),
        writeBps: nonNegative.optional(),
      }),
    )
    .max(64)
    .optional(),
  network: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(128),
        /** bits per second */
        inBps: nonNegative,
        outBps: nonNegative,
      }),
    )
    .max(64)
    .optional(),
  processCount: z.number().int().min(0).max(10_000_000).optional(),
  uptimeSeconds: nonNegative.optional(),
  temperatures: z
    .array(
      z.object({
        sensor: z.string().trim().min(1).max(128),
        celsius: z.number().min(-100).max(300),
      }),
    )
    .max(64)
    .optional(),
  /** Measured (IPMI / RAPL) power draw of the whole machine, in watts. */
  powerWatts: nonNegative.max(1_000_000).optional(),
});

// ── SNMPDevices — network equipment polled locally by the agent ───────────────────────────────

export const DEVICE_TYPES = ["router", "switch", "firewall", "ap", "ups", "bmc", "other"] as const;
export const OPER_STATUSES = ["up", "down", "testing", "unknown"] as const;
export const SNMP_VERSIONS = ["v1", "v2c", "v3"] as const;

export const SnmpInterfaceSchema = z.object({
  /** ifIndex — stable identifier of the port on the device. */
  ifIndex: z.number().int().min(0).max(2_147_483_647),
  /** ifName, e.g. "Gi1/0/24". */
  name: shortText,
  alias: z.string().trim().max(255).optional(),
  description: z.string().trim().max(255).optional(),
  macAddress: z.string().trim().max(64).optional(),
  speedMbps: z.number().int().min(0).max(100_000_000).optional(),
  mtu: z.number().int().min(0).max(65535).optional(),
  adminStatus: z.enum(OPER_STATUSES).optional(),
  operStatus: z.enum(OPER_STATUSES),
  /** Throughput computed by the agent from counter deltas, bits per second. */
  inBps: nonNegative,
  outBps: nonNegative,
  utilizationPercent: percent.optional(),
  packetLossPercent: percent.optional(),
  /** Cumulative counters as read from the device. */
  inErrors: counter.optional(),
  outErrors: counter.optional(),
  crcErrors: counter.optional(),
  inDiscards: counter.optional(),
  outDiscards: counter.optional(),
  /** Error rates computed by the agent (events per second), stored as time series. */
  errorsPerSec: nonNegative.optional(),
  crcErrorsPerSec: nonNegative.optional(),
  lastChangeAt: timestamp.optional(),
});

export const SnmpDeviceSchema = z.object({
  collectedAt: timestamp,
  device: z.object({
    ipAddress: z.union([z.ipv4(), z.ipv6()]),
    name: shortText.optional(),
    type: z.enum(DEVICE_TYPES).optional(),
    vendor: shortText.optional(),
    model: shortText.optional(),
    firmwareVersion: shortText.optional(),
    serialNumber: shortText.optional(),
    sysName: shortText.optional(),
    sysDescr: longText.optional(),
    sysLocation: shortText.optional(),
    sysContact: shortText.optional(),
    uptimeSeconds: nonNegative.optional(),
    snmpVersion: z.enum(SNMP_VERSIONS).optional(),
    /** false when the SNMP poll failed: the device is then reported DOWN. */
    reachable: z.boolean(),
    latencyMs: nonNegative.optional(),
    temperatureCelsius: z.number().min(-100).max(300).optional(),
    powerWatts: nonNegative.max(1_000_000).optional(),
  }),
  interfaces: z.array(SnmpInterfaceSchema).max(1024).default([]),
});

export const SNMPDevicesSchema = z.array(SnmpDeviceSchema).max(200);

// ── DatabaseMetrics — database engines reachable from the agent ───────────────────────────────

export const DATABASE_ENGINES = ["postgresql", "mysql", "mariadb", "mongodb", "redis", "mssql"] as const;

export const SlowQuerySchema = z.object({
  capturedAt: timestamp,
  /** Hash of the NORMALIZED statement (literals replaced by placeholders). */
  fingerprint: z.string().trim().min(1).max(128),
  /** Normalized, truncated statement text — the agent must never send raw literals. */
  queryText: z.string().max(4000).optional(),
  durationMs: nonNegative,
  calls: z.number().int().min(1).max(1_000_000_000).optional(),
  rowsExamined: bytes.optional(),
  rowsReturned: bytes.optional(),
  databaseName: z.string().trim().max(128).optional(),
  userName: z.string().trim().max(128).optional(),
});

export const DatabaseMetricSchema = z.object({
  collectedAt: timestamp,
  instance: z.object({
    /** Stable identifier chosen by the agent, unique per host + engine (e.g. "main:5432"). */
    name: z.string().trim().min(1).max(128),
    engine: z.enum(DATABASE_ENGINES),
    version: z.string().trim().max(64).optional(),
    /**
     * Address for display ("10.0.0.5:5432"). Credentials must never travel here: anything that
     * looks like userinfo ("user:pass@host", a URL with "@") is rejected.
     */
    endpoint: z
      .string()
      .trim()
      .max(255)
      .refine((value) => !value.includes("@"), "must not contain credentials")
      .optional(),
    isReplica: z.boolean().optional(),
    storageQuotaBytes: bytes.optional(),
    maxConnections: z.number().int().min(0).max(10_000_000).optional(),
    slowQueryThresholdMs: z.number().int().min(1).max(3_600_000).optional(),
  }),
  reachable: z.boolean().default(true),
  metrics: z
    .object({
      qps: nonNegative.optional(),
      activeConnections: z.number().int().min(0).max(10_000_000).optional(),
      /** Derived by the server from maxConnections when omitted. */
      connectionUsagePercent: percent.optional(),
      cacheHitRatio: ratio.optional(),
      slowQueriesPerMin: nonNegative.optional(),
      deadlocksPerMin: nonNegative.optional(),
      deadlocksTotal: counter.optional(),
      replicationLagSeconds: nonNegative.optional(),
      storageUsedBytes: bytes.optional(),
    })
    .default({}),
  slowQueries: z.array(SlowQuerySchema).max(100).default([]),
});

export const DatabaseMetricsSchema = z.array(DatabaseMetricSchema).max(100);

// ── Envelope ──────────────────────────────────────────────────────────────────────────────────

export const TELEMETRY_SCHEMA_VERSION = 1;

export const TelemetryPayloadSchema = z
  .object({
    schemaVersion: z.literal(TELEMETRY_SCHEMA_VERSION),
    /** When the agent built the request (used for diagnostics, not for the metrics' own times). */
    sentAt: timestamp,
    agent: z.object({ version: z.string().trim().min(1).max(64) }),
    system: SystemMetricsSchema.optional(),
    snmpDevices: SNMPDevicesSchema.optional(),
    databases: DatabaseMetricsSchema.optional(),
  })
  .refine((payload) => payload.system || payload.snmpDevices?.length || payload.databases?.length, {
    message: "at least one of system, snmpDevices or databases must be provided",
    path: [],
  });

export type HostInventory = z.infer<typeof HostInventorySchema>;
export type SystemMetrics = z.infer<typeof SystemMetricsSchema>;
export type SnmpInterface = z.infer<typeof SnmpInterfaceSchema>;
export type SnmpDevice = z.infer<typeof SnmpDeviceSchema>;
export type SlowQuery = z.infer<typeof SlowQuerySchema>;
export type DatabaseMetric = z.infer<typeof DatabaseMetricSchema>;
export type TelemetryPayload = z.infer<typeof TelemetryPayloadSchema>;
