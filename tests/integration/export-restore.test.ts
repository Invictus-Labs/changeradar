import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashCanonical } from "../../src/domain/canonical.js";
import { fixedClock } from "../../src/domain/clock.js";
import { assess } from "../../src/services/assess.js";
import { buildGraph } from "../../src/services/graph.js";
import { defaultSettings } from "../../src/platform/context.js";
import { buildBundle, BundleError, serializeBundle, verifyBundle, type EvidenceBundle } from "../../src/services/evidence.js";
import { restoreBundle, RestoreConflictError } from "../../src/services/restore.js";
import { runWorkerOnce, SimulatedCrash } from "../../src/workers/worker.js";
import { startFixture, type Fixture } from "../helpers/fixture-server.js";
import { count, createHarness, getRun, type Harness, type TestWorkspace } from "../helpers/harness.js";
import { addOptionalFieldDoc, baselineDoc, removeAmountDoc, unverifiedEdgeDoc } from "../helpers/scenario.js";
import { UUID_ONES, UUID_TWOS, UUID_ZERO } from "../helpers/ids.js";

const TABLES = ["workspaces", "snapshots", "nodes", "edges", "impact_runs", "findings", "run_events", "check_results", "contract_checks", "audit_events"];
const emptyState = async (h: Harness) => {
  const out: Record<string, number> = {};
  for (const t of TABLES) out[t] = await count(h.db, t);
  return out;
};
const zeroState = Object.fromEntries(TABLES.map((t) => [t, 0]));

/** Re-seal a tampered bundle the way an attacker who recomputes every hash would. */
function reseal(bundle: Record<string, any>): string {
  const { bundle_hash: _drop, hashes: _h, stale_runs: _s, ...body } = bundle;
  const hashes = { snapshots: hashCanonical(body.snapshots), impact_runs: hashCanonical(body.impact_runs), contract_checks: hashCanonical(body.contract_checks) };
  const withHashes = { ...body, hashes };
  return JSON.stringify({ ...withHashes, bundle_hash: hashCanonical(withHashes) });
}
const expectRejected = (text: string | Uint8Array, code: string, maxBytes = 250 * 1024 * 1024) => {
  try {
    verifyBundle(text, { maxBytes });
  } catch (error) {
    expect(error).toBeInstanceOf(BundleError);
    expect((error as BundleError).code).toBe(code);
    return;
  }
  // An assertion, not a thrown Error: a mutant that lets a bad bundle through must be killed by a failing EXPECTATION.
  expect("accepted", `the bundle was accepted; expected the rejection ${code}`).toBe("rejected");
};

