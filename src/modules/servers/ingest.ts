import { HealthStatus, OsFamily, type Prisma } from "@/generated/prisma/client";
import type { AuthenticatedAgent } from "@/lib/telemetry/auth";
import { type IngestContext, type MetricRow, parseCollectedAt, systemMetricRows } from "@/lib/telemetry/metrics";
import type { SystemMetrics } from "@/lib/telemetry/schemas";

const OS_FAMILY = {
  windows: OsFamily.WINDOWS,
  linux: OsFamily.LINUX,
  macos: OsFamily.MACOS,
  unix: OsFamily.UNIX,
  other: OsFamily.OTHER,
} as const;

/**
 * Any correctly signed request proves the agent is alive, whether it carries host metrics or only
 * SNMP / database data: mark the host UP and remember when it was last seen.
 */
export async function recordHeartbeat(
  tx: Prisma.TransactionClient,
  agent: AuthenticatedAgent,
  agentVersion: string,
  now: Date,
): Promise<void> {
  await tx.monitoredHost.update({
    where: { id: agent.hostId },
    data: {
      status: HealthStatus.UP,
      lastSeenAt: now,
      agentVersion,
      ...(agent.firstSeenAt ? {} : { firstSeenAt: now }),
    },
  });
}

/** Store the host's inventory (when sent) and return the time-series rows for its metrics. */
export async function ingestSystem(
  tx: Prisma.TransactionClient,
  agent: AuthenticatedAgent,
  system: SystemMetrics,
  ctx: IngestContext,
): Promise<MetricRow[]> {
  const time = parseCollectedAt(system.collectedAt, ctx, "system");
  const inv = system.inventory;

  if (inv) {
    await tx.monitoredHost.update({
      where: { id: agent.hostId },
      data: {
        osFamily: OS_FAMILY[inv.osFamily],
        osName: inv.osName,
        osVersion: inv.osVersion,
        kernelVersion: inv.kernelVersion,
        arch: inv.arch,
        cpuModel: inv.cpuModel,
        cpuCores: inv.cpuCores,
        cpuThreads: inv.cpuThreads,
        cpuFrequencyMhz: inv.cpuFrequencyMhz,
        memoryTotalBytes: inv.memoryTotalBytes === undefined ? undefined : BigInt(inv.memoryTotalBytes),
        diskTotalBytes: inv.diskTotalBytes === undefined ? undefined : BigInt(inv.diskTotalBytes),
        ipAddresses: inv.ipAddresses,
        macAddress: inv.macAddress,
        virtualization: inv.virtualization,
        cloudProvider: inv.cloudProvider,
        cloudRegion: inv.cloudRegion,
        agentVersion: inv.agentVersion,
      },
    });
  }

  return systemMetricRows(agent.orgId, agent.hostId, system, time);
}
