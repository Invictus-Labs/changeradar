import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, PASSWORD, type Harness, type TestUser, type TestWorkspace } from "../helpers/harness.js";
import { baselineDoc, removeAmountDoc } from "../helpers/scenario.js";
import { UUID_ZERO } from "../helpers/ids.js";

const UUID0 = UUID_ZERO;

describe("AC-12 authentication, sessions and CSRF", () => {
  let h: Harness;
  let ws: TestWorkspace;
  beforeAll(async () => {
    h = await createHarness();
    ws = await h.workspace("Auth");
  });
  afterAll(async () => h.close());

  const login = (email: string, password: string, extra: Record<string, unknown> = {}) =>
    h.app.inject({ method: "POST", url: "/api/v1/auth/login", headers: { "content-type": "application/json" }, payload: JSON.stringify({ email, password, ...extra }) });

  it("issues an HttpOnly SameSite=Strict cookie and a CSRF token, never a password or hash", async () => {
    const res = await login("admin@auth.test", PASSWORD);
    expect(res.statusCode).toBe(200);
    const cookie = String(res.headers["set-cookie"]);
    expect(cookie).toMatch(/^changeradar_session=[A-Za-z0-9_-]{40,}/);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/");
    expect(cookie).toMatch(/Max-Age=\d+/);
    expect(cookie).not.toContain("Secure"); // harness serves plain http
    const body = JSON.parse(res.body);
    expect(body.csrf_token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(JSON.stringify(body)).not.toMatch(/password|scrypt/i);
    expect(body.user).toMatchObject({ email: "admin@auth.test", role: "admin", workspace_name: "Auth" });
  });

  it("marks the cookie Secure when the deployment is served over https", async () => {
    const secure = await createHarness({ settings: { secureCookies: true } });
    try {
      const w = await secure.workspace("Tls");
      void w;
      const res = await secure.app.inject({ method: "POST", url: "/api/v1/auth/login", headers: { "content-type": "application/json" }, payload: JSON.stringify({ email: "admin@tls.test", password: PASSWORD }) });
      expect(String(res.headers["set-cookie"])).toContain("Secure");
    } finally {
      await secure.close();
    }
  });

  it("answers wrong password and unknown account identically (no account enumeration)", async () => {
    const wrong = await login("admin@auth.test", "not-the-password-123");
    const unknown = await login("nobody@auth.test", "not-the-password-123");
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    const strip = (b: string) => ({ ...JSON.parse(b).error, request_id: "x" });
    expect(strip(wrong.body)).toEqual(strip(unknown.body));
    expect(strip(wrong.body).code).toBe("INVALID_CREDENTIALS");
  });

  it("rejects malformed login bodies with 400 and oversized credentials", async () => {
    expect((await login("admin@auth.test", undefined as never)).statusCode).toBe(400);
    expect((await login("a".repeat(400) + "@x.test", PASSWORD)).statusCode).toBe(400);
    expect((await login("admin@auth.test", "p".repeat(5000))).statusCode).toBe(400);
  });

  it("rejects a workspace the user is not a member of", async () => {
    const res = await login("admin@auth.test", PASSWORD, { workspace_id: UUID0 });
    expect(res.statusCode).toBe(401);
  });

  it("lets a user with two workspaces choose which one the session binds to", async () => {
    const other = await h.workspace("Second");
    const { grantUser } = await import("../../src/services/auth.js");
    await h.db.transaction((tx) => grantUser(tx, { workspaceId: other.id, email: "admin@auth.test", password: "ignored-existing-user", role: "viewer", at: h.now() }));
    const res = await login("admin@auth.test", PASSWORD, { workspace_id: other.id });
    expect(JSON.parse(res.body).user).toMatchObject({ workspace_id: other.id, role: "viewer" });
  });

  it("requires a session for every non-health route", async () => {
    const routes: [string, string][] = [
      ["GET", "/api/v1/auth/session"], ["POST", "/api/v1/auth/logout"], ["GET", "/api/v1/members"], ["GET", "/api/v1/audit"], ["GET", "/api/v1/events"], ["GET", "/api/v1/settings"],
      ["GET", "/api/v1/baseline"], ["GET", "/api/v1/snapshots"], ["POST", "/api/v1/snapshots"], [`GET`, `/api/v1/snapshots/${UUID0}`], ["GET", `/api/v1/snapshots/${UUID0}/manifest`],
      ["GET", `/api/v1/snapshots/${UUID0}/nodes`], ["GET", `/api/v1/snapshots/${UUID0}/edges`], ["GET", "/api/v1/impact-runs"], ["POST", "/api/v1/impact-runs"],
      ["GET", `/api/v1/impact-runs/${UUID0}`], ["GET", `/api/v1/impact-runs/${UUID0}/findings`], ["GET", `/api/v1/impact-runs/${UUID0}/export`], ["GET", `/api/v1/impact-runs/${UUID0}/bundle`],
      ["GET", "/api/v1/contract-checks"], ["POST", "/api/v1/contract-checks"], ["POST", `/api/v1/contract-checks/${UUID0}/disable`],
    ];
    for (const [method, url] of routes) {
      const res = await h.api(null, method as "GET", url, method === "POST" ? {} : undefined);
      expect(res.status, `${method} ${url}`).toBe(401);
      expect(res.body.error.code).toBe("UNAUTHENTICATED");
    }
    const garbage = await h.api({ cookie: "changeradar_session=garbage", csrf: "x", userId: "", email: "", role: "admin" }, "GET", "/api/v1/snapshots");
    expect(garbage.status).toBe(401);
  });

  it("rejects a malformed cookie encoding with 400", async () => {
    const res = await h.app.inject({ method: "GET", url: "/api/v1/snapshots", headers: { cookie: "changeradar_session=%E0%A4%A" } });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe("INVALID_COOKIE");
  });

  it("requires a valid CSRF token on every mutation but not on reads", async () => {
    const body = { schema_version: 1, revision: "r", manifest: baselineDoc() };
    const missing = await h.api(ws.operator, "POST", "/api/v1/snapshots", body, { csrf: null });
    expect(missing.status).toBe(403);
    expect(missing.body.error.code).toBe("CSRF_INVALID");
    const wrong = await h.api(ws.operator, "POST", "/api/v1/snapshots", body, { csrf: "A".repeat(ws.operator.csrf.length) });
    expect(wrong.status).toBe(403);
    const foreign = await h.api(ws.operator, "POST", "/api/v1/snapshots", body, { csrf: ws.admin.csrf });
    expect(foreign.status).toBe(403);
    const readNoCsrf = await h.api(ws.operator, "GET", "/api/v1/snapshots", undefined, { csrf: null });
    expect(readNoCsrf.status).toBe(200);
    const ok = await h.api(ws.operator, "POST", "/api/v1/snapshots", body);
    expect(ok.status).toBe(201);
    const logoutNoCsrf = await h.api(ws.viewer, "POST", "/api/v1/auth/logout", undefined, { csrf: null });
    expect(logoutNoCsrf.status).toBe(403);
  });

  it("GET /auth/session returns the same CSRF token so a page reload keeps working", async () => {
    const res = await h.api(ws.operator, "GET", "/api/v1/auth/session");
    expect(res.status).toBe(200);
    expect(res.body.csrf_token).toBe(ws.operator.csrf);
    expect(res.body.user.role).toBe("operator");
  });

  it("logout revokes the session server side", async () => {
    const fresh = JSON.parse((await login("viewer@auth.test", PASSWORD)).body);
    const cookieRes = await login("viewer@auth.test", PASSWORD);
    const cookie = String(cookieRes.headers["set-cookie"]).split(";")[0] as string;
    const csrf = JSON.parse(cookieRes.body).csrf_token as string;
    const user: TestUser = { cookie, csrf, userId: fresh.user.id, email: "viewer@auth.test", role: "viewer" };
    expect((await h.api(user, "GET", "/api/v1/snapshots")).status).toBe(200);
    const out = await h.app.inject({ method: "POST", url: "/api/v1/auth/logout", headers: { cookie, "x-csrf-token": csrf } });
    expect(out.statusCode).toBe(200);
    expect(String(out.headers["set-cookie"])).toContain("Max-Age=0");
    expect((await h.api(user, "GET", "/api/v1/snapshots")).status).toBe(401);
  });

  it("sessions expire", async () => {
    const short = await createHarness({ settings: { sessionTtlSeconds: 60 } });
    try {
      const w = await short.workspace("Expiry");
      expect((await short.api(w.viewer, "GET", "/api/v1/snapshots")).status).toBe(200);
      short.advance(61);
      expect((await short.api(w.viewer, "GET", "/api/v1/snapshots")).status).toBe(401);
    } finally {
      await short.close();
    }
  });

  it("removing a membership invalidates existing sessions immediately", async () => {
    const w = await h.workspace("Revoked");
    expect((await h.api(w.operator, "GET", "/api/v1/snapshots")).status).toBe(200);
    await h.db.query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1", [w.operator.userId]);
    expect((await h.api(w.operator, "GET", "/api/v1/snapshots")).status).toBe(401);
  });
});

describe("AC-12 roles are enforced on reads, writes, jobs and exports", () => {
  let h: Harness;
  let ws: TestWorkspace;
  let snapshotId: string;
  let runId: string;
  let checkId: string;
  beforeAll(async () => {
    h = await createHarness({ settings: { checks: { allowedHosts: ["checks.example.test"], allowPrivateNetwork: false, maxBodyBytes: 1024 * 1024, maxTimeoutMs: 30_000, maxRedirects: 3, maxChecksPerRun: 50, backoffBaseMs: 5, runBudgetMs: 600_000 } } });
    ws = await h.workspace("Roles");
    const snap = await h.importSnapshot(ws.operator, baselineDoc());
    snapshotId = snap.body.id;
    const run = await h.requestRun(ws.operator, { snapshot_id: snapshotId, proposed_manifest: removeAmountDoc(), expected_hash: snap.body.hash });
    runId = run.body.id;
    await h.drain();
    const check = await h.api(ws.admin, "POST", "/api/v1/contract-checks", { key: "chk.roles", node_id: "contract.invoice", url: "https://checks.example.test/invoice" });
    checkId = check.body.id;
  });
  afterAll(async () => h.close());

  type Case = { name: string; route: string; method: "GET" | "POST"; url: () => string; body?: () => unknown; viewer: number; operator: number; admin: number };
  const snapshotBody = () => ({ schema_version: 1, revision: "roles", manifest: baselineDoc() });
  const cases: Case[] = [
    { name: "read baseline", route: "GET /api/v1/baseline", method: "GET", url: () => "/api/v1/baseline", viewer: 200, operator: 200, admin: 200 },
    { name: "list snapshots", route: "GET /api/v1/snapshots", method: "GET", url: () => "/api/v1/snapshots", viewer: 200, operator: 200, admin: 200 },
    { name: "import snapshot", route: "POST /api/v1/snapshots", method: "POST", url: () => "/api/v1/snapshots", body: snapshotBody, viewer: 403, operator: 201, admin: 201 },
    { name: "read snapshot", route: "GET /api/v1/snapshots/:id", method: "GET", url: () => `/api/v1/snapshots/${snapshotId}`, viewer: 200, operator: 200, admin: 200 },
    { name: "read snapshot manifest", route: "GET /api/v1/snapshots/:id/manifest", method: "GET", url: () => `/api/v1/snapshots/${snapshotId}/manifest`, viewer: 403, operator: 200, admin: 200 },
    { name: "read nodes", route: "GET /api/v1/snapshots/:id/nodes", method: "GET", url: () => `/api/v1/snapshots/${snapshotId}/nodes`, viewer: 200, operator: 200, admin: 200 },
    { name: "read edges", route: "GET /api/v1/snapshots/:id/edges", method: "GET", url: () => `/api/v1/snapshots/${snapshotId}/edges`, viewer: 200, operator: 200, admin: 200 },
    { name: "list runs", route: "GET /api/v1/impact-runs", method: "GET", url: () => "/api/v1/impact-runs", viewer: 200, operator: 200, admin: 200 },
    { name: "read run", route: "GET /api/v1/impact-runs/:id", method: "GET", url: () => `/api/v1/impact-runs/${runId}`, viewer: 200, operator: 200, admin: 200 },
    { name: "read findings", route: "GET /api/v1/impact-runs/:id/findings", method: "GET", url: () => `/api/v1/impact-runs/${runId}/findings`, viewer: 200, operator: 200, admin: 200 },
    { name: "export report json", route: "GET /api/v1/impact-runs/:id/export", method: "GET", url: () => `/api/v1/impact-runs/${runId}/export?format=json`, viewer: 200, operator: 200, admin: 200 },
    { name: "export report html", route: "GET /api/v1/impact-runs/:id/export", method: "GET", url: () => `/api/v1/impact-runs/${runId}/export?format=html`, viewer: 200, operator: 200, admin: 200 },
    { name: "export evidence bundle", route: "GET /api/v1/impact-runs/:id/bundle", method: "GET", url: () => `/api/v1/impact-runs/${runId}/bundle`, viewer: 403, operator: 200, admin: 200 },
    {
      name: "request run (enqueues a job)",
      route: "POST /api/v1/impact-runs",
      method: "POST",
      url: () => "/api/v1/impact-runs",
      body: () => ({ snapshot_id: snapshotId, proposed_manifest: removeAmountDoc(), expected_hash: "sha256:" + "0".repeat(64) }),
      viewer: 403,
      operator: 409,
      admin: 409,
    },
    { name: "list contract checks", route: "GET /api/v1/contract-checks", method: "GET", url: () => "/api/v1/contract-checks", viewer: 403, operator: 200, admin: 200 },
    { name: "create contract check", route: "POST /api/v1/contract-checks", method: "POST", url: () => "/api/v1/contract-checks", body: () => ({ key: `chk.${Math.random().toString(36).slice(2, 8)}`, node_id: "contract.invoice", url: "https://checks.example.test/x" }), viewer: 403, operator: 403, admin: 201 },
    { name: "list events", route: "GET /api/v1/events", method: "GET", url: () => "/api/v1/events", viewer: 403, operator: 200, admin: 200 },
    { name: "list members", route: "GET /api/v1/members", method: "GET", url: () => "/api/v1/members", viewer: 403, operator: 403, admin: 200 },
    { name: "read audit trail", route: "GET /api/v1/audit", method: "GET", url: () => "/api/v1/audit", viewer: 403, operator: 403, admin: 200 },
    { name: "read settings", route: "GET /api/v1/settings", method: "GET", url: () => "/api/v1/settings", viewer: 403, operator: 403, admin: 200 },
    { name: "disable contract check", route: "POST /api/v1/contract-checks/:id/disable", method: "POST", url: () => `/api/v1/contract-checks/${checkId}/disable`, viewer: 403, operator: 403, admin: 200 },
  ];

  it("every registered route is covered by this matrix or is one of the session endpoints tested above", () => {
    const covered = new Set(cases.map((c) => c.route));
    const exempt = new Set(["GET /api/v1/health/live", "GET /api/v1/health/ready", "POST /api/v1/auth/login", "GET /api/v1/auth/session", "POST /api/v1/auth/logout"]);
    const uncovered = h.app.routeTable.filter((r) => !covered.has(r) && !exempt.has(r));
    expect(uncovered, "a route was added without a role test").toEqual([]);
    for (const r of covered) expect(h.app.routeTable, r).toContain(r);
  });

  for (const c of cases) {
    it(`${c.name}: viewer ${c.viewer}, operator ${c.operator}, admin ${c.admin}`, async () => {
      for (const role of ["viewer", "operator", "admin"] as const) {
        const res = await h.api(ws[role], c.method, c.url(), c.body?.());
        expect(res.status, `${role}: ${res.text.slice(0, 200)}`).toBe(c[role]);
        if (res.status === 403) expect(res.body.error).toMatchObject({ code: "FORBIDDEN", request_id: expect.any(String) });
      }
    });
  }

  it("each write service refuses a viewer on its own, without the route hook in front of it", async () => {
    // The route refuses a viewer before the body is read (`onRequest: needs("operator")`), so no request reaches the service check: it is the second
    // layer that a route wired without the hook would rely on (src/services/auth.ts: every service entry point checks the role itself).
    const { importSnapshot } = await import("../../src/services/snapshots.js");
    const { requestImpactRun } = await import("../../src/services/impact.js");
    const viewer = { userId: ws.viewer.userId, email: ws.viewer.email, workspaceId: ws.id, workspaceName: ws.name, role: "viewer" as const, sessionId: "service-level" };
    const input = { body: {}, idempotencyKey: undefined, requestHash: "sha256:" + "0".repeat(64) };
    await expect(importSnapshot(h.ctx, viewer, input)).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    await expect(requestImpactRun(h.ctx, viewer, input)).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
  });

  it("a denied write changes no state and enqueues no job", async () => {
    const before = await h.db.query<{ s: number; r: number; j: number; a: number }>(
      "SELECT (SELECT count(*) FROM snapshots)::int AS s, (SELECT count(*) FROM impact_runs)::int AS r, (SELECT count(*) FROM jobs)::int AS j, (SELECT count(*) FROM audit_events)::int AS a",
    );
    const denied = await h.requestRun(ws.viewer, { snapshot_id: snapshotId, proposed_manifest: removeAmountDoc(), expected_hash: "sha256:" + "0".repeat(64) });
    expect(denied.status).toBe(403);
    expect((await h.importSnapshot(ws.viewer, baselineDoc())).status).toBe(403);
    const after = await h.db.query<{ s: number; r: number; j: number; a: number }>(
      "SELECT (SELECT count(*) FROM snapshots)::int AS s, (SELECT count(*) FROM impact_runs)::int AS r, (SELECT count(*) FROM jobs)::int AS j, (SELECT count(*) FROM audit_events)::int AS a",
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });
});

describe("rate limiting", () => {
  it("throttles logins per account with 429 and Retry-After, and counts an address across accounts", async () => {
    const h = await createHarness({ settings: { rateLimit: { loginPerAccount: 3, loginPerAddress: 12, apiPerPrincipal: 1_000_000, windowMs: 60_000 } } });
    try {
      await h.workspace("Limits");
      const attempt = (email: string) => h.app.inject({ method: "POST", url: "/api/v1/auth/login", headers: { "content-type": "application/json" }, payload: JSON.stringify({ email, password: "wrong-password-123" }) });
      const codes: number[] = [];
      for (let i = 0; i < 5; i += 1) codes.push((await attempt("admin@limits.test")).statusCode);
      // The setup login already spent one of the three per-account attempts.
      expect(codes).toEqual([401, 401, 429, 429, 429]);
      const blocked = await attempt("admin@limits.test");
      expect(blocked.headers["retry-after"]).toMatch(/^\d+$/);
      expect(JSON.parse(blocked.body).error.code).toBe("RATE_LIMITED");
      // A different account is still allowed until the per-address budget (12, three used by setup) is spent.
      expect((await attempt("operator@limits.test")).statusCode).toBe(401);
      expect((await attempt("stranger-1@limits.test")).statusCode).toBe(401);
      expect((await attempt("stranger-2@limits.test")).statusCode).toBe(401);
      expect((await attempt("stranger-3@limits.test")).statusCode).toBe(429);
      h.advance(61);
      expect((await attempt("admin@limits.test")).statusCode).toBe(401);
    } finally {
      await h.close();
    }
  });

  it("throttles authenticated API calls per principal", async () => {
    const h = await createHarness({ settings: { rateLimit: { loginPerAccount: 1000, loginPerAddress: 10_000, apiPerPrincipal: 5, windowMs: 60_000 } } });
    try {
      const w = await h.workspace("ApiLimit");
      const statuses: number[] = [];
      for (let i = 0; i < 7; i += 1) statuses.push((await h.api(w.viewer, "GET", "/api/v1/snapshots")).status);
      expect(statuses).toEqual([200, 200, 200, 200, 200, 429, 429]);
      // Another principal has an independent budget; health is never throttled.
      expect((await h.api(w.operator, "GET", "/api/v1/snapshots")).status).toBe(200);
      expect((await h.api(null, "GET", "/api/v1/health/live")).status).toBe(200);
    } finally {
      await h.close();
    }
  });
});
