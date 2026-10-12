import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashCanonical } from "../../src/domain/canonical.js";
import { defaultSettings } from "../../src/platform/context.js";
import { buildBundle, BundleError, serializeBundle, verifyBundle, type EvidenceBundle } from "../../src/services/evidence.js";
import { restoreBundle } from "../../src/services/restore.js";
import { e, f, manifest, n } from "../helpers/builders.js";
import { startFixture, type Fixture } from "../helpers/fixture-server.js";
import { count, createHarness, getRun, type Harness, type TestWorkspace } from "../helpers/harness.js";
import { baselineDoc, removeAmountDoc } from "../helpers/scenario.js";

/**
 * Review round 2 regression tests for evidence bundles, restore and the API surface around them (logic and security
 * findings). Each block names its finding; every P1 was red on the reviewed revision.
 */

const join = (...parts: string[]): string => parts.join("");
const HOSTILE = { contract: "contract.token:abcdef", consumer: "svc.token:refresh-service", job: "job.secret-rotation:nightly2", check: "chk.credential:prod2024" };

/** contract with ids that pass import but that the log-strength redactor would rewrite (`token:abcdef`). */
function hostileManifest(dropAmount: boolean): Record<string, unknown> {
  const fields = [f("invoice_id"), f("amount", "number")].filter((x) => !(dropAmount && x.name === "amount"));
  return manifest(
    [n(HOSTILE.contract, "contract", { owner: "team-billing", fields }), n(HOSTILE.consumer, "service"), n(HOSTILE.job, "job")],
    [e(HOSTILE.consumer, HOSTILE.contract, "consumes"), e(HOSTILE.job, HOSTILE.contract, "consumes")],
  );
}

/** The identifier fields of a run view are exactly the ids that were imported (free text may still be redacted). */
function expectIdentifiersIntact(view: any): void {
  expect(view.affected.map((x: any) => x.consumer_id).sort()).toEqual([HOSTILE.consumer, HOSTILE.job].sort());
  expect(view.affected.every((x: any) => x.origin_id === HOSTILE.contract)).toBe(true);
  expect(view.paths.map((p: any) => p.path[0])).toEqual([HOSTILE.contract, HOSTILE.contract]);
  expect(view.paths.flatMap((p: any) => p.hops.flatMap((h: any) => [h.source_id, h.target_id])).every((id: string) => [HOSTILE.contract, HOSTILE.consumer, HOSTILE.job].includes(id))).toBe(true);
  expect(view.changes.every((c: any) => c.node_id === HOSTILE.contract && c.origin_id === HOSTILE.contract)).toBe(true);
}

function reseal(bundle: Record<string, any>): string {
  const { bundle_hash: _drop, hashes: _h, stale_runs: _s, ...body } = bundle;
  const hashes = { snapshots: hashCanonical(body.snapshots), impact_runs: hashCanonical(body.impact_runs), contract_checks: hashCanonical(body.contract_checks) };
  const withHashes = { ...body, hashes };
  return JSON.stringify({ ...withHashes, bundle_hash: hashCanonical(withHashes) });
}
function rejection(text: string): string {
  try {
    verifyBundle(text, { maxBytes: 250 * 1024 * 1024 });
  } catch (error) {
    if (error instanceof BundleError) return error.code;
    throw error;
  }
  return "ACCEPTED";
}

