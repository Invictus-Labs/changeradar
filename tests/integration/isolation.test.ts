import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultSettings } from "../../src/platform/context.js";
import { count, createHarness, getRun, PASSWORD, type Harness, type TestWorkspace } from "../helpers/harness.js";
import { baselineDoc, removeAmountDoc } from "../helpers/scenario.js";
import { UUID_UNKNOWN } from "../helpers/ids.js";

const RANDOM_ID = UUID_UNKNOWN;

describe("AC-12 workspace isolation: foreign ids are 404 and change nothing", () => {
  let h: Harness;
  let a: TestWorkspace;
  let b: TestWorkspace;
  let bSnapshot: string;
  let bRun: string;
  let bCheck: string;
  let bHash: string;

  beforeAll(async () => {
    h = await createHarness({ settings: { checks: { ...defaultSettings.checks, allowedHosts: ["checks.example.test"] } } });
    a = await h.workspace("Alpha");
    b = await h.workspace("Beta");
    await h.importSnapshot(a.operator, baselineDoc(), { revision: "alpha" });
    const snap = await h.importSnapshot(b.operator, baselineDoc(), { revision: "beta" });
    bSnapshot = snap.body.id;
    bHash = snap.body.hash;
    const run = await h.requestRun(b.operator, { snapshot_id: bSnapshot, proposed_manifest: removeAmountDoc(), expected_hash: bHash });
    bRun = run.body.id;
    await h.drain();
    const check = await h.api(b.admin, "POST", "/api/v1/contract-checks", { key: "chk.beta", node_id: "contract.invoice", url: "https://checks.example.test/beta" });
    bCheck = check.body.id;
  });
  afterAll(async () => h.close());

  const fingerprint = async () => {
    const tables = ["workspaces", "snapshots", "nodes", "edges", "impact_runs", "findings", "run_events", "check_results", "contract_checks", "jobs", "outbox_events", "audit_events", "idempotency_keys", "sessions"];
    const out: Record<string, number> = {};
    for (const t of tables) out[t] = await count(h.db, t);
    const enabled = await h.db.query<{ enabled: boolean }>("SELECT enabled FROM contract_checks WHERE id = $1", [bCheck]);
    const baseline = await h.db.query<{ baseline_snapshot_id: string; baseline_version: number }>("SELECT baseline_snapshot_id, baseline_version FROM workspaces WHERE id = $1", [b.id]);
    return { out, enabled: enabled.rows[0]?.enabled, baseline: baseline.rows[0] };
  };

  type Probe = { name: string; method: "GET" | "POST"; url: (id: string) => string; body?: (snapshotOrRun: string) => unknown; foreign: () => string; users: (w: TestWorkspace) => Array<TestWorkspace["admin"]> };
  const all = (w: TestWorkspace) => [w.admin, w.operator, w.viewer];
  const operators = (w: TestWorkspace) => [w.admin, w.operator];
  const probes: Probe[] = [
    { name: "read snapshot", method: "GET", url: (id) => `/api/v1/snapshots/${id}`, foreign: () => bSnapshot, users: all },
    { name: "read snapshot manifest", method: "GET", url: (id) => `/api/v1/snapshots/${id}/manifest`, foreign: () => bSnapshot, users: operators },
    { name: "read snapshot nodes", method: "GET", url: (id) => `/api/v1/snapshots/${id}/nodes`, foreign: () => bSnapshot, users: all },
    { name: "read snapshot edges", method: "GET", url: (id) => `/api/v1/snapshots/${id}/edges`, foreign: () => bSnapshot, users: all },
    { name: "read run", method: "GET", url: (id) => `/api/v1/impact-runs/${id}`, foreign: () => bRun, users: all },
    { name: "read findings", method: "GET", url: (id) => `/api/v1/impact-runs/${id}/findings`, foreign: () => bRun, users: all },
    { name: "export report json", method: "GET", url: (id) => `/api/v1/impact-runs/${id}/export?format=json`, foreign: () => bRun, users: all },
    { name: "export report html", method: "GET", url: (id) => `/api/v1/impact-runs/${id}/export?format=html`, foreign: () => bRun, users: all },
    { name: "export evidence bundle", method: "GET", url: (id) => `/api/v1/impact-runs/${id}/bundle`, foreign: () => bRun, users: operators },
    { name: "disable check", method: "POST", url: (id) => `/api/v1/contract-checks/${id}/disable`, foreign: () => bCheck, users: (w) => [w.admin] },
  ];

  for (const probe of probes) {
    it(`${probe.name}: another workspace's id is indistinguishable from an unknown id and changes no state`, async () => {
      for (const user of probe.users(a)) {
        const before = await fingerprint();
        const foreign = await h.api(user, probe.method, probe.url(probe.foreign()), probe.method === "POST" ? {} : undefined);
        const unknown = await h.api(user, probe.method, probe.url(RANDOM_ID), probe.method === "POST" ? {} : undefined);
        expect(foreign.status, `${user.role}`).toBe(404);
        expect(unknown.status).toBe(404);
        const strip = (r: typeof foreign) => ({ ...r.body.error, request_id: "x" });
        expect(strip(foreign)).toEqual(strip(unknown));
        expect(foreign.text.length).toBe(unknown.text.length);
        expect(await fingerprint()).toEqual(before);
      }
    });
  }

  it("requesting a run against another workspace's snapshot is 404 (even with the right hash) and creates no run or job", async () => {
    const before = await fingerprint();
    const res = await h.requestRun(a.operator, { snapshot_id: bSnapshot, proposed_manifest: removeAmountDoc(), expected_hash: bHash });
    expect(res.status).toBe(404);
    const wrongHash = await h.requestRun(a.operator, { snapshot_id: bSnapshot, proposed_manifest: removeAmountDoc(), expected_hash: "sha256:" + "0".repeat(64) });
    expect(wrongHash.status).toBe(404); // existence is not revealed by a hash mismatch either
    expect(await fingerprint()).toEqual(before);
  });

  it("check_keys of another workspace are unknown, not accepted", async () => {
    const snap = await h.importSnapshot(a.operator, baselineDoc());
    const res = await h.requestRun(a.operator, { snapshot_id: snap.body.id, proposed_manifest: removeAmountDoc(), expected_hash: snap.body.hash, check_keys: ["chk.beta"] });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("UNKNOWN_CHECK");
  });

  it("lists, events, audit and baseline only ever show the caller's own workspace", async () => {
    const snaps = await h.api(a.viewer, "GET", "/api/v1/snapshots?limit=100");
    expect(snaps.body.items.map((s: any) => s.id)).not.toContain(bSnapshot);
    const runs = await h.api(a.viewer, "GET", "/api/v1/impact-runs?limit=100");
    expect(runs.body.items.map((r: any) => r.id)).not.toContain(bRun);
    expect((await h.api(a.viewer, "GET", `/api/v1/impact-runs?snapshot_id=${bSnapshot}`)).body.items).toEqual([]);
    const checks = await h.api(a.admin, "GET", "/api/v1/contract-checks");
    expect(checks.body.items.map((c: any) => c.key)).not.toContain("chk.beta");
    const events = await h.api(a.operator, "GET", "/api/v1/events?limit=100");
    expect(events.text).not.toContain(bSnapshot);
    expect(events.text).not.toContain(bRun);
    const audit = await h.api(a.admin, "GET", "/api/v1/audit?limit=100");
    expect(audit.text).not.toContain(bSnapshot);
    const members = await h.api(a.admin, "GET", "/api/v1/members");
    expect(members.body.items.every((m: any) => m.email.endsWith("@alpha.test"))).toBe(true);
    const baseline = await h.api(a.viewer, "GET", "/api/v1/baseline");
    expect(baseline.body.snapshot.id).not.toBe(bSnapshot);
    expect(baseline.body.snapshot.revision).not.toBe("beta");
  });

  it("a cursor taken from one workspace never exposes another workspace's rows", async () => {
    const bPage = await h.api(b.viewer, "GET", "/api/v1/snapshots?limit=1");
    await h.importSnapshot(b.operator, baselineDoc());
    await h.importSnapshot(b.operator, baselineDoc());
    const bPage2 = await h.api(b.viewer, "GET", "/api/v1/snapshots?limit=1");
    const cursor = bPage2.body.next_cursor as string;
    expect(bPage.body.items).toHaveLength(1);
    const asAlpha = await h.api(a.viewer, "GET", `/api/v1/snapshots?limit=100&cursor=${cursor}`);
    expect(asAlpha.status).toBe(200);
    const betaIds = new Set((await h.api(b.viewer, "GET", "/api/v1/snapshots?limit=100")).body.items.map((s: any) => s.id));
    expect(asAlpha.body.items.every((s: any) => !betaIds.has(s.id))).toBe(true);
  });

  it("a worker job whose object belongs to another workspace does nothing to that object", async () => {
    const snap = await h.importSnapshot(b.operator, baselineDoc());
    const run = await h.requestRun(b.operator, { snapshot_id: snap.body.id, proposed_manifest: removeAmountDoc(), expected_hash: snap.body.hash });
    // A forged job in workspace A pointing at B's still-queued run.
    await h.db.query("DELETE FROM jobs WHERE object_id = $1", [run.body.id]).catch(() => undefined);
    await h.db.query(
      "INSERT INTO jobs (id, workspace_id, type, object_id, state, next_attempt_at, deduplication_key, created_at, updated_at) VALUES (gen_random_uuid(), $1, 'assess_run', $2, 'queued', now() - interval '1 day', 'forged-cross-workspace', now(), now())",
      [a.id, run.body.id],
    );
    await h.drain();
    const view = await getRun(h, b.viewer, run.body.id);
    expect(view.status).toBe("queued");
    expect(await count(h.db, "findings", "run_id = $1", [run.body.id])).toBe(0);
    expect(await count(h.db, "check_results", "run_id = $1", [run.body.id])).toBe(0);
  });

  it("a user of both workspaces acts only in the workspace the session was created for", async () => {
    const { grantUser } = await import("../../src/services/auth.js");
    await h.db.transaction((tx) => grantUser(tx, { workspaceId: b.id, email: "admin@alpha.test", password: "unused-existing-user", role: "viewer", at: h.now() }));
    const alphaLogin = await h.app.inject({ method: "POST", url: "/api/v1/auth/login", headers: { "content-type": "application/json" }, payload: JSON.stringify({ email: "admin@alpha.test", password: PASSWORD, workspace_id: a.id }) });
    const cookie = String(alphaLogin.headers["set-cookie"]).split(";")[0] as string;
    const asAlpha = { cookie, csrf: JSON.parse(alphaLogin.body).csrf_token as string, userId: "", email: "", role: "admin" as const };
    expect((await h.api(asAlpha, "GET", `/api/v1/snapshots/${bSnapshot}`)).status).toBe(404);
    const me = await h.api(asAlpha, "GET", "/api/v1/auth/session");
    expect(me.body.user.workspace_id).toBe(a.id);
  });
});
