import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { buildRequestJsonSchemas } from "../../src/domain/api-schemas.js";
import { DEFAULT_LIMITS } from "../../src/domain/limits.js";
import { defaultSettings } from "../../src/platform/context.js";
import { bodySchema } from "../../src/services/checks.js";
import { RequestSchema } from "../../src/services/impact.js";
import { billingManifest } from "../helpers/builders.js";
import { UUID_ONES } from "../helpers/ids.js";

/** Review round 1 P2: request schemas did not ship. They are generated from the validators and checked for drift. */

const path = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "schemas", "api-requests.json");
const committed = readFileSync(path, "utf8");
const schema = JSON.parse(committed) as { $defs: Record<string, object> };
const ajv = new Ajv2020({ allErrors: true, strict: false });
const compile = (name: string) => ajv.compile({ $schema: "https://json-schema.org/draft/2020-12/schema", ...schema.$defs[name] });

describe("schemas/api-requests.json", () => {
  it("is exactly what the server's validators generate (no drift)", () => {
    const generated = buildRequestJsonSchemas({ impactRun: RequestSchema, contractCheck: bodySchema(defaultSettings.checks.maxTimeoutMs), limits: DEFAULT_LIMITS });
    expect(committed).toBe(JSON.stringify(generated, null, 2) + "\n");
  });

  it("declares the three write bodies and the documented manifest limits", () => {
    expect(Object.keys(schema.$defs).sort()).toEqual(["contract_check_request", "impact_run_request", "snapshot_request"]);
    const snapshot = schema.$defs.snapshot_request as { properties: { manifest: { properties: { nodes: { maxItems: number }; edges: { maxItems: number } } } } };
    expect(snapshot.properties.manifest.properties.nodes.maxItems).toBe(10_000);
    expect(snapshot.properties.manifest.properties.edges.maxItems).toBe(50_000);
  });

  it("snapshot_request accepts a real request and rejects what the runtime rejects", () => {
    const validate = compile("snapshot_request");
    expect(validate({ schema_version: 1, revision: "r1", manifest: billingManifest() })).toBe(true);
    expect(validate({ schema_version: 1, revision: "r1", manifest: billingManifest(), extra: 1 })).toBe(false);
    expect(validate({ schema_version: 2, revision: "r1", manifest: billingManifest() })).toBe(false);
    expect(validate({ schema_version: 1, revision: "", manifest: billingManifest() })).toBe(false);
    expect(validate({ schema_version: 1, revision: "r1" })).toBe(false);
  });

  it("impact_run_request and contract_check_request agree with their validators on samples", () => {
    const impact = compile("impact_run_request");
    const goodImpact = { snapshot_id: UUID_ONES, proposed_manifest: {}, expected_hash: "sha256:x", run_checks: false, check_keys: ["chk.a"] };
    expect(impact(goodImpact)).toBe(true);
    expect(RequestSchema.safeParse(goodImpact).success).toBe(true);
    for (const bad of [{ ...goodImpact, extra: 1 }, { ...goodImpact, check_keys: "chk.a" }, { proposed_manifest: {} }]) {
      expect(impact(bad)).toBe(false);
      expect(RequestSchema.safeParse(bad).success).toBe(false);
    }
    const check = compile("contract_check_request");
    const goodCheck = { key: "chk.a", node_id: "contract.invoice", url: "https://check.example.test/x", retries: 1, required_fields: [{ name: "id", type: "string" }] };
    expect(check(goodCheck)).toBe(true);
    expect(bodySchema(30_000).safeParse(goodCheck).success).toBe(true);
    for (const bad of [{ ...goodCheck, retries: 9 }, { ...goodCheck, method: "POST" }, { ...goodCheck, timeout_ms: 0 }]) {
      expect(check(bad)).toBe(false);
      expect(bodySchema(30_000).safeParse(bad).success).toBe(false);
    }
  });
});
