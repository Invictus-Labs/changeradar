import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hashCanonical } from "../../src/domain/canonical.js";
import { defaultSettings } from "../../src/platform/context.js";
import { buildBundle, BundleError, serializeBundle, staleEngineRuns, verifyBundle, type EvidenceBundle } from "../../src/services/evidence.js";
import { restoreBundle } from "../../src/services/restore.js";
import { htmlReportRenderer } from "../../src/report/html-report.js";
import { e, f, manifest, n } from "../helpers/builders.js";
import { createHarness, getRun, PASSWORD } from "../helpers/harness.js";
import { baselineDoc, removeAmountDoc } from "../helpers/scenario.js";

/**
 * Review round 3 regression tests for evidence bundles, restore and the run views: the upgrade path (a database and a
 * bundle written by the previous engine), redaction of every non-hashed text of a bundle, re-creating a restored
 * check, restore text caps, and the field families of the bundle verification that were not yet pinned.
 */

const join = (...parts: string[]): string => parts.join("");
const TOKEN_CORE = "Zq8vK2mXp4Lw9RtY7nBcJd3fQ1aB2cD3eF4g";
const TOKEN = join("gh", "p_", TOKEN_CORE);
const here = dirname(fileURLToPath(import.meta.url));
/** A genuine bundle written by the 2cc918e build (engine before the version stamp); UUIDs are stored without dashes. */
const ENGINE1_BUNDLE = readFileSync(resolve(here, "../fixtures/upgrade/engine1-bundle.json"), "utf8").replace(
  /\b([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12})\b/g,
  "$1-$2-$3-$4-$5",
);

function reseal(bundle: Record<string, any>): string {
  const { bundle_hash: _drop, hashes: _h, stale_runs: _s, ...body } = bundle;
  const hashes = { snapshots: hashCanonical(body.snapshots), impact_runs: hashCanonical(body.impact_runs), contract_checks: hashCanonical(body.contract_checks) };
  const withHashes = { ...body, hashes };
  return JSON.stringify({ ...withHashes, bundle_hash: hashCanonical(withHashes) });
}
const parse = (text: string): Record<string, any> => JSON.parse(text) as Record<string, any>;
function rejection(text: string): string {
  try {
    verifyBundle(text, { maxBytes: 250 * 1024 * 1024 });
  } catch (error) {
    if (error instanceof BundleError) return error.code;
    throw error;
  }
  return "ACCEPTED";
}

