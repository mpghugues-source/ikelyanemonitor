import { HealthStatus, NetworkDeviceType, OperStatus, Prisma, SnmpVersion } from "@/generated/prisma/client";
import type { AuthenticatedAgent } from "@/lib/telemetry/auth";
import { deviceMetricRows, type IngestContext, type MetricRow, parseCollectedAt } from "@/lib/telemetry/metrics";
import type { SnmpDevice, SnmpInterface } from "@/lib/telemetry/schemas";

const DEVICE_TYPE = {
  router: NetworkDeviceType.ROUTER,
  switch: NetworkDeviceType.SWITCH,
  firewall: NetworkDeviceType.FIREWALL,
  ap: NetworkDeviceType.AP,
  ups: NetworkDeviceType.UPS,
  bmc: NetworkDeviceType.BMC,
  other: NetworkDeviceType.OTHER,
} as const;

const OPER_STATUS = {
  up: OperStatus.UP,
  down: OperStatus.DOWN,
  testing: OperStatus.TESTING,
  unknown: OperStatus.UNKNOWN,
} as const;

const SNMP_VERSION = { v1: SnmpVersion.V1, v2c: SnmpVersion.V2C, v3: SnmpVersion.V3 } as const;

export interface NetworkIngestResult {
  rows: MetricRow[];
  devices: number;
  interfaces: number;
}

/**
 * Upsert each polled device (auto-discovery by IP address within the organization), refresh its
 * interfaces, and return the time-series rows.
 *
 * SNMP credentials are NOT touched here: they are configured by an administrator and stored
 * encrypted; the agent only reports what it read.
 */
export async function ingestSnmpDevices(
  tx: Prisma.TransactionClient,
  agent: AuthenticatedAgent,
  devices: SnmpDevice[],
  ctx: IngestContext,
): Promise<NetworkIngestResult> {
  const rows: MetricRow[] = [];
  let interfaceCount = 0;

  for (const snmp of devices) {
    const time = parseCollectedAt(snmp.collectedAt, ctx, `snmpDevices[${snmp.device.ipAddress}]`);
    const { device } = snmp;

    const fields = {
      type: device.type ? DEVICE_TYPE[device.type] : undefined,
      vendor: device.vendor,
      model: device.model,
      firmwareVersion: device.firmwareVersion,
      serialNumber: device.serialNumber,
      sysName: device.sysName,
      sysDescr: device.sysDescr,
      sysLocation: device.sysLocation,
      sysContact: device.sysContact,
      uptimeSeconds: device.uptimeSeconds === undefined ? undefined : BigInt(Math.round(device.uptimeSeconds)),
      powerWatts: device.powerWatts,
      snmpVersion: device.snmpVersion ? SNMP_VERSION[device.snmpVersion] : undefined,
      status: device.reachable ? HealthStatus.UP : HealthStatus.DOWN,
      lastPolledAt: time,
    };

    const stored = await tx.networkDevice.upsert({
      where: { orgId_ipAddress: { orgId: agent.orgId, ipAddress: device.ipAddress } },
      create: {
        orgId: agent.orgId,
        ipAddress: device.ipAddress,
        name: device.name ?? device.sysName ?? device.ipAddress,
        pollerHostId: agent.hostId,
        ...fields,
        type: fields.type ?? NetworkDeviceType.OTHER,
      },
      update: fields,
      select: { id: true },
    });

    if (device.reachable) {
      rows.push(...deviceMetricRows(agent.orgId, stored.id, snmp, time));
      interfaceCount += await upsertInterfaces(tx, stored.id, snmp.interfaces, time, ctx.now);
    }
  }

  return { rows, devices: devices.length, interfaces: interfaceCount };
}

/**
 * Bulk upsert of a device's ports in two statements, whatever the port count:
 *  1. INSERT … ON CONFLICT DO NOTHING creates ports seen for the first time;
 *  2. UPDATE … FROM (VALUES …) refreshes every reported port.
 * A CTE cannot do both in one statement (rows inserted by a CTE are invisible to the UPDATE of the
 * same statement), and per-row `upsert()` would issue ~1000 round trips for a large switch.
 *
 * "Not reported" fields keep their previous value (COALESCE); point-in-time values (throughput,
 * utilization, loss, operational status) always take the new reading.
 */
