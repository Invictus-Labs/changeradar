import { describe, expect, it } from "vitest";
import { classifyVersionChange } from "../../src/domain/semver.js";
import { assess, ENGINE_VERSION, type Assessment } from "../../src/services/assess.js";
import { build, clock, e, f, manifest, n } from "../helpers/builders.js";

/**
 * Review round 3 regression tests for the decision code: a new requirement reaches every consumer of a contract, whatever
 * fields it declares, and the semver rule for a prerelease that moves to another core.
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

/** contract.c has f (required) and g (optional); svc.j declares [f]; svc.k declares nothing (when `withK`). */
function world(withK: boolean): { base: Doc; proposed: Doc } {
  const nodes = [n("contract.c", "contract", { fields: [f("f"), f("g", "string", false)] }), n("svc.j", "service"), ...(withK ? [n("svc.k", "service")] : [])];
  const edges = [e("svc.j", "contract.c", "consumes", { fields: ["f"] }), ...(withK ? [e("svc.k", "contract.c", "consumes")] : [])];
  const base = manifest(nodes, edges) as unknown as Doc;
  return { base, proposed: clone(base) };
}

describe("R3 P2 (diff.ts:273): a NEW requirement reaches every consumer, including one that declares other fields", () => {
  it("a newly added required field reaches the consumer that declares [f]", () => {
    const { base, proposed } = world(false);
    proposed.nodes[0]!.contract.fields = [f("f"), f("g", "string", false), f("z")];
    const a = verdict(base, proposed);
    expect(a.assessment).toBe("AFFECTED");
    expect(a.findings.map((x) => x.consumer_id)).toEqual(["svc.j"]);
  });

  it("an optional field that becomes required reaches the consumer that declares [f]", () => {
    const { base, proposed } = world(false);
    proposed.nodes[0]!.contract.fields = [f("f"), f("g", "string", true)];
    const a = verdict(base, proposed);
    expect(a.assessment).toBe("AFFECTED");
    expect(a.findings.map((x) => x.consumer_id)).toEqual(["svc.j"]);
  });

  it("with an undeclared consumer next to it, both are reached (the declared one used to be dropped)", () => {
    for (const change of [(fields: any[]) => [...fields, f("z")], (fields: any[]) => fields.map((x) => (x.name === "g" ? f("g", "string", true) : x))]) {
      const { base, proposed } = world(true);
      proposed.nodes[0]!.contract.fields = change(proposed.nodes[0]!.contract.fields);
      expect(verdict(base, proposed).findings.map((x) => x.consumer_id).sort()).toEqual(["svc.j", "svc.k"]);
    }
  });

  it("controls: what a declared consumer may still ignore stays ignored (optional field added, optional removed, another field's type)", () => {
    const optionalAdded = world(false);
    optionalAdded.proposed.nodes[0]!.contract.fields = [f("f"), f("g", "string", false), f("h", "string", false)];
    expect(verdict(optionalAdded.base, optionalAdded.proposed).assessment).toBe("NO_KNOWN_IMPACT");
    const optionalRemoved = world(false);
    optionalRemoved.proposed.nodes[0]!.contract.fields = [f("f")];
    expect(verdict(optionalRemoved.base, optionalRemoved.proposed).assessment).toBe("NO_KNOWN_IMPACT");
    const requiredToOptional = world(false);
    requiredToOptional.base.nodes[0]!.contract.fields = [f("f"), f("g", "string", true)];
    requiredToOptional.proposed.nodes[0]!.contract.fields = [f("f"), f("g", "string", false)];
    // g was required and svc.j does not declare it: a required to optional flip still goes only where g is declared.
    expect(verdict(requiredToOptional.base, requiredToOptional.proposed).assessment).toBe("NO_KNOWN_IMPACT");
  });

  it("a removed required field still reaches only the consumers that declare it (unchanged)", () => {
    const { base, proposed } = world(false);
    proposed.nodes[0]!.contract.fields = [f("g", "string", false)]; // f removed: svc.j declares f
    expect(verdict(base, proposed).findings.map((x) => x.consumer_id)).toEqual(["svc.j"]);
  });

  it("the engine version says the rules changed (3)", () => {
    expect(ENGINE_VERSION).toBeGreaterThanOrEqual(3);
  });
});

describe("R3 P2 (semver.ts): a prerelease that moves to another core is breaking", () => {
  const breaking: [string, string][] = [
    ["1.2.3-rc.1", "1.2.4-rc.1"],
    ["1.2.3-rc.1", "1.3.0-rc.1"],
    ["1.2.3-rc.1", "1.2.4-rc.2"],
    ["1.2.3-beta", "1.2.4-beta"],
  ];
  for (const [before, after] of breaking) {
    it(`${before} -> ${after}`, () => {
      expect(classifyVersionChange(before, after).breaking).toBe(true);
    });
  }
  it("the same prerelease on the same core with different build metadata is not breaking", () => {
    expect(classifyVersionChange("1.2.3-rc.1", "1.2.3-rc.1+build.7").breaking).toBe(false);
  });
});