describe("R3 P1 (evidence.ts:268): the upgrade path, a database and a bundle written by the previous engine", () => {
  it("the genuine 2cc918e bundle verifies, and its runs are reported as stale, not refused", () => {
    // An explicit expectation: a build that re-derived these runs would throw BundleError here, and that must fail as an assertion.
    expect(rejection(ENGINE1_BUNDLE)).toBe("ACCEPTED");
    const bundle = verifyBundle(ENGINE1_BUNDLE, { maxBytes: 10_000_000 });
    expect(bundle.impact_runs).toHaveLength(2);
    expect(bundle.impact_runs.every((r) => r.assessment_detail?.engine_version === undefined)).toBe(true);
    expect(staleEngineRuns(bundle).sort()).toEqual(bundle.impact_runs.map((r) => r.id).sort());
    // The wrong verdict the old engine gave for a typo in a declared field is exactly what is stored.
    expect(bundle.impact_runs.map((r) => r.verdict).sort()).toEqual(["AFFECTED", "NO_KNOWN_IMPACT"]);
  });

  it("restoring it works, the workspace export works afterwards, and nothing old looks safe", async () => {
    const dst = await createHarness();
    try {
      // Written so that a build that refuses the bundle fails by assertion (not by a thrown error).
      const restored = await restoreBundle(dst.ctx, ENGINE1_BUNDLE).catch((error: unknown) => error);
      expect(restored instanceof Error ? `${(restored as Error).name}: ${restored.message}` : "restored").toBe("restored");
      const summary = restored as Awaited<ReturnType<typeof restoreBundle>>;
      expect(summary.stale_runs).toHaveLength(2);
      // The documented upgrade step: a fresh export of the upgraded workspace.
      const again = await buildBundle(dst.db, { workspaceId: summary.workspace_id }, dst.now());
      expect(again).not.toBeNull();
      const text = serializeBundle(again as EvidenceBundle);
      expect(staleEngineRuns(verifyBundle(text, { maxBytes: 10_000_000 })).sort()).toEqual(summary.stale_runs.slice().sort());
      // The same through the API, one stale run at a time, and the whole workspace next to a NEW run.
      const admin = await dst.userIn(summary.workspace_id, "admin");
      const viewer = await dst.userIn(summary.workspace_id, "viewer");
      const list = await dst.api(viewer, "GET", "/api/v1/impact-runs");
      expect(list.body.items.every((r: any) => r.rerun_required === true)).toBe(true);
      // Round 4: a stale run's `assessment` is null; the old (wrong) verdict is in `recorded_assessment`.
      const wrongSafe = list.body.items.find((r: any) => r.recorded_assessment === "NO_KNOWN_IMPACT" && r.assessment === null);
      const bundleOfStale = await dst.api(admin, "GET", `/api/v1/impact-runs/${wrongSafe.id}/bundle`);
      expect(bundleOfStale.status, bundleOfStale.text).toBe(200);
      const view = await getRun(dst, viewer, wrongSafe.id);
      expect(view.engine).toMatchObject({ version: 1, rerun_required: true });
      // Production HTML renderer: no verdict block that looks safe.
      dst.ctx.reportRenderer = htmlReportRenderer;
      const html = await dst.api(viewer, "GET", `/api/v1/impact-runs/${wrongSafe.id}/export?format=html`);
      expect(html.status).toBe(200);
      expect(html.text).toContain("older decision engine");
      expect(html.text).not.toContain('data-verdict="NO_KNOWN_IMPACT"');
      // A new run in the same workspace: workspace and run exports still work with stale and current runs together.
      const baseline = (await dst.api(viewer, "GET", "/api/v1/baseline")).body.snapshot;
      const operator = await dst.userIn(summary.workspace_id, "operator");
      const fresh = await dst.requestRun(operator, { snapshot_id: baseline.id, proposed_manifest: removeAmountDoc(), expected_hash: baseline.hash, run_checks: false, allow_superseded: true });
      expect(fresh.status, fresh.text).toBe(202);
      await dst.drain();
      const mixed = await buildBundle(dst.db, { workspaceId: summary.workspace_id }, dst.now());
      expect(staleEngineRuns(verifyBundle(serializeBundle(mixed as EvidenceBundle), { maxBytes: 10_000_000 }))).toHaveLength(2);
    } finally {
      await dst.close();
    }
  }, 120_000);

  it("a bundle from a NEWER engine is refused with its own code; a corrupt run is a 409 with a code, never a 500", async () => {
    const newer = parse(ENGINE1_BUNDLE);
    newer.impact_runs[0].assessment_detail.engine_version = 99;
    expect(rejection(reseal(newer))).toBe("BUNDLE_ENGINE_VERSION");
    const h = await createHarness();
    try {
      const w = await h.workspace("Corrupt");
      const snap = await h.importSnapshot(w.operator, baselineDoc(), { revision: "release-1" });
      const run = await h.requestRun(w.operator, { snapshot_id: snap.body.id, proposed_manifest: removeAmountDoc(), expected_hash: snap.body.hash, run_checks: false });
      await h.drain();
      await h.db.query("ALTER TABLE impact_runs DISABLE TRIGGER impact_runs_protect");
      try {
        await h.db.query("UPDATE impact_runs SET verdict = 'NO_KNOWN_IMPACT' WHERE id = $1", [run.body.id]);
      } finally {
        await h.db.query("ALTER TABLE impact_runs ENABLE TRIGGER impact_runs_protect");
      }
      const res = await h.api(w.operator, "GET", `/api/v1/impact-runs/${run.body.id}/bundle`);
      expect(res.status, res.text).toBe(409);
      expect(res.body.error.code).toBe("BUNDLE_RUN_INCONSISTENT");
    } finally {
      await h.close();
    }
  });

  it("KNOWN LIMIT (documented): a stale run is protected by the hashes only; an edited stale finding that is resealed verifies", () => {
    const copy = parse(ENGINE1_BUNDLE);
    const affected = copy.impact_runs.find((r: any) => r.findings.length > 0);
    affected.findings[0].reason = "edited reason";
    expect(rejection(reseal(copy))).toBe("ACCEPTED");
  });
});

