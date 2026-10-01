import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultSettings } from "../../src/platform/context.js";
import { htmlReportRenderer } from "../../src/report/html-report.js";
import { buildBundle, serializeBundle, verifyBundle } from "../../src/services/evidence.js";
import { restoreBundle } from "../../src/services/restore.js";
import { runWorkerOnce, SimulatedCrash } from "../../src/workers/worker.js";
import { startFixture, type Fixture } from "../helpers/fixture-server.js";
import { count, createHarness, getRun, type Harness, type TestWorkspace } from "../helpers/harness.js";
import { baselineDoc, removeAmountDoc } from "../helpers/scenario.js";
import { bumped, chain } from "../helpers/scale-shapes.js";

/**
 * Review round 1 regressions at the worker/API level: requested checks that vanish (P1), a failed run's open
 * checks (P2), bounded findings surviving persistence, export, bundle and restore (P1), the output backstop, and
 * the live-check coverage statement (P2).
 */

async function queue(h: Harness, ws: TestWorkspace, extra: Record<string, unknown> = {}, proposed: unknown = removeAmountDoc(), baseline: unknown = baselineDoc()) {
  const snap = await h.importSnapshot(ws.operator, baseline);
  const run = await h.requestRun(ws.operator, { snapshot_id: snap.body.id, proposed_manifest: proposed, expected_hash: snap.body.hash, ...extra });
  expect(run.status, run.text).toBe(202);
  return { snap: snap.body, runId: run.body.id as string };
}

describe("R1 P1: a check the request named is never silently dropped (worker.ts:128)", () => {
  let h: Harness;
  let ws: TestWorkspace;
  let fx: Fixture;
  beforeAll(async () => {
    fx = await startFixture();
    h = await createHarness({ settings: { checks: { ...defaultSettings.checks, allowedHosts: [`127.0.0.1:${fx.port}`], allowPrivateNetwork: true, backoffBaseMs: 5 } } });
    ws = await h.workspace("Requested");
  });
  afterAll(async () => {
    await h.close();
    await fx.close();
  });

  const create = async (key: string, path: string) => {
    const res = await h.api(ws.admin, "POST", "/api/v1/contract-checks", { key, node_id: "contract.invoice", url: `${fx.origin}${path}`, retries: 0, timeout_ms: 1000 });
    expect(res.status, res.text).toBe(201);
    return res.body.id as string;
  };

  it("a requested check that is disabled before the worker runs makes the run INCOMPLETE with CHECK_NOT_RUN", async () => {
    const id = await create("chk.requested", "/ok");
    const { runId } = await queue(h, ws, { check_keys: ["chk.requested"] });
    const disabled = await h.api(ws.admin, "POST", `/api/v1/contract-checks/${id}/disable`);
    expect(disabled.status, disabled.text).toBe(200);
    await h.drain();
    const view = await getRun(h, ws.viewer, runId);
    expect(view.status).toBe("complete");
    expect(view.checks).toEqual([]);
    expect(view.assessment).toBe("INCOMPLETE");
    expect(view.unknowns.map((u: any) => u.code)).toContain("CHECK_NOT_RUN");
    expect(view.unknowns.find((u: any) => u.code === "CHECK_NOT_RUN").message).toContain("chk.requested");
  });

  it("a requested check that is disabled before the worker runs cannot turn a would-be pass into NO_KNOWN_IMPACT", async () => {
    const id = await create("chk.requested2", "/ok");
    const informational = { ...(baselineDoc() as Record<string, unknown>), revision: "rev-2" };
    const { runId } = await queue(h, ws, { check_keys: ["chk.requested2"] }, informational, baselineDoc());
    await h.api(ws.admin, "POST", `/api/v1/contract-checks/${id}/disable`);
    await h.drain();
    const view = await getRun(h, ws.viewer, runId);
    expect(view.assessment).toBe("INCOMPLETE");
  });

  it("control: the same request with the check still enabled runs it and has no CHECK_NOT_RUN", async () => {
    await create("chk.enabled", "/ok");
    const { runId } = await queue(h, ws, { check_keys: ["chk.enabled"] });
    await h.drain();
    const view = await getRun(h, ws.viewer, runId);
    expect(view.checks.map((c: any) => [c.check_key, c.state])).toEqual([["chk.enabled", "PASSED"]]);
    expect(view.unknowns.map((u: any) => u.code)).not.toContain("CHECK_NOT_RUN");
  });

  it("the CHECK_NOT_RUN unknown reproduces from an exported bundle (the derivation is shared)", async () => {
    const id = await create("chk.exported", "/ok");
    await queue(h, ws, { check_keys: ["chk.exported"] });
    await h.api(ws.admin, "POST", `/api/v1/contract-checks/${id}/disable`);
    await h.drain();
    const bundle = await buildBundle(h.db, { workspaceId: ws.id }, h.now());
    expect(() => verifyBundle(serializeBundle(bundle!), { maxBytes: 1e9 })).not.toThrow();
  });
});

