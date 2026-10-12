import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultSettings } from "../../src/platform/context.js";
import { createHarness, type Harness, type TestWorkspace } from "../helpers/harness.js";
import { baselineDoc, removeAmountDoc } from "../helpers/scenario.js";
import { UUID_ZERO } from "../helpers/ids.js";

const ENVELOPE_KEYS = ["code", "message", "request_id"];

describe("PRD error envelope and status codes", () => {
  let h: Harness;
  let ws: TestWorkspace;
  beforeAll(async () => {
    h = await createHarness({ settings: { maxManifestBytes: 4096, rateLimit: { loginPerAccount: 1000, loginPerAddress: 10_000, apiPerPrincipal: 1_000_000, windowMs: 60_000 } } });
    ws = await h.workspace("Envelope");
  });
  afterAll(async () => h.close());

  const expectEnvelope = (res: { status: number; body: any; headers: Record<string, unknown> }, status: number, code: string) => {
    expect(res.status).toBe(status);
    expect(res.body).toHaveProperty("error");
    expect(Object.keys(res.body)).toEqual(["error"]);
    expect(Object.keys(res.body.error).filter((k) => ENVELOPE_KEYS.includes(k)).sort()).toEqual(ENVELOPE_KEYS);
    expect(res.body.error.code).toBe(code);
    expect(res.body.error.request_id).toBe(res.headers["x-request-id"]);
    expect(typeof res.body.error.message).toBe("string");
  };

  it("400 malformed input", async () => {
    expectEnvelope(await h.api(ws.operator, "POST", "/api/v1/snapshots", undefined, { raw: "{" }), 400, "MALFORMED_JSON");
    expectEnvelope(await h.api(ws.viewer, "GET", "/api/v1/snapshots?limit=nope"), 400, "INVALID_LIMIT");
    expectEnvelope(await h.api(ws.viewer, "GET", "/api/v1/snapshots?cursor=%%"), 400, "INVALID_CURSOR");
  });
  it("401 unauthenticated", async () => {
    expectEnvelope(await h.api(null, "GET", "/api/v1/snapshots"), 401, "UNAUTHENTICATED");
  });
  it("403 forbidden action", async () => {
    expectEnvelope(await h.importSnapshot(ws.viewer, baselineDoc()), 403, "FORBIDDEN");
    expectEnvelope(await h.api(ws.operator, "POST", "/api/v1/snapshots", {}, { csrf: null }), 403, "CSRF_INVALID");
  });
  it("404 inaccessible object, unknown route and unsupported method", async () => {
    expectEnvelope(await h.api(ws.viewer, "GET", `/api/v1/snapshots/${UUID_ZERO}`), 404, "NOT_FOUND");
    expectEnvelope(await h.api(null, "GET", "/api/v1/nope"), 404, "NOT_FOUND");
    expectEnvelope(await h.api(null, "DELETE", "/api/v1/snapshots"), 404, "NOT_FOUND");
    expectEnvelope(await h.api(null, "GET", "/"), 404, "NOT_FOUND");
    expectEnvelope(await h.api(ws.viewer, "GET", "/api/v1/snapshots/"), 404, "NOT_FOUND");
    expectEnvelope(await h.api(ws.viewer, "GET", "/API/V1/snapshots"), 404, "NOT_FOUND");
  });
  it("409 version conflict and idempotency conflict", async () => {
    const snap = await h.importSnapshot(ws.operator, baselineDoc());
    expectEnvelope(await h.requestRun(ws.operator, { snapshot_id: snap.body.id, proposed_manifest: removeAmountDoc(), expected_hash: "sha256:" + "f".repeat(64) }), 409, "STALE_BASELINE");
    await h.importSnapshot(ws.operator, baselineDoc(), { key: "k-envelope" });
    expectEnvelope(await h.importSnapshot(ws.operator, removeAmountDoc(), { key: "k-envelope" }), 409, "IDEMPOTENCY_CONFLICT");
  });
  it("413 oversize payload, before processing", async () => {
    const body = JSON.stringify({ schema_version: 1, revision: "r", manifest: { ...baselineDoc(), padding: "x".repeat(70_000) } });
    expectEnvelope(await h.api(ws.operator, "POST", "/api/v1/snapshots", undefined, { raw: body }), 413, "PAYLOAD_TOO_LARGE");
  });
  it("422 schema or policy rejection", async () => {
    expectEnvelope(await h.importSnapshot(ws.operator, { schema_version: 1 }), 422, "SCHEMA_INVALID");
    expectEnvelope(await h.api(ws.operator, "POST", "/api/v1/impact-runs", {}), 422, "SCHEMA_INVALID");
  });
  it("429 rate limit", async () => {
    const limited = await createHarness({ settings: { rateLimit: { loginPerAccount: 1, loginPerAddress: 10_000, apiPerPrincipal: 1_000_000, windowMs: 60_000 } } });
    try {
      await limited.workspace("Limited"); // the setup login spent the single per-account attempt
      const res = await limited.app.inject({ method: "POST", url: "/api/v1/auth/login", headers: { "content-type": "application/json" }, payload: JSON.stringify({ email: "admin@limited.test", password: "x".repeat(12) }) });
      expect(res.statusCode).toBe(429);
      expect(JSON.parse(res.body).error).toMatchObject({ code: "RATE_LIMITED" });
    } finally {
      await limited.close();
    }
  });
  it("503 dependency unavailable", async () => {
    h.ctx.readiness = { ok: false, reason: "database_unavailable" };
    try {
      expectEnvelope(await h.api(ws.viewer, "GET", "/api/v1/snapshots"), 503, "NOT_READY");
      expectEnvelope(await h.api(null, "GET", "/api/v1/health/ready"), 503, "NOT_READY");
      expect((await h.api(null, "GET", "/api/v1/health/live")).status).toBe(200);
    } finally {
      h.ctx.readiness = { ok: true, reason: "ready" };
    }
    expect((await h.api(ws.viewer, "GET", "/api/v1/snapshots")).status).toBe(200);
  });
  it("500 is generic and carries a request id", async () => {
    const original = h.ctx.db.query.bind(h.ctx.db);
    h.ctx.db.query = (async () => {
      throw new Error("internal detail that must not leak");
    }) as never;
    try {
      const res = await h.api(ws.viewer, "GET", "/api/v1/baseline");
      expect(res.status).toBe(500);
      expect(res.text).not.toContain("internal detail");
    } finally {
      h.ctx.db.query = original as never;
    }
  });
});