describe("R3 P1 (evidence.ts:264): every non-hashed text of a bundle is redacted, and check definitions are scanned at creation", () => {
  it("POST /contract-checks with a secret-shaped required field name is refused (422 SECRET_VALUE_REJECTED, never echoed)", async () => {
    const h = await createHarness({ settings: { checks: { ...defaultSettings.checks, allowedHosts: ["localhost:9"] } } });
    try {
      const w = await h.workspace("Scan");
      const res = await h.api(w.admin, "POST", "/api/v1/contract-checks", { key: "chk.scan", node_id: "contract.invoice", url: "http://localhost:9/ok", retries: 0, required_fields: [{ name: TOKEN, type: "string" }] });
      expect(res.status, res.text).toBe(422);
      expect(res.text).toContain("SECRET_VALUE_REJECTED");
      expect(res.text).not.toContain(TOKEN_CORE);
    } finally {
      await h.close();
    }
  });

  it("a legacy row and a crafted bundle: workspace bundle, run bundle, GET /contract-checks, login and session show no token", async () => {
    const src = await createHarness({ settings: { checks: { ...defaultSettings.checks, allowedHosts: ["localhost:9"] } } });
    let text = "";
    let workspaceId = "";
    let runId = "";
    try {
      const w = await src.workspace("Ops");
      workspaceId = w.id;
      await src.api(w.admin, "POST", "/api/v1/contract-checks", { key: "chk.legacy", node_id: "contract.invoice", url: "http://localhost:9/ok", retries: 0, required_fields: [{ name: "invoice_id", type: "string" }] });
      const snap = await src.importSnapshot(w.operator, baselineDoc(), { revision: "release-1" });
      const run = await src.requestRun(w.operator, { snapshot_id: snap.body.id, proposed_manifest: removeAmountDoc(), expected_hash: snap.body.hash, run_checks: false });
      runId = run.body.id;
      await src.drain();
      // A row written before the creation scan existed carries a secret-shaped field name.
      await src.db.query("UPDATE contract_checks SET required_fields = $1::jsonb WHERE workspace_id = $2", [JSON.stringify([{ name: TOKEN, type: "string" }]), workspaceId]);
      const viaApi = await src.api(w.admin, "GET", "/api/v1/contract-checks");
      expect(viaApi.text, "GET /contract-checks").not.toContain(TOKEN_CORE);
      const workspaceBundle = await buildBundle(src.db, { workspaceId }, src.now());
      expect(serializeBundle(workspaceBundle as EvidenceBundle), "workspace bundle").not.toContain(TOKEN_CORE);
      const runBundle = await src.api(w.operator, "GET", `/api/v1/impact-runs/${runId}/bundle`);
      expect(runBundle.status).toBe(200);
      expect(runBundle.text, "run bundle").not.toContain(TOKEN_CORE);
      // Craft a verifying bundle whose non-derived text carries tokens everywhere it can.
      const crafted = parse(serializeBundle(workspaceBundle as EvidenceBundle));
      crafted.workspace.name = `team ${TOKEN}`;
      crafted.snapshots[0].revision = `rev ${TOKEN}`;
      crafted.snapshots[0].warnings = [{ code: "CYCLE_DETECTED", message: `note ${TOKEN}` }];
      crafted.impact_runs[0].events[0].note = `note ${TOKEN}`;
      crafted.impact_runs[0].error_code = `code ${TOKEN}`;
      crafted.impact_runs[0].error_detail = `detail ${TOKEN}`;
      crafted.contract_checks[0].required_fields = [{ name: TOKEN, type: "string" }];
      text = reseal(crafted);
      verifyBundle(text, { maxBytes: 10_000_000 });
    } finally {
      await src.close();
    }
    const dst = await createHarness();
    try {
      await restoreBundle(dst.ctx, text);
      const admin = await dst.userIn(workspaceId, "admin");
      const login = await dst.api(null, "POST", "/api/v1/auth/login", { email: admin.email, password: PASSWORD, workspace_id: workspaceId });
      expect(login.status, login.text).toBe(200);
      expect(login.text, "login").not.toContain(TOKEN_CORE);
      expect((await dst.api(admin, "GET", "/api/v1/auth/session")).text, "session").not.toContain(TOKEN_CORE);
      expect((await dst.api(admin, "GET", "/api/v1/contract-checks")).text, "GET /contract-checks after restore").not.toContain(TOKEN_CORE);
      const again = await buildBundle(dst.db, { workspaceId }, dst.now());
      expect(serializeBundle(again as EvidenceBundle), "re-exported bundle").not.toContain(TOKEN_CORE);
      const runBundle = await dst.api(admin, "GET", `/api/v1/impact-runs/${runId}/bundle`);
      expect(runBundle.text, "run bundle after restore").not.toContain(TOKEN_CORE);
    } finally {
      await dst.close();
    }
  }, 120_000);
});

