import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer } from "../../src/api/bootstrap.js";
import { RESPONSE_SCHEMAS } from "../../src/domain/api-responses.js";
import { defaultSettings } from "../../src/platform/context.js";
import { createHarness, getRun, PASSWORD, type Harness, type TestWorkspace } from "../helpers/harness.js";
import { UUID_ONES } from "../helpers/ids.js";
import { baselineDoc, fanOutManifest, removeAmountDoc, unverifiedEdgeDoc } from "../helpers/scenario.js";

/**
 * Contract tests (review round 2, PRD "request and response schemas ship"): REAL responses of the running API, in
 * every documented state, validated against the SHIPPED schemas/api-responses.json (Ajv, draft 2020-12) and against
 * the zod schemas they are generated from. A renamed, removed or added member fails here; the negative controls at
 * the end prove the schemas are strict enough for that to be true.
 */

const path = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "schemas", "api-responses.json");
const shipped = JSON.parse(readFileSync(path, "utf8")) as { $defs: Record<string, object> };
const ajv = new Ajv2020({ allErrors: true, strict: false });
type Name = keyof typeof RESPONSE_SCHEMAS;
const validators = new Map<string, ReturnType<typeof ajv.compile>>();
const shippedValidator = (name: Name) => {
  if (!validators.has(name)) validators.set(name, ajv.compile({ $schema: "https://json-schema.org/draft/2020-12/schema", ...shipped.$defs[name] }));
  return validators.get(name)!;
};

/** The body must satisfy the shipped JSON Schema AND the zod schema; the failure message names the schema and the errors. */
function conforms(name: Name, body: unknown, label: string): void {
  const validate = shippedValidator(name);
  const ok = validate(body);
  expect(ok, `${label}: shipped ${name} rejects the response: ${JSON.stringify(validate.errors?.slice(0, 3))}`).toBe(true);
  const parsed = RESPONSE_SCHEMAS[name].safeParse(body);
  expect(parsed.success, `${label}: zod ${name} rejects the response: ${parsed.success ? "" : JSON.stringify(parsed.error.issues.slice(0, 3))}`).toBe(true);
}
const rejected = (name: Name, body: unknown): boolean => !shippedValidator(name)(body) && !RESPONSE_SCHEMAS[name].safeParse(body).success;

describe("shipped response schemas: file, coverage of the documented responses", () => {
  it("schemas/api-responses.json declares every named response and nothing else", () => {
    expect(Object.keys(shipped.$defs).sort()).toEqual(Object.keys(RESPONSE_SCHEMAS).sort());
    for (const name of ["error_envelope", "health_live", "health_ready", "session_response", "snapshot_receipt", "impact_run_receipt", "impact_run_view", "findings_page", "run_report", "snapshot_list_page", "impact_run_list_page"]) {
      expect(shipped.$defs[name], name).toBeDefined();
    }
  });
});

