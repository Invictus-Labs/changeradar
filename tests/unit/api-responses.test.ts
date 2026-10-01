import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { buildResponseJsonSchemas, RESPONSE_SCHEMAS } from "../../src/domain/api-responses.js";
import { UUID_ONES } from "../helpers/ids.js";

/** PRD: request AND response schemas ship. schemas/api-responses.json is generated from src/domain/api-responses.ts. */

const path = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "schemas", "api-responses.json");
const committed = readFileSync(path, "utf8");
const shipped = JSON.parse(committed) as { $defs: Record<string, object> };
const ajv = new Ajv2020({ allErrors: true, strict: false });
const compile = (name: string) => ajv.compile({ $schema: "https://json-schema.org/draft/2020-12/schema", ...shipped.$defs[name] });
const H = `sha256:${"a".repeat(64)}`;

describe("schemas/api-responses.json", () => {
  it("is exactly what the response schemas generate (no drift)", () => {
    expect(committed).toBe(JSON.stringify(buildResponseJsonSchemas(), null, 2) + "\n");
  });

  it("declares every named response", () => {
    expect(Object.keys(shipped.$defs)).toEqual(Object.keys(RESPONSE_SCHEMAS));
  });

  it("the error envelope, health and session schemas accept their documented bodies and reject near misses", () => {
    const error = compile("error_envelope");
    expect(error({ error: { code: "NOT_FOUND", message: "Not found", request_id: "r-1" } })).toBe(true);
    expect(error({ error: { code: "SCHEMA_INVALID", message: "m", request_id: "r-1", details: { issues: [] } } })).toBe(true);
    expect(error({ error: { code: "X", message: "m" } })).toBe(false);
    expect(error({ code: "X", message: "m", request_id: "r" })).toBe(false);
    const live = compile("health_live");
    expect(live({ status: "ok", version: "0.1.0" })).toBe(true);
    expect(live({ status: "ready", version: "0.1.0" })).toBe(false);
    const session = compile("session_response");
    const user = { id: UUID_ONES, email: "a@b.test", workspace_id: UUID_ONES, workspace_name: "W", role: "viewer" };
    expect(session({ user, csrf_token: "t" })).toBe(true);
    expect(session({ user: { ...user, role: "root" }, csrf_token: "t" })).toBe(false);
    expect(session({ user })).toBe(false);
  });

  it("the run receipt is exactly its six members", () => {
    const receipt = compile("impact_run_receipt");
    const good = { id: UUID_ONES, status: "queued", snapshot_id: UUID_ONES, baseline_hash: H, proposed_hash: H, baseline_version: 1 };
    expect(receipt(good)).toBe(true);
    expect(receipt({ ...good, status: "running" })).toBe(false);
    expect(receipt({ ...good, extra: 1 })).toBe(false);
    const { baseline_version: _v, ...missing } = good;
    expect(receipt(missing)).toBe(false);
  });
});
