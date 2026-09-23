import dns from "node:dns";
import net from "node:net";

/**
 * SSRF protection for the synthetic check runner.
 *
 * Endpoints are configured by organization members, but probed FROM THE PLATFORM's own network: without
 * this guard any tenant could make the runner reach the monitoring database, the cloud metadata service
 * (169.254.169.254), or any other service listening on the host or its private network — and read the
 * outcome back through status codes, timings and "body contains" assertions.
 *
 * Every address a check connects to is vetted AT CONNECTION TIME (the `lookup` hook below), not only
 * when the URL is saved: a hostname can resolve to a public address when the form is submitted and to
 * 127.0.0.1 on the next probe (DNS rebinding), and each redirect hop is a new target.
 *
 * Self-hosted installs that deliberately monitor their own LAN set CHECKS_ALLOW_PRIVATE_TARGETS=true.
 */

// Special-purpose ranges (IANA IPv4/IPv6 Special-Purpose Address Registries) that are never a
// legitimate public web endpoint. Two SEPARATE lists on purpose: net.BlockList matches IPv4 addresses
// against IPv4-mapped IPv6 rules, so the ::ffff:0:0/96 rule below would otherwise block every IPv4
// address (caught by tests/checks.test.ts).
const BLOCKED_V4 = new net.BlockList();
const BLOCKED_V6 = new net.BlockList();
for (const [prefix, bits] of [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, incl. cloud metadata endpoints
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16],
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, incl. 255.255.255.255
] as const) {
  BLOCKED_V4.addSubnet(prefix, bits, "ipv4");
}
for (const [prefix, bits] of [
  ["::", 128],
  ["::1", 128],
  // IPv4-mapped / translated forms can wrap ANY IPv4 address (::ffff:127.0.0.1): refuse them outright
  // rather than decode them — a real public endpoint is never addressed that way.
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64], // discard-only
  ["2001::", 23], // IETF protocol assignments, incl. Teredo
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4 (embeds an IPv4 address)
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8], // multicast
] as const) {
  BLOCKED_V6.addSubnet(prefix, bits, "ipv6");
}

/** Whether `address` (an IP literal) is a public unicast address the runner may connect to. */
export function isPublicAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 0) return false;
  return family === 4 ? !BLOCKED_V4.check(address, "ipv4") : !BLOCKED_V6.check(address, "ipv6");
}

/** Thrown (via the lookup callback) when a check targets a non-public address. */
export class BlockedTargetError extends Error {
  readonly code = "EBLOCKEDTARGET";
  constructor(readonly address: string) {
    super(`refusing to connect to non-public address ${address}`);
    this.name = "BlockedTargetError";
  }
}

/** URL.hostname keeps the brackets around an IPv6 literal ("[::1]"). */
export function hostnameOf(url: URL): string {
  return url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
}

/**
 * Node only calls `lookup` for hostnames; an IP literal in the URL connects directly. This covers
 * that case — call it for every hop before connecting.
 */
export function assertLiteralTargetAllowed(url: URL, allowPrivate: boolean): void {
  const host = hostnameOf(url);
  if (!allowPrivate && net.isIP(host) !== 0 && !isPublicAddress(host)) throw new BlockedTargetError(host);
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

/**
 * A drop-in `lookup` for http(s).request that resolves normally, then refuses the connection if ANY
 * resolved address is non-public (a name that also resolves to a private address is suspicious enough
 * to refuse outright — and connecting to "the public one" would still race with the OS's choice).
 * Supports both call shapes Node uses: single address, and `all: true` (happy-eyeballs).
 */
export function guardedLookup(allowPrivate: boolean) {
  return (hostname: string, options: dns.LookupOptions, callback: LookupCallback): void => {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, "");
      const list = addresses as dns.LookupAddress[];
      if (!allowPrivate) {
        const blocked = list.find((entry) => !isPublicAddress(entry.address));
        if (blocked) return callback(new BlockedTargetError(blocked.address) as unknown as NodeJS.ErrnoException, "");
      }
      if (list.length === 0) {
        const notFound: NodeJS.ErrnoException = new Error(`no address for ${hostname}`);
        notFound.code = "ENOTFOUND";
        return callback(notFound, "");
      }
      if (options.all) return callback(null, list);
      callback(null, list[0].address, list[0].family);
    });
  };
}