describe("AC-10 / AC-13 evidence bundle export, restore into a clean installation, references preserved", () => {
  let src: Harness;
  let ws: TestWorkspace;
  let fx: Fixture;
  let bundleText: string;
  let bundle: EvidenceBundle;
  const runIds: string[] = [];
  const snapshotIds: string[] = [];

  beforeAll(async () => {
    fx = await startFixture();
    src = await createHarness({ settings: { checks: { ...defaultSettings.checks, allowedHosts: [`127.0.0.1:${fx.port}`], allowPrivateNetwork: true, backoffBaseMs: 5 } } });
    ws = await src.workspace("Source");
    const check = await src.api(ws.admin, "POST", "/api/v1/contract-checks", { key: "chk.source", node_id: "contract.invoice", url: `${fx.origin}/ok`, retries: 0, required_fields: [{ name: "invoice_id", type: "string" }] });
    expect(check.status, check.text).toBe(201);
    // A second check on a node no run touches, with a NON-default value in every field, so that a restore that drops or
    // hard-codes any one of them is visible in the comparison below (round 3, test-adequacy P1).
    const second = await src.api(ws.admin, "POST", "/api/v1/contract-checks", { key: "chk.head", node_id: "contract.other", url: `${fx.origin}/ok`, method: "HEAD", timeout_ms: 1234, retries: 3, expect_status: 204, required_fields: [], credential_alias: "cred.source" });
    expect(second.status, second.text).toBe(201);
    const s1 = await src.importSnapshot(ws.operator, baselineDoc(), { revision: "release-1" });
    snapshotIds.push(s1.body.id);
    for (const proposed of [removeAmountDoc(), addOptionalFieldDoc()]) {
      const run = await src.requestRun(ws.operator, { snapshot_id: s1.body.id, proposed_manifest: proposed, expected_hash: s1.body.hash });
      runIds.push(run.body.id);
    }
    const s2 = await src.importSnapshot(ws.operator, unverifiedEdgeDoc(), { revision: "release-2" });
    snapshotIds.push(s2.body.id);
    const incomplete = await src.requestRun(ws.operator, { snapshot_id: s2.body.id, proposed_manifest: removeAmountDoc(), expected_hash: s2.body.hash, run_checks: false });
    runIds.push(incomplete.body.id);
    await src.drain();
    const built = await buildBundle(src.db, { workspaceId: ws.id }, src.now());
    if (!built) throw new Error("no bundle");
    bundle = built;
    bundleText = serializeBundle(built);
  });
  afterAll(async () => {
    await src.close();
    await fx.close();
  });

  it("the bundle is versioned, hashed, secret free and self-verifying", () => {
    expect(bundle).toMatchObject({ format: "changeradar-evidence-bundle", schema_version: 1, scope: "workspace", producer: { name: "changeradar" } });
    expect(bundle.bundle_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(bundle.snapshots).toHaveLength(2);
    expect(bundle.impact_runs).toHaveLength(3);
    expect(bundle.contract_checks).toHaveLength(2);
    expect(verifyBundle(bundleText, { maxBytes: 10_000_000 }).bundle_hash).toBe(bundle.bundle_hash);
    expect(bundleText).not.toMatch(/password|scrypt|session|token_hash|secret_enc/i);
    expect(bundleText.endsWith("\n")).toBe(true);
  });

  it("restores into a clean installation with every id, hash and reference preserved", async () => {
    const dst = await createHarness();
    try {
      const summary = await restoreBundle(dst.ctx, bundleText);
      expect(summary).toMatchObject({ workspace_id: ws.id, snapshots: 2, impact_runs: 3, contract_checks: 2, interrupted_runs: [], stale_runs: [] });
      const admin = await dst.userIn(ws.id, "admin");
      const viewer = await dst.userIn(ws.id, "viewer");
      // Snapshots: same ids, same hashes, same baseline pointer, graph rows rebuilt.
      for (const id of snapshotIds) {
        const a = await src.api(ws.viewer, "GET", `/api/v1/snapshots/${id}`);
        const b = await dst.api(viewer, "GET", `/api/v1/snapshots/${id}`);
        expect(b.status).toBe(200);
        expect(b.body).toEqual(a.body);
      }
      expect((await dst.api(viewer, "GET", "/api/v1/baseline")).body).toEqual((await src.api(ws.viewer, "GET", "/api/v1/baseline")).body);
      expect(await count(dst.db, "nodes")).toBe(await count(src.db, "nodes", "workspace_id = $1", [ws.id]));
      expect(await count(dst.db, "edges")).toBe(await count(src.db, "edges", "workspace_id = $1", [ws.id]));
      // Runs: identical views and identical report hashes (snapshot -> run -> finding ids all preserved).
      for (const id of runIds) {
        const a = await getRun(src, ws.viewer, id);
        const b = await getRun(dst, viewer, id);
        expect(b).toEqual(a);
        expect(b.affected.map((x: any) => x.id)).toEqual(a.affected.map((x: any) => x.id));
        const reportA = await src.api(ws.viewer, "GET", `/api/v1/impact-runs/${id}/export?format=json`);
        const reportB = await dst.api(viewer, "GET", `/api/v1/impact-runs/${id}/export?format=json`);
        expect(reportB.body.report_hash).toBe(reportA.body.report_hash);
        expect(reportB.body.snapshot.id).toBe(reportA.body.snapshot.id);
      }
      expect(await count(dst.db, "findings")).toBe(await count(src.db, "findings", "workspace_id = $1", [ws.id]));
      // Nothing was re-executed or queued by the restore.
      expect(await count(dst.db, "jobs")).toBe(0);
      // Re-exporting the restored installation reproduces every section hash.
      const again = await buildBundle(dst.db, { workspaceId: ws.id }, dst.now());
      expect(again!.hashes.snapshots).toBe(bundle.hashes.snapshots);
      expect(again!.hashes.impact_runs).toBe(bundle.hashes.impact_runs);
      // Round 2 (security P2, restore.ts:42): a bundle is not authenticated, so its check definitions come back DISABLED
      // (same key, node, url; the contract_checks section therefore differs, on purpose, in enabled and disabled_at only).
      expect(bundle.contract_checks.every((c) => c.enabled)).toBe(true);
      expect(again!.contract_checks.every((c) => !c.enabled && c.disabled_at !== null)).toBe(true);
      // Round 3 (test-adequacy P1): EVERY other field of EVERY check is restored exactly (key, node, url, method, timeout,
      // retries, expected status, required fields, credential alias, creation time), and the two checks differ in all of
      // them, so dropping or hard-coding any one field fails here. Only enabled and disabled_at differ, on purpose.
      const withoutState = (list: EvidenceBundle["contract_checks"]) => list.map(({ enabled: _e, disabled_at: _d, ...rest }) => rest);
      expect(withoutState(again!.contract_checks)).toEqual(withoutState(bundle.contract_checks));
      expect(bundle.contract_checks.find((c) => c.key === "chk.head")).toMatchObject({ method: "HEAD", timeout_ms: 1234, retries: 3, expect_status: 204, credential_alias: "cred.source" });
      expect(again!.baseline).toEqual(bundle.baseline);
      // The restored installation is fully usable: a new run against the restored baseline works and is stale-checked.
      const baseline = (await dst.api(viewer, "GET", "/api/v1/baseline")).body.snapshot;
      const operator = await dst.userIn(ws.id, "operator");
      const fresh = await dst.requestRun(operator, { snapshot_id: baseline.id, proposed_manifest: removeAmountDoc(), expected_hash: baseline.hash });
      expect(fresh.status).toBe(202);
      await dst.drain();
      expect((await getRun(dst, admin, fresh.body.id)).status).toBe("complete");
      // The restore is audited.
      const audit = await dst.api(admin, "GET", "/api/v1/audit?limit=100");
      expect(audit.body.items.some((a: any) => a.action === "bundle.restored" && a.metadata.bundle_hash === bundle.bundle_hash)).toBe(true);
    } finally {
      await dst.close();
    }
  });

  it("a run bundle from the API restores on its own, carrying only what it references", async () => {
    const res = await src.api(ws.operator, "GET", `/api/v1/impact-runs/${runIds[0]}/bundle`);
    expect(res.status).toBe(200);
    expect(String(res.headers["content-disposition"])).toContain(`changeradar-run-${runIds[0]}.json`);
    const runBundle = verifyBundle(res.text, { maxBytes: 10_000_000 });
    expect(runBundle).toMatchObject({ scope: "run" });
    expect(runBundle.snapshots.map((s) => s.id)).toEqual([snapshotIds[0]]);
    expect(runBundle.impact_runs.map((r) => r.id)).toEqual([runIds[0]]);
    const dst = await createHarness();
    try {
      await restoreBundle(dst.ctx, res.text);
      const viewer = await dst.userIn(ws.id, "viewer");
      const a = await getRun(src, ws.viewer, runIds[0]!);
      expect(await getRun(dst, viewer, runIds[0]!)).toEqual(a);
      expect(await count(dst.db, "snapshots")).toBe(1);
    } finally {
      await dst.close();
    }
  });

  it("truncation at any cut point is rejected and accepts nothing", async () => {
    const dst = await createHarness();
    try {
      const cuts = new Set<number>([0, 1, 2, 10, bundleText.length - 1, bundleText.length - 2, bundleText.length - 3, Math.floor(bundleText.length / 2)]);
      for (let i = 1; i < 60; i += 1) cuts.add(Math.floor((bundleText.length * i) / 60));
      // The trailing newline is not part of the document, so cutting only it must still verify.
      expect(() => verifyBundle(bundleText.slice(0, bundleText.length - 1), { maxBytes: 1e9 })).not.toThrow();
      cuts.delete(bundleText.length - 1);
      for (const cut of cuts) {
        let failure: unknown;
        try {
          await restoreBundle(dst.ctx, bundleText.slice(0, cut));
        } catch (error) {
          failure = error;
        }
        expect(failure, `cut at ${cut}`).toBeInstanceOf(BundleError);
        expect(["BUNDLE_MALFORMED", "BUNDLE_SCHEMA_INVALID", "BUNDLE_HASH_MISMATCH"]).toContain((failure as BundleError).code);
      }
      expect(await emptyState(dst)).toEqual(zeroState);
    } finally {
      await dst.close();
    }
  });

  it("edits to derived or inconsistent fields (findings, verdict, unknowns, ids, status) are rejected even when every hash is recomputed, because snapshots are rebuilt and runs re-derived (integrity, not authenticity)", () => {
    const edit = (fn: (b: Record<string, any>) => void) => {
      const copy = JSON.parse(bundleText) as Record<string, any>;
      fn(copy);
      return reseal(copy);
    };
    const completed = (b: Record<string, any>) => b.impact_runs.find((r: any) => r.status === "COMPLETE" && r.findings.length > 0);
    // Without recomputing hashes: the bundle hash catches any edit.
    const naive = JSON.parse(bundleText) as Record<string, any>;
    naive.workspace.name = "Renamed";
    expectRejected(JSON.stringify(naive), "BUNDLE_HASH_MISMATCH");
    const sectionOnly = JSON.parse(bundleText) as Record<string, any>;
    sectionOnly.snapshots[0].revision = "edited";
    expectRejected(JSON.stringify(sectionOnly), "BUNDLE_HASH_MISMATCH");
    // With recomputed hashes: consistency checks catch it.
    expectRejected(edit((b) => { const f = completed(b).findings[0]; f.finding_key = `fnd_${"0".repeat(20)}`; }), "BUNDLE_RUN_INCONSISTENT");
    expectRejected(edit((b) => { completed(b).findings.pop(); }), "BUNDLE_RUN_INCONSISTENT");
    expectRejected(edit((b) => { completed(b).verdict = "NO_KNOWN_IMPACT"; }), "BUNDLE_RUN_INCONSISTENT");
    expectRejected(edit((b) => { completed(b).unknowns.push({ id: "unk_00000000000000000000" }); }), "BUNDLE_RUN_INCONSISTENT");
    expectRejected(edit((b) => { completed(b).proposed_manifest.nodes[0].owner = "someone-else"; }), "BUNDLE_RUN_INCONSISTENT");
    expectRejected(edit((b) => { completed(b).baseline_hash = `sha256:${"a".repeat(64)}`; }), "BUNDLE_RUN_INCONSISTENT");
    expectRejected(edit((b) => { completed(b).status = "QUEUED"; }), "BUNDLE_RUN_INCONSISTENT");
    expectRejected(edit((b) => { b.impact_runs.find((r: any) => r.status === "COMPLETE" && r.findings.length === 0).findings.push(completed(b).findings[0]); }), "BUNDLE_RUN_INCONSISTENT");
    expectRejected(edit((b) => { completed(b).snapshot_id = UUID_ZERO; }), "BUNDLE_RUN_INCONSISTENT");
    expectRejected(edit((b) => { b.impact_runs[1].id = b.impact_runs[0].id; }), "BUNDLE_RUN_INCONSISTENT");
    expectRejected(edit((b) => { completed(b).assessment_detail = null; }), "BUNDLE_RUN_INCONSISTENT");
    expectRejected(edit((b) => { completed(b).assessment_detail.evaluated_at = "yesterday"; }), "BUNDLE_RUN_INCONSISTENT");
    expectRejected(edit((b) => { b.snapshots[0].manifest.nodes[0].owner = "someone-else"; }), "BUNDLE_SNAPSHOT_MISMATCH");
    expectRejected(edit((b) => { b.snapshots[0].node_count += 1; }), "BUNDLE_SNAPSHOT_MISMATCH");
    expectRejected(edit((b) => { b.snapshots[1].id = b.snapshots[0].id; }), "BUNDLE_SNAPSHOT_MISMATCH");
    expectRejected(edit((b) => { b.snapshots[0].id = "not-a-uuid"; }), "BUNDLE_SNAPSHOT_MISMATCH");
    expectRejected(edit((b) => { b.baseline.snapshot_id = UUID_ZERO; }), "BUNDLE_SNAPSHOT_MISMATCH");
    expectRejected(edit((b) => { b.snapshots[0].manifest.edges.push({ source_id: "x", target_id: "y", relation: "consumes", source_file: "f", source_line: 1 }); }), "BUNDLE_SNAPSHOT_MISMATCH");
    expectRejected(edit((b) => { b.workspace.id = "not-a-uuid"; }), "BUNDLE_SCHEMA_INVALID");
    expectRejected(edit((b) => { b.contract_checks.push({ ...b.contract_checks[0] }); }), "BUNDLE_SCHEMA_INVALID");
  });

  it("a check result edited without also rewriting the derived verdict and unknowns is rejected (RUN_INCONSISTENT)", () => {
    const copy = JSON.parse(bundleText) as Record<string, any>;
    const withCheck = copy.impact_runs.find((r: any) => r.checks.length > 0);
    withCheck.checks[0].result.state = "FAILED";
    withCheck.checks[0].state = "FAILED";
    expectRejected(reseal(copy), "BUNDLE_RUN_INCONSISTENT");
  });

  it("KNOWN LIMIT (review round 1, documented): a forger who rewrites the recorded check results TOGETHER with the derived unknowns and verdict, then recomputes every hash, is not detected - the bundle proves integrity, not authenticity", () => {
    const copy = JSON.parse(bundleText) as Record<string, any>;
    const run = copy.impact_runs.find((r: any) => r.status === "COMPLETE" && r.checks.length > 0);
    run.checks[0].result = { ...run.checks[0].result, state: "FAILED" };
    run.checks[0].state = "FAILED";
    const baseline = buildGraph(copy.snapshots.find((s: any) => s.id === run.snapshot_id).manifest);
    const proposed = buildGraph(run.proposed_manifest);
    if (!baseline.ok || !proposed.ok) throw new Error("fixture graphs must build");
    const rederived = assess({
      baseline: baseline.graph,
      proposed: proposed.graph,
      expected_hash: run.baseline_hash,
      clock: fixedClock(run.assessment_detail.evaluated_at),
      check_results: run.checks.map((c: any) => c.result),
    });
    if (!rederived.ok) throw new Error("re-derivation must succeed");
    run.unknowns = rederived.assessment.unknowns;
    run.verdict = rederived.assessment.assessment;
    // Round 2: verification compares the assessment detail too, so a consistent forgery has to rewrite it as well.
    const { findings: _findings, unknowns: _unknowns, ...detail } = rederived.assessment;
    run.assessment_detail = JSON.parse(JSON.stringify(detail));
    expect(run.verdict).toBe("INCOMPLETE");
    // Accepted: nothing in the bundle is keyed to the operator, so a consistent forgery cannot be told from a real one.
    expect(() => verifyBundle(reseal(copy), { maxBytes: 250 * 1024 * 1024 })).not.toThrow();
  });

  it("unsupported versions, wrong formats, extra members, bad encodings and oversize files are refused", () => {
    const copy = () => JSON.parse(bundleText) as Record<string, any>;
    const v2 = copy();
    v2.schema_version = 2;
    expectRejected(JSON.stringify(v2), "BUNDLE_UNSUPPORTED_VERSION");
    const v0 = copy();
    v0.schema_version = "1";
    expectRejected(JSON.stringify(v0), "BUNDLE_UNSUPPORTED_VERSION");
    const format = copy();
    format.format = "something-else";
    expectRejected(JSON.stringify(format), "BUNDLE_SCHEMA_INVALID");
    const extra = copy();
    extra.telemetry = { phone_home: true };
    expectRejected(JSON.stringify(extra), "BUNDLE_SCHEMA_INVALID");
    const nested = copy();
    nested.impact_runs[0].surprise = 1;
    expectRejected(JSON.stringify(nested), "BUNDLE_SCHEMA_INVALID");
    const missing = copy();
    delete missing.hashes;
    expectRejected(JSON.stringify(missing), "BUNDLE_SCHEMA_INVALID");
    expectRejected("[]", "BUNDLE_SCHEMA_INVALID");
    expectRejected("null", "BUNDLE_SCHEMA_INVALID");
    expectRejected("", "BUNDLE_MALFORMED");
    expectRejected("not json", "BUNDLE_MALFORMED");
    expectRejected(new Uint8Array([0xff, 0xfe, 0x7b, 0x7d]), "BUNDLE_MALFORMED");
    expectRejected(bundleText, "BUNDLE_TOO_LARGE", 1000);
    expectRejected(new TextEncoder().encode(bundleText), "BUNDLE_TOO_LARGE", 1000);
    expect(verifyBundle(new TextEncoder().encode(bundleText), { maxBytes: 10_000_000 }).bundle_hash).toBe(bundle.bundle_hash);
  });

  it("a restore that fails at ANY step leaves no partial state, and a clean retry then succeeds", async () => {
    const dst = await createHarness();
    try {
      for (const step of ["workspace", "snapshots", "checks", "runs", "findings"] as const) {
        await expect(
          restoreBundle(dst.ctx, bundleText, {
            afterStep: (s) => {
              if (s === step) throw new Error(`injected failure after ${step}`);
            },
          }),
        ).rejects.toThrow(`injected failure after ${step}`);
        expect(await emptyState(dst), step).toEqual(zeroState);
      }
      // A failure raised by the database itself in the middle of the write is rolled back too.
      await dst.db.exec(`CREATE FUNCTION test_fail_findings() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'findings rejected'; END; $$ LANGUAGE plpgsql;
        CREATE TRIGGER test_fail_findings BEFORE INSERT ON findings FOR EACH ROW EXECUTE FUNCTION test_fail_findings();`);
      await expect(restoreBundle(dst.ctx, bundleText)).rejects.toThrow(/findings rejected/);
      expect(await emptyState(dst)).toEqual(zeroState);
      await dst.db.exec("DROP TRIGGER test_fail_findings ON findings; DROP FUNCTION test_fail_findings();");
      const ok = await restoreBundle(dst.ctx, bundleText);
      expect(ok.impact_runs).toBe(3);
    } finally {
      await dst.close();
    }
  });

  it("restoring into an installation that already holds the workspace, a snapshot or a run is refused unchanged", async () => {
    const dst = await createHarness();
    try {
      await restoreBundle(dst.ctx, bundleText);
      const after = await emptyState(dst);
      await expect(restoreBundle(dst.ctx, bundleText)).rejects.toBeInstanceOf(RestoreConflictError);
      expect(await emptyState(dst)).toEqual(after);
      // Same snapshots under a different workspace id (attacker resealed): refused on the snapshot ids.
      const moved = JSON.parse(bundleText) as Record<string, any>;
      moved.workspace.id = UUID_ONES;
      await expect(restoreBundle(dst.ctx, reseal(moved))).rejects.toThrow(/snapshot id/);
      // Only the run ids collide.
      const runOnly = JSON.parse(bundleText) as Record<string, any>;
      runOnly.workspace.id = UUID_TWOS;
      for (const s of runOnly.snapshots) s.id = s.id.replace(/^.{8}/, "abcdef01");
      const idMap = new Map<string, string>(bundle.snapshots.map((s) => [s.id, s.id.replace(/^.{8}/, "abcdef01")]));
      for (const r of runOnly.impact_runs) r.snapshot_id = idMap.get(r.snapshot_id);
      runOnly.baseline.snapshot_id = idMap.get(runOnly.baseline.snapshot_id) ?? null;
      await expect(restoreBundle(dst.ctx, reseal(runOnly))).rejects.toThrow(/run id/);
      expect(await emptyState(dst)).toEqual(after);
    } finally {
      await dst.close();
    }
  });
});

describe("AC-13 restore records unfinished work honestly", () => {
  it("a queued run and a check that was STARTED at backup time are restored as FAILED and UNKNOWN, never as finished", async () => {
    const fx = await startFixture();
    const src = await createHarness({ settings: { checks: { ...defaultSettings.checks, allowedHosts: [`127.0.0.1:${fx.port}`], allowPrivateNetwork: true } } });
    const dst = await createHarness();
    try {
      const w = await src.workspace("Unfinished");
      await src.api(w.admin, "POST", "/api/v1/contract-checks", { key: "chk.open", node_id: "contract.invoice", url: `${fx.origin}/ok`, retries: 0 });
      const snap = await src.importSnapshot(w.operator, baselineDoc());
      const queued = await src.requestRun(w.operator, { snapshot_id: snap.body.id, proposed_manifest: addOptionalFieldDoc(), expected_hash: snap.body.hash });
      const running = await src.requestRun(w.operator, { snapshot_id: snap.body.id, proposed_manifest: removeAmountDoc(), expected_hash: snap.body.hash });
      // Drive the second run into RUNNING with an open (STARTED) check by crashing the worker inside the check.
      await src.db.query("UPDATE jobs SET next_attempt_at = now() + interval '1 day' WHERE object_id = $1", [queued.body.id]);
      await runWorkerOnce(src.ctx, { hooks: { afterCheckStarted: () => { throw new SimulatedCrash(); } } });
      const text = serializeBundle((await buildBundle(src.db, { workspaceId: w.id }, src.now()))!);
      const summary = await restoreBundle(dst.ctx, text);
      expect(summary.interrupted_runs.sort()).toEqual([queued.body.id, running.body.id].sort());
      const viewer = await dst.userIn(w.id, "viewer");
      for (const id of [queued.body.id, running.body.id]) {
        const view = await getRun(dst, viewer, id);
        expect(view).toMatchObject({ status: "failed", assessment: null, error: { code: "RESTORED_UNFINISHED" }, affected: [] });
      }
      const open = await getRun(dst, viewer, running.body.id);
      expect(open.checks).toEqual([expect.objectContaining({ check_key: "chk.open", state: "UNKNOWN" })]);
      expect(await count(dst.db, "jobs")).toBe(0); // nothing is silently re-queued into a success
      const history = await dst.db.query<{ note: string | null; to_status: string }>("SELECT note, to_status FROM run_events WHERE run_id = $1 ORDER BY id", [running.body.id]);
      expect(history.rows.at(-1)).toMatchObject({ to_status: "FAILED" });
      expect(history.rows.at(-1)?.note).toContain("restored from a backup while unfinished");
    } finally {
      await src.close();
      await dst.close();
      await fx.close();
    }
  });
});
