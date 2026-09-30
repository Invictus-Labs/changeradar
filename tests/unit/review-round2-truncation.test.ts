import { describe, expect, it } from "vitest";
import { assess, type Assessment } from "../../src/services/assess.js";
import type { AssessConfig } from "../../src/domain/limits.js";
import { build, clock, e, f, manifest, n, prng } from "../helpers/builders.js";

/**
 * Review round 2 (test-adequacy P1, assess.ts:349): each of the three triggers of the FINDINGS_TRUNCATED unknown must
 * be proven ALONE, and any finding lost to a cap must force INCOMPLETE. The two scenarios below fire exactly one
 * trigger each (the third, `findingsOmitted`, is covered by review-round1-scale.test.ts and the property here).
 */

type Doc = { nodes: Record<string, any>[]; edges: Record<string, any>[] };
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function run(baselineDoc: unknown, proposedDoc: unknown, config?: Partial<AssessConfig>): Assessment {
  const baseline = build(baselineDoc);
  const proposed = build(proposedDoc);
  const result = assess({ baseline, proposed, expected_hash: baseline.hash, clock, ...(config ? { config } : {}) });
  if (!result.ok) throw new Error("assess failed: " + result.error.code);
  return result.assessment;
}

const codes = (a: Assessment): string[] => a.unknowns.map((u) => u.code);

describe("R2 P1 (assess.ts:349): a traversal cut inside ONE origin, with no finding recorded, is INCOMPLETE (originsTruncated alone)", () => {
  function singleOrigin(): { base: Doc; proposed: Doc } {
    const nodes: Record<string, unknown>[] = [n("contract.c", "contract", { fields: [f("a"), f("b")] })];
    const edges: Record<string, unknown>[] = [];
    // Ten consumers that declare only `a` come first (ids sort before s10), then one undeclared consumer that breaks.
    for (let i = 0; i < 10; i += 1) {
      nodes.push(n(`svc.s${String(i).padStart(2, "0")}`, "service"));
      edges.push(e(`svc.s${String(i).padStart(2, "0")}`, "contract.c", "consumes", { fields: ["a"] }));
    }
    nodes.push(n("svc.s10", "service"));
    edges.push(e("svc.s10", "contract.c", "consumes"));
    const base = manifest(nodes, edges) as unknown as Doc;
    const proposed = clone(base);
    proposed.nodes[0]!.contract.fields = [f("a")];
    return { base, proposed };
  }

  it("with the whole budget the broken consumer is found", () => {
    const { base, proposed } = singleOrigin();
    const a = run(base, proposed);
    expect(a.assessment).toBe("AFFECTED");
    expect(a.findings.map((x) => x.consumer_id)).toEqual(["svc.s10"]);
  });

  it("with a budget of 5 links no finding is recorded and the verdict is INCOMPLETE, not NO_KNOWN_IMPACT", () => {
    const { base, proposed } = singleOrigin();
    const a = run(base, proposed, { max_traversal_links: 5 });
    expect(a.findings).toEqual([]);
    expect(a.assessment).toBe("INCOMPLETE");
    expect(codes(a)).toContain("FINDINGS_TRUNCATED");
    expect(a.unknowns.find((u) => u.code === "FINDINGS_TRUNCATED")!.message).toMatch(/only partly analysed/);
    expect(a.unknowns.find((u) => u.code === "FINDINGS_TRUNCATED")!.message).not.toMatch(/not analysed at all/);
  });
});

