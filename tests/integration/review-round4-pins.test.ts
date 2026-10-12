import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runCli, type Io } from "../../src/commands/run.js";
import { hashCanonical } from "../../src/domain/canonical.js";
import { defaultSettings } from "../../src/platform/context.js";
import { buildBundle, BundleError, serializeBundle, staleEngineRuns, verifyBundle, type EvidenceBundle } from "../../src/services/evidence.js";
import { restoreBundle } from "../../src/services/restore.js";
import { createHarness, getRun, type Harness } from "../helpers/harness.js";
import { baselineDoc, removeAmountDoc } from "../helpers/scenario.js";

/**
 * Review round 4 (tests P2): sites and boundaries that a mutation left standing. Bundle text is redacted at every site, a
 * re-enabled check is fully re-enabled and its alias and every field name scanned, the run-list marker respects the run's
 * status and any older stamp, the engine boundary is exact, a duplicate check key is refused, the restore message is printed
 * when a check is restored, and no more than two exports are built at the same moment.
 * Fake secrets are assembled at run time.
 */

const join2 = (...parts: string[]): string => parts.join("");
const CORE = "Zq8vK2mXp4Lw9RtY7nBcJd3fQ1aB2cD3eF4g";
const TOKEN = join2("gh", "p_", CORE);
const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function reseal(bundle: Record<string, any>): string {
  const { bundle_hash: _drop, hashes: _h, stale_runs: _s, ...body } = bundle;
  const hashes = { snapshots: hashCanonical(body.snapshots), impact_runs: hashCanonical(body.impact_runs), contract_checks: hashCanonical(body.contract_checks) };
  const withHashes = { ...body, hashes };
  return JSON.stringify({ ...withHashes, bundle_hash: hashCanonical(withHashes) });
}
const outcome = (text: string): string => {
  try {
    verifyBundle(text, { maxBytes: 250 * 1024 * 1024 });
  } catch (error) {
    if (error instanceof BundleError) return error.code;
    throw error;
  }
  return "ACCEPTED";
};
const withChecks = () => createHarness({ settings: { checks: { ...defaultSettings.checks, allowedHosts: ["localhost:9"] } } });
async function seeded(h: Harness) {
  const w = await h.workspace("Pins");
  await h.api(w.admin, "POST", "/api/v1/contract-checks", { key: "chk.pin", node_id: "contract.invoice", url: "http://localhost:9/ok", retries: 0, required_fields: [{ name: "invoice_id", type: "string" }] });
  const snap = await h.importSnapshot(w.operator, baselineDoc(), { revision: "release-1" });
  const run = await h.requestRun(w.operator, { snapshot_id: snap.body.id, proposed_manifest: removeAmountDoc(), expected_hash: snap.body.hash, run_checks: false });
  await h.drain();
  return { w, snap, runId: run.body.id as string };
}

describe("R4 P2 (evidence.ts redactBundleText): every run text site of a bundle is redacted at export", () => {
  it("assessment detail, unknowns, check keys and the node and key of a run's check carry no token in the next export", async () => {
    const src = await withChecks();
    let text = "";
    let workspaceId = "";
    try {
      const { w } = await seeded(src);
      workspaceId = w.id;
      const crafted = JSON.parse(serializeBundle((await buildBundle(src.db, { workspaceId }, src.now())) as EvidenceBundle)) as Record<string, any>;
      const run = crafted.impact_runs[0];
      delete run.assessment_detail.engine_version; // an older stamp: hashed only, so text can be planted
      run.assessment_detail.note = `detail ${TOKEN}`;
      run.unknowns = [...run.unknowns, { id: "u-token", code: "STALE_CONTRACT", message: `unknown ${TOKEN}`, node_id: "svc.a" }];
      run.check_keys = [`key ${TOKEN}`];
      run.checks = [{ check_key: `check ${TOKEN}`, node_id: `node ${TOKEN}`, state: "PASSED", definition: { note: "d" }, result: { note: "r" }, started_at: run.created_at, finished_at: run.created_at }];
      text = reseal(crafted);
    } finally {
      await src.close();
    }
    const dst = await createHarness();
    try {
      await restoreBundle(dst.ctx, text);
      const exported = serializeBundle((await buildBundle(dst.db, { workspaceId }, dst.now())) as EvidenceBundle);
      expect(exported).not.toContain(CORE);
      const parsed = JSON.parse(exported) as { impact_runs: { assessment_detail: { note: string }; unknowns: { message: string }[]; check_keys: string[]; checks: { check_key: string; node_id: string }[] }[] };
      const run = parsed.impact_runs[0]!;
      expect(run.assessment_detail.note, "assessment detail").toContain("[REDACTED]");
      expect(run.unknowns.some((u) => u.message.includes("[REDACTED]")), "unknowns").toBe(true);
      expect(run.check_keys[0], "check_keys").toContain("[REDACTED]");
      expect(run.checks[0]!.check_key, "run check key").toContain("[REDACTED]");
      expect(run.checks[0]!.node_id, "run check node").toContain("[REDACTED]");
    } finally {
      await dst.close();
    }
  }, 120_000);
});