describe("R2 P1 (evidence.ts:276): ids that pass import survive export -> verify -> restore -> export unchanged", () => {
  let src: Harness;
  let ws: TestWorkspace;
  let fx: Fixture;
  let workspaceBundle: EvidenceBundle;
  let runId: string;

  beforeAll(async () => {
    fx = await startFixture();
    src = await createHarness({ settings: { checks: { ...defaultSettings.checks, allowedHosts: [`127.0.0.1:${fx.port}`], allowPrivateNetwork: true, backoffBaseMs: 5 } } });
    ws = await src.workspace("Ops team; token:refresh-service");
    const check = await src.api(ws.admin, "POST", "/api/v1/contract-checks", { key: HOSTILE.check, node_id: HOSTILE.contract, url: `${fx.origin}/server-error`, retries: 0, required_fields: [{ name: "invoice_id", type: "string" }] });
    expect(check.status, check.text).toBe(201);
    const snapshot = await src.importSnapshot(ws.operator, hostileManifest(false), { revision: "release-1" });
    expect(snapshot.status, snapshot.text).toBe(201);
    const run = await src.requestRun(ws.operator, { snapshot_id: snapshot.body.id, proposed_manifest: hostileManifest(true), expected_hash: snapshot.body.hash });
    expect(run.status, run.text).toBe(202);
    runId = run.body.id;
    await src.drain();
    const built = await buildBundle(src.db, { workspaceId: ws.id }, src.now());
    if (!built) throw new Error("no bundle");
    workspaceBundle = built;
  });
  afterAll(async () => {
    await src.close();
    await fx.close();
  });

  it("the run really carries the hostile ids in findings, unknowns and check results", async () => {
    const run = workspaceBundle.impact_runs[0]!;
    expect(run.findings.map((x) => x.consumer_id).sort()).toEqual([HOSTILE.consumer, HOSTILE.job].sort());
    expect(run.findings.every((x) => x.origin_id === HOSTILE.contract)).toBe(true);
    expect(run.unknowns.some((u) => (u as { node_id?: string }).node_id === HOSTILE.contract || JSON.stringify(u).includes(HOSTILE.check))).toBe(true);
    expect(run.checks.map((c) => [c.check_key, c.node_id])).toEqual([[HOSTILE.check, HOSTILE.contract]]);
    expect(JSON.stringify(run.checks[0]!.result)).toContain(HOSTILE.contract);
  });

  it("export of the workspace and of the run verifies, and restores into a clean installation", async () => {
    const runBundle = await buildBundle(src.db, { workspaceId: ws.id, runId }, src.now());
    expect(runBundle).not.toBeNull();
    for (const bundle of [workspaceBundle, runBundle as EvidenceBundle]) {
      expect(verifyBundle(serializeBundle(bundle), { maxBytes: 10_000_000 }).bundle_hash).toBe(bundle.bundle_hash);
    }
    const dst = await createHarness();
    try {
      const summary = await restoreBundle(dst.ctx, serializeBundle(workspaceBundle));
      expect(summary).toMatchObject({ workspace_id: ws.id, snapshots: 1, impact_runs: 1, contract_checks: 1 });
      const again = await buildBundle(dst.db, { workspaceId: ws.id }, dst.now());
      expect(again!.hashes.impact_runs).toBe(workspaceBundle.hashes.impact_runs);
      expect(again!.hashes.snapshots).toBe(workspaceBundle.hashes.snapshots);
      const admin = await dst.userIn(ws.id, "admin");
      const view = await getRun(dst, admin, runId);
      expectIdentifiersIntact(view);
    } finally {
      await dst.close();
    }
  });

  it("views show accepted ids exactly, and two different ids never collapse", async () => {
    const viewer = ws.viewer;
    const nodes = await src.api(viewer, "GET", `/api/v1/snapshots/${workspaceBundle.snapshots[0]!.id}/nodes?limit=100`);
    const ids = nodes.body.items.map((x: any) => x.id).sort();
    expect(ids).toEqual([HOSTILE.contract, HOSTILE.consumer, HOSTILE.job].sort());
    expect(new Set(ids).size).toBe(3);
    expectIdentifiersIntact(await getRun(src, viewer, runId));
  });

  it("export fails closed when the stored run no longer reproduces (no bundle is reported as success)", async () => {
    // Run rows are protected by a trigger; a test (playing a corrupted disk) has to switch it off to change one.
    const tamper = async (verdict: string) => {
      await src.db.query("ALTER TABLE impact_runs DISABLE TRIGGER impact_runs_protect");
      try {
        await src.db.query("UPDATE impact_runs SET verdict = $2 WHERE id = $1", [runId, verdict]);
      } finally {
        await src.db.query("ALTER TABLE impact_runs ENABLE TRIGGER impact_runs_protect");
      }
    };
    await tamper("NO_KNOWN_IMPACT");
    try {
      await expect(buildBundle(src.db, { workspaceId: ws.id }, src.now())).rejects.toBeInstanceOf(BundleError);
      const viaApi = await src.api(ws.operator, "GET", `/api/v1/impact-runs/${runId}/bundle`);
      expect(viaApi.status).not.toBe(200);
    } finally {
      await tamper("INCOMPLETE");
    }
    expect(await buildBundle(src.db, { workspaceId: ws.id }, src.now())).not.toBeNull();
  });
});

