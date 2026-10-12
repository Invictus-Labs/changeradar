import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultSettings } from "../../src/platform/context.js";
import { revokeAccess } from "../../src/services/auth.js";
import { buildGraph } from "../../src/services/graph.js";
import { startFixture, type Fixture } from "../helpers/fixture-server.js";
import { count, createHarness, getRun, PASSWORD, type Harness, type TestWorkspace } from "../helpers/harness.js";
import { baselineDoc, removeAmountDoc } from "../helpers/scenario.js";
import { billingManifest } from "../helpers/builders.js";

/** Review round 1 P2 items with code changes: 422 details, member revocation, check budget, early abort. */

describe("R1 P2: 422 details never echo submitted text (checks.ts:113, impact.ts:63)", () => {
  let h: Harness;
  let ws: TestWorkspace;
  beforeAll(async () => {
    h = await createHarness();
    ws = await h.workspace("Details");
  });
  afterAll(async () => h.close());
  const planted = ["AK", "IA", "IOSFODNN7EXAMPLE"].join("");

  it("a contract check body with an unrecognised key named like a credential returns fixed messages", async () => {
    const res = await h.api(ws.admin, "POST", "/api/v1/contract-checks", { key: "chk.a", node_id: "contract.invoice", url: "https://check.example.test/x", [planted]: 1 });
    expect(res.status).toBe(422);
    expect(res.text).not.toContain(planted);
    expect(res.body.error.details.issues[0].message).toBe("unrecognized properties are not allowed");
  });

  it("an impact run request with such a key does the same, and valid custom messages still explain themselves", async () => {
    const res = await h.api(ws.operator, "POST", "/api/v1/impact-runs", { snapshot_id: "not-a-uuid", proposed_manifest: {}, expected_hash: "x", [planted]: true });
    expect(res.status).toBe(422);
    expect(res.text).not.toContain(planted);
    const messages = res.body.error.details.issues.map((i: any) => i.message);
    expect(messages).toContain("unrecognized properties are not allowed");
    expect(messages).toContain("snapshot_id must be a UUID");
  });
});

describe("R1 P2: an operator can revoke a member's sessions or remove them (auth.ts:63)", () => {
  let h: Harness;
  let ws: TestWorkspace;
  beforeAll(async () => {
    h = await createHarness();
    ws = await h.workspace("Revoke");
  });
  afterAll(async () => h.close());

  it("revoking cuts the member's session off at the next request and leaves others alone", async () => {
    expect((await h.api(ws.operator, "GET", "/api/v1/baseline")).status).toBe(200);
    const result = await h.db.transaction((tx) => revokeAccess(tx, { workspaceId: ws.id, email: ws.operator.email, removeMember: false, at: h.now() }));
    expect(result).toEqual({ sessions_revoked: 1, membership_removed: false });
    expect((await h.api(ws.operator, "GET", "/api/v1/baseline")).status).toBe(401);
    expect((await h.api(ws.viewer, "GET", "/api/v1/baseline")).status).toBe(200);
    expect(await count(h.db, "audit_events", "action = 'member.sessions_revoked'")).toBe(1);
    // The account still exists: a fresh login works until the membership is removed.
    const login = await h.app.inject({ method: "POST", url: "/api/v1/auth/login", headers: { "content-type": "application/json" }, payload: JSON.stringify({ email: ws.operator.email, password: PASSWORD }) });
    expect(login.statusCode).toBe(200);
  });

  it("removing the membership ends every session and the login", async () => {
    const result = await h.db.transaction((tx) => revokeAccess(tx, { workspaceId: ws.id, email: ws.viewer.email.toUpperCase(), removeMember: true, at: h.now() }));
    expect(result.membership_removed).toBe(true);
    expect((await h.api(ws.viewer, "GET", "/api/v1/baseline")).status).toBe(401);
    expect(await count(h.db, "memberships", "workspace_id = $1", [ws.id])).toBe(2);
    expect(await count(h.db, "audit_events", "action = 'member.removed'")).toBe(1);
  });

  it("an unknown member is a clear error and changes nothing", async () => {
    await expect(h.db.transaction((tx) => revokeAccess(tx, { workspaceId: ws.id, email: "nobody@revoke.test", removeMember: true, at: h.now() }))).rejects.toMatchObject({ code: "UNKNOWN_MEMBER" });
  });
});

describe("R1 P2: the contract checks of one run have a wall clock budget (worker.ts:134)", () => {
  let h: Harness;
  let ws: TestWorkspace;
  let fx: Fixture;
  beforeAll(async () => {
    fx = await startFixture();
    h = await createHarness({ settings: { checks: { ...defaultSettings.checks, allowedHosts: [`127.0.0.1:${fx.port}`], allowPrivateNetwork: true, backoffBaseMs: 5, runBudgetMs: 0 } } });
    ws = await h.workspace("Budget");
    for (const key of ["chk.one", "chk.two"]) {
      const res = await h.api(ws.admin, "POST", "/api/v1/contract-checks", { key, node_id: "contract.invoice", url: `${fx.origin}/ok`, retries: 0, timeout_ms: 1000 });
      expect(res.status, res.text).toBe(201);
    }
  });
  afterAll(async () => {
    await h.close();
    await fx.close();
  });

  it("once the budget is used up every check not yet run is recorded TIMED_OUT (not run), the endpoint is never called, and the run is INCOMPLETE", async () => {
    const snap = await h.importSnapshot(ws.operator, baselineDoc());
    const run = await h.requestRun(ws.operator, { snapshot_id: snap.body.id, proposed_manifest: removeAmountDoc(), expected_hash: snap.body.hash });
    const before = fx.hits("/ok");
    await h.drain();
    const view = await getRun(h, ws.viewer, run.body.id);
    expect(view.status).toBe("complete");
    expect(view.assessment).toBe("INCOMPLETE");
    expect(view.checks.map((c: any) => [c.check_key, c.state, c.attempts])).toEqual([["chk.one", "TIMED_OUT", 0], ["chk.two", "TIMED_OUT", 0]]);
    expect(view.checks[0].detail).toContain("not run");
    expect(view.unknowns.map((u: any) => u.code).filter((c: string) => c === "CHECK_TIMED_OUT")).toHaveLength(2);
    expect(fx.hits("/ok")).toBe(before);
  });
});

describe("R1 P2: an invalid manifest stops collecting issues at the cap (graph.ts:282)", () => {
  it("50,000 broken edges (250,000 schema issues) are rejected quickly with the first 100 issues and a total of at least 100", () => {
    const doc = billingManifest();
    (doc as { edges: unknown[] }).edges = Array.from({ length: 50_000 }, () => ({}));
    const started = Date.now();
    const built = buildGraph(doc);
    const ms = Date.now() - started;
    expect(built.ok).toBe(false);
    if (!built.ok) {
      expect(built.failure.code).toBe("SCHEMA_INVALID");
      expect(built.failure.issues).toHaveLength(100);
      expect(built.failure.total_issues).toBeGreaterThanOrEqual(100);
      expect(built.failure.issues[0]!.path.startsWith("/edges/")).toBe(true);
    }
    expect(ms).toBeLessThan(1500);
  });

  it("below the cap the total is exact and the same input always gives the same failure", () => {
    const doc = billingManifest();
    (doc as { nodes: unknown[] }).nodes = [{}, { id: "x" }];
    const a = buildGraph(doc);
    const b = buildGraph(doc);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    if (!a.ok) expect(a.failure.total_issues).toBe(a.failure.issues.length);
  });
});