async function upsertInterfaces(
  tx: Prisma.TransactionClient,
  deviceId: string,
  interfaces: SnmpInterface[],
  polledAt: Date,
  now: Date,
): Promise<number> {
  if (interfaces.length === 0) return 0;

  // If an agent repeats an ifIndex, the last occurrence wins (a duplicate key in UPDATE … FROM
  // would otherwise pick an arbitrary row).
  const byIndex = new Map<number, SnmpInterface>();
  for (const port of interfaces) byIndex.set(port.ifIndex, port);
  const ports = [...byIndex.values()];

  const num = (value: number | undefined) => (value === undefined ? null : Math.round(value));
  const date = (iso: string | undefined) => (iso === undefined ? null : new Date(iso));

  const tuples = ports.map(
    (p) => Prisma.sql`(
      ${p.ifIndex}::int, ${p.name}::text, ${p.alias ?? null}::text, ${p.description ?? null}::text,
      ${p.macAddress ?? null}::text, ${num(p.speedMbps)}::bigint, ${p.mtu ?? null}::int,
      ${p.adminStatus ? OPER_STATUS[p.adminStatus] : null}::"OperStatus", ${OPER_STATUS[p.operStatus]}::"OperStatus",
      ${Math.round(p.inBps)}::bigint, ${Math.round(p.outBps)}::bigint,
      ${p.utilizationPercent ?? null}::float8, ${p.packetLossPercent ?? null}::float8,
      ${num(p.inErrors)}::bigint, ${num(p.outErrors)}::bigint, ${num(p.crcErrors)}::bigint,
      ${num(p.inDiscards)}::bigint, ${num(p.outDiscards)}::bigint, ${date(p.lastChangeAt)}::timestamptz
    )`,
  );
  const values = Prisma.join(tuples);
  const columns = Prisma.raw(
    `"ifIndex", "name", "alias", "description", "macAddress", "speedMbps", "mtu", "adminStatus", "operStatus", ` +
      `"inBps", "outBps", "utilizationPercent", "packetLossPercent", "inErrors", "outErrors", "crcErrors", ` +
      `"inDiscards", "outDiscards", "lastChangeAt"`,
  );

  await tx.$executeRaw(Prisma.sql`
    INSERT INTO network_interfaces (id, "deviceId", "ifIndex", "name", "operStatus", "updatedAt")
    SELECT gen_random_uuid()::text, ${deviceId}::text, v."ifIndex", v."name", v."operStatus", ${now}::timestamptz
    FROM (VALUES ${values}) AS v(${columns})
    ON CONFLICT ("deviceId", "ifIndex") DO NOTHING
  `);

  await tx.$executeRaw(Prisma.sql`
    UPDATE network_interfaces AS n SET
      "name"               = v."name",
      "alias"              = COALESCE(v."alias", n."alias"),
      "description"        = COALESCE(v."description", n."description"),
      "macAddress"         = COALESCE(v."macAddress", n."macAddress"),
      "speedMbps"          = COALESCE(v."speedMbps", n."speedMbps"),
      "mtu"                = COALESCE(v."mtu", n."mtu"),
      "adminStatus"        = COALESCE(v."adminStatus", n."adminStatus"),
      "operStatus"         = v."operStatus",
      "inBps"              = v."inBps",
      "outBps"             = v."outBps",
      "utilizationPercent" = v."utilizationPercent",
      "packetLossPercent"  = v."packetLossPercent",
      "inErrors"           = COALESCE(v."inErrors", n."inErrors"),
      "outErrors"          = COALESCE(v."outErrors", n."outErrors"),
      "crcErrors"          = COALESCE(v."crcErrors", n."crcErrors"),
      "inDiscards"         = COALESCE(v."inDiscards", n."inDiscards"),
      "outDiscards"        = COALESCE(v."outDiscards", n."outDiscards"),
      "lastChangeAt"       = COALESCE(v."lastChangeAt", n."lastChangeAt"),
      "lastPolledAt"       = ${polledAt}::timestamptz,
      "updatedAt"          = ${now}::timestamptz
    FROM (VALUES ${values}) AS v(${columns})
    WHERE n."deviceId" = ${deviceId}::text AND n."ifIndex" = v."ifIndex"
  `);

  return ports.length;
}