describe("R2 P1 (evidence.ts:347): every derived field of a run is verified, not only the verdict and ids", () => {
  let src: Harness;
  let ws: TestWorkspace;
  let text: string;

  beforeAll(async () => {
    src = await createHarness();
    ws = await src.workspace("Tamper");
    const snapshot = await src.importSnapshot(ws.operator, baselineDoc(), { revision: "release-1" });
    const run = await src.requestRun(ws.operator, { snapshot_id: snapshot.body.id, proposed_manifest: removeAmountDoc(), expected_hash: snapshot.body.hash, run_checks: false });
    expect(run.status, run.text).toBe(202);
    await src.drain();
    const bundle = await buildBundle(src.db, { workspaceId: ws.id }, src.now());
    text = serializeBundle(bundle as EvidenceBundle);
  });
  afterAll(async () => {
    await src.close();
  });

  const edits: [string, (run: any) => void][] = [
    ["finding severity", (r) => { r.findings[0].severity = r.findings[0].severity === "high" ? "medium" : "high"; }],
    ["finding consumer_owner", (r) => { r.findings[0].consumer_owner = "team-forged"; }],
    ["finding reason", (r) => { r.findings[0].reason = "edited reason"; }],
    ["finding direct", (r) => { r.findings[0].direct = !r.findings[0].direct; }],
    ["finding depth", (r) => { r.findings[0].depth += 1; }],
    ["finding path", (r) => { r.findings[0].path = [...r.findings[0].path, "svc.forged"]; }],
    ["finding hops", (r) => { r.findings[0].hops = []; }],
    ["finding origin_id", (r) => { r.findings[0].origin_id = "contract.forged"; }],
    ["finding consumer_kind", (r) => { r.findings[0].consumer_kind = "artifact"; }],
    ["finding change_ids", (r) => { r.findings[0].change_ids = ["chg_forged"]; }],
    ["a finding removed", (r) => { r.findings.pop(); }],
    ["assessment_detail summary", (r) => { r.assessment_detail = { ...r.assessment_detail, summary: { forged: true } }; }],
    ["assessment_detail evaluated_at", (r) => { r.assessment_detail = { ...r.assessment_detail, evaluated_at: "2026-01-01T00:00:00.000Z" }; }],
    ["unknown message", (r) => { r.unknowns = [...r.unknowns, { id: "unk_forged", code: "X", message: "forged" }]; }],
  ];
  for (const [name, edit] of edits) {
    it(`${name}: a resealed bundle with this edit is rejected as BUNDLE_RUN_INCONSISTENT`, () => {
      const copy = JSON.parse(text) as Record<string, any>;
      expect(copy.impact_runs[0].findings.length).toBeGreaterThan(0);
      edit(copy.impact_runs[0]);
      expect(rejection(reseal(copy)), name).toBe("BUNDLE_RUN_INCONSISTENT");
    });
  }

  it("control: an untouched bundle resealed is accepted", () => {
    expect(rejection(reseal(JSON.parse(text)))).toBe("ACCEPTED");
  });

  it("KNOWN LIMIT (documented): fields outside the re-derivation (workspace name, snapshot revision, events) are integrity-protected only", () => {
    for (const edit of [
      (b: any) => { b.workspace.name = "renamed"; },
      (b: any) => { b.snapshots[0].revision = "forged-revision"; },
      (b: any) => { b.impact_runs[0].events[0].note = "forged note"; },
    ]) {
      const copy = JSON.parse(text) as Record<string, any>;
      edit(copy);
      expect(rejection(reseal(copy))).toBe("ACCEPTED");
    }
  });
});

describe("R2 P2 (evidence.ts:385): a run assessed by another engine version is refused with its own code, never as tampering", () => {
  it("a stamp that differs or is missing (version 1) is BUNDLE_ENGINE_VERSION", async () => {
    const h = await createHarness();
    try {
      const w = await h.workspace("Engine");
      const snapshot = await h.importSnapshot(w.operator, baselineDoc(), { revision: "release-1" });
      await h.requestRun(w.operator, { snapshot_id: snapshot.body.id, proposed_manifest: removeAmountDoc(), expected_hash: snapshot.body.hash, run_checks: false });
      await h.drain();
      const text = serializeBundle((await buildBundle(h.db, { workspaceId: w.id }, h.now())) as EvidenceBundle);
      const stamped = JSON.parse(text) as Record<string, any>;
      expect(stamped.impact_runs[0].assessment_detail.engine_version ?? 0).toBeGreaterThanOrEqual(2);
      // A fresh run reports its engine in the view and the report, and needs no re-run.
      const view = await getRun(h, w.viewer, stamped.impact_runs[0].id);
      expect(view.engine).toEqual({ version: stamped.impact_runs[0].assessment_detail.engine_version, current: stamped.impact_runs[0].assessment_detail.engine_version, rerun_required: false });
      const report = await h.api(w.viewer, "GET", `/api/v1/impact-runs/${stamped.impact_runs[0].id}/export?format=json`);
      expect(report.body.run.engine.rerun_required).toBe(false);
      // Round 3 (logic P1, evidence.ts:268): a stamp OLDER than this build (or missing, which is version 1) is no
      // longer refused, because that made every workspace holding an old run impossible to export after an upgrade; the run
      // is accepted on the hashes alone and reported by staleEngineRuns (review-round3-evidence.test.ts). A stamp NEWER
      // than this build, or one that is not an integer, is still refused under its own code.
      for (const mutate of [(d: any) => { d.engine_version = 99; }, (d: any) => { d.engine_version = "two"; }, (d: any) => { d.engine_version = 2.5; }]) {
        const copy = JSON.parse(text) as Record<string, any>;
        mutate(copy.impact_runs[0].assessment_detail);
        expect(rejection(reseal(copy))).toBe("BUNDLE_ENGINE_VERSION");
      }
      for (const mutate of [(d: any) => { d.engine_version = 1; }, (d: any) => { delete d.engine_version; }]) {
        const copy = JSON.parse(text) as Record<string, any>;
        mutate(copy.impact_runs[0].assessment_detail);
        expect(rejection(reseal(copy))).toBe("ACCEPTED");
      }
    } finally {
      await h.close();
    }
  });
});

