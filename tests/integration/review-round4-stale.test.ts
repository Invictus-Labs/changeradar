import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ImpactRunView, RunListPage, RunReport } from "../../src/domain/api-responses.js";
import { hashCanonical } from "../../src/domain/canonical.js";
import { htmlReportRenderer } from "../../src/report/html-report.js";
import { buildBundle, serializeBundle, type EvidenceBundle } from "../../src/services/evidence.js";
import { restoreBundle } from "../../src/services/restore.js";
import { createHarness, getRun, type Harness } from "../helpers/harness.js";
import { baselineDoc, removeAmountDoc } from "../helpers/scenario.js";

/**
 * Review round 4 (logic P2, security P2, ruled must-fix): a run assessed by an older decision engine must never look safe
 * anywhere. Its verdict field is null (with the old verdict in `recorded_assessment`), so a script that gates on
 * `assessment == "NO_KNOWN_IMPACT"` cannot accept it, in the run view, the list, the JSON export and the HTML export
 * (through the production renderer), and also for a bundle that was restored, or forged and resealed.
 */

const here = dirname(fileURLToPath(import.meta.url));
/** The genuine bundle written by the 2cc918e build; UUIDs are stored without dashes in the fixture. */
const ENGINE1 = readFileSync(resolve(here, "../fixtures/upgrade/engine1-bundle.json"), "utf8").replace(/\b([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12})\b/g, "$1-$2-$3-$4-$5");

function reseal(bundle: Record<string, any>): string {
  const { bundle_hash: _drop, hashes: _h, stale_runs: _s, ...body } = bundle;
  const hashes = { snapshots: hashCanonical(body.snapshots), impact_runs: hashCanonical(body.impact_runs), contract_checks: hashCanonical(body.contract_checks) };
  const withHashes = { ...body, hashes };
  return JSON.stringify({ ...withHashes, bundle_hash: hashCanonical(withHashes) });
}

async function restored(): Promise<{ h: Harness; workspaceId: string; runs: { id: string; verdict: string }[] }> {
  const h = await createHarness();
  h.ctx.reportRenderer = htmlReportRenderer;
  const summary = await restoreBundle(h.ctx, ENGINE1);
  const parsed = JSON.parse(ENGINE1) as { impact_runs: { id: string; verdict: string; status: string }[] };
  const runs = parsed.impact_runs.filter((r) => summary.stale_runs.includes(r.id)).map((r) => ({ id: r.id, verdict: r.verdict }));
  return { h, workspaceId: summary.workspace_id, runs };
}