describe("R4 P2 (checks.ts): re-creating a disabled check re-enables it completely and scans everything it takes", () => {
  it("disabled_at is cleared, a token-shaped alias and a secret in the second or third field name are refused", async () => {
    const h = await withChecks();
    try {
      const { w } = await seeded(h);
      const list = await h.api(w.admin, "GET", "/api/v1/contract-checks");
      const id = list.body.items[0].id as string;
      expect((await h.api(w.admin, "POST", `/api/v1/contract-checks/${id}/disable`, {})).status).toBe(200);
      const disabled = (await h.api(w.admin, "GET", "/api/v1/contract-checks")).body.items[0];
      expect(disabled.enabled).toBe(false);
      expect(disabled.disabled_at).not.toBeNull();
      const body = { key: "chk.pin", node_id: "contract.invoice", url: "http://localhost:9/ok", retries: 0, required_fields: [{ name: "invoice_id", type: "string" }] };
      for (const bad of [
        { ...body, credential_alias: TOKEN },
        { ...body, required_fields: [{ name: "a", type: "string" }, { name: TOKEN, type: "string" }] },
        { ...body, required_fields: [{ name: "a", type: "string" }, { name: "b", type: "string" }, { name: TOKEN, type: "string" }] },
      ]) {
        const refused = await h.api(w.admin, "POST", "/api/v1/contract-checks", bad);
        expect(refused.status, refused.text).toBe(422);
        expect(refused.text).not.toContain(CORE);
      }
      expect((await h.api(w.admin, "GET", "/api/v1/contract-checks")).body.items[0].enabled, "still disabled after every refusal").toBe(false);
      const ok = await h.api(w.admin, "POST", "/api/v1/contract-checks", body);
      expect(ok.status, ok.text).toBe(201);
      const again = (await h.api(w.admin, "GET", "/api/v1/contract-checks")).body.items[0];
      expect(again).toMatchObject({ id, enabled: true, disabled_at: null });
    } finally {
      await h.close();
    }
  }, 120_000);
});

describe("R4 P2 (impact.ts): the run-list marker follows the status and any older stamp", () => {
  it("a run stamped 2 is stale in the list and the view; a run that is not finished, and a failed run, are not marked", async () => {
    const h = await createHarness();
    try {
      const w = await h.workspace("Marker");
      const snap = await h.importSnapshot(w.operator, baselineDoc(), { revision: "release-1" });
      const done = await h.requestRun(w.operator, { snapshot_id: snap.body.id, proposed_manifest: removeAmountDoc(), expected_hash: snap.body.hash, run_checks: false });
      await h.drain();
      const failed = await h.requestRun(w.operator, { snapshot_id: snap.body.id, proposed_manifest: removeAmountDoc(), expected_hash: snap.body.hash, run_checks: false, allow_superseded: true });
      await h.drain();
      // Unfinished and failed runs have no assessment, so an engine stamp is absent (read as version 1): only FINISHED runs may be marked.
      const queued = await h.requestRun(w.operator, { snapshot_id: snap.body.id, proposed_manifest: removeAmountDoc(), expected_hash: snap.body.hash, run_checks: false, allow_superseded: true });
      await h.db.query("ALTER TABLE impact_runs DISABLE TRIGGER impact_runs_protect");
      try {
        await h.db.query("UPDATE impact_runs SET assessment = jsonb_set(assessment, '{engine_version}', '2'::jsonb) WHERE id = $1", [done.body.id]);
        await h.db.query("UPDATE impact_runs SET status = 'FAILED', verdict = NULL, assessment = NULL, error_code = 'TOO_MANY_CHECKS', error_detail = 'x', finished_at = created_at WHERE id = $1", [failed.body.id]);
      } finally {
        await h.db.query("ALTER TABLE impact_runs ENABLE TRIGGER impact_runs_protect");
      }
      const list = await h.api(w.viewer, "GET", "/api/v1/impact-runs");
      const flag = Object.fromEntries(list.body.items.map((r: any) => [r.id, r.rerun_required]));
      expect(flag[done.body.id], "stamped 2").toBe(true);
      expect(flag[failed.body.id], "failed").toBe(false);
      expect(flag[queued.body.id], "queued").toBe(false);
      const view = await getRun(h, w.viewer, done.body.id);
      expect(view.engine).toMatchObject({ version: 2, rerun_required: true });
      expect(view.assessment).toBeNull();
    } finally {
      await h.close();
    }
  }, 120_000);
});