describe("R2 P2 (worker.ts:129): a check auto-selected for a run is resolved at request time, so disabling it is a visible unknown", () => {
  it("disabled between request and worker: INCOMPLETE with CHECK_NOT_RUN, and the bundle still verifies and restores", async () => {
    const fx = await startFixture();
    const h = await createHarness({ settings: { checks: { ...defaultSettings.checks, allowedHosts: [`127.0.0.1:${fx.port}`], allowPrivateNetwork: true, backoffBaseMs: 5 } } });
    try {
      const w = await h.workspace("Auto");
      const created = await h.api(w.admin, "POST", "/api/v1/contract-checks", { key: "chk.auto", node_id: "contract.invoice", url: `${fx.origin}/ok`, retries: 0, required_fields: [{ name: "invoice_id", type: "string" }] });
      expect(created.status, created.text).toBe(201);
      const snapshot = await h.importSnapshot(w.operator, baselineDoc(), { revision: "release-1" });
      const run = await h.requestRun(w.operator, { snapshot_id: snapshot.body.id, proposed_manifest: removeAmountDoc(), expected_hash: snapshot.body.hash });
      expect(run.status, run.text).toBe(202);
      const disabled = await h.api(w.admin, "POST", `/api/v1/contract-checks/${created.body.id}/disable`);
      expect(disabled.status, disabled.text).toBe(200);
      await h.drain();
      const view = await getRun(h, w.viewer, run.body.id);
      expect(view.verdict ?? view.assessment).toBe("INCOMPLETE");
      expect(JSON.stringify(view)).toContain("CHECK_NOT_RUN");
      const bundle = (await buildBundle(h.db, { workspaceId: w.id, runId: run.body.id }, h.now())) as EvidenceBundle;
      expect(bundle.impact_runs[0]!.check_keys).toEqual(["chk.auto"]);
      expect(bundle.contract_checks.map((c) => [c.key, c.enabled])).toEqual([["chk.auto", false]]);
      expect(verifyBundle(serializeBundle(bundle), { maxBytes: 10_000_000 }).bundle_hash).toBe(bundle.bundle_hash);
    } finally {
      await h.close();
      await fx.close();
    }
  });

  it("control: no check on the changed nodes stores an empty selection and adds no unknown", async () => {
    const h = await createHarness();
    try {
      const w = await h.workspace("NoChecks");
      const snapshot = await h.importSnapshot(w.operator, baselineDoc(), { revision: "release-1" });
      const run = await h.requestRun(w.operator, { snapshot_id: snapshot.body.id, proposed_manifest: removeAmountDoc(), expected_hash: snapshot.body.hash });
      await h.drain();
      const rows = await h.db.query<{ check_keys: string[] }>("SELECT check_keys FROM impact_runs WHERE id = $1", [run.body.id]);
      expect(rows.rows[0]!.check_keys).toEqual([]);
      expect(JSON.stringify(await getRun(h, w.viewer, run.body.id))).not.toContain("CHECK_NOT_RUN");
    } finally {
      await h.close();
    }
  });
});

