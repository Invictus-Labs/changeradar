import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

/** One resolved address of a hostname. */
export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}
export type HostResolver = (hostname: string) => Promise<ResolvedAddress[]>;

export const systemResolver: HostResolver = async (hostname) => {
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map((r) => ({ address: r.address, family: r.family === 6 ? 6 : 4 }));
};

export interface EgressPolicy {
  /** Operator allowlist: `host`, `host:port` or `*.suffix`. Empty means no outbound request is ever allowed. */
  allowedHosts: readonly string[];
  /** TEST ONLY: also allow loopback and private ranges (still only for allowlisted hosts). */
  allowPrivateNetwork: boolean;
}

export type EgressDeniedCode =
  | "INVALID_URL"
  | "SCHEME_NOT_ALLOWED"
  | "CREDENTIALS_IN_URL"
  | "HOST_NOT_ALLOWED"
  | "PORT_NOT_ALLOWED"
  | "RESOLUTION_FAILED"
  | "PRIVATE_ADDRESS";

export class EgressDeniedError extends Error {
  constructor(
    readonly code: EgressDeniedCode,
    message: string,
  ) {
    super(message);
    this.name = "EgressDeniedError";
  }
}

// Never reachable, even with the test override: unspecified, multicast, broadcast, link-local (cloud
// metadata lives at 169.254.169.254), IPv4-mapped/embedding IPv6 transition ranges, documentation ranges.
const ALWAYS_BLOCKED = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["169.254.0.0", 16],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
] as const) {
  ALWAYS_BLOCKED.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128],
  ["fe80::", 10],
  ["fec0::", 10], // deprecated site-local space
  ["ff00::", 8],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["2002::", 16],
  ["2001::", 32],
  ["2001:db8::", 32],
  ["3fff::", 20], // documentation (RFC 9637)
  ["2001:2::", 48], // benchmarking
  ["2001:10::", 28], // ORCHID
  ["100::", 64],
] as const) {
  ALWAYS_BLOCKED.addSubnet(net, prefix, "ipv6");
}

// Loopback and private space: blocked unless the test-only override is set.
const PRIVATE_BLOCKED = new BlockList();
for (const [net, prefix] of [
  ["127.0.0.0", 8],
  ["10.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["100.64.0.0", 10],
  ["198.18.0.0", 15],
] as const) {
  PRIVATE_BLOCKED.addSubnet(net, prefix, "ipv4");
}
PRIVATE_BLOCKED.addAddress("::1", "ipv6");
PRIVATE_BLOCKED.addSubnet("fc00::", 7, "ipv6");

export type AddressClass = "public" | "private" | "blocked";

/**
 * IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) IPv6 forms. They are matched on the canonical
 * text form rather than with a subnet rule, because node's BlockList evaluates IPv4 addresses against
 * IPv4-mapped IPv6 rules, so a `::ffff:0:0/96` rule would swallow every public IPv4 address.
 */
function embedsIpv4(address: string): boolean {
  let canonical: string;
  try {
    canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  } catch {
    return true;
  }
  return /^::ffff:/.test(canonical) || /^::[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(canonical);
}

export function classifyAddress(address: string): AddressClass {
  const family = isIP(address);
  if (family === 0) return "blocked";
  if (family === 6 && embedsIpv4(address)) return "blocked";
  const type = family === 6 ? "ipv6" : "ipv4";
  if (ALWAYS_BLOCKED.check(address, type)) return "blocked";
  if (PRIVATE_BLOCKED.check(address, type)) return "private";
  return "public";
}

interface AllowEntry {
  host: string;
  port: number | null;
  wildcard: boolean;
}

export function parseAllowlist(entries: readonly string[]): AllowEntry[] {
  const out: AllowEntry[] = [];
  for (const raw of entries) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    const wildcard = entry.startsWith("*.");
    const rest = wildcard ? entry.slice(2) : entry;
    let host = rest;
    let port: number | null = null;
    const bracket = rest.match(/^\[([0-9a-f:.]+)\](?::(\d{1,5}))?$/);
    if (bracket) {
      host = bracket[1] as string;
      port = bracket[2] ? Number(bracket[2]) : null;
    } else if (rest.includes(":")) {
      // An unbracketed entry may carry one port; anything with more colons is not a valid entry.
      if (rest.indexOf(":") !== rest.lastIndexOf(":")) continue;
      const [h, p] = rest.split(":") as [string, string];
      host = h;
      port = /^\d{1,5}$/.test(p) ? Number(p) : Number.NaN;
    }
    if (!host || (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535))) continue;
    out.push({ host: host.replace(/\.$/, ""), port, wildcard });
  }
  return out;
}