describe("R1 P2: failWith leaves no check STARTED on a failed run (worker.ts:107)", () => {
  let h: Harness;
  let ws: TestWorkspace;
  let fx: Fixture;
  beforeAll(async () => {
    fx = await startFixture();
    h = await createHarness({ settings: { checks: { ...defaultSettings.checks, allowedHosts: [`127.0.0.1:${fx.port}`], allowPrivateNetwork: true, backoffBaseMs: 5 } } });
    ws = await h.workspace("FailWith");
    const created = await h.api(ws.admin, "POST", "/api/v1/contract-checks", { key: "chk.open", node_id: "contract.invoice", url: `${fx.origin}/ok`, retries: 0, timeout_ms: 1000 });
    expect(created.status, created.text).toBe(201);
  });
  afterAll(async () => {
    await h.close();
    await fx.close();
  });

  it("a crash with the check STARTED, then an integrity failure on the rerun, ends FAILED with the check UNKNOWN", async () => {
    const { runId } = await queue(h, ws);
    const crashed = await runWorkerOnce(h.ctx, { hooks: { afterCheckStarted: () => { throw new SimulatedCrash(); } } });
    expect(crashed.result).toBe("crashed");
    expect((await h.db.query<{ state: string }>("SELECT state FROM check_results WHERE run_id = $1", [runId])).rows).toEqual([{ state: "STARTED" }]);
    await h.db.query("ALTER TABLE impact_runs DISABLE TRIGGER impact_runs_protect");
    await h.db.query("UPDATE impact_runs SET proposed_manifest = replace(proposed_manifest, 'contract.invoice', 'contract.other') WHERE id = $1", [runId]);
    await h.db.query("ALTER TABLE impact_runs ENABLE TRIGGER impact_runs_protect");
    h.advance(61);
    await h.drain();
    const view = await getRun(h, ws.viewer, runId);
    expect(view).toMatchObject({ status: "failed", assessment: null, error: { code: "INTEGRITY_FAILURE" } });
    const rows = await h.db.query<{ state: string }>("SELECT state FROM check_results WHERE run_id = $1", [runId]);
    expect(rows.rows).toEqual([{ state: "UNKNOWN" }]);
  });
});

