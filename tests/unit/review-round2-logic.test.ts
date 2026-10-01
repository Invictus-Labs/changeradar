import { describe, expect, it } from "vitest";
import { classifyVersionChange } from "../../src/domain/semver.js";
import { assess, ENGINE_VERSION, type Assessment } from "../../src/services/assess.js";
import { usableDeclaredFields } from "../../src/services/diff.js";
import { engineOf } from "../../src/services/impact.js";
import { build, clock, e, f, manifest, n } from "../helpers/builders.js";

/**
 * Review round 2 regression tests for the decision code (logic findings). Each block names the finding it pins;
 * see docs/qa/review-round1-ledger.md ("Re-review wave"). Every P1 here was RED against a37dd69 and is GREEN now.
 */

type Doc = { nodes: Record<string, any>[]; edges: Record<string, any>[] };
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function verdict(baselineDoc: unknown, proposedDoc: unknown): Assessment {
  const baseline = build(baselineDoc);
  const proposed = build(proposedDoc);
  const result = assess({ baseline, proposed, expected_hash: baseline.hash, clock });
  if (!result.ok) throw new Error("assess failed: " + result.error.code);
  return result.assessment;
}

describe("R2 P1 (diff.ts:315): `fields` on a produces edge names the TARGET contract's fields and never filters", () => {
  /** contract.a (a1, a2 required) --produces--> contract.b (b1); job.c consumes contract.b. */
  function chain(producesFields: string[] | undefined): { base: Doc; proposed: Doc } {
    const nodes = [
      n("contract.a", "contract", { fields: [f("a1"), f("a2")] }),
      n("contract.b", "contract", { fields: [f("b1")] }),
      n("job.c", "job"),
    ];
    const edges = [
      e("contract.a", "contract.b", "produces", producesFields ? { fields: producesFields } : {}),
      e("job.c", "contract.b", "consumes"),
    ];
    const base = manifest(nodes, edges) as unknown as Doc;
    const proposed = clone(base);
    proposed.nodes[0]!.contract.fields = [f("a2")];
    return { base, proposed };
  }

  it("removing a required field of the producer reaches the derived contract and its consumer", () => {
    const { base, proposed } = chain(["b1"]);
    const a = verdict(base, proposed);
    expect(a.assessment).toBe("AFFECTED");
    expect(a.findings.map((x) => x.consumer_id).sort()).toEqual(["contract.b", "job.c"]);
  });

  it("metamorphic: the findings do not depend on what the produces edge says in `fields`", () => {
    const ids = (fields: string[] | undefined) => {
      const { base, proposed } = chain(fields);
      return verdict(base, proposed).findings.map((x) => `${x.consumer_id}:${x.severity}:${x.depth}`).sort();
    };
    const reference = ids(undefined);
    expect(reference.length).toBeGreaterThan(0);
    for (const fields of [["b1"], ["zzz"], ["b1", "a1"], []]) expect(ids(fields), JSON.stringify(fields)).toEqual(reference);
  });

  it("usableDeclaredFields ignores a produces edge whatever it declares", () => {
    const edge = { source_id: "contract.a", target_id: "contract.b", relation: "produces", fields: ["b1"] } as never;
    expect(usableDeclaredFields(edge, new Set(["a1"]))).toBeNull();
    expect(usableDeclaredFields(edge, null)).toBeNull();
  });
});

describe("R2 P1 (assess.ts:376): a declaration that names fields the baseline contract lacks is unusable, never an exclusion", () => {
  function consumer(declared: string[]): { base: Doc; proposed: Doc } {
    const nodes = [n("contract.c", "contract", { fields: [f("invoice_id"), f("amount")] }), n("svc.x", "service")];
    const base = manifest(nodes, [e("svc.x", "contract.c", "consumes", { fields: declared })]) as unknown as Doc;
    const proposed = clone(base);
    proposed.nodes[0]!.contract.fields = [f("amount")];
    return { base, proposed };
  }

  it("a typo in the declaration (invoice_idd) is not NO_KNOWN_IMPACT: the consumer is found and the evidence is an unknown", () => {
    const { base, proposed } = consumer(["invoice_idd"]);
    const a = verdict(base, proposed);
    expect(a.assessment).toBe("INCOMPLETE");
    expect(a.findings.map((x) => x.consumer_id)).toEqual(["svc.x"]);
    expect(a.unknowns.map((u) => u.code)).toEqual(["EDGE_FIELD_NOT_IN_CONTRACT"]);
  });

  it("a valid name mixed with an invalid one is unusable as a whole", () => {
    const { base, proposed } = consumer(["amount", "invoice_idd"]);
    const a = verdict(base, proposed);
    expect(a.findings.map((x) => x.consumer_id)).toEqual(["svc.x"]);
    expect(a.unknowns.map((u) => u.code)).toEqual(["EDGE_FIELD_NOT_IN_CONTRACT"]);
  });

  it("control: a correct declaration still excludes an unrelated change, with no unknown", () => {
    const { base, proposed } = consumer(["amount"]);
    const a = verdict(base, proposed);
    expect(a.assessment).toBe("NO_KNOWN_IMPACT"); // invoice_id was removed; this consumer declares only amount
    expect(a.findings).toEqual([]);
    expect(a.unknowns).toEqual([]);
  });

  it("a declaration naming a field the contract lacks is unusable (null), one naming a real field is kept", () => {
    const origin = new Set(["invoice_id", "amount"]);
    const typo = { source_id: "svc.x", target_id: "contract.c", relation: "consumes", fields: ["invoice_idd"] } as never;
    const real = { source_id: "svc.x", target_id: "contract.c", relation: "consumes", fields: ["invoice_id"] } as never;
    expect(usableDeclaredFields(typo, origin)).toBeNull();
    expect(usableDeclaredFields(real, origin)).toEqual(["invoice_id"]);
  });
});