const DEFAULT_PORTS: Record<string, number> = { "http:": 80, "https:": 443 };

function effectivePort(url: URL): number {
  return url.port ? Number(url.port) : (DEFAULT_PORTS[url.protocol] as number);
}

/** Syntax and allowlist checks that need no DNS. Throws EgressDeniedError. */
export function checkUrlAgainstAllowlist(input: string | URL, allowedHosts: readonly string[]): URL {
  let url: URL;
  try {
    url = typeof input === "string" ? new URL(input) : input;
  } catch {
    throw new EgressDeniedError("INVALID_URL", "URL is not valid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new EgressDeniedError("SCHEME_NOT_ALLOWED", "only http and https are allowed");
  }
  if (url.username !== "" || url.password !== "") {
    throw new EgressDeniedError("CREDENTIALS_IN_URL", "credentials in a URL are not allowed; use a credential alias");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (!hostname) throw new EgressDeniedError("INVALID_URL", "URL has no host");
  const port = effectivePort(url);
  const matches = parseAllowlist(allowedHosts).filter((e) => (e.wildcard ? hostname.endsWith(`.${e.host}`) : hostname === e.host));
  if (matches.length === 0) throw new EgressDeniedError("HOST_NOT_ALLOWED", "host is not on the egress allowlist");
  if (!matches.some((e) => (e.port === null ? port === DEFAULT_PORTS[url.protocol] : e.port === port))) {
    throw new EgressDeniedError("PORT_NOT_ALLOWED", "port is not allowed for this host");
  }
  return url;
}

export interface VettedDestination {
  url: URL;
  hostname: string;
  /** The first vetted address (the one connected to first). */
  address: ResolvedAddress;
  /** Every vetted address in resolver order; a connection that cannot be established tries the next one. */
  addresses: ResolvedAddress[];
}

/**
 * Full destination check performed for the first request AND for every redirect hop: scheme, credentials,
 * allowlist, then DNS resolution with every returned address classified. If any address is not allowed the
 * whole destination is refused. The returned address is the one to connect to (pinned), so a second DNS
 * answer cannot swap in a private address between the check and the connection.
 */
export async function vetDestination(input: string | URL, policy: EgressPolicy, resolver: HostResolver = systemResolver): Promise<VettedDestination> {
  const url = checkUrlAgainstAllowlist(input, policy.allowedHosts);
  const hostname = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  let addresses: ResolvedAddress[];
  if (isIP(hostname) !== 0) {
    addresses = [{ address: hostname, family: isIP(hostname) === 6 ? 6 : 4 }];
  } else {
    try {
      addresses = await resolver(hostname);
    } catch {
      throw new EgressDeniedError("RESOLUTION_FAILED", "host name could not be resolved");
    }
  }
  if (addresses.length === 0) throw new EgressDeniedError("RESOLUTION_FAILED", "host name did not resolve");
  for (const a of addresses) {
    const klass = classifyAddress(a.address);
    if (klass === "blocked" || (klass === "private" && !policy.allowPrivateNetwork)) {
      throw new EgressDeniedError("PRIVATE_ADDRESS", "destination resolves to an address that is not allowed");
    }
  }
  return { url, hostname, address: addresses[0] as ResolvedAddress, addresses };
}
