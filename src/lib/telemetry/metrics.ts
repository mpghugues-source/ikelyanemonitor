import { MetricSource, MetricType, type Prisma } from "@/generated/prisma/client";
import { TelemetryHttpError } from "@/lib/telemetry/errors";
import type { DatabaseMetric, SnmpDevice, SystemMetrics } from "@/lib/telemetry/schemas";

/** One row of the `metric_entries` hypertable. */
export type MetricRow = Prisma.MetricEntryCreateManyInput;

export interface IngestContext {
  /** Server time at reception. */
  now: Date;
  /** Data points older than this are refused (the agent's buffer replay window). */
  maxBackfillMs: number;
  /** Data points further in the future than this are refused (bad agent clock). */
  maxSkewMs: number;
}

/**
 * Parse an agent timestamp and make sure it is plausible. A point far in the future would sit in
 * the hypertable "ahead" of every query and never expire; a point beyond the backfill window would
 * land in a chunk that retention may already have dropped.
 */
export function parseCollectedAt(iso: string, ctx: IngestContext, label: string): Date {
  const time = new Date(iso);
  const age = ctx.now.getTime() - time.getTime();
  if (Number.isNaN(time.getTime()) || age > ctx.maxBackfillMs || age < -ctx.maxSkewMs) {
    throw new TelemetryHttpError(
      422,
      "timestamp_out_of_range",
      `${label}: collectedAt (${iso}) is too old or too far in the future compared to server time ${ctx.now.toISOString()}.`,
    );
  }
  return time;
}

/** Accumulates the metric rows of one source at one instant, skipping absent values. */
class RowCollector {
  readonly rows: MetricRow[] = [];

  constructor(
    private readonly orgId: string,
    private readonly sourceKind: MetricSource,
    private readonly sourceId: string,
    private readonly time: Date,
  ) {}

  add(metric: MetricType, value: number | undefined | null, instance = ""): void {
    if (value === undefined || value === null || !Number.isFinite(value)) return;
    this.rows.push({
      time: this.time,
      orgId: this.orgId,
      sourceKind: this.sourceKind,
      sourceId: this.sourceId,
      metric,
      instance,
      value,
    });
  }
}

/** Host metrics. `sourceId` is the monitored host's id. */
export function systemMetricRows(orgId: string, hostId: string, system: SystemMetrics, time: Date): MetricRow[] {
  const c = new RowCollector(orgId, MetricSource.HOST, hostId, time);

  c.add(MetricType.CPU_USAGE_PERCENT, system.cpu?.usagePercent);
  c.add(MetricType.LOAD_AVERAGE_1M, system.cpu?.loadAverage1m);
  c.add(MetricType.MEMORY_USED_PERCENT, system.memory?.usedPercent);
  c.add(MetricType.MEMORY_USED_BYTES, system.memory?.usedBytes);
  c.add(MetricType.SWAP_USED_PERCENT, system.memory?.swapUsedPercent);

  for (const disk of system.disks ?? []) {
    // Capacity is per mount point; I/O is per block device (fall back to the mount point).
    c.add(MetricType.DISK_USED_PERCENT, disk.usedPercent, disk.mount);
    c.add(MetricType.DISK_USED_BYTES, disk.usedBytes, disk.mount);
    const ioInstance = disk.device ?? disk.mount;
    c.add(MetricType.DISK_READ_IOPS, disk.readIops, ioInstance);
    c.add(MetricType.DISK_WRITE_IOPS, disk.writeIops, ioInstance);
    c.add(MetricType.DISK_READ_BPS, disk.readBps, ioInstance);
    c.add(MetricType.DISK_WRITE_BPS, disk.writeBps, ioInstance);
  }

  for (const nic of system.network ?? []) {
    c.add(MetricType.NETWORK_IN_BPS, nic.inBps, nic.name);
    c.add(MetricType.NETWORK_OUT_BPS, nic.outBps, nic.name);
  }

  for (const sensor of system.temperatures ?? []) {
    c.add(MetricType.TEMPERATURE_CELSIUS, sensor.celsius, sensor.sensor);
  }

  c.add(MetricType.PROCESS_COUNT, system.processCount);
  c.add(MetricType.UPTIME_SECONDS, system.uptimeSeconds);
  c.add(MetricType.POWER_WATTS, system.powerWatts);
  return c.rows;
}

/**
 * Network device metrics. Per-port series are stored against the DEVICE with `instance` = port name
 * (same convention as disks on a host), so no per-interface id lookup is needed on the hot path.
 */
export function deviceMetricRows(orgId: string, deviceId: string, snmp: SnmpDevice, time: Date): MetricRow[] {
  const c = new RowCollector(orgId, MetricSource.NETWORK_DEVICE, deviceId, time);
  const { device } = snmp;

  c.add(MetricType.LATENCY_MS, device.latencyMs);
  c.add(MetricType.UPTIME_SECONDS, device.uptimeSeconds);
  c.add(MetricType.TEMPERATURE_CELSIUS, device.temperatureCelsius);
  c.add(MetricType.POWER_WATTS, device.powerWatts);

  for (const port of snmp.interfaces) {
    c.add(MetricType.BANDWIDTH_IN_BPS, port.inBps, port.name);
    c.add(MetricType.BANDWIDTH_OUT_BPS, port.outBps, port.name);
    c.add(MetricType.BANDWIDTH_UTILIZATION_PERCENT, port.utilizationPercent, port.name);
    c.add(MetricType.PACKET_LOSS_PERCENT, port.packetLossPercent, port.name);
    c.add(MetricType.INTERFACE_ERRORS_PER_SEC, port.errorsPerSec, port.name);
    c.add(MetricType.INTERFACE_CRC_ERRORS_PER_SEC, port.crcErrorsPerSec, port.name);
  }
  return c.rows;
}

/** Database metrics. `maxConnections` (from the stored instance) lets the server derive usage %. */
export function databaseMetricRows(
  orgId: string,
  dbId: string,
  db: DatabaseMetric,
  time: Date,
  maxConnections: number | null,
): MetricRow[] {
  const c = new RowCollector(orgId, MetricSource.DATABASE, dbId, time);
  const m = db.metrics;

  let usage = m.connectionUsagePercent;
  if (usage === undefined && m.activeConnections !== undefined && maxConnections && maxConnections > 0) {
    usage = Math.min(100, (m.activeConnections / maxConnections) * 100);
  }

  c.add(MetricType.DB_QPS, m.qps);
  c.add(MetricType.DB_ACTIVE_CONNECTIONS, m.activeConnections);
  c.add(MetricType.DB_CONNECTION_USAGE_PERCENT, usage);
  c.add(MetricType.DB_CACHE_HIT_RATIO, m.cacheHitRatio);
  c.add(MetricType.DB_SLOW_QUERIES_PER_MIN, m.slowQueriesPerMin);
  c.add(MetricType.DB_DEADLOCKS_PER_MIN, m.deadlocksPerMin);
  c.add(MetricType.DB_REPLICATION_LAG_SECONDS, m.replicationLagSeconds);
  c.add(MetricType.DB_STORAGE_USED_BYTES, m.storageUsedBytes);
  return c.rows;
}
