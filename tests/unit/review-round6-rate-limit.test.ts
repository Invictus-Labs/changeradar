import { describe, expect, it } from "vitest";
import { addressKey } from "../../src/platform/rate-limit.js";

/** Review round 6 (logic P3): a string with two `::` is not an IPv6 address, so it does not share a bucket with a valid one. */
describe("R6 (rate-limit.ts): addressKey reads only a well-formed address as an address", () => {
  it("a string with two `::` comes back as it is, and a valid one still keys by its /64", () => {
    expect(addressKey("1::2::3")).toBe("1::2::3");
    expect(addressKey("1:2::3::")).toBe("1:2::3::");
    expect(addressKey("1::2")).toBe("1:0:0:0::/64");
    expect(addressKey("2001:db8:1:2::1")).toBe("2001:db8:1:2::/64");
  });
});
