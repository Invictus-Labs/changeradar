import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultSettings } from "../../src/platform/context.js";
import type { DiagnosticEvent } from "../../src/platform/diagnostics.js";
import { SecretBox } from "../../src/platform/crypto.js";
import { setCredential } from "../../src/services/checks.js";
import { billingManifest } from "../helpers/builders.js";
import { ALL_FAKE_SECRETS, FAKE_API_KEY, FAKE_AWS_KEY, FAKE_BEARER, FAKE_GITHUB_TOKEN, FAKE_JWT, FAKE_STRIPE_KEY, SECRET_CORES } from "../helpers/fake-secrets.js";
import { startFixture, type Fixture } from "../helpers/fixture-server.js";
import { createHarness, getRun, PASSWORD, type Harness, type TestWorkspace } from "../helpers/harness.js";
import { baselineDoc, removeAmountDoc } from "../helpers/scenario.js";

describe("AC-09 planted secrets never appear in logs, responses, exports or the database", () => {
  let h: Harness;
  let ws: TestWorkspace;
  let fx: Fixture;
  const logs: DiagnosticEvent[] = [];
  const stderrWrites: string[] = [];

  beforeAll(async () => {
    fx = await startFixture({ bearer: FAKE_STRIPE_KEY });
    h = await createHarness({
      diagnostics: (e) => logs.push(e),
      settings: { checks: { ...defaultSettings.checks, allowedHosts: [`127.0.0.1:${fx.port}`], allowPrivateNetwork: true, backoffBaseMs: 5 } },
    });
    ws = await h.workspace("Secrets");
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
      stderrWrites.push(String(chunk));
      return (original as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stderr.write;
    (globalThis as { __restoreStderr?: () => void }).__restoreStderr = () => {
      process.stderr.write = original as typeof process.stderr.write;
    };
  });
  afterAll(async () => {
    (globalThis as { __restoreStderr?: () => void }).__restoreStderr?.();
    await h.close();
    await fx.close();
  });

  const everything = () => JSON.stringify(logs) + stderrWrites.join("");
  const expectClean = (text: string, where: string) => {
    for (const core of SECRET_CORES) expect(text.includes(core), `${where} leaked ${core.slice(0, 8)}...`).toBe(false);
  };

  it("request logs and diagnostics carry classifications only: secrets in headers, query strings and bodies never appear", async () => {
    const hostileHeaders = { authorization: FAKE_BEARER, "x-api-key": FAKE_API_KEY, "x-forwarded-for": FAKE_AWS_KEY, referer: `https://x.test/?token=${FAKE_GITHUB_TOKEN}` };
    await h.api(null, "GET", `/api/v1/snapshots?token=${FAKE_GITHUB_TOKEN}&limit=1`, undefined, { headers: hostileHeaders });
    await h.api(null, "POST", "/api/v1/auth/login", { email: "admin@secrets.test", password: FAKE_JWT }, { headers: hostileHeaders });
    await h.api(ws.operator, "GET", `/api/v1/snapshots/${FAKE_STRIPE_KEY}`, undefined, { headers: hostileHeaders });
    await h.api(ws.viewer, "POST", "/api/v1/snapshots", { schema_version: 1, revision: FAKE_API_KEY, manifest: {} });
    await h.api(ws.operator, "POST", "/api/v1/snapshots", { schema_version: 1, revision: FAKE_API_KEY, manifest: {} }, { headers: hostileHeaders });
    await h.api(ws.operator, "POST", "/api/v1/snapshots", undefined, { raw: `{"bad": ${FAKE_JWT}`, headers: hostileHeaders });
    await h.api(ws.operator, "GET", `/api/v1/${FAKE_GITHUB_TOKEN}/nowhere`, undefined, { headers: hostileHeaders });
    await h.api({ cookie: `changeradar_session=${FAKE_JWT}`, csrf: FAKE_BEARER, userId: "", email: "", role: "admin" }, "GET", "/api/v1/snapshots");
    expect(logs.length).toBeGreaterThan(5);
    expectClean(everything(), "diagnostics");
    // Every emitted entry has only allowlisted members: no headers, bodies, urls or messages.
    const allowed = new Set(["event", "level", "request_id", "operation", "method", "status", "duration_ms", "code", "job_id", "run_id"]);
    for (const entry of logs) for (const key of Object.keys(entry)) expect(allowed.has(key), key).toBe(true);
    expect(logs.some((l) => l.event === "auth.login_failed")).toBe(true);
    expect(logs.every((l) => l.operation === undefined || !l.operation.includes("fnd_") )).toBe(true);
  });

  it("an unexpected server error answers with a generic envelope and logs a classification, not the message", async () => {
    const original = h.ctx.db.query.bind(h.ctx.db);
    h.ctx.db.query = (async (text: string, params?: unknown[]) => {
      if (String(text).includes("FROM snapshots")) throw new Error(`connection to ${FAKE_URL_WITH_SECRET} failed with ${FAKE_AWS_KEY}`);
      return original(text, params);
    }) as never;
    try {
      const res = await h.api(ws.viewer, "GET", "/api/v1/snapshots");
      expect(res.status).toBe(500);
      expect(res.body.error).toMatchObject({ code: "INTERNAL", message: "Internal error", request_id: expect.any(String) });
      expectClean(res.text, "500 response");
      expect(res.text).not.toContain("connection to");
    } finally {
      h.ctx.db.query = original as never;
    }
    expect(logs.some((l) => l.event === "api.unhandled_error" && l.level === "error" && l.code === "INTERNAL")).toBe(true);
    expectClean(everything(), "diagnostics after a 500");
  });

  it("manifests containing secrets are rejected before storage and nothing echoes them back", async () => {
    for (const secret of ALL_FAKE_SECRETS) {
      const doc = billingManifest((nodes) => {
        (nodes[0] as { owner: string }).owner = `prefix ${secret} suffix`;
      });
      const res = await h.importSnapshot(ws.operator, doc);
      expect(res.status, secret.slice(0, 10)).toBe(422);
      // A multi-line private key is stopped even earlier, by the control character rule; both refuse it.
      expect(["SECRET_VALUE_REJECTED", "SCHEMA_INVALID"], secret.slice(0, 10)).toContain(res.body.error.code);
      expectClean(res.text, "422 response");
    }
    const raw = await h.db.query<{ t: string }>("SELECT (SELECT coalesce(string_agg(manifest, ''), '') FROM snapshots) AS t");
    expectClean(raw.rows[0]?.t ?? "", "stored manifests");
    expectClean(everything(), "diagnostics after rejections");
  });

  it("exports, run views, bundles, audit and the whole database contain no secret, including one held only as a credential value", async () => {
    await setCredential(h.ctx, ws.id, "planted", FAKE_STRIPE_KEY);
    const check = await h.api(ws.admin, "POST", "/api/v1/contract-checks", { key: "chk.secrets", node_id: "contract.invoice", url: `${fx.origin}/auth`, credential_alias: "planted", retries: 0, required_fields: [{ name: "invoice_id", type: "string" }] });
    expect(check.status, check.text).toBe(201);
    const snap = await h.importSnapshot(ws.operator, baselineDoc(), { key: "secrets-1" });
    const run = await h.requestRun(ws.operator, { snapshot_id: snap.body.id, proposed_manifest: removeAmountDoc(), expected_hash: snap.body.hash }, { key: "secrets-2" });
    await h.drain();
    const view = await getRun(h, ws.viewer, run.body.id);
    expect(view.checks[0].state).toBe("PASSED"); // the sealed value really was used
    const responses = await Promise.all([
      h.api(ws.viewer, "GET", `/api/v1/impact-runs/${run.body.id}`),
      h.api(ws.viewer, "GET", `/api/v1/impact-runs/${run.body.id}/export?format=json`),
      h.api(ws.viewer, "GET", `/api/v1/impact-runs/${run.body.id}/export?format=html`),
      h.api(ws.operator, "GET", `/api/v1/impact-runs/${run.body.id}/bundle`),
      h.api(ws.operator, "GET", `/api/v1/snapshots/${snap.body.id}/manifest`),
      h.api(ws.admin, "GET", "/api/v1/audit?limit=100"),
      h.api(ws.admin, "GET", "/api/v1/contract-checks"),
      h.api(ws.admin, "GET", "/api/v1/settings"),
      h.api(ws.operator, "GET", "/api/v1/events?limit=100"),
    ]);
    for (const r of responses) expectClean(r.text, "api response");
    // A full dump of every table (as text) contains no planted value in the clear.
    const tables = await h.db.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'");
    let dump = "";
    for (const t of tables.rows) {
      const rows = await h.db.query<{ r: string }>(`SELECT row_to_json(x)::text AS r FROM ${t.table_name} x`);
      dump += rows.rows.map((x) => x.r).join("\n");
    }
    expectClean(dump, "database dump");
    expect(dump).toContain("planted"); // the alias name is stored...
    expect(dump).toContain("v1:"); // ...and the value only as sealed ciphertext
    expectClean(everything(), "diagnostics after exports");
  });

  it("the sealed credential cannot be opened without the operator key and detects tampering", async () => {
    const sealed = await h.db.query<{ secret_enc: string }>("SELECT secret_enc FROM credential_secrets WHERE alias = 'planted'");
    const value = sealed.rows[0]?.secret_enc as string;
    expect(new SecretBox(Buffer.alloc(32, 9)).decrypt.bind(new SecretBox(Buffer.alloc(32, 9)), value)).toThrow();
    expect(h.ctx.box.decrypt(value)).toBe(FAKE_STRIPE_KEY);
    const parts = value.split(":");
    parts[3] = Buffer.from("tampered").toString("base64");
    expect(() => h.ctx.box.decrypt(parts.join(":"))).toThrow();
  });

  it("stored passwords are salted scrypt hashes, never the password", async () => {
    const rows = await h.db.query<{ password_hash: string }>("SELECT password_hash FROM users");
    for (const r of rows.rows) {
      expect(r.password_hash).toMatch(/^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
      expect(r.password_hash).not.toContain(PASSWORD);
    }
    expect(new Set(rows.rows.map((r) => r.password_hash)).size).toBe(rows.rows.length); // unique salts even for the same password
    const sessions = await h.db.query<{ token_hash: string }>("SELECT token_hash FROM sessions");
    for (const s of sessions.rows) expect(s.token_hash).toMatch(/^[0-9a-f]{64}$/); // only a hash of the session token is stored
    expect(JSON.stringify(sessions.rows)).not.toContain(ws.operator.cookie.split("=")[1] as string);
  });

  it("hostile HTML in every user-controlled field renders as text in the HTML export", async () => {
    const hostile = '"><script>alert(1)</script><img src=x onerror=alert(2)>';
    const doc = billingManifest((nodes, edges) => {
      (nodes[2] as { owner: string }).owner = hostile;
      (nodes[3] as { owner: string }).owner = hostile;
      for (const e of edges) e.source_file = hostile;
    });
    const proposed = JSON.parse(JSON.stringify(doc)) as { nodes: { id: string; contract?: { fields: { name: string }[] } }[] };
    const contract = proposed.nodes.find((n) => n.id === "contract.invoice")!;
    contract.contract!.fields = contract.contract!.fields.filter((f) => f.name !== "amount");
    const snap = await h.importSnapshot(ws.operator, doc, { revision: hostile });
    expect(snap.status, snap.text).toBe(201);
    const run = await h.requestRun(ws.operator, { snapshot_id: snap.body.id, proposed_manifest: proposed, expected_hash: snap.body.hash, run_checks: false });
    await h.drain();
    const html = await h.api(ws.viewer, "GET", `/api/v1/impact-runs/${run.body.id}/export?format=html`);
    expect(html.status).toBe(200);
    expect(html.text).not.toMatch(/<script|<img/);
    expect(html.text).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(String(html.headers["content-type"])).toContain("text/html");
    expect(html.headers["x-content-type-options"]).toBe("nosniff");
    expect(String(html.headers["content-security-policy"])).toContain("default-src 'none'");
  });
});

const FAKE_URL_WITH_SECRET = ["postgres", "://svc:", "plantedPass1234", "@db.internal:5432/x"].join("");

describe("security headers", () => {
  it("every response carries hardening headers and API responses are not cacheable", async () => {
    const h = await createHarness();
    try {
      const w = await h.workspace("Headers");
      for (const res of [await h.api(null, "GET", "/api/v1/health/live"), await h.api(w.viewer, "GET", "/api/v1/snapshots"), await h.api(null, "GET", "/nope")]) {
        expect(res.headers["x-content-type-options"]).toBe("nosniff");
        expect(res.headers["x-frame-options"]).toBe("DENY");
        expect(res.headers["referrer-policy"]).toBe("no-referrer");
        expect(res.headers["cache-control"]).toBe("no-store");
        expect(String(res.headers["content-security-policy"])).toContain("frame-ancestors 'none'");
        expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
      }
    } finally {
      await h.close();
    }
  });
});