describe("R1 P1: bounded findings through persistence, export, bundle and restore", () => {
  let h: Harness;
  let ws: TestWorkspace;
  beforeAll(async () => {
    h = await createHarness({ settings: { assess: { max_findings: 30 } } });
    ws = await h.workspace("Bounded");
  });
  afterAll(async () => h.close());

  it("a 60 node chain: elided paths are stored, served, exported, bundled and restored, and the run is INCOMPLETE", async () => {
    const { runId } = await queue(h, ws, {}, bumped(chain(60), [0]), chain(60));
    await h.drain();
    const view = await getRun(h, ws.viewer, runId);
    expect(view.status).toBe("complete");
    expect(view.assessment).toBe("INCOMPLETE");
    expect(view.unknowns.map((u: any) => u.code)).toEqual(["FINDINGS_TRUNCATED"]);
    expect(view.totals.findings).toBe(30);
    expect(view.summary.findings_omitted).toBe(29);
    const stored = await h.db.query<{ depth: number; path_omitted_hops: number; jsonb_array_length: number }>(
      "SELECT depth, path_omitted_hops, jsonb_array_length(hops) FROM findings WHERE run_id = $1 ORDER BY position DESC LIMIT 1",
      [runId],
    );
    expect(stored.rows[0]).toMatchObject({ depth: 30, path_omitted_hops: 6, jsonb_array_length: 24 });

    const page = await h.api(ws.viewer, "GET", `/api/v1/impact-runs/${runId}/findings?limit=100`);
    const deepest = page.body.items.at(-1);
    expect(deepest).toMatchObject({ depth: 30, path_omitted_hops: 6 });
    expect(page.body.items[0]).not.toHaveProperty("path_omitted_hops");

    const json = await h.api(ws.viewer, "GET", `/api/v1/impact-runs/${runId}/export?format=json`);
    expect(json.body.findings.at(-1).path_omitted_hops).toBe(6);
    const html = await h.api(ws.viewer, "GET", `/api/v1/impact-runs/${runId}/export?format=html`);
    expect(html.text).toContain("6 hops omitted from the middle"); // the built-in renderer
    h.ctx.reportRenderer = htmlReportRenderer; // the report the server ships
    const shipped = await h.api(ws.viewer, "GET", `/api/v1/impact-runs/${runId}/export?format=html`);
    expect(shipped.text).toContain("6 hops not shown");

    const bundle = await buildBundle(h.db, { workspaceId: ws.id }, h.now());
    const text = serializeBundle(bundle!);
    const verified = verifyBundle(text, { maxBytes: 1e9 });
    expect(verified.impact_runs[0]!.findings.at(-1)).toMatchObject({ path_omitted_hops: 6 });

    const other = await createHarness({});
    try {
      await restoreBundle(other.ctx, text);
      const restored = await other.db.query<{ path_omitted_hops: number }>("SELECT path_omitted_hops FROM findings WHERE run_id = $1 ORDER BY position DESC LIMIT 1", [runId]);
      expect(restored.rows[0]!.path_omitted_hops).toBe(6);
    } finally {
      await other.close();
    }
  });
});

describe("R1: the output backstop and the live-check coverage statement", () => {
  it("an assessment above the byte limit fails the run visibly as OUTPUT_TOO_LARGE and stores no findings", async () => {
    const h = await createHarness({ settings: { maxAssessmentBytes: 500 } });
    try {
      const ws = await h.workspace("Backstop");
      const { runId } = await queue(h, ws);
      await h.drain();
      const view = await getRun(h, ws.viewer, runId);
      expect(view).toMatchObject({ status: "failed", assessment: null, error: { code: "OUTPUT_TOO_LARGE" } });
      expect(await count(h.db, "findings", "run_id = $1", [runId])).toBe(0);
    } finally {
      await h.close();
    }
  });

  it("with live checks switched off the coverage says they were not run", async () => {
    const h = await createHarness({});
    try {
      const ws = await h.workspace("NoChecks");
      const { runId } = await queue(h, ws, { run_checks: false });
      await h.drain();
      const view = await getRun(h, ws.viewer, runId);
      expect(view.coverage.limits.map((l: any) => l.code)).toContain("LIVE_CHECKS_NOT_RUN");
      const { runId: second } = await queue(h, ws, {});
      await h.drain();
      const withChecksOn = await getRun(h, ws.viewer, second);
      const note = withChecksOn.coverage.limits.find((l: any) => l.code === "LIVE_CHECKS_NOT_RUN");
      expect(note.message).toContain("No enabled live contract check matched");
    } finally {
      await h.close();
    }
  });
});