describe("contract: every documented response of the running API conforms to the shipped schemas", () => {
  let h: Harness;
  let ws: TestWorkspace;
  let baseline: { id: string; hash: string };
  let runComplete: string;
  let runIncomplete: string;
  let runMany: string;
  let runCapped: string;
  let snapshotReceipt: unknown;
  let runReceipt: unknown;
  let queuedView: { status: string };

  beforeAll(async () => {
    h = await createHarness({ settings: { assess: { max_findings: 120, max_findings_per_origin: 120 } } });
    ws = await h.workspace("Contract");
    const s1 = await h.importSnapshot(ws.operator, baselineDoc(), { revision: "release-1" });
    expect(s1.status, s1.text).toBe(201);
    snapshotReceipt = s1.body;
    baseline = { id: s1.body.id, hash: s1.body.hash };
    const complete = await h.requestRun(ws.operator, { snapshot_id: baseline.id, proposed_manifest: removeAmountDoc(), expected_hash: baseline.hash, run_checks: false });
    expect(complete.status, complete.text).toBe(202);
    runReceipt = complete.body;
    runComplete = complete.body.id;
    // A queued run, read before the worker has touched it (validated in a test below, not in this hook).
    queuedView = await getRun(h, ws.viewer, runComplete);
    await h.drain();

    const s2 = await h.importSnapshot(ws.operator, unverifiedEdgeDoc(), { revision: "release-2" });
    const incomplete = await h.requestRun(ws.operator, { snapshot_id: s2.body.id, proposed_manifest: removeAmountDoc(), expected_hash: s2.body.hash, run_checks: false });
    runIncomplete = incomplete.body.id;

    const s3 = await h.importSnapshot(ws.operator, fanOutManifest(150), { revision: "release-3" });
    const many = await h.requestRun(ws.operator, { snapshot_id: s3.body.id, proposed_manifest: fanOutManifest(150, { dropAmount: true }), expected_hash: s3.body.hash, run_checks: false });
    runMany = many.body.id;
    const s4 = await h.importSnapshot(ws.operator, fanOutManifest(200), { revision: "release-4" });
    const capped = await h.requestRun(ws.operator, { snapshot_id: s4.body.id, proposed_manifest: fanOutManifest(200, { dropAmount: true }), expected_hash: s4.body.hash, run_checks: false });
    runCapped = capped.body.id;
    await h.drain();
  }, 120_000);
  afterAll(async () => {
    await h.close();
  });

  it("the receipts: POST /snapshots 201, POST /impact-runs 202, and the run as read while still queued", () => {
    conforms("snapshot_receipt", snapshotReceipt, "POST /snapshots 201");
    conforms("impact_run_receipt", runReceipt, "POST /impact-runs 202");
    conforms("impact_run_view", queuedView, "GET run (queued)");
    expect(queuedView.status).toBe("queued");
  });

  it("health: live 200, ready 200, and ready 503 with the error envelope and Retry-After", async () => {
    conforms("health_live", (await h.api(null, "GET", "/api/v1/health/live")).body, "live");
    conforms("health_ready", (await h.api(null, "GET", "/api/v1/health/ready")).body, "ready");
    h.ctx.readiness = { ok: false, reason: "migration_failed" };
    try {
      const notReady = await h.api(null, "GET", "/api/v1/health/ready");
      expect(notReady.status).toBe(503);
      conforms("error_envelope", notReady.body, "ready 503");
      expect(notReady.headers["retry-after"]).toBe("5");
      const other = await h.api(ws.viewer, "GET", "/api/v1/snapshots");
      expect(other.status).toBe(503);
      conforms("error_envelope", other.body, "any route while not ready");
    } finally {
      h.ctx.readiness = { ok: true, reason: "ready" };
    }
  });

  it("login 200, session 200, logout 200; wrong password 401; unauthenticated 401; wrong role 403", async () => {
    const login = await h.api(null, "POST", "/api/v1/auth/login", { email: ws.viewer.email, password: PASSWORD, workspace_id: ws.id });
    expect(login.status, login.text).toBe(200);
    conforms("session_response", login.body, "login");
    const session = await h.api(ws.viewer, "GET", "/api/v1/auth/session");
    expect(session.status).toBe(200);
    conforms("session_response", session.body, "session");
    const wrong = await h.api(null, "POST", "/api/v1/auth/login", { email: ws.viewer.email, password: "not-the-password", workspace_id: ws.id });
    expect(wrong.status).toBe(401);
    conforms("error_envelope", wrong.body, "login 401");
    const anonymous = await h.api(null, "GET", "/api/v1/snapshots");
    expect(anonymous.status).toBe(401);
    conforms("error_envelope", anonymous.body, "unauthenticated 401");
    const forbidden = await h.api(ws.viewer, "POST", "/api/v1/snapshots", { schema_version: 1, revision: "x", manifest: baselineDoc() });
    expect(forbidden.status).toBe(403);
    conforms("error_envelope", forbidden.body, "viewer POST 403");
    const logout = await h.api(ws.admin, "POST", "/api/v1/auth/logout");
    expect(logout.status).toBe(200);
    expect(RESPONSE_SCHEMAS.logout_response.safeParse(logout.body).success).toBe(true);
  });

  it("error envelopes: 404, 409 stale baseline, 422 with details, 400 bad cursor, 429", async () => {
    const missing = await h.api(ws.viewer, "GET", `/api/v1/impact-runs/${UUID_ONES}`);
    expect(missing.status).toBe(404);
    conforms("error_envelope", missing.body, "404");
    const stale = await h.api(ws.operator, "POST", "/api/v1/impact-runs", { snapshot_id: baseline.id, proposed_manifest: removeAmountDoc(), expected_hash: baseline.hash }, { csrf: ws.operator.csrf });
    expect(stale.status, stale.text).toBe(409);
    conforms("error_envelope", stale.body, "409 stale baseline");
    expect(stale.body.error.details).toMatchObject({ current_baseline_snapshot_id: expect.any(String) });
    const invalid = await h.importSnapshot(ws.operator, { schema_version: 1, nodes: "no" }, { revision: "bad" });
    expect(invalid.status).toBe(422);
    conforms("error_envelope", invalid.body, "422");
    expect(invalid.body.error.details.issues.length).toBeGreaterThan(0);
    const cursor = await h.api(ws.viewer, "GET", `/api/v1/impact-runs/${runMany}/findings?cursor=not-a-cursor`);
    expect(cursor.status).toBe(400);
    conforms("error_envelope", cursor.body, "400 cursor");
    // The operator's own export budget (12 per window) is used up here; the viewer's is untouched for the tests below.
    for (let i = 0; i < 14; i += 1) await h.api(ws.operator, "GET", `/api/v1/impact-runs/${runComplete}/export?format=json`);
    const limited = await h.api(ws.operator, "GET", `/api/v1/impact-runs/${runComplete}/export?format=json`);
    expect(limited.status).toBe(429);
    conforms("error_envelope", limited.body, "429");
    expect(limited.headers["retry-after"]).toBeDefined();
  });

  it("run views: AFFECTED, INCOMPLETE with unknowns, more than 100 findings (truncated flags), findings omitted by a cap", async () => {
    const affected = await getRun(h, ws.viewer, runComplete);
    conforms("impact_run_view", affected, "AFFECTED");
    expect(affected.assessment).toBe("AFFECTED");
    const incomplete = await getRun(h, ws.viewer, runIncomplete);
    conforms("impact_run_view", incomplete, "INCOMPLETE");
    expect(incomplete.assessment).toBe("INCOMPLETE");
    expect(incomplete.unknowns.length).toBeGreaterThan(0);
    const many = await getRun(h, ws.viewer, runMany);
    conforms("impact_run_view", many, ">100 findings");
    expect(many.truncated.findings).toBe(true);
    expect(many.affected).toHaveLength(100);
    const capped = await getRun(h, ws.viewer, runCapped);
    conforms("impact_run_view", capped, "findings omitted");
    expect(capped.assessment).toBe("INCOMPLETE");
    expect(capped.summary.findings_omitted).toBeGreaterThan(0);
  });

  it("an older-engine run keeps the same shape and says so (engine.rerun_required, note)", async () => {
    await h.db.query("ALTER TABLE impact_runs DISABLE TRIGGER impact_runs_protect");
    try {
      await h.db.query("UPDATE impact_runs SET assessment = assessment - 'engine_version' WHERE id = $1", [runComplete]);
    } finally {
      await h.db.query("ALTER TABLE impact_runs ENABLE TRIGGER impact_runs_protect");
    }
    const old = await getRun(h, ws.viewer, runComplete);
    conforms("impact_run_view", old, "older engine");
    expect(old.engine).toMatchObject({ version: 1, rerun_required: true });
    expect(old.engine.note).toContain("re-run required");
    const report = await h.api(ws.viewer, "GET", `/api/v1/impact-runs/${runComplete}/export?format=json`);
    expect(report.status).toBe(200);
    conforms("run_report", report.body, "report of an older-engine run");
  });

  it("findings pages: first page with next_cursor, last page with null, an empty run", async () => {
    const first = await h.api(ws.viewer, "GET", `/api/v1/impact-runs/${runMany}/findings?limit=100`);
    expect(first.status).toBe(200);
    conforms("findings_page", first.body, "findings page 1");
    expect(first.body.next_cursor).toEqual(expect.any(String));
    const second = await h.api(ws.viewer, "GET", `/api/v1/impact-runs/${runMany}/findings?limit=100&cursor=${encodeURIComponent(first.body.next_cursor)}`);
    conforms("findings_page", second.body, "findings page 2");
    expect(second.body.next_cursor).toBeNull();
    // max_findings is 120 in this harness, so the 150 consumers are capped: 120 recorded, the run is INCOMPLETE.
    expect(first.body.items.length + second.body.items.length).toBe(120);
  });

  it("lists: snapshots and runs, with and without a next cursor", async () => {
    const snaps = await h.api(ws.viewer, "GET", "/api/v1/snapshots?limit=2");
    expect(snaps.status).toBe(200);
    conforms("snapshot_list_page", snaps.body, "snapshots page");
    expect(snaps.body.next_cursor).toEqual(expect.any(String));
    const runs = await h.api(ws.viewer, "GET", "/api/v1/impact-runs?limit=3");
    conforms("impact_run_list_page", runs.body, "runs page");
    const one = await h.api(ws.viewer, "GET", `/api/v1/snapshots/${baseline.id}`);
    expect(RESPONSE_SCHEMAS.snapshot_summary.safeParse(one.body).success).toBe(true);
    expect(shippedValidator("snapshot_summary")(one.body)).toBe(true);
  });

  it("the JSON export conforms, for a complete run and one with unknowns", async () => {
    for (const id of [runMany, runIncomplete]) {
      const report = await h.api(ws.viewer, "GET", `/api/v1/impact-runs/${id}/export?format=json`);
      expect(report.status, report.text).toBe(200);
      conforms("run_report", report.body, `export ${id}`);
    }
  });

  describe("negative controls: the schemas catch drift (each real response, then renamed, removed and added members)", () => {
    let view: any;
    let page: any;
    let receipt: any;
    beforeAll(async () => {
      view = await getRun(h, ws.viewer, runIncomplete);
      page = (await h.api(ws.viewer, "GET", `/api/v1/impact-runs/${runMany}/findings?limit=2`)).body;
      const list = await h.api(ws.viewer, "GET", "/api/v1/snapshots?limit=1");
      receipt = list.body.items[0];
    });

    it("control: the untouched responses conform", () => {
      conforms("impact_run_view", view, "view");
      conforms("findings_page", page, "page");
      conforms("snapshot_summary", receipt, "summary");
    });

    it("a renamed member is rejected", () => {
      const { assessment, ...rest } = view;
      expect(rejected("impact_run_view", { ...rest, verdict: assessment })).toBe(true);
      const { next_cursor, ...pageRest } = page;
      expect(rejected("findings_page", { ...pageRest, cursor: next_cursor })).toBe(true);
      const { hash, ...summaryRest } = receipt;
      expect(rejected("snapshot_summary", { ...summaryRest, graph_hash: hash })).toBe(true);
    });

    it("a removed member is rejected, for every top-level member of the run view", () => {
      for (const key of Object.keys(view)) {
        const copy = { ...view };
        delete copy[key];
        expect(rejected("impact_run_view", copy), `removing ${key}`).toBe(true);
      }
    });

    it("an added member is rejected", () => {
      expect(rejected("impact_run_view", { ...view, extra: 1 })).toBe(true);
      expect(rejected("findings_page", { ...page, total: 2 })).toBe(true);
      expect(rejected("findings_page", { ...page, items: page.items.map((i: any) => ({ ...i, extra: true })) })).toBe(true);
      expect(rejected("error_envelope", { error: { code: "X", message: "m", request_id: "r" }, status: 400 })).toBe(true);
    });

    it("a wrong type is rejected (a status outside the vocabulary, a number where text belongs)", () => {
      expect(rejected("impact_run_view", { ...view, status: "done" })).toBe(true);
      expect(rejected("impact_run_view", { ...view, assessment: "SAFE" })).toBe(true);
      expect(rejected("findings_page", { ...page, next_cursor: 5 })).toBe(true);
      expect(rejected("error_envelope", { error: { code: 404, message: "m", request_id: "r" } })).toBe(true);
    });
  });
});

