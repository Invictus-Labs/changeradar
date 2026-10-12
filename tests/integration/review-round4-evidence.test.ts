import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hashCanonical } from "../../src/domain/canonical.js";
import { buildBundle, BundleError, serializeBundle, verifyBundle, type EvidenceBundle } from "../../src/services/evidence.js";
import { createHarness } from "../helpers/harness.js";
import { baselineDoc, removeAmountDoc } from "../helpers/scenario.js";

/**
 * Review round 4 (logic P2 evidence.ts:433, security P2): the engine stamp is written by the untrusted side, and a run that
 * carries an older (or no) stamp is not re-derived. What does not depend on the engine version is still checked, so a
 * resealed bundle cannot claim NO_KNOWN_IMPACT for a run whose own rows say otherwise.
 */

const here = dirname(fileURLToPath(import.meta.url));
const ENGINE1 = readFileSync(resolve(here, "../fixtures/upgrade/engine1-bundle.json"), "utf8").replace(/\b([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12})\b/g, "$1-$2-$3-$4-$5");

function reseal(bundle: Record<string, any>): string {
  const { bundle_hash: _drop, hashes: _h, stale_runs: _s, ...body } = bundle;
  const hashes = { snapshots: hashCanonical(body.snapshots), impact_runs: hashCanonical(body.impact_runs), contract_checks: hashCanonical(body.contract_checks) };
  const withHashes = { ...body, hashes };
  return JSON.stringify({ ...withHashes, bundle_hash: hashCanonical(withHashes) });
}
function outcome(text: string): string {
  try {
    verifyBundle(text, { maxBytes: 250 * 1024 * 1024 });
  } catch (error) {
    if (error instanceof BundleError) return error.code;
    throw error;
  }
  return "ACCEPTED";
}

describe("R4 P2 (evidence.ts:433): the version-independent checks still apply to a run with an older or missing engine stamp", () => {
  it("an untouched run whose stamp is removed is accepted; a run whose rows contradict its own verdict or summary is rejected", async () => {
    const h = await createHarness();
    try {
      const w = await h.workspace("Stamp");
      const snap = await h.importSnapshot(w.operator, baselineDoc(), { revision: "release-1" });
      await h.requestRun(w.operator, { snapshot_id: snap.body.id, proposed_manifest: removeAmountDoc(), expected_hash: snap.body.hash, run_checks: false });
      await h.drain();
      const text = serializeBundle((await buildBundle(h.db, { workspaceId: w.id }, h.now())) as EvidenceBundle);
      const fresh = (): Record<string, any> => JSON.parse(text) as Record<string, any>;
      const stamped = fresh();
      expect(stamped.impact_runs[0].verdict).toBe("AFFECTED");
      expect(stamped.impact_runs[0].findings.length).toBeGreaterThan(0);

      const forge = (mutate: (run: Record<string, any>) => void, dropStamp = true): string => {
        const b = fresh();
        const run = b.impact_runs[0];
        if (dropStamp) delete run.assessment_detail.engine_version;
        mutate(run);
        return reseal(b);
      };
      // Controls: the stamp removed and nothing else changed is consistent; an older number likewise.
      expect(outcome(forge(() => {}))).toBe("ACCEPTED");
      expect(outcome(forge((run) => (run.assessment_detail.engine_version = 2), false))).toBe("ACCEPTED");
      // Forgeries the stamp used to let through.
      expect(outcome(forge((run) => (run.verdict = "NO_KNOWN_IMPACT")))).toBe("BUNDLE_RUN_INCONSISTENT");
      expect(outcome(forge((run) => { run.verdict = "NO_KNOWN_IMPACT"; run.findings = []; }))).toBe("BUNDLE_RUN_INCONSISTENT"); // summary still counts them
      expect(outcome(forge((run) => { run.findings = []; }))).toBe("BUNDLE_RUN_INCONSISTENT");
      expect(outcome(forge((run) => { run.verdict = "NO_KNOWN_IMPACT"; run.findings = []; run.assessment_detail.summary.findings = 0; run.assessment_detail.summary.direct_findings = 0; run.assessment_detail.summary.transitive_findings = 0; run.assessment_detail.summary.known_impact = false; }))).toBe("ACCEPTED"); // consistent: the documented hash-only limit
      expect(outcome(forge((run) => { run.verdict = "NO_KNOWN_IMPACT"; run.findings = []; run.assessment_detail.summary.findings = 0; run.unknowns = [{ id: "u1", code: "STALE_CONTRACT", message: "x", node_id: "svc.a" }]; }))).toBe("BUNDLE_RUN_INCONSISTENT");
      // A truncated run (the FINDINGS_TRUNCATED unknown) may hold fewer rows than its summary counts.
      expect(outcome(forge((run) => { run.findings = run.findings.slice(0, 1); run.unknowns = [...run.unknowns, { id: "t1", code: "FINDINGS_TRUNCATED", message: "cut", node_id: null }]; run.assessment_detail.summary.findings = run.assessment_detail.summary.findings + 5; }))).toBe("ACCEPTED");
    } finally {
      await h.close();
    }
  }, 120_000);

  it("the genuine bundle written by the previous engine still verifies", () => {
    expect(outcome(ENGINE1)).toBe("ACCEPTED");
  });
});
