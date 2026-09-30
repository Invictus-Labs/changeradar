import { describe, expect, it } from "vitest";
import { buildGraph } from "../../src/services/graph.js";
import { assess, ENGINE_VERSION, isStaleEngineRun } from "../../src/services/assess.js";
import { staleEngineRuns, type EvidenceBundle } from "../../src/services/evidence.js";
import { engineOf } from "../../src/services/impact.js";
import { build, clock, e, f, manifest, n } from "../helpers/builders.js";

/**
 * Review round 4 (logic P2): an edge that declares `fields: []` is accepted and exempts its consumer (and that consumer's
 * dependents) from every field change: the rule stays (a consumer that reads no field is not affected by a field change), but
 * it is now VISIBLE: an import warning names every such edge.
 */

describe("R4 (assess.ts): ONE predicate decides whether a run's engine is out of date, used by the views, the exports and the bundles", () => {
  it("only a FINISHED run whose stamp (a missing stamp is version 1) is not the current version is stale", () => {
    expect(isStaleEngineRun(true, ENGINE_VERSION)).toBe(false);
    expect(isStaleEngineRun(true, ENGINE_VERSION - 1)).toBe(true);
    expect(isStaleEngineRun(true, undefined)).toBe(true); // stored before the stamp existed: version 1
    expect(isStaleEngineRun(true, ENGINE_VERSION + 1)).toBe(true); // newer than this build: not current either
    expect(isStaleEngineRun(true, "3")).toBe(true); // not a number: never read as current
    expect(isStaleEngineRun(false, undefined)).toBe(false); // unfinished: no assessment to be stale
    expect(isStaleEngineRun(false, 1)).toBe(false);
  });

  it("engineOf (views, list, exports) and staleEngineRuns (bundles) agree on it for every combination", () => {
    for (const finished of [true, false]) {
      for (const stamp of [undefined, 1, 2, ENGINE_VERSION, ENGINE_VERSION + 1]) {
        const detail = stamp === undefined ? {} : { engine_version: stamp };
        expect(engineOf(detail, finished).rerun_required, `${finished} ${String(stamp)}`).toBe(isStaleEngineRun(finished, stamp));
        const bundle = { impact_runs: [{ id: "r", status: finished ? "COMPLETE" : "QUEUED", assessment_detail: finished ? detail : null }] } as unknown as EvidenceBundle;
        expect(staleEngineRuns(bundle).length === 1, `${finished} ${String(stamp)}`).toBe(isStaleEngineRun(finished, stamp));
      }
    }
  });
});

describe("R4 P2 (diff.ts:345): an edge that declares no fields is reported at import", () => {
  const doc = (fields: string[] | undefined) =>
    manifest([n("svc.a", "service"), n("contract.c", "contract", { fields: [f("x")] })], [e("svc.a", "contract.c", "consumes", fields === undefined ? {} : { fields })]);

  it("EMPTY_FIELD_DECLARATION lists the edge; a declared field or an absent declaration is not reported", () => {
    const empty = buildGraph(doc([]));
    if (!empty.ok) throw new Error("rejected");
    expect(empty.warnings.find((w) => w.code === "EMPTY_FIELD_DECLARATION")).toMatchObject({ count: 1 });
    expect(empty.warnings.find((w) => w.code === "EMPTY_FIELD_DECLARATION")?.message).toMatch(/exempt/);
    for (const other of [["x"], undefined]) {
      const ok = buildGraph(doc(other));
      if (!ok.ok) throw new Error("rejected");
      expect(ok.warnings.map((w) => w.code), JSON.stringify(other)).not.toContain("EMPTY_FIELD_DECLARATION");
    }
  });

  it("the decision rule is unchanged and documented: the consumer with [] is exempt from a field removal, one without a declaration is not", () => {
    const base = manifest(
      [n("contract.c", "contract", { fields: [f("id"), f("amount")] }), n("svc.empty", "service"), n("svc.none", "service")],
      [e("svc.empty", "contract.c", "consumes", { fields: [] }), e("svc.none", "contract.c", "consumes")],
    );
    const proposed = manifest([n("contract.c", "contract", { fields: [f("id")] }), n("svc.empty", "service"), n("svc.none", "service")], [e("svc.empty", "contract.c", "consumes", { fields: [] }), e("svc.none", "contract.c", "consumes")]);
    const b = build(base);
    const result = assess({ baseline: b, proposed: build(proposed), expected_hash: b.hash, clock });
    if (!result.ok) throw new Error("assess failed");
    expect(result.assessment.findings.map((x) => x.consumer_id)).toEqual(["svc.none"]);
  });
});
