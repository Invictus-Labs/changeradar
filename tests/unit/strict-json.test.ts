import { describe, expect, it } from "vitest";
import { JsonRejectedError, checkJsonStructure, parseStrictJson } from "../../src/domain/strict-json.js";
import { buildGraphFromJson } from "../../src/services/graph.js";
import { billingManifest } from "../helpers/builders.js";

/** Review round 1 P1: duplicate JSON keys were last-wins (graph.ts:202, server.ts:66, evidence.ts:320). */

const rejects = (text: string, code: string) => {
  try {
    parseStrictJson(text);
  } catch (error) {
    expect(error).toBeInstanceOf(JsonRejectedError);
    expect((error as JsonRejectedError).code).toBe(code);
    return;
  }
  throw new Error(`accepted: ${text.slice(0, 60)}`);
};

describe("strict JSON: duplicate keys", () => {
  it.each([
    ['{"a":1,"a":2}', "top level"],
    ['{"schema_version":2,"schema_version":1}', "schema_version"],
    ['{"o":{"verified_at":"1999-01-01T00:00:00Z","verified_at":"2026-09-28T00:00:00Z"}}', "nested verified_at"],
    ['{"nodes":[],"nodes":[{"id":"x"}]}', "duplicate nodes array"],
    ['{"owner":"o","owner":null}', "owner then null"],
    ['{"owner":"o","\\u006fwner":"p"}', "unicode escaped variant"],
    ['{"\\u006fwner":"o","owner":"p"}', "unicode escaped first"],
    ['{"a\\"b":1,"a\\"b":2}', "escaped quote in the key"],
    ['[{"x":1,"x":2}]', "inside an array"],
    ['{"a":{"b":1},"c":[{"d":1,"d":1}]}', "deep inside"],
    ['{"a":1,\n  "a" : 2}', "whitespace and newline"],
  ])("rejects %s (%s)", (text) => rejects(text, "DUPLICATE_JSON_KEY"));

  it.each([
    ['{"a":1,"b":2}', "distinct keys"],
    ['[{"a":1},{"a":2}]', "the same key in different objects"],
    ['{"a":{"a":1}}', "the same key at different depths"],
    ['{"a":"a","b":"a"}', "a key text repeated as a value"],
    ['{"a":"{\\"a\\":1,\\"a\\":2}"}', "duplicate keys inside a string value"],
    ['{"k":"x\\\\","k2":"y"}', "a string value ending in an escaped backslash"],
    ['{"":1,"a":2}', "an empty key once"],
    ['{"a":[1,2,{"a":3}],"b":null,"c":true,"d":1.5e3}', "mixed values"],
  ])("accepts %s (%s)", (text) => {
    expect(parseStrictJson(text)).toEqual(JSON.parse(text));
  });

  it("the error never echoes the key or any input", () => {
    try {
      parseStrictJson('{"secretkeyname":1,"secretkeyname":2}');
    } catch (error) {
      expect((error as Error).message).not.toContain("secretkeyname");
    }
  });

  it("malformed text is left for JSON.parse to reject, without hanging or throwing another kind of error", () => {
    for (const text of ['{"a":1,', '{"a"', '"unterminated', '{"a":1}}}', "[[[", "}{", '{"a":"\\', "nope", "", '{"a":"\\uZZZZ","a":1}']) {
      expect(() => parseStrictJson(text)).toThrow(JsonRejectedError);
      try {
        parseStrictJson(text);
      } catch (error) {
        expect(["MALFORMED_JSON", "DUPLICATE_JSON_KEY"]).toContain((error as JsonRejectedError).code);
      }
    }
  });

  it("a bad unicode escape in a repeated key is still a malformed document, never a crash", () => {
    rejects('{"\\uZZZZ":1,"\\uZZZZ":2}', "DUPLICATE_JSON_KEY");
    expect(() => JSON.parse('{"\\uZZZZ":1}')).toThrow();
  });
});