describe("contract over a real socket: health, login, session and the error envelope", () => {
  it("a listening server answers with bodies that conform, and with the 401 envelope", async () => {
    const h = await createHarness({ settings: { checks: { ...defaultSettings.checks } } });
    const server = await startServer(h.ctx, { host: "127.0.0.1", port: 0, withWorker: false });
    try {
      const w = await h.workspace("Socket");
      const base = server.address;
      const live = await fetch(`${base}/api/v1/health/live`);
      expect(live.status).toBe(200);
      conforms("health_live", await live.json(), "socket live");
      const ready = await fetch(`${base}/api/v1/health/ready`);
      conforms("health_ready", await ready.json(), "socket ready");
      const login = await fetch(`${base}/api/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: w.viewer.email, password: PASSWORD, workspace_id: w.id }) });
      expect(login.status).toBe(200);
      conforms("session_response", await login.json(), "socket login");
      const denied = await fetch(`${base}/api/v1/snapshots`);
      expect(denied.status).toBe(401);
      conforms("error_envelope", await denied.json(), "socket 401");
      const missing = await fetch(`${base}/api/v1/nope`);
      expect(missing.status).toBe(404);
      conforms("error_envelope", await missing.json(), "socket 404 route");
    } finally {
      await server.stop();
      await h.close();
    }
  }, 60_000);
});