describe("R4 P3 (evidence.ts): the engine boundary, duplicate check keys and the stale count", () => {
  it("engine 3 is current, 4 is refused with BUNDLE_ENGINE_VERSION, a duplicate contract check key is refused, and only COMPLETE runs are counted stale", async () => {
    const h = await withChecks();
    try {
      const { w } = await seeded(h);
      const text = serializeBundle((await buildBundle(h.db, { workspaceId: w.id }, h.now())) as EvidenceBundle);
      const fresh = (): Record<string, any> => JSON.parse(text) as Record<string, any>;
      expect(outcome(text)).toBe("ACCEPTED");
      const four = fresh();
      four.impact_runs[0].assessment_detail.engine_version = 4;
      expect(outcome(reseal(four))).toBe("BUNDLE_ENGINE_VERSION");
      const dup = fresh();
      dup.contract_checks.push({ ...dup.contract_checks[0] });
      expect(outcome(reseal(dup))).toBe("BUNDLE_SCHEMA_INVALID");
      const failedRun = fresh();
      const r = failedRun.impact_runs[0];
      r.status = "FAILED";
      r.verdict = null;
      r.findings = [];
      r.assessment_detail = null;
      r.unknowns = [];
      r.error_code = "RUN_FAILED";
      r.error_detail = "x";
      const bundle = verifyBundle(reseal(failedRun), { maxBytes: 250 * 1024 * 1024 });
      expect(staleEngineRuns(bundle), "a failed run has no assessment to be stale").toEqual([]);
    } finally {
      await h.close();
    }
  }, 120_000);
});

describe("R4 P2 (run.ts:405): restoring a bundle that holds a check prints how to re-arm it", () => {
  it("the restore message names DISABLED and re-creating with the SAME key", async () => {
    const src = await withChecks();
    let text = "";
    try {
      const { w } = await seeded(src);
      text = serializeBundle((await buildBundle(src.db, { workspaceId: w.id }, src.now())) as EvidenceBundle);
    } finally {
      await src.close();
    }
    const dir = mkdtempSync(join(tmpdir(), "changeradar-r4pins-"));
    scratch.push(dir);
    const file = join(dir, "bundle.json");
    writeFileSync(file, text);
    const out: string[] = [];
    const err: string[] = [];
    const io: Io = { out: (m) => out.push(m), err: (m) => err.push(m), stdin: async () => "" };
    const code = await runCli(["restore", "--in", file], { CHANGERADAR_DATABASE_URL: `pglite:${join(dir, "db")}`, CHANGERADAR_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64") }, io);
    expect(code, err.join("\n")).toBe(0);
    const said = out.join("\n");
    expect(said).toContain("restored DISABLED");
    expect(said).toContain("with the SAME key");
    expect(said).toContain("1 contract check(s)");
  }, 120_000);
});

describe("R4 P2 (server.ts heavyExport): exactly two exports are built at the same moment", () => {
  it("with two built and held, the third to sixth request are refused with 429; released, the two finish with 200", async () => {
    const h = await createHarness();
    try {
      const { w, runId } = await (async () => {
        const wk = await h.workspace("Burst");
        const snap = await h.importSnapshot(wk.operator, baselineDoc(), { revision: "release-1" });
        const run = await h.requestRun(wk.operator, { snapshot_id: snap.body.id, proposed_manifest: removeAmountDoc(), expected_hash: snap.body.hash, run_checks: false });
        await h.drain();
        return { w: wk, runId: run.body.id as string };
      })();
      const users = [w.admin, w.operator, w.viewer, await h.userIn(w.id, "viewer"), await h.userIn(w.id, "operator"), await h.userIn(w.id, "admin")];
      // Hold every export at its first read of the findings, so that "being built" is a state the test controls.
      const db = h.ctx.db as unknown as { query: (sql: string, params?: unknown[]) => Promise<unknown> };
      const original = db.query.bind(db);
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => (release = resolve));
      let held = 0;
      db.query = async (sql: string, params?: unknown[]) => {
        if (/FROM findings/.test(sql) && /ORDER BY position/.test(sql) && !/LIMIT 100/.test(sql)) {
          held += 1;
          await gate;
        }
        return original(sql, params);
      };
      try {
        const pending = users.map((user) => h.api(user, "GET", `/api/v1/impact-runs/${runId}/export?format=json`));
        const deadline = Date.now() + 5000;
        while (held < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
        await new Promise((r) => setTimeout(r, 150));
        expect(held, "exactly two exports reached the build").toBe(2);
        release();
        const statuses = (await Promise.all(pending)).map((r) => r.status).sort();
        expect(statuses).toEqual([200, 200, 429, 429, 429, 429]);
      } finally {
        db.query = original;
        release();
      }
    } finally {
      await h.close();
    }
  }, 120_000);
});