describe("routes, methods and headers", () => {
  let h: Harness;
  let ws: TestWorkspace;
  beforeAll(async () => {
    h = await createHarness();
    ws = await h.workspace("Routes");
  });
  afterAll(async () => h.close());

  it("health endpoints report liveness and readiness with the version", async () => {
    const live = await h.api(null, "GET", "/api/v1/health/live");
    expect(live.body).toEqual({ status: "ok", version: "0.1.0" });
    const ready = await h.api(null, "GET", "/api/v1/health/ready");
    expect(ready.status).toBe(200);
    expect(ready.body).toEqual({ status: "ready", version: "0.1.0" });
  });

  it("sets no CORS headers and answers OPTIONS with 404 (same-origin only)", async () => {
    const res = await h.app.inject({ method: "OPTIONS", url: "/api/v1/snapshots", headers: { origin: "https://evil.example", "access-control-request-method": "POST" } });
    expect(res.statusCode).toBe(404);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    const get = await h.app.inject({ method: "GET", url: "/api/v1/health/live", headers: { origin: "https://evil.example" } });
    expect(get.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("GET /settings reports effective limits and the retention defaults as NOT enforced", async () => {
    const res = await h.api(ws.admin, "GET", "/api/v1/settings");
    expect(res.status).toBe(200);
    expect(res.body.limits).toMatchObject({ max_manifest_bytes: 25 * 1024 * 1024, max_nodes: 10_000, max_edges: 50_000, max_page_size: 100, idempotency_retention_days: 7 });
    expect(res.body.retention).toMatchObject({ evidenceDays: 90, deletionHours: 24, backupExpiryDays: 30, enforced: false });
    expect(res.body.retention.note).toContain("Nothing is deleted automatically");
    expect(res.body.checks).toMatchObject({ allow_private_network: false });
    expect(res.body.event_sink_configured).toBe(false);
  });

  it("GET /members and GET /audit list only what an admin may see, with audit paging", async () => {
    await h.importSnapshot(ws.operator, baselineDoc());
    const members = await h.api(ws.admin, "GET", "/api/v1/members");
    expect(members.body.items.map((m: any) => m.role).sort()).toEqual(["admin", "operator", "viewer"]);
    // Round 4: logins are audited too (the harness signs each user in first), so the import is found among the rows, not first.
    const audit = await h.api(ws.admin, "GET", "/api/v1/audit?limit=100");
    expect(audit.body.items.find((r: any) => r.action === "snapshot.imported")).toMatchObject({ actor_type: "user", action: "snapshot.imported", resource_type: "snapshot" });
    expect(audit.body.items.filter((r: any) => r.action === "auth.login").length).toBeGreaterThanOrEqual(3);
    expect(audit.body.next_cursor).toBeNull();
    expect((await h.api(ws.admin, "GET", "/api/v1/audit?limit=1")).body.items).toHaveLength(1);
    await h.importSnapshot(ws.operator, baselineDoc());
    const p1 = await h.api(ws.admin, "GET", "/api/v1/audit?limit=1");
    expect(p1.body.next_cursor).toEqual(expect.any(String));
    const p2 = await h.api(ws.admin, "GET", `/api/v1/audit?limit=1&cursor=${p1.body.next_cursor}`);
    expect(p2.body.items[0].seq).toBeGreaterThan(p1.body.items[0].seq);
  });

  it("members and contract checks are cursor paginated like every other list", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: { status: number; body: { items: { email: string }[]; next_cursor: string | null } } = await h.api(ws.admin, "GET", `/api/v1/members?limit=1${cursor ? `&cursor=${cursor}` : ""}`);
      expect(page.status).toBe(200);
      expect(page.body.items.length).toBeLessThanOrEqual(1);
      seen.push(...page.body.items.map((m) => m.email));
      cursor = page.body.next_cursor;
    } while (cursor);
    expect(seen).toEqual(["admin@routes.test", "operator@routes.test", "viewer@routes.test"]);
    expect((await h.api(ws.admin, "GET", "/api/v1/members?limit=101")).status).toBe(400);

    const withChecks = await createHarness({ settings: { checks: { ...defaultSettings.checks, allowedHosts: ["checks.example.test"] } } });
    try {
      const w = await withChecks.workspace("Paged");
      for (const key of ["chk.c", "chk.a", "chk.b"]) {
        expect((await withChecks.api(w.admin, "POST", "/api/v1/contract-checks", { key, node_id: "contract.invoice", url: "https://checks.example.test/x" })).status).toBe(201);
      }
      const keys: string[] = [];
      let next: string | null = null;
      do {
        const page: { body: { items: { key: string }[]; next_cursor: string | null } } = await withChecks.api(w.operator, "GET", `/api/v1/contract-checks?limit=2${next ? `&cursor=${next}` : ""}`);
        keys.push(...page.body.items.map((c) => c.key));
        next = page.body.next_cursor;
      } while (next);
      expect(keys).toEqual(["chk.a", "chk.b", "chk.c"]);
      expect((await withChecks.api(w.operator, "GET", "/api/v1/contract-checks?limit=0")).status).toBe(400);
    } finally {
      await withChecks.close();
    }
  });

  it("HEAD works like GET for reads and needs no CSRF token", async () => {
    const res = await h.app.inject({ method: "HEAD", url: "/api/v1/baseline", headers: { cookie: ws.viewer.cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("");
  });
});