describe("R2 P2 (restore.ts:42): restore never brings unauthenticated content back live, and bounds free text", () => {
  it("checks come back disabled, and oversized free text is cut to 2000 characters", async () => {
    const fx = await startFixture();
    const src = await createHarness({ settings: { checks: { ...defaultSettings.checks, allowedHosts: [`127.0.0.1:${fx.port}`], allowPrivateNetwork: true } } });
    try {
      const w = await src.workspace("Restore source");
      await src.api(w.admin, "POST", "/api/v1/contract-checks", { key: "chk.one", node_id: "contract.invoice", url: `${fx.origin}/ok`, retries: 0, required_fields: [] });
      const snapshot = await src.importSnapshot(w.operator, baselineDoc(), { revision: "release-1" });
      await src.requestRun(w.operator, { snapshot_id: snapshot.body.id, proposed_manifest: removeAmountDoc(), expected_hash: snapshot.body.hash, run_checks: false });
      await src.drain();
      const copy = JSON.parse(serializeBundle((await buildBundle(src.db, { workspaceId: w.id }, src.now())) as EvidenceBundle)) as Record<string, any>;
      copy.workspace.name = "n".repeat(5000);
      copy.contract_checks[0].enabled = true;
      copy.contract_checks[0].disabled_at = null;
      const dst = await createHarness();
      try {
        await restoreBundle(dst.ctx, reseal(copy));
        const checks = await dst.db.query<{ enabled: boolean; disabled_at: Date | null }>("SELECT enabled, disabled_at FROM contract_checks");
        expect(checks.rows).toHaveLength(1);
        expect(checks.rows[0]!.enabled).toBe(false);
        expect(checks.rows[0]!.disabled_at).not.toBeNull();
        const names = await dst.db.query<{ name: string }>("SELECT name FROM workspaces");
        expect(names.rows[0]!.name).toHaveLength(2000);
        expect(await count(dst.db, "jobs")).toBe(0);
      } finally {
        await dst.close();
      }
    } finally {
      await src.close();
      await fx.close();
    }
  });
});

describe("R2 P1 (graph.ts:387,401,413,419,422): 422 details never repeat a submitted id or field name", () => {
  const secretId = join("gh", "p_", "Zq8vK2mXp4Lw9RtY7nBcJd3fQ1aB2cD3eF4g");
  it("dangling edge, duplicate node id, duplicate contract field and duplicate edge answer with fixed text", async () => {
    const h = await createHarness();
    try {
      const w = await h.workspace("Echo");
      const cases: [string, Record<string, unknown>][] = [
        ["dangling target", manifest([n("svc.a", "service")], [e("svc.a", secretId, "consumes")])],
        ["dangling source", manifest([n("svc.a", "service")], [e(secretId, "svc.a", "consumes")])],
        ["duplicate node id", manifest([n(secretId, "service"), n(secretId, "service")], [])],
        ["duplicate contract field", manifest([n("contract.c", "contract", { fields: [f(secretId), f(secretId)] })], [])],
        ["duplicate edge", manifest([n("svc.a", "service"), n(secretId, "service")], [e("svc.a", secretId, "consumes"), e("svc.a", secretId, "consumes")])],
      ];
      for (const [name, doc] of cases) {
        const res = await h.importSnapshot(w.operator, doc, { revision: "release-1" });
        expect(res.status, `${name}: ${res.text}`).toBe(422);
        expect(res.text, name).not.toContain("Zq8vK2mXp4Lw9RtY7nBcJd3f");
        expect(res.text, name).not.toContain(secretId);
      }
    } finally {
      await h.close();
    }
  });
});

describe("R2 P2 (server.ts:319): exports and bundles have their own per-principal budget", () => {
  it("the 13th export in one window is answered 429 with Retry-After", async () => {
    const h = await createHarness();
    try {
      const w = await h.workspace("Budget");
      const snapshot = await h.importSnapshot(w.operator, baselineDoc(), { revision: "release-1" });
      const run = await h.requestRun(w.operator, { snapshot_id: snapshot.body.id, proposed_manifest: removeAmountDoc(), expected_hash: snapshot.body.hash, run_checks: false });
      await h.drain();
      const statuses: number[] = [];
      for (let i = 0; i < 14; i += 1) statuses.push((await h.api(w.viewer, "GET", `/api/v1/impact-runs/${run.body.id}/export?format=json`)).status);
      expect(statuses.slice(0, 12).every((s) => s === 200)).toBe(true);
      expect(statuses.slice(12)).toContain(429);
      const limited = await h.api(w.viewer, "GET", `/api/v1/impact-runs/${run.body.id}/export?format=json`);
      expect(limited.status).toBe(429);
      expect(limited.headers["retry-after"]).toBeDefined();
    } finally {
      await h.close();
    }
  });
});