describe("R3 cross-check (b): names that glue a credential word to a token survive export, verify, restore and export again unchanged", () => {
  it("legacy names carrying a token are redacted once and stay exactly that through a round trip", async () => {
    const glued = [`token${TOKEN}`, `pass<${TOKEN}>`, `x-auth-${TOKEN}`];
    const src = await createHarness({ settings: { checks: { ...defaultSettings.checks, allowedHosts: ["localhost:9"] } } });
    let first = "";
    let workspaceId = "";
    try {
      const w = await src.workspace("Ops");
      workspaceId = w.id;
      await src.api(w.admin, "POST", "/api/v1/contract-checks", { key: "chk.glued", node_id: "contract.invoice", url: "http://localhost:9/ok", retries: 0, required_fields: [{ name: "invoice_id", type: "string" }] });
      const snap = await src.importSnapshot(w.operator, baselineDoc(), { revision: "release-1" });
      await src.requestRun(w.operator, { snapshot_id: snap.body.id, proposed_manifest: removeAmountDoc(), expected_hash: snap.body.hash, run_checks: false });
      await src.drain();
      // Rows written before the creation scan existed: a workspace name and required field names with a token glued to a word.
      await src.db.query("UPDATE workspaces SET name = $1 WHERE id = $2", [`team ${glued[0]}=Zx9Kq2Lm7Pw4Rt8Yv3Bn6Cd1Fg5Hj0`, workspaceId]);
      await src.db.query("UPDATE contract_checks SET required_fields = $1::jsonb WHERE workspace_id = $2", [JSON.stringify(glued.map((name) => ({ name, type: "string" }))), workspaceId]);
      first = serializeBundle((await buildBundle(src.db, { workspaceId }, src.now())) as EvidenceBundle);
    } finally {
      await src.close();
    }
    expect(first).not.toContain(TOKEN_CORE);
    expect(first).not.toContain("Zx9Kq2Lm7Pw4Rt8Yv3Bn6Cd1Fg5Hj0");
    const dst = await createHarness();
    try {
      verifyBundle(first, { maxBytes: 10_000_000 });
      await restoreBundle(dst.ctx, first);
      const second = serializeBundle((await buildBundle(dst.db, { workspaceId }, dst.now())) as EvidenceBundle);
      expect(second).not.toContain(TOKEN_CORE);
      const a = parse(first);
      const b = parse(second);
      expect(b.workspace.name).toBe(a.workspace.name);
      expect(b.contract_checks[0].required_fields).toEqual(a.contract_checks[0].required_fields);
    } finally {
      await dst.close();
    }
  }, 120_000);
});

