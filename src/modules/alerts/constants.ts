import { AlertOperator, AnomalySensitivity, MetricSource, MetricType, NotificationChannel, Severity } from "@/generated/prisma/enums";

/** Client-safe: no Node builtins, no database access — usable from "use client" form components. */

export const ALERT_SEVERITIES: readonly Severity[] = [Severity.INFO, Severity.WARNING, Severity.CRITICAL];

export const ALERT_OPERATORS: readonly AlertOperator[] = [
  AlertOperator.GT, AlertOperator.GTE, AlertOperator.LT, AlertOperator.LTE, AlertOperator.EQ, AlertOperator.NEQ,
];

export const NOTIFICATION_CHANNELS: readonly NotificationChannel[] = [
  NotificationChannel.EMAIL, NotificationChannel.SLACK, NotificationChannel.TEAMS,
  NotificationChannel.WEBHOOK, NotificationChannel.SMS, NotificationChannel.PUSH,
];

/** Only sources that currently produce time-series metrics (see docs/telemetry.md). */
export const ANOMALY_SENSITIVITIES: readonly AnomalySensitivity[] = [AnomalySensitivity.LOW, AnomalySensitivity.MEDIUM, AnomalySensitivity.HIGH];

export const ALERT_SOURCE_KINDS: readonly MetricSource[] = [
  MetricSource.HOST, MetricSource.NETWORK_DEVICE, MetricSource.DATABASE, MetricSource.ENDPOINT,
];

/** Which metrics a rule may target, given the source kind it scopes to (mirrors src/lib/telemetry/metrics.ts). */
export const METRICS_BY_SOURCE_KIND: Readonly<Record<MetricSource, readonly MetricType[]>> = {
  [MetricSource.HOST]: [
    MetricType.CPU_USAGE_PERCENT, MetricType.LOAD_AVERAGE_1M, MetricType.MEMORY_USED_PERCENT, MetricType.MEMORY_USED_BYTES,
    MetricType.SWAP_USED_PERCENT, MetricType.DISK_USED_PERCENT, MetricType.DISK_USED_BYTES, MetricType.DISK_READ_IOPS,
    MetricType.DISK_WRITE_IOPS, MetricType.DISK_READ_BPS, MetricType.DISK_WRITE_BPS, MetricType.NETWORK_IN_BPS,
    MetricType.NETWORK_OUT_BPS, MetricType.PROCESS_COUNT, MetricType.UPTIME_SECONDS, MetricType.TEMPERATURE_CELSIUS,
    MetricType.POWER_WATTS,
  ],
  [MetricSource.NETWORK_DEVICE]: [
    MetricType.LATENCY_MS, MetricType.UPTIME_SECONDS, MetricType.TEMPERATURE_CELSIUS, MetricType.POWER_WATTS,
    MetricType.BANDWIDTH_IN_BPS, MetricType.BANDWIDTH_OUT_BPS, MetricType.BANDWIDTH_UTILIZATION_PERCENT,
    MetricType.PACKET_LOSS_PERCENT, MetricType.INTERFACE_ERRORS_PER_SEC, MetricType.INTERFACE_CRC_ERRORS_PER_SEC,
  ],
  [MetricSource.NETWORK_INTERFACE]: [],
  [MetricSource.DATABASE]: [
    MetricType.DB_QPS, MetricType.DB_ACTIVE_CONNECTIONS, MetricType.DB_CONNECTION_USAGE_PERCENT, MetricType.DB_CACHE_HIT_RATIO,
    MetricType.DB_SLOW_QUERIES_PER_MIN, MetricType.DB_DEADLOCKS_PER_MIN, MetricType.DB_REPLICATION_LAG_SECONDS,
    MetricType.DB_STORAGE_USED_BYTES,
  ],
  [MetricSource.ENDPOINT]: [MetricType.ENDPOINT_RESPONSE_MS, MetricType.ENDPOINT_AVAILABLE, MetricType.ENDPOINT_SSL_DAYS_LEFT],
};

/** Lower-camelCase key matching `messages/{en,fr}.json#metricType`, e.g. CPU_USAGE_PERCENT -> cpuUsagePercent. */
export function metricTypeMessageKey(metric: MetricType): string {
  return metric.toLowerCase().replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/** Lower-camelCase key matching `messages/{en,fr}.json#topology.nodeKind`. */
export function sourceKindMessageKey(kind: MetricSource): string {
  return { HOST: "host", NETWORK_DEVICE: "networkDevice", NETWORK_INTERFACE: "networkDevice", DATABASE: "database", ENDPOINT: "endpoint" }[kind];
}

/** Sentinel `Incident.resolutionNote` written by the evaluation engine; the UI shows `incidentsAdmin.systemResolved` for it. */
export const AUTO_RESOLUTION_NOTE = "auto";