describe("R4 (impact.ts): a run from an older engine has no current assessment in any API response", () => {
  it("the run view, the list and the JSON export answer assessment null and keep the old verdict in recorded_assessment", async () => {
    const { h, workspaceId, runs } = await restored();
    try {
      const viewer = await h.userIn(workspaceId, "viewer");
      expect(runs.length).toBeGreaterThanOrEqual(2);
      expect(new Set(runs.map((r) => r.verdict))).toContain("NO_KNOWN_IMPACT");
      const list = await h.api(viewer, "GET", "/api/v1/impact-runs");
      for (const run of runs) {
        const view = await getRun(h, viewer, run.id);
        expect(view.assessment, `run view ${run.verdict}`).toBeNull();
        expect(view.recorded_assessment, "run view").toBe(run.verdict);
        expect(view.engine.rerun_required).toBe(true);
        const item = list.body.items.find((i: any) => i.id === run.id);
        expect(item.assessment, "list").toBeNull();
        expect(item.recorded_assessment, "list").toBe(run.verdict);
        expect(item.rerun_required).toBe(true);
        const json = await h.api(viewer, "GET", `/api/v1/impact-runs/${run.id}/export?format=json`);
        expect(json.status).toBe(200);
        expect(json.body.run.assessment, "json export").toBeNull();
        expect(json.body.run.recorded_assessment, "json export").toBe(run.verdict);
      }
      // No response of these routes holds the string as a CURRENT assessment.
      expect(JSON.stringify(list.body)).not.toMatch(/"assessment":"NO_KNOWN_IMPACT"/);
    } finally {
      await h.close();
    }
  }, 120_000);

  it("control: a run of the current engine keeps its verdict and has no recorded_assessment", async () => {
    const h = await createHarness();
    try {
      const w = await h.workspace("Current");
      const snap = await h.importSnapshot(w.operator, baselineDoc(), { revision: "release-1" });
      const run = await h.requestRun(w.operator, { snapshot_id: snap.body.id, proposed_manifest: removeAmountDoc(), expected_hash: snap.body.hash, run_checks: false });
      await h.drain();
      const view = await getRun(h, w.viewer, run.body.id);
      expect(view.assessment).toBe("AFFECTED");
      expect(view.recorded_assessment).toBeNull();
      const list = await h.api(w.viewer, "GET", "/api/v1/impact-runs");
      expect(list.body.items[0]).toMatchObject({ assessment: "AFFECTED", recorded_assessment: null, rerun_required: false });
      // A queued run is not stale either: it has no assessment yet, and no recorded one.
      const queued = await h.requestRun(w.operator, { snapshot_id: snap.body.id, proposed_manifest: removeAmountDoc(), expected_hash: snap.body.hash, run_checks: false, allow_superseded: true });
      const queuedView = await getRun(h, w.viewer, queued.body.id);
      expect(queuedView).toMatchObject({ assessment: null, recorded_assessment: null });
      expect(queuedView.engine.rerun_required).toBe(false);
    } finally {
      await h.close();
    }
  }, 120_000);

  it("a forged and resealed bundle that claims NO_KNOWN_IMPACT for an AFFECTED run without an engine stamp is served as stale, never as safe", async () => {
    const src = await createHarness();
    let text = "";
    let workspaceId = "";
    let runId = "";
    try {
      const w = await src.workspace("Forge");
      workspaceId = w.id;
      const snap = await src.importSnapshot(w.operator, baselineDoc(), { revision: "release-1" });
      const run = await src.requestRun(w.operator, { snapshot_id: snap.body.id, proposed_manifest: removeAmountDoc(), expected_hash: snap.body.hash, run_checks: false });
      runId = run.body.id;
      await src.drain();
      const forged = JSON.parse(serializeBundle((await buildBundle(src.db, { workspaceId }, src.now())) as EvidenceBundle)) as Record<string, any>;
      const r = forged.impact_runs[0];
      r.verdict = "NO_KNOWN_IMPACT";
      delete r.assessment_detail.engine_version;
      r.findings = [];
      // A CONSISTENT forgery (an inconsistent one is refused, see review-round4-evidence.test.ts): the summary counts no finding.
      Object.assign(r.assessment_detail.summary, { findings: 0, direct_findings: 0, transitive_findings: 0, known_impact: false });
      text = reseal(forged);
    } finally {
      await src.close();
    }
    const dst = await createHarness();
    dst.ctx.reportRenderer = htmlReportRenderer;
    try {
      await restoreBundle(dst.ctx, text);
      const viewer = await dst.userIn(workspaceId, "viewer");
      const view = await getRun(dst, viewer, runId);
      expect(view.assessment).toBeNull();
      expect(view.recorded_assessment).toBe("NO_KNOWN_IMPACT");
      expect(view.engine.rerun_required).toBe(true);
      const html = await dst.api(viewer, "GET", `/api/v1/impact-runs/${runId}/export?format=html`);
      expect(html.text).not.toContain('data-verdict="NO_KNOWN_IMPACT"');
      expect(html.text).toContain('data-verdict="STALE_ENGINE"');
      // Round 6: the examined counts and the changes list are qualified like the rest of a stale report.
      expect(html.text).toContain("As assessed by the older engine: Examined ");
      expect(html.text).toContain("Detected changes as recorded by the older engine (");
    } finally {
      await dst.close();
    }
  }, 120_000);
});