describe("R3 P1 (checks.ts:132): a restored (disabled) check can be re-created and re-enabled through the vetted path", () => {
  it("POST /contract-checks with the same key replaces the disabled row; an enabled key is still 409; an unvetted url is refused and changes nothing", async () => {
    const src = await createHarness({ settings: { checks: { ...defaultSettings.checks, allowedHosts: ["localhost:9"] } } });
    let bundleText = "";
    let workspaceId = "";
    try {
      const w = await src.workspace("Reenable");
      workspaceId = w.id;
      const created = await src.api(w.admin, "POST", "/api/v1/contract-checks", { key: "chk.one", node_id: "contract.invoice", url: "http://localhost:9/ok", retries: 0, required_fields: [{ name: "invoice_id", type: "string" }] });
      expect(created.status, created.text).toBe(201);
      const snap = await src.importSnapshot(w.operator, baselineDoc(), { revision: "release-1" });
      await src.requestRun(w.operator, { snapshot_id: snap.body.id, proposed_manifest: removeAmountDoc(), expected_hash: snap.body.hash, run_checks: false });
      await src.drain();
      bundleText = serializeBundle((await buildBundle(src.db, { workspaceId }, src.now())) as EvidenceBundle);
    } finally {
      await src.close();
    }
    const dst = await createHarness({ settings: { checks: { ...defaultSettings.checks, allowedHosts: ["localhost:9"] } } });
    try {
      await restoreBundle(dst.ctx, bundleText);
      const admin = await dst.userIn(workspaceId, "admin");
      const listed = await dst.api(admin, "GET", "/api/v1/contract-checks");
      expect(listed.body.items.map((c: any) => [c.key, c.enabled])).toEqual([["chk.one", false]]);
      const body = { key: "chk.one", node_id: "contract.invoice", url: "http://localhost:9/renewed", retries: 1, required_fields: [{ name: "invoice_id", type: "string" }] };
      const refused = await dst.api(admin, "POST", "/api/v1/contract-checks", { ...body, url: "http://not-allowed.example.test/x" });
      expect(refused.status).toBe(422);
      expect((await dst.api(admin, "GET", "/api/v1/contract-checks")).body.items[0]).toMatchObject({ enabled: false, url: "http://localhost:9/ok" });
      const again = await dst.api(admin, "POST", "/api/v1/contract-checks", body);
      expect(again.status, again.text).toBe(201);
      expect(again.body).toMatchObject({ key: "chk.one", enabled: true, url: "http://localhost:9/renewed", retries: 1 });
      const after = await dst.api(admin, "GET", "/api/v1/contract-checks");
      expect(after.body.items).toHaveLength(1);
      expect(after.body.items[0].enabled).toBe(true);
      const conflict = await dst.api(admin, "POST", "/api/v1/contract-checks", body);
      expect(conflict.status).toBe(409);
      expect(conflict.body.error.code).toBe("CHECK_EXISTS");
      const audit = await dst.api(admin, "GET", "/api/v1/audit?limit=50");
      expect(audit.body.items.map((a: any) => a.action)).toContain("contract_check.reenabled");
    } finally {
      await dst.close();
    }
  }, 120_000);
});

describe("R3 P2 (evidence.ts:306 tests): restore caps every free text field it stores, one assertion per field", () => {
  it("workspace name, snapshot revision, snapshot warning text, run error_detail, event note and error_code are cut to 2000 characters", async () => {
    const src = await createHarness();
    let text = "";
    let workspaceId = "";
    try {
      const w = await src.workspace("Caps");
      workspaceId = w.id;
      const snap = await src.importSnapshot(w.operator, baselineDoc(), { revision: "release-1" });
      await src.requestRun(w.operator, { snapshot_id: snap.body.id, proposed_manifest: removeAmountDoc(), expected_hash: snap.body.hash, run_checks: false });
      await src.drain();
      const crafted = parse(serializeBundle((await buildBundle(src.db, { workspaceId }, src.now())) as EvidenceBundle));
      const long = "n".repeat(5000);
      crafted.workspace.name = long;
      crafted.snapshots[0].revision = long;
      crafted.impact_runs[0].error_detail = long;
      crafted.impact_runs[0].error_code = long;
      crafted.impact_runs[0].events[0].note = long;
      crafted.snapshots[0].warnings = [{ code: "CRAFTED", detail: long }];
      text = reseal(crafted);
    } finally {
      await src.close();
    }
    const dst = await createHarness();
    try {
      await restoreBundle(dst.ctx, text);
      const one = async (sql: string): Promise<string> => ((await dst.db.query<{ v: string }>(sql)).rows[0] as { v: string }).v;
      expect((await one("SELECT name AS v FROM workspaces")).length, "workspace name").toBe(2000);
      expect((await one("SELECT revision AS v FROM snapshots")).length, "snapshot revision").toBe(2000);
      expect((await one("SELECT error_detail AS v FROM impact_runs")).length, "error_detail").toBe(2000);
      expect((await one("SELECT error_code AS v FROM impact_runs")).length, "error_code").toBe(2000);
      expect((await one("SELECT note AS v FROM run_events WHERE note IS NOT NULL ORDER BY id LIMIT 1")).length, "event note").toBe(2000);
      expect((await one("SELECT warnings->0->>'detail' AS v FROM snapshots")).length, "snapshot warning text").toBe(2000);
    } finally {
      await dst.close();
    }
  }, 120_000);
});

