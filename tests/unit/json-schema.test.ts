import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS } from "../../src/domain/limits.js";
import { buildManifestJsonSchema, isUtcTimestamp } from "../../src/domain/manifest.js";
import { buildGraph } from "../../src/services/graph.js";
import { billingManifest, clone, e, manifest, n } from "../helpers/builders.js";

const schemaPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "schemas", "dependencies.json");
const committed = readFileSync(schemaPath, "utf8");
const schema = JSON.parse(committed) as Record<string, unknown>;
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validate = ajv.compile(schema);

describe("schemas/dependencies.json", () => {
  it("is exactly what the runtime zod schema generates (no drift)", () => {
    expect(committed).toBe(JSON.stringify(buildManifestJsonSchema(DEFAULT_LIMITS), null, 2) + "\n");
  });

  it("declares schema_version 1, draft 2020-12 and the documented limits", () => {
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    const props = schema.properties as Record<string, any>;
    expect(props.schema_version).toEqual({ type: "integer", const: 1 });
    expect(props.nodes.maxItems).toBe(10_000);
    expect(props.edges.maxItems).toBe(50_000);
    expect(schema.additionalProperties).toBe(false);
  });

  it("accepts the reference manifest in both the JSON Schema and the runtime validator", () => {
    const doc = billingManifest();
    expect(validate(doc)).toBe(true);
    expect(buildGraph(doc).ok).toBe(true);
  });

  const invalid: [string, (doc: any) => void][] = [
    ["unknown top-level property", (d) => (d.extra = 1)],
    ["missing schema_version", (d) => delete d.schema_version],
    ["schema_version 2", (d) => (d.schema_version = 2)],
    ["string schema_version", (d) => (d.schema_version = "1")],
    ["missing provenance", (d) => delete d.provenance],
    ["unknown node property", (d) => (d.nodes[0].ownr = "x")],
    ["unknown node kind", (d) => (d.nodes[0].kind = "database")],
    ["bad node id", (d) => (d.nodes[0].id = "has space")],
    ["missing node version", (d) => delete d.nodes[0].version],
    ["empty owner", (d) => (d.nodes[0].owner = "")],
    ["unknown relation", (d) => (d.edges[0].relation = "calls")],
    ["zero source_line", (d) => (d.edges[0].source_line = 0)],
    ["fractional source_line", (d) => (d.edges[0].source_line = 1.5)],
    ["missing source_file", (d) => delete d.edges[0].source_file],
    ["non UTC timestamp", (d) => (d.edges[0].verified_at = "2026-09-01T00:00:00+02:00")],
    ["bad contract field type", (d) => (d.nodes[1].contract.fields[0].type = "date")],
    ["missing contract field required flag", (d) => delete d.nodes[1].contract.fields[0].required],
    ["nodes not an array", (d) => (d.nodes = {})],
  ];

  it.each(invalid)("both validators reject: %s", (_name, mutate) => {
    const doc = clone(billingManifest());
    mutate(doc);
    expect(validate(doc)).toBe(false);
    expect(buildGraph(doc).ok).toBe(false);
  });

  it("documents (and this test pins) the rules only the runtime validator enforces", () => {
    const dangling = manifest([n("svc.a", "service")], [e("svc.a", "svc.ghost", "consumes")]);
    expect(validate(dangling)).toBe(true);
    expect(buildGraph(dangling).ok).toBe(false);
    const duplicate = manifest([n("svc.a", "service"), n("svc.a", "service")], []);
    expect(validate(duplicate)).toBe(true);
    expect(buildGraph(duplicate).ok).toBe(false);
    const calendar = billingManifest();
    (calendar.edges as any[])[0].verified_at = "2026-02-31T00:00:00Z";
    expect(validate(calendar)).toBe(true);
    expect(buildGraph(calendar).ok).toBe(false);
  });

  it("isUtcTimestamp accepts real instants and rejects overflow", () => {
    expect(isUtcTimestamp("2026-02-28T23:59:59Z")).toBe(true);
    expect(isUtcTimestamp("2028-02-29T00:00:00.5Z")).toBe(true);
    expect(isUtcTimestamp("2026-02-29T00:00:00Z")).toBe(false);
    expect(isUtcTimestamp("2026-13-01T00:00:00Z")).toBe(false);
    expect(isUtcTimestamp("not a time")).toBe(false);
  });
});
