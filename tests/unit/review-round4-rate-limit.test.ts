import { describe, expect, it } from "vitest";
import { RateLimiter, addressKey } from "../../src/platform/rate-limit.js";

/**
 * Review round 4 (security P2, rate-limit.ts:19): a client that rotates source addresses could fill the table and make every
 * new address answer 429 for the rest of the window; every call also walked the whole table. IPv6 clients are keyed by their
 * /64, idle buckets make room, and a throttled bucket is never evicted (throttling cannot be reset by flooding keys).
 */

describe("R4 P2 (rate-limit.ts): addressKey keys an IPv6 client by its /64", () => {
  it("two addresses in one /64 share a key, different /64s and IPv4 addresses do not", () => {
    expect(addressKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe(addressKey("2001:db8:1:2:1::1"));
    expect(addressKey("2001:db8:1:2::1")).toBe("2001:db8:1:2::/64");
    expect(addressKey("2001:db8:1:3::1")).not.toBe(addressKey("2001:db8:1:2::1"));
    expect(addressKey("2001:DB8:1:2::1")).toBe(addressKey("2001:db8:1:2::1"));
    expect(addressKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(addressKey("::1")).toBe("0:0:0:0::/64");
    expect(addressKey("192.0.2.7")).toBe("192.0.2.7");
    expect(addressKey("::ffff:192.0.2.7")).toBe("192.0.2.7");
    expect(addressKey("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(addressKey("not an address")).toBe("not an address");
  });
});

describe("R4 P2 (rate-limit.ts): a full table makes room from idle buckets and never resets a throttled one", () => {
  it("at capacity a new key is served by evicting an idle bucket, not refused", () => {
    const limiter = new RateLimiter(3, 60_000, 4);
    for (const key of ["a", "b", "c", "d"]) expect(limiter.take(key, 1000)).toBeNull();
    expect(limiter.take("e", 1001), "table full of idle buckets: the oldest makes room").toBeNull();
    expect(limiter.take("e", 1002)).toBeNull();
  });

  it("a bucket that is over its limit is kept: filling the table cannot reset it", () => {
    const limiter = new RateLimiter(2, 60_000, 3);
    limiter.take("bad", 1000);
    limiter.take("bad", 1001);
    expect(limiter.take("bad", 1002), "third hit is refused").not.toBeNull();
    limiter.take("x", 1003);
    limiter.take("y", 1004);
    limiter.take("z", 1005); // full: an idle bucket (x) is evicted, not "bad"
    limiter.take("w", 1006);
    expect(limiter.take("bad", 1007), "still throttled after the table churned").not.toBeNull();
  });

  it("when every bucket is throttled, a new key fails closed", () => {
    const limiter = new RateLimiter(1, 60_000, 2);
    for (const key of ["a", "b"]) {
      limiter.take(key, 1000);
      limiter.take(key, 1001);
    }
    expect(limiter.take("c", 1002)).not.toBeNull();
  });

  it("expired buckets are dropped as the window passes and the counter restarts", () => {
    const limiter = new RateLimiter(1, 1000, 2);
    limiter.take("a", 0);
    limiter.take("a", 1);
    expect(limiter.take("a", 2)).not.toBeNull();
    expect(limiter.take("a", 1500), "a new window").toBeNull();
  });

  it("a call does not walk the whole table (amortised constant time)", () => {
    // The same 3,000 calls against a table of 1,000 and a table of 100,000 keys: a walk of the whole table makes the second
    // about a hundred times slower, constant time makes them alike. A ratio (with a floor for timer noise) does not depend on
    // how fast or how loaded the machine is.
    const timeCalls = (size: number): number => {
      const limiter = new RateLimiter(5, 60_000, 200_000);
      for (let i = 0; i < size; i += 1) limiter.take(`k${i}`, 1000);
      const started = process.hrtime.bigint();
      for (let i = 0; i < 3_000; i += 1) limiter.take(`k${i % 100}`, 1001);
      return Number(process.hrtime.bigint() - started) / 1e6;
    };
    const small = timeCalls(1_000);
    const large = timeCalls(100_000);
    expect(large, `1,000 keys: ${small} ms, 100,000 keys: ${large} ms`).toBeLessThan(small * 25 + 100);
  });
});