describe("strict JSON: depth and container limits", () => {
  it("rejects nesting beyond the depth limit and accepts the limit itself", () => {
    const deep = (n: number) => "[".repeat(n) + "]".repeat(n);
    expect(() => parseStrictJson(deep(64))).not.toThrow();
    rejects(deep(65), "JSON_TOO_COMPLEX");
    rejects("[".repeat(1_000_000), "JSON_TOO_COMPLEX");
    rejects("{\"a\":".repeat(70) + "1" + "}".repeat(70), "JSON_TOO_COMPLEX");
  });

  it("rejects a body made of millions of tiny containers before the real parse allocates them", () => {
    const bomb = "[" + "[],".repeat(3_000_000) + "[]]";
    const started = Date.now();
    rejects(bomb, "JSON_TOO_COMPLEX");
    expect(Date.now() - started).toBeLessThan(3_000);
    const objects = "[" + "{},".repeat(3_000_000) + "{}]";
    rejects(objects, "JSON_TOO_COMPLEX");
  });

  it("accepts an ordinary document with many containers at a realistic density", () => {
    const items = Array.from({ length: 50_000 }, (_, i) => ({ id: `node-${i}`, kind: "service", owner: "team", fields: [] as string[] }));
    expect(parseStrictJson(JSON.stringify({ nodes: items }))).toMatchObject({ nodes: expect.any(Array) });
  });

  it("the limits are configurable", () => {
    expect(() => checkJsonStructure("[[[]]]", { maxDepth: 2 })).toThrow(JsonRejectedError);
    expect(() => checkJsonStructure("[[],[],[]]", { maxContainers: 3 })).toThrow(JsonRejectedError);
    expect(() => checkJsonStructure("[[],[],[]]", { maxContainers: 4 })).not.toThrow();
  });
});

describe("strict JSON: linear time", () => {
  it("scans a 25 MB manifest-shaped document in well under ten seconds", () => {
    const nodes = Array.from({ length: 60_000 }, (_, i) => `{"id":"node-${i}","kind":"service","version":"1.0.0","owner":"team-${i % 50}"}`);
    const text = `{"nodes":[${nodes.join(",")}],"pad":"${"x".repeat(20 * 1024 * 1024)}"}`;
    const started = Date.now();
    checkJsonStructure(text);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("many keys in one object (100,000) and many escapes stay linear", () => {
    const keys = Array.from({ length: 100_000 }, (_, i) => `"k\\u0041${i}":${i}`).join(",");
    const started = Date.now();
    checkJsonStructure(`{${keys}}`);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("strict JSON: manifest and bundle entry points", () => {
  it("buildGraphFromJson refuses duplicate keys with a stable code (schema_version, verified_at, owner, nodes)", () => {
    const text = JSON.stringify(billingManifest());
    const cases = [
      text.replace('"schema_version":1', '"schema_version":2,"schema_version":1'),
      text.replace('"owner":"team-billing"', '"owner":"x","owner":"team-billing"'),
      text.replace('"verified_at":"2026-09-28T00:00:00Z"', '"verified_at":"1999-01-01T00:00:00Z","verified_at":"2026-09-28T00:00:00Z"'),
      text.replace('"nodes":[', '"nodes":[],"nodes":['),
      text.replace('"owner":"team-billing"', '"\\u006fwner":"x","owner":"team-billing"'),
    ];
    for (const doc of cases) {
      expect(doc).not.toBe(text);
      const built = buildGraphFromJson(doc);
      expect(built.ok).toBe(false);
      if (!built.ok) {
        expect(built.failure.code).toBe("DUPLICATE_JSON_KEY");
        expect(built.failure.status).toBe(400);
      }
    }
    expect(buildGraphFromJson(text).ok).toBe(true);
  });

  it("buildGraphFromJson reports a container bomb as JSON_TOO_COMPLEX", () => {
    const built = buildGraphFromJson("[" + "[],".repeat(3_000_000) + "[]]", { limits: { max_manifest_bytes: 25 * 1024 * 1024 } });
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.failure.code).toBe("JSON_TOO_COMPLEX");
  });
});
