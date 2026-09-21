import { DatabaseEngine, HealthStatus, type Prisma } from "@/generated/prisma/client";
import type { AuthenticatedAgent } from "@/lib/telemetry/auth";
import { databaseMetricRows, type IngestContext, type MetricRow, parseCollectedAt } from "@/lib/telemetry/metrics";
import type { DatabaseMetric } from "@/lib/telemetry/schemas";

const ENGINE = {
  postgresql: DatabaseEngine.POSTGRESQL,
  mysql: DatabaseEngine.MYSQL,
  mariadb: DatabaseEngine.MARIADB,
  mongodb: DatabaseEngine.MONGODB,
  redis: DatabaseEngine.REDIS,
  mssql: DatabaseEngine.MSSQL,
} as const;

export interface DatabaseIngestResult {
  rows: MetricRow[];
  databases: number;
  slowQueries: number;
}

/**
 * Upsert each reported database instance (auto-discovery: an agent may report an instance the
 * server has never seen), refresh its latest-value snapshot, record slow queries, and return the
 * time-series rows. Database credentials never reach the server: the agent keeps them locally.
 */
export async function ingestDatabases(
  tx: Prisma.TransactionClient,
  agent: AuthenticatedAgent,
  databases: DatabaseMetric[],
  ctx: IngestContext,
): Promise<DatabaseIngestResult> {
  const rows: MetricRow[] = [];
  let slowQueryCount = 0;

  for (const database of databases) {
    const time = parseCollectedAt(database.collectedAt, ctx, `databases[${database.instance.name}]`);
    const { instance, metrics } = database;
    const engine = ENGINE[instance.engine];

    // Fields shared by create and update. `undefined` means "not reported": Prisma leaves the
    // stored value untouched, so a partial report never erases known data.
    const snapshot = {
      version: instance.version,
      endpoint: instance.endpoint,
      isReplica: instance.isReplica,
      storageQuotaBytes: instance.storageQuotaBytes === undefined ? undefined : BigInt(instance.storageQuotaBytes),
      maxConnections: instance.maxConnections,
      slowQueryThresholdMs: instance.slowQueryThresholdMs,
      storageUsedBytes: metrics.storageUsedBytes === undefined ? undefined : BigInt(metrics.storageUsedBytes),
      activeConnections: metrics.activeConnections,
      cacheHitRatio: metrics.cacheHitRatio,
      deadlocksTotal: metrics.deadlocksTotal === undefined ? undefined : BigInt(metrics.deadlocksTotal),
      replicationLagSeconds: metrics.replicationLagSeconds,
      status: database.reachable ? HealthStatus.UP : HealthStatus.DOWN,
      lastPolledAt: time,
    };

    const stored = await tx.databaseInstance.upsert({
      where: {
        orgId_hostId_engine_name: { orgId: agent.orgId, hostId: agent.hostId, engine, name: instance.name },
      },
      create: { orgId: agent.orgId, hostId: agent.hostId, engine, name: instance.name, ...snapshot },
      update: snapshot,
      select: { id: true, maxConnections: true },
    });

    if (database.reachable) {
      rows.push(...databaseMetricRows(agent.orgId, stored.id, database, time, stored.maxConnections));
    }

    if (database.slowQueries.length > 0) {
      const result = await tx.slowQueryLog.createMany({
        data: database.slowQueries.map((q) => ({
          dbInstanceId: stored.id,
          capturedAt: parseCollectedAt(q.capturedAt, ctx, `databases[${instance.name}].slowQueries`),
          fingerprint: q.fingerprint,
          queryText: q.queryText,
          durationMs: q.durationMs,
          calls: q.calls ?? 1,
          rowsExamined: q.rowsExamined === undefined ? undefined : BigInt(q.rowsExamined),
          rowsReturned: q.rowsReturned === undefined ? undefined : BigInt(q.rowsReturned),
          databaseName: q.databaseName,
          userName: q.userName,
        })),
        // (dbInstanceId, fingerprint, capturedAt) is unique: a retried batch is a no-op.
        skipDuplicates: true,
      });
      slowQueryCount += result.count;
    }
  }

  return { rows, databases: databases.length, slowQueries: slowQueryCount };
}
