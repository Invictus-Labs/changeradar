import { describe, expect, it } from "vitest";
import { canonicalJson, compareStrings, hashCanonical, isHashString, sha256Hex, stableId } from "../../src/domain/canonical.js";

describe("canonicalJson", () => {
  it("sorts object keys and removes whitespace", () => {
    expect(canonicalJson({ b: 1, a: [true, null, "x"], c: { z: 1, y: 2 } })).toBe(
      '{"a":[true,null,"x"],"b":1,"c":{"y":2,"z":1}}',
    );
  });

  it("is independent of key insertion order", () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });

  it("preserves array order", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });

  it("omits undefined object properties", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("sorts keys by UTF-16 code units, not locale", () => {
    expect(canonicalJson({ b: 1, B: 2, a: 3, "ä": 4 })).toBe('{"B":2,"a":3,"b":1,"ä":4}');
  });

  it("escapes strings like JSON", () => {
    expect(canonicalJson('quote " and \n newline')).toBe(JSON.stringify('quote " and \n newline'));
  });

  it("rejects non-finite numbers, undefined array items, bigint and functions", () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(() => canonicalJson([undefined])).toThrow(TypeError);
    expect(() => canonicalJson(10n)).toThrow(TypeError);
    expect(() => canonicalJson(() => 1)).toThrow(TypeError);
  });

  it("rejects circular structures", () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(() => canonicalJson(a)).toThrow(/circular/);
  });

  it("allows shared (non circular) references", () => {
    const shared = { x: 1 };
    expect(canonicalJson({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}');
  });
});

describe("hashing", () => {
  it("matches the published sha256 test vector for the empty string", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("produces a sha256:<hex> value that isHashString accepts", () => {
    const h = hashCanonical({ a: 1 });
    expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(isHashString(h)).toBe(true);
  });

  it("isHashString rejects malformed values", () => {
    expect(isHashString("sha256:ABC")).toBe(false);
    expect(isHashString("sha256:" + "A".repeat(64))).toBe(false);
    expect(isHashString("md5:" + "a".repeat(64))).toBe(false);
    expect(isHashString(42)).toBe(false);
  });

  it("stableId is deterministic, prefixed and content sensitive", () => {
    expect(stableId("fnd", { a: 1 })).toBe(stableId("fnd", { a: 1 }));
    expect(stableId("fnd", { a: 1 })).toMatch(/^fnd_[0-9a-f]{20}$/);
    expect(stableId("fnd", { a: 1 })).not.toBe(stableId("fnd", { a: 2 }));
  });

  it("compareStrings orders by code unit", () => {
    expect(compareStrings("a", "b")).toBe(-1);
    expect(compareStrings("b", "a")).toBe(1);
    expect(compareStrings("a", "a")).toBe(0);
  });
});
