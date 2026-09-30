import { describe, expect, it } from "vitest";
import { RateLimiter } from "../../src/platform/rate-limit.js";

/**
 * Review round 5 (logic P3 rate-limit.ts:41, security P2, tests P3 h51): a bucket that has used its whole allowance is SPENT,
 * not idle: a full table never evicts it (a new key cannot reset a used-up budget), and finding a bucket to evict is constant
 * time however many spent buckets come first.
 */

describe("R5 (rate-limit.ts): a bucket at exactly its limit is spent, never evicted", () => {
  it("limit 3, table of 2, both buckets used all 3 hits: a new key is refused and neither budget is reset", () => {
    const limiter = new RateLimiter(3, 60_000, 2);
    for (const key of ["a", "b"]) for (let i = 0; i < 3; i += 1) expect(limiter.take(key, 1000 + i)).toBeNull();
    expect(limiter.take("c", 1010), "a new key while every bucket is spent").not.toBeNull();
    // Neither spent bucket was reset: one more hit is over the limit for both.
    expect(limiter.take("a", 1011)).not.toBeNull();
    expect(limiter.take("b", 1012)).not.toBeNull();
  });

  it("limit 1: the first hit spends the bucket, so a full table refuses a new key", () => {
    const limiter = new RateLimiter(1, 60_000, 2);
    expect(limiter.take("a", 1000)).toBeNull();
    expect(limiter.take("b", 1001)).toBeNull();
    expect(limiter.take("c", 1002)).not.toBeNull();
  });

  it("a bucket one hit below its limit is still idle and makes room", () => {
    const limiter = new RateLimiter(3, 60_000, 2);
    for (let i = 0; i < 2; i += 1) {
      expect(limiter.take("a", 1000 + i)).toBeNull();
      expect(limiter.take("b", 1000 + i)).toBeNull();
    }
    expect(limiter.take("c", 1010), "two hits of three: idle").toBeNull();
  });

  it("the oldest idle bucket is the one evicted, and a spent bucket in front of it is skipped", () => {
    const limiter = new RateLimiter(2, 60_000, 3);
    expect(limiter.take("spent", 1000)).toBeNull();
    expect(limiter.take("spent", 1001)).toBeNull(); // 2 of 2: spent
    expect(limiter.take("idle1", 1002)).toBeNull();
    expect(limiter.take("idle2", 1003)).toBeNull();
    expect(limiter.take("new", 1004), "makes room by evicting idle1").toBeNull();
    // The spent bucket kept its count: its next hit is over the limit.
    expect(limiter.take("spent", 1005)).not.toBeNull();
    // idle1 was evicted (a fresh bucket again), idle2 was kept (its second hit is the last allowed one, its third is over).
    expect(limiter.take("idle2", 1006)).toBeNull();
    expect(limiter.take("idle2", 1007)).not.toBeNull();
  });

  it("expired buckets leave the idle set: an expired idle key is not evicted twice", () => {
    const limiter = new RateLimiter(3, 1000, 2);
    expect(limiter.take("a", 0)).toBeNull();
    expect(limiter.take("b", 1)).toBeNull();
    // Both expired: the table is empty again, three new keys in a row fit two at a time without touching a dead key.
    expect(limiter.take("c", 5000)).toBeNull();
    expect(limiter.take("d", 5001)).toBeNull();
    expect(limiter.take("e", 5002), "c or d is idle and makes room").toBeNull();
  });

  it("making room does not walk the spent buckets (constant time): the cost does not grow with the table", () => {
    // 3,000 new keys against a table of 1,000 and of 20,000 SPENT buckets and one idle bucket at the back: a walk from the front
    // is about twenty times slower on the big table; constant time makes them alike. A ratio with a floor for timer noise.
    const timeNewKeys = (size: number): number => {
      const limiter = new RateLimiter(2, 600_000, size + 1);
      for (let i = 0; i < size; i += 1) {
        limiter.take(`s${i}`, 1000);
        limiter.take(`s${i}`, 1000);
      }
      limiter.take("idle", 1001);
      const started = process.hrtime.bigint();
      for (let i = 0; i < 3_000; i += 1) limiter.take(`n${i}`, 1002);
      return Number(process.hrtime.bigint() - started) / 1e6;
    };
    const small = timeNewKeys(1_000);
    const large = timeNewKeys(20_000);
    expect(large, `1,000 spent: ${small} ms, 20,000 spent: ${large} ms`).toBeLessThan(small * 25 + 100);
  });
});
