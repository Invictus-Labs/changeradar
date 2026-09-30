import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FindingsPage } from "../../src/domain/api-responses.js";
import { restoreBundle } from "../../src/services/restore.js";
import { createHarness } from "../helpers/harness.js";
import { baselineDoc, removeAmountDoc } from "../helpers/scenario.js";

/**
 * Review round 7 (logic P3, impact.ts:333): the findings page of a run from an older decision engine carried its recorded rows
 * with nothing on the page to say they are history. The page now has a `rerun_required` member, true for such a run and false for a
 * current one, like `engine.rerun_required` in the run view.
 */

const here = dirname(fileURLToPath(import.meta.url));
const ENGINE1 = readFileSync(resolve(here, "../fixtures/upgrade/engine1-bundle.json"), "utf8").replace(/\b([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12})\b/g, "$1-$2-$3-$4-$5");

describe("R7 (impact.ts): the findings page says when its rows are an older engine's record", () => {
  it("a run restored from an engine-1 bundle: rerun_required is true on every findings page; a current run: false", async () => {
    const h = await createHarness();
    try {
      const summary = await restoreBundle(h.ctx, ENGINE1);
      const viewer = await h.userIn(summary.workspace_id, "viewer");
      expect(summary.stale_runs.length).toBeGreaterThanOrEqual(1);
      for (const id of summary.stale_runs) {
        const page = await h.api(viewer, "GET", `/api/v1/impact-runs/${id}/findings?limit=100`);
        expect(page.status, page.text).toBe(200);
        expect(FindingsPage.safeParse(page.body).success, "the page matches its schema").toBe(true);
        expect(page.body.rerun_required, `stale run ${id}`).toBe(true);
      }
      const w = await h.workspace("CurrentFindings");
      const snap = await h.importSnapshot(w.operator, baselineDoc(), { revision: "release-1" });
      const run = await h.requestRun(w.operator, { snapshot_id: snap.body.id, proposed_manifest: removeAmountDoc(), expected_hash: snap.body.hash, run_checks: false });
      await h.drain();
      const current = await h.api(w.viewer, "GET", `/api/v1/impact-runs/${run.body.id}/findings?limit=100`);
      expect(current.status, current.text).toBe(200);
      expect(FindingsPage.safeParse(current.body).success, "the page matches its schema").toBe(true);
      expect(current.body.rerun_required, "a run of this build's engine").toBe(false);
    } finally {
      await h.close();
    }
  }, 120_000);
});
