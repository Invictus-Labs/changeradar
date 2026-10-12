import { describe, expect, it } from "vitest";
import { createHarness, getRun } from "../helpers/harness.js";
import { e, manifest, n } from "../helpers/builders.js";

/**
 * Review round 4 (conformance P2, API.md:65): the run view lists every change and cycle in ONE response, unpaged, although
 * the product requirements say lists cap at 100 with a cursor. That is a recorded deviation awaiting the product owner
 * (docs/API.md, docs/qa/ac-matrix.md); this test pins the behaviour so that a change is a decision, not an accident.
 */

describe("R4 P2 (impact.ts getImpactRun): the run view holds all changes unpaged while findings are paged at 100", () => {
  it("130 changed nodes: `changes` has 130 entries, `affected` 100 of 130 findings, and the findings endpoint pages the rest", async () => {
    const h = await createHarness();
    try {
      const w = await h.workspace("Unpaged");
      const version = (v: string) => Array.from({ length: 130 }, (_, i) => n(`svc.n${String(i).padStart(3, "0")}`, "service", { version: v }));
      const consumer = n("svc.consumer", "service");
      const edges = Array.from({ length: 130 }, (_, i) => e("svc.consumer", `svc.n${String(i).padStart(3, "0")}`, "consumes"));
      const base = manifest([...version("1.0.0"), consumer], edges);
      const proposed = manifest([...version("2.0.0"), consumer], edges);
      const snap = await h.importSnapshot(w.operator, base, { revision: "release-1" });
      expect(snap.status, snap.text).toBe(201);
      const run = await h.requestRun(w.operator, { snapshot_id: snap.body.id, proposed_manifest: proposed, expected_hash: snap.body.hash, run_checks: false });
      expect(run.status, run.text).toBe(202);
      await h.drain();
      const view = await getRun(h, w.viewer, run.body.id);
      expect(view.changes).toHaveLength(130);
      expect(view.affected).toHaveLength(100);
      expect(view.totals.findings).toBe(130);
      expect(view.truncated.findings).toBe(true);
      const json = await h.api(w.viewer, "GET", `/api/v1/impact-runs/${run.body.id}/export?format=json`);
      expect(json.body.changes).toHaveLength(130);
      const page = await h.api(w.viewer, "GET", `/api/v1/impact-runs/${run.body.id}/findings?limit=100`);
      expect(page.body.items).toHaveLength(100);
      expect(page.body.next_cursor).not.toBeNull();
    } finally {
      await h.close();
    }
  }, 120_000);
});
