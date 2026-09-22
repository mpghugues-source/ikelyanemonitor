import { MetricSource } from "@/generated/prisma/enums";
import type { Db } from "@/lib/auth/db";

/**
 * `AlertRule.sourceId` / `Incident.sourceId` are free-form (no FK, by design — see the `Incident`
 * model comment: the label must stay readable after the referenced row is deleted), so their
 * human label has to be resolved by hand, one query per source kind actually in use.
 */
export async function resolveSourceLabels(db: Db, orgId: string, kind: MetricSource, ids: readonly string[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids)];
  if (wanted.length === 0) return new Map();

  switch (kind) {
    case MetricSource.HOST: {
      const rows = await db.monitoredHost.findMany({ where: { orgId, id: { in: wanted } }, select: { id: true, hostname: true, displayName: true } });
      return new Map(rows.map((row) => [row.id, row.displayName ?? row.hostname]));
    }
    case MetricSource.NETWORK_DEVICE:
    case MetricSource.NETWORK_INTERFACE: {
      const rows = await db.networkDevice.findMany({ where: { orgId, id: { in: wanted } }, select: { id: true, name: true } });
      return new Map(rows.map((row) => [row.id, row.name]));
    }
    case MetricSource.DATABASE: {
      const rows = await db.databaseInstance.findMany({ where: { orgId, id: { in: wanted } }, select: { id: true, name: true } });
      return new Map(rows.map((row) => [row.id, row.name]));
    }
    case MetricSource.ENDPOINT: {
      const rows = await db.endpointCheck.findMany({ where: { orgId, id: { in: wanted } }, select: { id: true, name: true } });
      return new Map(rows.map((row) => [row.id, row.name]));
    }
  }
}

/** True when `sourceId` belongs to the organization and matches `kind` (used to validate rule input). */
export async function sourceExists(db: Db, orgId: string, kind: MetricSource, sourceId: string): Promise<boolean> {
  const labels = await resolveSourceLabels(db, orgId, kind, [sourceId]);
  return labels.has(sourceId);
}
