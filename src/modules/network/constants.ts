import { NetworkDeviceType, SnmpVersion } from "@/generated/prisma/enums";

/**
 * Client-safe: kept apart from devices.ts, which imports node:crypto/node:net and would
 * otherwise pull Node builtins into any client component that needs these lists.
 */
export const SNMP_VERSIONS: readonly SnmpVersion[] = [SnmpVersion.V1, SnmpVersion.V2C, SnmpVersion.V3];

export const DEVICE_TYPES: readonly NetworkDeviceType[] = [
  NetworkDeviceType.ROUTER, NetworkDeviceType.SWITCH, NetworkDeviceType.FIREWALL,
  NetworkDeviceType.AP, NetworkDeviceType.UPS, NetworkDeviceType.BMC, NetworkDeviceType.OTHER,
];
