import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { runCli, type Io } from "../../src/commands/run.js";
import { htmlReportRenderer } from "../../src/report/html-report.js";
import { BundleError, buildBundle, serializeBundle, staleEngineRuns, verifyBundle, type EvidenceBundle } from "../../src/services/evidence.js";
import { restoreBundle } from "../../src/services/restore.js";
import { createHarness } from "../helpers/harness.js";
import { UUID_UNKNOWN } from "../helpers/ids.js";
import { baselineDoc, removeAmountDoc } from "../helpers/scenario.js";

/**
 * Review round 5 (logic P2, ruled must-fix): the evidence bundle of a run assessed by an older engine keeps the recorded verdict
 * (it is hashed evidence), so a script that gates on the bundle's `verdict` field would accept it. The bundle therefore carries a
 * marker OUTSIDE the hashed body (`stale_runs`, the ids of the finished runs of an older engine) and the API answers the header
 * `x-changeradar-stale-runs` with the count; the CLI export says it. The marker is checked against the runs it names.
 */

const here = dirname(fileURLToPath(import.meta.url));
const ENGINE1 = readFileSync(resolve(here, "../fixtures/upgrade/engine1-bundle.json"), "utf8").replace(/\b([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12})\b/g, "$1-$2-$3-$4-$5");
const LIMIT = 64 * 1024 * 1024;
const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) {
    try {
      chmodSync(dir, 0o700);
    } catch {
      /* already gone */
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
function capture(): { io: Io; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (m) => out.push(m), err: (m) => err.push(m), stdin: async () => "" }, out, err };
}

async function restored() {
  const h = await createHarness();
  h.ctx.reportRenderer = htmlReportRenderer;
  const summary = await restoreBundle(h.ctx, ENGINE1);
  return { h, workspaceId: summary.workspace_id, stale: summary.stale_runs };
}

describe("R5 (evidence.ts:202): the run bundle of a stale run says so outside the hashed body", () => {
  it("the API body lists the stale run and the header counts it; the bundle still verifies (the marker is not hashed)", async () => {
    const { h, workspaceId, stale } = await restored();
    try {
      const operator = await h.userIn(workspaceId, "operator");
      expect(stale.length).toBeGreaterThanOrEqual(1);
      for (const id of stale) {
        const res = await h.api(operator, "GET", `/api/v1/impact-runs/${id}/bundle`);
        expect(res.status).toBe(200);
        expect(res.headers["x-changeradar-stale-runs"], "header").toBe("1");
        expect(res.body.stale_runs, "body marker").toEqual([id]);
        // The recorded verdict is still there, as history: hashed evidence is not rewritten.
        expect(["AFFECTED", "NO_KNOWN_IMPACT", "INCOMPLETE"]).toContain(res.body.impact_runs[0].verdict);
        const bundle = verifyBundle(JSON.stringify(res.body), { maxBytes: LIMIT });
        expect(staleEngineRuns(bundle)).toEqual([id]);
      }
    } finally {
      await h.close();
    }
  }, 120_000);

  it("a workspace bundle names every stale run; a bundle of current runs says none (control)", async () => {
    const { h, workspaceId, stale } = await restored();
    try {
      const bundle = (await buildBundle(h.db, { workspaceId }, h.now())) as EvidenceBundle;
      expect([...(bundle.stale_runs ?? [])].sort()).toEqual([...stale].sort());
    } finally {
      await h.close();
    }
    const current = await createHarness();
    try {
      const w = await current.workspace("Marker5");
      const snap = await current.importSnapshot(w.operator, baselineDoc(), { revision: "release-1" });
      const run = await current.requestRun(w.operator, { snapshot_id: snap.body.id, proposed_manifest: removeAmountDoc(), expected_hash: snap.body.hash, run_checks: false });
      await current.drain();
      const res = await current.api(w.operator, "GET", `/api/v1/impact-runs/${run.body.id}/bundle`);
      expect(res.status).toBe(200);
      expect(res.headers["x-changeradar-stale-runs"]).toBe("0");
      expect(res.body.stale_runs).toEqual([]);
    } finally {
      await current.close();
    }
  }, 120_000);
});

describe("R5: the marker is checked, and bundles without it (written by earlier builds) still verify", () => {
  it("a bundle that claims no stale run for a run of an older engine, or names a run that is current, is refused", async () => {
    const { h, workspaceId } = await restored();
    let text = "";
    try {
      text = serializeBundle((await buildBundle(h.db, { workspaceId }, h.now())) as EvidenceBundle);
    } finally {
      await h.close();
    }
    const good = JSON.parse(text) as Record<string, any>;
    expect(() => verifyBundle(text, { maxBytes: LIMIT })).not.toThrow();
    for (const [label, marker] of [["emptied", []], ["wrong id", [UUID_UNKNOWN]], ["not an array", "none"]] as const) {
      const edited = { ...good, stale_runs: marker };
      let code = "";
      try {
        verifyBundle(JSON.stringify(edited), { maxBytes: LIMIT });
      } catch (error) {
        code = error instanceof BundleError ? error.code : String(error);
      }
      expect(code, label).toBe("BUNDLE_SCHEMA_INVALID");
    }
    // Earlier builds wrote no marker at all: the genuine bundle of the previous engine has none and verifies.
    expect(JSON.parse(ENGINE1).stale_runs).toBeUndefined();
    expect(() => verifyBundle(ENGINE1, { maxBytes: LIMIT })).not.toThrow();
    // Removing the marker altogether is what an earlier build's file looks like: accepted (it is a hint, the hashes are the evidence).
    const { stale_runs: _drop, ...without } = good;
    expect(() => verifyBundle(JSON.stringify(without), { maxBytes: LIMIT })).not.toThrow();
  }, 120_000);

  it("the marker is outside the hash: changing it does not change bundle_hash", async () => {
    const { h, workspaceId } = await restored();
    try {
      const bundle = (await buildBundle(h.db, { workspaceId }, h.now())) as EvidenceBundle;
      const text = serializeBundle(bundle);
      const without = JSON.parse(text) as Record<string, any>;
      delete without.stale_runs;
      expect(verifyBundle(JSON.stringify(without), { maxBytes: LIMIT }).bundle_hash).toBe(bundle.bundle_hash);
    } finally {
      await h.close();
    }
  }, 120_000);
});

describe("R5: the CLI export says which exported runs are history", () => {
  it("export prints the count of runs assessed by an older engine and where the marker is", async () => {
    const dir = mkdtempSync(join(tmpdir(), "changeradar-r5stale-"));
    scratch.push(dir);
    const env = { CHANGERADAR_DATABASE_URL: `pglite:${join(dir, "db")}`, CHANGERADAR_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64") } as NodeJS.ProcessEnv;
    const file = join(dir, "engine1.json");
    writeFileSync(file, ENGINE1);
    const restoredRun = capture();
    expect(await runCli(["restore", "--in", file], env, restoredRun.io), restoredRun.err.join("\n")).toBe(0);
    const workspaceId = (JSON.parse(ENGINE1) as { workspace: { id: string } }).workspace.id.replace(/\b([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12})\b/, "$1-$2-$3-$4-$5");
    const exported = capture();
    const code = await runCli(["export", "--workspace-id", workspaceId, "--out", join(dir, "again.json")], env, exported.io);
    expect(code, exported.err.join("\n")).toBe(0);
    const text = exported.out.join("\n");
    expect(text).toContain("2 exported run(s) were assessed by an older decision engine");
    expect(text).toContain("stale_runs");
    expect(JSON.parse(readFileSync(join(dir, "again.json"), "utf8")).stale_runs).toHaveLength(2);
  }, 120_000);
});