describe("R2 P2 (mutation-controls.mjs:193): the `||` in required_relevant is verdict-equivalent, not output-equivalent: causes are complete", () => {
  it("a field that changes type AND requiredness reaches an undeclared consumer with BOTH causes named", () => {
    const nodes = [n("contract.c", "contract", { fields: [f("g", "string", true), f("keep")] }), n("svc.x", "service")];
    const base = manifest(nodes, [e("svc.x", "contract.c", "consumes")]) as unknown as Doc;
    const proposed = clone(base);
    proposed.nodes[0]!.contract.fields = [f("g", "integer", false), f("keep")];
    const a = verdict(base, proposed);
    expect(a.assessment).toBe("AFFECTED");
    const finding = a.findings[0]!;
    expect(a.changes.map((c) => c.kind).sort()).toEqual(["contract_field_requirement_changed", "contract_field_type_changed"]);
    expect(finding.change_ids.length, "the finding must name both causes").toBe(2);
    expect(new Set(finding.change_ids)).toEqual(new Set(a.changes.map((c) => c.id)));
  });

  it("the same for every combination of a type change with a requiredness change (both orders of requiredness)", () => {
    for (const [beforeRequired, afterRequired] of [[true, false], [false, true]] as const) {
      const nodes = [n("contract.c", "contract", { fields: [f("g", "string", beforeRequired), f("keep")] }), n("svc.x", "service")];
      const base = manifest(nodes, [e("svc.x", "contract.c", "consumes")]) as unknown as Doc;
      const proposed = clone(base);
      proposed.nodes[0]!.contract.fields = [f("g", "integer", afterRequired), f("keep")];
      const a = verdict(base, proposed);
      expect(a.findings[0]!.change_ids.length, `${beforeRequired} -> ${afterRequired}`).toBe(a.changes.length);
    }
  });
});

describe("R2 P2 (semver.ts:41): moving INTO a prerelease, or across 0.0.x, is breaking", () => {
  const breaking: [string, string][] = [
    ["1.2.3", "1.3.0-alpha.1"],
    ["1.2.3", "1.2.4-rc.1"],
    ["1.2.3", "2.0.0-beta.1"],
    ["0.0.1", "0.0.2"],
    ["0.0.2", "0.0.1"],
    ["1.2.3-rc.1", "1.2.3-rc.2"],
    ["1.2.3", "1.2.3-rc.1"],
  ];
  for (const [before, after] of breaking) {
    it(`${before} -> ${after} is breaking`, () => {
      expect(classifyVersionChange(before, after).breaking).toBe(true);
    });
  }
  const safe: [string, string][] = [
    ["1.2.3", "1.2.4"],
    ["1.2.3", "1.3.0"],
    ["1.2.3-rc.1", "1.2.3"], // graduating to the release
    ["1.2.3", "1.2.3+build.5"],
    ["1.2.3-rc.1", "1.2.3-rc.1+build.9"],
    ["0.1.1", "0.1.1"],
  ];
  for (const [before, after] of safe) {
    it(`${before} -> ${after} is not breaking`, () => {
      expect(classifyVersionChange(before, after).breaking).toBe(false);
    });
  }
});

describe("R2 P2 (evidence.ts:385): a run assessed by an older engine is flagged 'assessed by an older engine, re-run required'", () => {
  it("engineOf: a current stamp is fine, a missing stamp is version 1 and flagged, an unfinished run is never flagged", () => {
    expect(engineOf({ engine_version: ENGINE_VERSION }, true)).toEqual({ version: ENGINE_VERSION, current: ENGINE_VERSION, rerun_required: false });
    const old = engineOf({}, true);
    expect(old).toMatchObject({ version: 1, current: ENGINE_VERSION, rerun_required: true });
    expect(old.note).toMatch(/older decision engine.*re-run required/);
    expect(engineOf(null, true).rerun_required).toBe(true);
    expect(engineOf({ engine_version: 1 }, false).rerun_required).toBe(false);
    expect(engineOf({ engine_version: ENGINE_VERSION + 1 }, true).rerun_required).toBe(true);
  });
});

describe("R2 P2 (evidence.ts:385): the assessment is stamped with the engine version that produced it", () => {
  it("every assessment carries engine_version equal to ENGINE_VERSION", () => {
    const nodes = [n("contract.c", "contract", { fields: [f("a")] }), n("svc.x", "service")];
    const base = manifest(nodes, [e("svc.x", "contract.c", "consumes")]) as unknown as Doc;
    const a = verdict(base, base);
    expect(a.engine_version).toBe(ENGINE_VERSION);
    expect(ENGINE_VERSION).toBeGreaterThanOrEqual(2);
  });
});
