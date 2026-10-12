import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyBundle, buildBundle, serializeBundle } from "../../src/services/evidence.js";
import { count, createHarness, PASSWORD, type Harness, type TestWorkspace } from "../helpers/harness.js";
import { baselineDoc } from "../helpers/scenario.js";
import { billingManifest } from "../helpers/builders.js";

/**
 * Review round 1 regressions at the HTTP level: duplicate JSON keys, authentication before body parsing,
 * a database outage answered 503, the login and unauthenticated limiters, and redaction of stored rows.
 */

const rawSnapshot = (manifestText: string, revision = "rev-1") => `{"schema_version":1,"revision":"${revision}","manifest":${manifestText}}`;

describe("R1 P1: duplicate JSON keys are refused at the API (server.ts:66)", () => {
  let h: Harness;
  let ws: TestWorkspace;
  beforeAll(async () => {
    h = await createHarness();
    ws = await h.workspace("DupKeys");
  });
  afterAll(async () => h.close());

  const manifestText = () => JSON.stringify(baselineDoc());
  const post = (raw: string) => h.api(ws.operator, "POST", "/api/v1/snapshots", undefined, { raw });

  it("control: the same document without a duplicate is imported", async () => {
    const ok = await post(rawSnapshot(manifestText()));
    expect(ok.status, ok.text).toBe(201);
  });

  it.each([
    ["schema_version repeated (2 then 1)", (t: string) => t.replace('"schema_version":1', '"schema_version":2,"schema_version":1')],
    ["owner repeated (a value then null)", (t: string) => t.replace('"owner":"team-billing"', '"owner":"x","owner":null,"owner":"team-billing"')],
    ["verified_at repeated (stale first, fresh last)", (t: string) => t.replace('"verified_at":"2026-09-28T00:00:00Z"', '"verified_at":"1999-01-01T00:00:00Z","verified_at":"2026-09-28T00:00:00Z"')],
    ["nodes repeated", (t: string) => t.replace('"nodes":[', '"nodes":[],"nodes":[')],
    ["a unicode escaped variant of owner", (t: string) => t.replace('"owner":"team-billing"', '"\\u006fwner":"x","owner":"team-billing"')],
  ])("inside the manifest: %s is a 400 DUPLICATE_JSON_KEY and stores nothing", async (_name, mutate) => {
    const before = await count(h.db, "snapshots");
    const text = mutate(manifestText());
    expect(text).not.toBe(manifestText());
    const res = await post(rawSnapshot(text));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("DUPLICATE_JSON_KEY");
    expect(res.text).not.toContain("team-billing");
    expect(await count(h.db, "snapshots")).toBe(before);
  });

  it("in the envelope (revision repeated) and in an impact run request", async () => {
    const res = await post(`{"schema_version":1,"revision":"a","revision":"b","manifest":${manifestText()}}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("DUPLICATE_JSON_KEY");
    const snap = await h.importSnapshot(ws.operator, baselineDoc(), { revision: "r2" });
    const run = await h.api(ws.operator, "POST", "/api/v1/impact-runs", undefined, {
      raw: `{"snapshot_id":"${snap.body.id}","expected_hash":"${snap.body.hash}","expected_hash":"sha256:${"0".repeat(64)}","proposed_manifest":${manifestText()}}`,
    });
    expect(run.status).toBe(400);
    expect(run.body.error.code).toBe("DUPLICATE_JSON_KEY");
  });

  it("a deeply nested body is refused as JSON_TOO_COMPLEX before it is parsed", async () => {
    const res = await post("[".repeat(5000) + "]".repeat(5000));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("JSON_TOO_COMPLEX");
  });

  it("an evidence bundle with a repeated key is refused under its own code (evidence.ts:320)", async () => {
    await h.importSnapshot(ws.operator, baselineDoc(), { revision: "for-bundle" });
    const bundle = await buildBundle(h.db, { workspaceId: ws.id }, h.now());
    const text = serializeBundle(bundle!);
    expect(() => verifyBundle(text, { maxBytes: 1e9 })).not.toThrow();
    const dup = text.replace('"scope":"workspace"', '"scope":"run","scope":"workspace"');
    expect(dup).not.toBe(text);
    try {
      verifyBundle(dup, { maxBytes: 1e9 });
      throw new Error("accepted");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("BUNDLE_DUPLICATE_KEY");
    }
    const nested = text.replace('"format":"changeradar-evidence-bundle"', '"format":"changeradar-evidence-bundle","format":"changeradar-evidence-bundle"');
    expect(() => verifyBundle(nested, { maxBytes: 1e9 })).toThrow(/same object key/);
  });
});

describe("R1 P1: authentication and rate limiting run before the body is read (server.ts:212)", () => {
  let h: Harness;
  let ws: TestWorkspace;
  beforeAll(async () => {
    h = await createHarness({ settings: { rateLimit: { loginPerAccount: 5, loginPerAddress: 50, apiPerPrincipal: 1_000_000, windowMs: 60_000 } } });
    ws = await h.workspace("PreBody");
  });
  afterAll(async () => h.close());

  it("an unauthenticated malformed body is a 401, not a 400 (it was never parsed)", async () => {
    for (const path of ["/api/v1/snapshots", "/api/v1/impact-runs", "/api/v1/contract-checks"]) {
      const res = await h.api(null, "POST", path, undefined, { raw: "{ this is not json" });
      expect(res.status, path).toBe(401);
      expect(res.body.error.code).toBe("UNAUTHENTICATED");
    }
  });

  it("a big unauthenticated body of tiny containers is a 401 without a parse", async () => {
    const started = Date.now();
    const res = await h.api(null, "POST", "/api/v1/snapshots", undefined, { raw: "[" + "[],".repeat(2_000_000) + "[]]" });
    expect(res.status).toBe(401);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("a missing CSRF token is a 403 before a malformed body is parsed", async () => {
    const res = await h.api(ws.operator, "POST", "/api/v1/snapshots", undefined, { raw: "{ nope", csrf: null });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("CSRF_INVALID");
  });

  it("a viewer posting a malformed big body is a 403 (role checked before parsing), an operator gets the 400", async () => {
    const viewer = await h.api(ws.viewer, "POST", "/api/v1/snapshots", undefined, { raw: "{ nope" });
    expect(viewer.status).toBe(403);
    const runViewer = await h.api(ws.viewer, "POST", "/api/v1/impact-runs", undefined, { raw: "{ nope" });
    expect(runViewer.status).toBe(403);
    const operator = await h.api(ws.operator, "POST", "/api/v1/snapshots", undefined, { raw: "{ nope" });
    expect(operator.status).toBe(400);
    expect(operator.body.error.code).toBe("MALFORMED_JSON");
    const operatorChecks = await h.api(ws.operator, "POST", "/api/v1/contract-checks", undefined, { raw: "{ nope" });
    expect(operatorChecks.status).toBe(403);
  });

  it("an address that keeps sending unauthenticated requests is throttled (429 with Retry-After)", async () => {
    const statuses = new Set<number>();
    let last: Awaited<ReturnType<Harness["api"]>> | null = null;
    for (let i = 0; i < 320; i += 1) {
      last = await h.api(null, "GET", "/api/v1/baseline");
      statuses.add(last.status);
    }
    expect(statuses.has(401)).toBe(true);
    expect(last!.status).toBe(429);
    expect(last!.headers["retry-after"]).toBeDefined();
    // The session holder is not affected: the budget is per address for anonymous requests only.
    expect((await h.api(ws.viewer, "GET", "/api/v1/baseline")).status).toBe(200);
  });

  it("the server has a request timeout and a connection cap", () => {
    expect(h.app.server.requestTimeout).toBeGreaterThan(0);
    expect(h.app.server.maxConnections).toBeGreaterThan(0);
  });
});

describe("R1 P2: login throttling (server.ts:185-197)", () => {
  let h: Harness;
  let ws: TestWorkspace;
  beforeAll(async () => {
    h = await createHarness({ settings: { rateLimit: { loginPerAccount: 3, loginPerAddress: 8, apiPerPrincipal: 1_000_000, windowMs: 60_000 } } });
    ws = await h.workspace("Login");
  });
  afterAll(async () => h.close());

  const login = (email: string, password: string, remoteAddress: string) =>
    h.app.inject({ method: "POST", url: "/api/v1/auth/login", remoteAddress, headers: { "content-type": "application/json" }, payload: JSON.stringify({ email, password }) });

  it("bad logins from another address cannot lock a known account out for its real user", async () => {
    for (let i = 0; i < 6; i += 1) expect((await login(ws.operator.email, "wrong-password", "192.0.2.10")).statusCode).toBeGreaterThanOrEqual(401);
    expect((await login(ws.operator.email, "wrong-password", "192.0.2.10")).statusCode).toBe(429);
    const real = await login(ws.operator.email, PASSWORD, "192.0.2.20");
    expect(real.statusCode).toBe(200);
  });

  it("a throttled address never creates account buckets (random names cannot fill the table)", async () => {
    for (let i = 0; i < 8; i += 1) await login(`nobody-${i}@x.test`, "x", "192.0.2.30");
    const throttled = await login("another@x.test", "x", "192.0.2.30");
    expect(throttled.statusCode).toBe(429);
    // A different address with a fresh account name still gets a normal (401) answer, not a 429.
    expect((await login("fresh@x.test", "x", "192.0.2.31")).statusCode).toBe(401);
  });
});

describe("R1 P1: a database outage after startup is a 503, not a 500 (server.ts:115)", () => {
  it("business routes, login and readiness all answer 503 NOT_READY when the database is closed", async () => {
    const h = await createHarness();
    const ws = await h.workspace("Outage");
    expect((await h.api(ws.viewer, "GET", "/api/v1/baseline")).status).toBe(200);
    await h.db.close();
    try {
      for (const [user, method, url, body] of [
        [ws.viewer, "GET", "/api/v1/impact-runs", undefined],
        [ws.operator, "POST", "/api/v1/snapshots", { schema_version: 1, revision: "r", manifest: baselineDoc() }],
        [null, "POST", "/api/v1/auth/login", { email: "a@b.test", password: "x" }],
      ] as const) {
        const res = await h.api(user, method, url, body);
        expect(res.status, `${method} ${url}: ${res.text}`).toBe(503);
        expect(res.body.error.code).toBe("NOT_READY");
        expect(res.headers["retry-after"]).toBeDefined();
      }
      const ready = await h.api(null, "GET", "/api/v1/health/ready");
      expect(ready.status).toBe(503);
      expect((await h.api(null, "GET", "/api/v1/health/live")).status).toBe(200);
    } finally {
      await h.app.close();
    }
  });

  it("a defect that is not a connection failure is still a 500 INTERNAL (the mapping is not a catch-all)", async () => {
    const h = await createHarness();
    try {
      const ws = await h.workspace("Defect");
      await h.db.query("ALTER TABLE snapshots RENAME TO snapshots_gone");
      const res = await h.api(ws.viewer, "GET", "/api/v1/snapshots");
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe("INTERNAL");
    } finally {
      await h.close();
    }
  });
});

describe("R1 P1: stored rows are redacted on the way out (snapshots.ts:289-331)", () => {
  it("nodes and edges served to a viewer never carry a secret that got into storage", async () => {
    const h = await createHarness();
    try {
      const ws = await h.workspace("Views");
      const snap = await h.importSnapshot(ws.operator, billingManifest());
      const planted = ["np", "m_", "aB3dE6gH9jK2mN5pQ8sT1vX4yZ7bC0eF3hJ6"].join("");
      await h.db.query("ALTER TABLE nodes DISABLE TRIGGER ALL");
      await h.db.query("ALTER TABLE edges DISABLE TRIGGER ALL");
      await h.db.query("UPDATE nodes SET owner = $2 WHERE snapshot_id = $1 AND id = 'svc.billing'", [snap.body.id, `team ${planted}`]);
      await h.db.query("UPDATE edges SET source_file = $2 WHERE snapshot_id = $1", [snap.body.id, `manifests/${planted}.yaml`]);
      const nodes = await h.api(ws.viewer, "GET", `/api/v1/snapshots/${snap.body.id}/nodes?limit=100`);
      const edges = await h.api(ws.viewer, "GET", `/api/v1/snapshots/${snap.body.id}/edges?limit=100`);
      expect(nodes.status).toBe(200);
      expect(nodes.text).not.toContain(planted);
      expect(edges.text).not.toContain(planted);
      expect(nodes.text).toContain("[REDACTED]");
      expect(edges.text).toContain("[REDACTED]");
    } finally {
      await h.close();
    }
  });
});