describe("R3 P1 (review-round2-evidence.test.ts:163): the field families of the bundle verification that were not pinned", () => {
  /** A chain deep enough to omit path hops, and a contract with enough removed fields to omit change ids. */
  function longWorld(dropFields: boolean): Record<string, unknown> {
    const fields = Array.from({ length: 25 }, (_, i) => f(`field_${String(i).padStart(2, "0")}`));
    const nodes: Record<string, unknown>[] = [n("contract.big", "contract", { owner: "team-a", fields: dropFields ? [f("keep")] : [...fields, f("keep")] })];
    const edges: Record<string, unknown>[] = [];
    for (let i = 0; i < 30; i += 1) {
      const id = `svc.hop-${String(i).padStart(2, "0")}`;
      nodes.push(n(id, "service", { owner: "team-a" }));
      edges.push(e(id, i === 0 ? "contract.big" : `svc.hop-${String(i - 1).padStart(2, "0")}`, "consumes"));
    }
    // A consumer with no owner is an examined node without an owner: a MISSING_OWNER unknown whose text a forger could edit.
    nodes.push(n("svc.unowned", "service", { owner: null }));
    edges.push(e("svc.unowned", "contract.big", "consumes"));
    return manifest(nodes, edges);
  }

  it("path_omitted_hops, change_ids_omitted, position, coverage, changes and unknown text: each edit of a resealed bundle is rejected", async () => {
    const h = await createHarness();
    try {
      const w = await h.workspace("Families");
      const snap = await h.importSnapshot(w.operator, longWorld(false), { revision: "release-1" });
      expect(snap.status, snap.text).toBe(201);
      const run = await h.requestRun(w.operator, { snapshot_id: snap.body.id, proposed_manifest: longWorld(true), expected_hash: snap.body.hash, run_checks: false });
      expect(run.status, run.text).toBe(202);
      await h.drain();
      const text = serializeBundle((await buildBundle(h.db, { workspaceId: w.id }, h.now())) as EvidenceBundle);
      const base = parse(text);
      const findings = base.impact_runs[0].findings;
      expect(findings.some((x: any) => x.path_omitted_hops > 0), "the scenario must omit hops").toBe(true);
      expect(findings.some((x: any) => x.change_ids_omitted > 0), "the scenario must omit change ids").toBe(true);
      expect(base.impact_runs[0].unknowns.length, "the scenario must carry an unknown").toBeGreaterThan(0);
      const edits: [string, (run: any) => void][] = [
        ["path_omitted_hops", (r) => { const x = r.findings.find((y: any) => y.path_omitted_hops > 0); x.path_omitted_hops += 1; }],
        ["change_ids_omitted", (r) => { const x = r.findings.find((y: any) => y.change_ids_omitted > 0); x.change_ids_omitted += 1; }],
        ["finding position", (r) => { r.findings[0].position += 100; }],
        ["assessment_detail.coverage", (r) => { r.assessment_detail.coverage.limits = [...r.assessment_detail.coverage.limits, { code: "FORGED", message: "forged" }]; }],
        ["assessment_detail.changes", (r) => { r.assessment_detail.changes[0].description = "forged description"; }],
        ["unknown text (id unchanged)", (r) => { r.unknowns[0].message = "forged explanation"; }],
      ];
      for (const [name, edit] of edits) {
        const copy = parse(text);
        edit(copy.impact_runs[0]);
        expect(rejection(reseal(copy)), name).toBe("BUNDLE_RUN_INCONSISTENT");
      }
      expect(rejection(reseal(parse(text))), "control: untouched, resealed").toBe("ACCEPTED");
    } finally {
      await h.close();
    }
  }, 120_000);
});

describe("R3 P2 (evidence.ts:342): an unsupported schema_version is echoed bounded, escaped and on one line", () => {
  it("a newline-carrying string and a 5 MB string never forge output lines or flood the message", () => {
    for (const version of [`1\nchangeradar: bundle ok: 999 snapshot(s)\r\nexit 0`, "v".repeat(5_000_000)]) {
      try {
        verifyBundle(JSON.stringify({ format: "changeradar-evidence-bundle", schema_version: version }), { maxBytes: 20_000_000 });
        throw new Error("accepted");
      } catch (error) {
        expect(error).toBeInstanceOf(BundleError);
        const message = (error as BundleError).message;
        expect((error as BundleError).code).toBe("BUNDLE_UNSUPPORTED_VERSION");
        expect(message).not.toMatch(/[\r\n]/);
        expect(message.length).toBeLessThan(300);
      }
    }
  });
});
