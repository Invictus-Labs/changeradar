/**
 * The key a client is throttled under: an IPv6 address stands for its whole /64 (a client owns a /64, so rotating the low
 * bits must not give it a fresh budget or fill the table), an IPv4-mapped address is the IPv4 address, anything else is
 * returned as it is.
 */
export function addressKey(ip: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) return mapped[1] as string;
  if (!ip.includes(":")) return ip;
  const bare = ip.split("%")[0] as string;
  let groups: string[];
  if (bare.includes("::")) {
    // More than one `::` is not an address: it shares no bucket with a valid one.
    if (bare.split("::").length > 2) return ip;
    const [left = "", right = ""] = bare.split("::");
    const head = left === "" ? [] : left.split(":");
    const tail = right === "" ? [] : right.split(":");
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return ip;
    groups = [...head, ...Array<string>(missing).fill("0"), ...tail];
  } else {
    groups = bare.split(":");
  }
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return ip;
  return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(":")}::/64`;
}

/**
 * Fixed-window limiter, in memory per process. `take` returns null when the request is allowed, or the number of seconds
 * until the window resets. Buckets are inserted in the order their windows end, so expired ones are dropped from the front
 * (constant time per call). At capacity an IDLE bucket (one that has not used its whole allowance) makes room; a bucket that
 * has reached its limit is SPENT and is never evicted, so neither throttling nor a used-up budget can be reset by filling the
 * table, and when every bucket is spent a new key fails closed. The idle buckets are kept in their own insertion ordered set,
 * so making room is constant time however many spent buckets stand in front of them.
 */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  /** Keys whose bucket has not reached the limit yet, oldest first. */
  private readonly idle = new Set<string>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxBuckets = 10_000,
  ) {}

  private evictIdle(): boolean {
    const oldest = this.idle.values().next();
    if (oldest.done) return false;
    this.idle.delete(oldest.value);
    this.hits.delete(oldest.value);
    return true;
  }

  take(key: string, nowMs: number): number | null {
    for (const [bucket, value] of this.hits) {
      if (value.resetAt > nowMs) break;
      this.hits.delete(bucket);
      this.idle.delete(bucket);
    }
    const entry = this.hits.get(key);
    if (!entry) {
      if (this.hits.size >= this.maxBuckets && !this.evictIdle()) return Math.max(1, Math.ceil(this.windowMs / 1000));
      this.hits.set(key, { count: 1, resetAt: nowMs + this.windowMs });
      if (1 < this.limit) this.idle.add(key);
      return null;
    }
    entry.count += 1;
    if (entry.count >= this.limit) this.idle.delete(key);
    if (entry.count > this.limit) return Math.max(1, Math.ceil((entry.resetAt - nowMs) / 1000));
    return null;
  }
}