describe("R2 P1 (assess.ts:349): a later origin skipped because an earlier one used the whole budget is INCOMPLETE (originsNotAnalyzed alone)", () => {
  function twoOrigins(): { base: Doc; proposed: Doc } {
    const nodes = [
      n("contract.c1", "contract", { fields: [f("a"), f("b")] }),
      n("contract.c2", "contract", { fields: [f("a"), f("b")] }),
      n("svc.excluded", "service"),
      n("svc.broken", "service"),
    ];
    const edges = [
      e("svc.excluded", "contract.c1", "consumes", { fields: ["a"] }), // excluded by its declaration: uses 1 link, records nothing
      e("svc.broken", "contract.c2", "consumes"),
    ];
    const base = manifest(nodes, edges) as unknown as Doc;
    const proposed = clone(base);
    proposed.nodes[0]!.contract.fields = [f("a")];
    proposed.nodes[1]!.contract.fields = [f("a")];
    return { base, proposed };
  }

  it("with the whole budget the second origin's consumer is found", () => {
    const { base, proposed } = twoOrigins();
    expect(run(base, proposed).findings.map((x) => x.consumer_id)).toEqual(["svc.broken"]);
  });

  it("with a budget of exactly 1 link the second origin is not analysed at all: INCOMPLETE, and it says so", () => {
    const { base, proposed } = twoOrigins();
    const a = run(base, proposed, { max_traversal_links: 1 });
    expect(a.findings).toEqual([]);
    expect(a.assessment).toBe("INCOMPLETE");
    const unknown = a.unknowns.find((u) => u.code === "FINDINGS_TRUNCATED");
    expect(unknown, JSON.stringify(a.unknowns)).toBeDefined();
    expect(unknown!.message).toMatch(/not analysed at all/);
    expect(unknown!.message).not.toMatch(/only partly analysed/);
  });
});

describe("R2 P1 (assess.ts:349): metamorphic property, any finding present uncapped and absent capped forces INCOMPLETE", () => {
  function randomWorld(seed: number): { base: Doc; proposed: Doc } {
    const random = prng(seed);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
    const contracts = 1 + Math.floor(random() * 3);
    const nodes: Record<string, unknown>[] = [];
    const edges: Record<string, unknown>[] = [];
    for (let c = 0; c < contracts; c += 1) nodes.push(n(`contract.c${c}`, "contract", { fields: [f("a"), f("b")] }));
    const consumers = 2 + Math.floor(random() * 10);
    const declarations: (string[] | undefined)[] = [undefined, undefined, ["a"], ["b"], ["a", "b"]];
    for (let i = 0; i < consumers; i += 1) {
      const id = `svc.n${String(i).padStart(2, "0")}`;
      nodes.push(n(id, "service"));
      const declared = pick(declarations);
      edges.push(e(id, `contract.c${Math.floor(random() * contracts)}`, "consumes", declared ? { fields: declared } : {}));
    }
    const base = manifest(nodes, edges) as unknown as Doc;
    const proposed = clone(base);
    for (let c = 0; c < contracts; c += 1) proposed.nodes[c]!.contract.fields = [f("a")];
    return { base, proposed };
  }

  it("300 seeds: whenever a cap loses a finding the run is INCOMPLETE with FINDINGS_TRUNCATED (and the lost cases are not vacuous)", () => {
    let lost = 0;
    let cappedByTraversal = 0;
    for (let seed = 1; seed <= 300; seed += 1) {
      const { base, proposed } = randomWorld(seed);
      const uncapped = run(base, proposed);
      const random = prng(seed * 7919);
      const which = Math.floor(random() * 3);
      const config: Partial<AssessConfig> =
        which === 0 ? { max_traversal_links: 1 + Math.floor(random() * 10) } : which === 1 ? { max_findings: 1 + Math.floor(random() * 5) } : { max_findings_per_origin: 1 + Math.floor(random() * 3) };
      const capped = run(base, proposed, config);
      const kept = new Set(capped.findings.map((x) => `${x.origin_id}>${x.consumer_id}`));
      const missing = uncapped.findings.filter((x) => !kept.has(`${x.origin_id}>${x.consumer_id}`));
      if (missing.length > 0) {
        lost += 1;
        if (which === 0) cappedByTraversal += 1;
        expect(capped.assessment, `seed ${seed} lost ${missing.map((m) => m.consumer_id).join(",")} under ${JSON.stringify(config)}`).toBe("INCOMPLETE");
        expect(codes(capped), `seed ${seed}`).toContain("FINDINGS_TRUNCATED");
      }
    }
    expect(lost, "the property must actually exercise the caps").toBeGreaterThan(30);
    expect(cappedByTraversal, "and the traversal budget in particular").toBeGreaterThan(5);
  });
});