describe("R4 (api-responses.ts): the response contract of the three verdict-bearing routes, at the HTTP layer", () => {
  it("a stale run answers assessment null + recorded_assessment in the view, the list and the JSON export, every body valid against the shipped schema", async () => {
    const { h, workspaceId, runs } = await restored();
    try {
      const viewer = await h.userIn(workspaceId, "viewer");
      const list = RunListPage.parse((await h.api(viewer, "GET", "/api/v1/impact-runs")).body);
      for (const run of runs) {
        const view = ImpactRunView.parse((await h.api(viewer, "GET", `/api/v1/impact-runs/${run.id}`)).body);
        expect(view).toMatchObject({ assessment: null, recorded_assessment: run.verdict, engine: { rerun_required: true } });
        const item = list.items.find((i) => i.id === run.id);
        expect(item).toMatchObject({ assessment: null, recorded_assessment: run.verdict, rerun_required: true });
        const report = RunReport.parse((await h.api(viewer, "GET", `/api/v1/impact-runs/${run.id}/export?format=json`)).body);
        expect(report.run).toMatchObject({ assessment: null, recorded_assessment: run.verdict });
        // A finished run is never "pending": status complete with a null assessment means re-run required.
        expect(view.status).toBe("complete");
      }
    } finally {
      await h.close();
    }
  }, 120_000);

  it("current and unfinished runs answer recorded_assessment null in all three routes, every body valid against the shipped schema", async () => {
    const h = await createHarness();
    try {
      const w = await h.workspace("Contract");
      const snap = await h.importSnapshot(w.operator, baselineDoc(), { revision: "release-1" });
      const done = await h.requestRun(w.operator, { snapshot_id: snap.body.id, proposed_manifest: removeAmountDoc(), expected_hash: snap.body.hash, run_checks: false });
      await h.drain();
      const queued = await h.requestRun(w.operator, { snapshot_id: snap.body.id, proposed_manifest: removeAmountDoc(), expected_hash: snap.body.hash, run_checks: false, allow_superseded: true });
      const list = RunListPage.parse((await h.api(w.viewer, "GET", "/api/v1/impact-runs")).body);
      expect(list.items.length).toBe(2);
      for (const item of list.items) expect(item.recorded_assessment, item.status).toBeNull();
      expect(list.items.find((i) => i.id === done.body.id)).toMatchObject({ assessment: "AFFECTED", rerun_required: false });
      expect(list.items.find((i) => i.id === queued.body.id)).toMatchObject({ assessment: null, rerun_required: false });
      for (const id of [done.body.id, queued.body.id]) {
        const view = ImpactRunView.parse((await h.api(w.viewer, "GET", `/api/v1/impact-runs/${id}`)).body);
        expect(view.recorded_assessment, id).toBeNull();
      }
      const report = RunReport.parse((await h.api(w.viewer, "GET", `/api/v1/impact-runs/${done.body.id}/export?format=json`)).body);
      expect(report.run).toMatchObject({ assessment: "AFFECTED", recorded_assessment: null });
    } finally {
      await h.close();
    }
  }, 120_000);
});

describe("R4 (html-report.ts:206): the HTML export body of a run from an older engine makes no present-tense claim", () => {
  it("through the production renderer: every 'no declared consumer' statement and count is qualified as the older engine's", async () => {
    const { h, workspaceId, runs } = await restored();
    try {
      const viewer = await h.userIn(workspaceId, "viewer");
      const safe = runs.find((r) => r.verdict === "NO_KNOWN_IMPACT");
      expect(safe, "the fixture holds a stale NO_KNOWN_IMPACT run").toBeDefined();
      const html = await h.api(viewer, "GET", `/api/v1/impact-runs/${(safe as { id: string }).id}/export?format=html`);
      expect(html.status).toBe(200);
      expect(html.text).toContain('data-verdict="STALE_ENGINE"');
      expect(html.text).toContain("RE-RUN REQUIRED");
      expect(html.text).not.toContain('data-verdict="NO_KNOWN_IMPACT"');
      // Every sentence that says no consumer is affected is prefixed as the older engine's.
      const parts = html.text.split("No declared consumer is affected");
      for (const before of parts.slice(0, -1)) expect(before.endsWith("As assessed by the older engine: "), before.slice(-80)).toBe(true);
      // Counts and headings carry the qualifier; the unqualified present-tense forms are gone.
      expect(html.text).not.toMatch(/<h2 id="findings">Affected consumers \(\d+\)<\/h2>/);
      expect(html.text).toContain("Affected consumers as listed by the older engine (");
      expect(html.text).toMatch(/<dt>Findings \(older engine\)<\/dt>/);
      expect(html.text).not.toMatch(/<dt>Findings<\/dt>/);
      expect(html.text).toContain("as recorded by the older engine");
    } finally {
      await h.close();
    }
  }, 120_000);

  it("control: a current run's HTML body is unchanged (its counts and headings carry no qualifier)", async () => {
    const h = await createHarness();
    try {
      h.ctx.reportRenderer = htmlReportRenderer;
      const w = await h.workspace("CurrentHtml");
      const snap = await h.importSnapshot(w.operator, baselineDoc(), { revision: "release-1" });
      const run = await h.requestRun(w.operator, { snapshot_id: snap.body.id, proposed_manifest: removeAmountDoc(), expected_hash: snap.body.hash, run_checks: false });
      await h.drain();
      const html = await h.api(w.viewer, "GET", `/api/v1/impact-runs/${run.body.id}/export?format=html`);
      expect(html.text).toMatch(/<h2 id="findings">Affected consumers \(\d+\)<\/h2>/);
      expect(html.text).toMatch(/<dt>Findings<\/dt>/);
      expect(html.text).not.toContain("older engine");
    } finally {
      await h.close();
    }
  }, 120_000);
});
