import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import type { AuthenticatedAgent } from "@/lib/telemetry/auth";
import type { IngestContext, MetricRow } from "@/lib/telemetry/metrics";
import type { TelemetryPayload } from "@/lib/telemetry/schemas";
import { evaluateIngestedMetrics } from "@/modules/alerts/evaluate";
import { ingestDatabases } from "@/modules/databases/ingest";
import { ingestSnmpDevices } from "@/modules/network/ingest";
import { ingestSystem, recordHeartbeat } from "@/modules/servers/ingest";

export interface IngestResult {
  /** Time-series points in the request. */
  metricsReceived: number;
  /** Points actually inserted; the difference are duplicates of an earlier (retried) request. */
  metricsStored: number;
  devices: number;
  interfaces: number;
  databases: number;
  slowQueriesStored: number;
}

/** Postgres allows 65 535 bind parameters per statement; a row has 7 → keep well below. */
const METRIC_INSERT_CHUNK = 5000;

/**
 * Insert time-series points. The primary key (source, metric, instance, time) makes the operation
 * idempotent: `skipDuplicates` turns into ON CONFLICT DO NOTHING, so an agent that retries a batch
 * after a timeout cannot create duplicates.
 */
async function writeMetricRows(tx: Prisma.TransactionClient, rows: MetricRow[]): Promise<number> {
  let stored = 0;
  for (let i = 0; i < rows.length; i += METRIC_INSERT_CHUNK) {
    const result = await tx.metricEntry.createMany({
      data: rows.slice(i, i + METRIC_INSERT_CHUNK),
      skipDuplicates: true,
    });
    stored += result.count;
  }
  return stored;
}

/**
 * Store one validated telemetry payload, atomically: either everything from the request is
 * persisted, or nothing is (the agent then retries the whole request safely, see idempotency above).
 */
export async function ingestTelemetry(
  db: PrismaClient,
  agent: AuthenticatedAgent,
  payload: TelemetryPayload,
  ctx: IngestContext,
): Promise<IngestResult> {
  const rows: MetricRow[] = [];

  const result = await db.$transaction(
    async (tx) => {
      await recordHeartbeat(tx, agent, payload.agent.version, ctx.now);

      const result: IngestResult = {
        metricsReceived: 0,
        metricsStored: 0,
        devices: 0,
        interfaces: 0,
        databases: 0,
        slowQueriesStored: 0,
      };

      if (payload.system) {
        rows.push(...(await ingestSystem(tx, agent, payload.system, ctx)));
      }
      if (payload.snmpDevices?.length) {
        const network = await ingestSnmpDevices(tx, agent, payload.snmpDevices, ctx);
        rows.push(...network.rows);
        result.devices = network.devices;
        result.interfaces = network.interfaces;
      }
      if (payload.databases?.length) {
        const databases = await ingestDatabases(tx, agent, payload.databases, ctx);
        rows.push(...databases.rows);
        result.databases = databases.databases;
        result.slowQueriesStored = databases.slowQueries;
      }

      result.metricsReceived = rows.length;
      result.metricsStored = await writeMetricRows(tx, rows);
      return result;
    },
    { timeout: 30_000, maxWait: 5_000 },
  );

  // Best-effort, AFTER the storage transaction has committed: alert evaluation must never make
  // telemetry ingestion fail, and it reads back the metric history it needs (so it must see what
  // was just written). AI anomaly detection and channel dispatch are not implemented yet — see
  // src/modules/alerts/evaluate.ts.
  try {
    await evaluateIngestedMetrics(db, agent.orgId, rows, ctx.now);
  } catch (error) {
    console.error("[telemetry] alert evaluation failed", error);
  }

  return result;
}
