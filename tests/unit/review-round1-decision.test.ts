import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../src/domain/canonical.js";
import type { ContractCheckResult } from "../../src/domain/contract-checks.js";
import { InvalidExpectedHashError, StaleBaselineError } from "../../src/domain/errors.js";
import { assess, checkBaselineHash, type Assessment } from "../../src/services/assess.js";
import { FRESH, NOW_ISO, STALE, build, clock, e, f, manifest, n, prng, shuffled } from "../helpers/builders.js";

/**
 * Review round 1 regression tests for the decision code: the first-hop exclusion hole (P0), requiredness and
 * type propagation, version rules, baseline hash exactness, and combination / metamorphic properties.
 * Each block names the finding it pins; see docs/qa/review-round1-ledger.md.
 */

type Doc = { nodes: Record<string, any>[]; edges: Record<string, any>[] };
const FUTURE = "2027-01-01T00:00:00Z";

function verdict(baselineDoc: unknown, proposedDoc: unknown, checks: ContractCheckResult[] = []): Assessment {
  const baseline = build(baselineDoc);
  const proposed = build(proposedDoc);
  const result = assess({ baseline, proposed, expected_hash: baseline.hash, clock, check_results: checks });
  if (!result.ok) throw new Error("assess failed: " + result.error.code);
  return result.assessment;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function result(state: ContractCheckResult["state"], id: string, node: string): ContractCheckResult {
  return {
    check_id: id,
    node_id: node,
    state,
    attempts: 1,
    started_at: NOW_ISO,
    finished_at: NOW_ISO,
    duration_ms: 1,
    detail: `${state} (synthetic)`,
    error_code: null,
    attempt_log: [{ attempt: 1, state, detail: state, error_code: null }],
  };
}

/** contract.c (a, b required) <- svc.x declaring `declared` <- svc.y (an undeclared consumer of svc.x). */
function declaredConsumer(declared: string[] | undefined, verified: string | null, mutate?: (d: Doc) => void): { base: Doc; proposed: Doc } {
  const nodes = [n("contract.c", "contract", { fields: [f("a"), f("b")] }), n("svc.x", "service")];
  const edges = [e("svc.x", "contract.c", "consumes", { verified_at: verified, ...(declared ? { fields: declared } : {}) })];
  const base = manifest(nodes, edges) as unknown as Doc;
  const proposed = clone(base);
  proposed.nodes[0]!.contract.fields = [f("a")];
  mutate?.(proposed);
  return { base, proposed };
}

describe("R1 P0: a consumer excluded by its declared fields still needs trustworthy evidence (diff.ts first hop)", () => {
  const cases: [string, string[] | undefined, string | null, string][] = [
    ["unverified edge, declares a subset", ["a"], null, "UNVERIFIED_CONTRACT"],
    ["stale edge, declares a subset", ["a"], STALE, "STALE_CONTRACT"],
    ["future dated edge, declares a subset", ["a"], FUTURE, "FUTURE_VERIFIED_AT"],
    ["unverified edge, declares an empty list", [], null, "UNVERIFIED_CONTRACT"],
    ["stale edge, declares an empty list", [], STALE, "STALE_CONTRACT"],
    ["future dated edge, declares an empty list", [], FUTURE, "FUTURE_VERIFIED_AT"],
  ];
  for (const [name, declared, verified, code] of cases) {
    it(`${name}: removing the undeclared field is INCOMPLETE, never NO_KNOWN_IMPACT`, () => {
      const { base, proposed } = declaredConsumer(declared, verified);
      const a = verdict(base, proposed);
      expect(a.assessment).toBe("INCOMPLETE");
      expect(a.unknowns.map((u) => u.code)).toContain(code);
    });
  }

  it("control: the same excluded consumer with a fresh edge is a genuine NO_KNOWN_IMPACT with no unknowns", () => {
    const { base, proposed } = declaredConsumer(["a"], FRESH);
    const a = verdict(base, proposed);
    expect(a.assessment).toBe("NO_KNOWN_IMPACT");
    expect(a.unknowns).toEqual([]);
  });

  it("an included consumer keeps its finding and the excluded consumer's bad evidence is added, so nothing is hidden", () => {
    const nodes = [n("contract.c", "contract", { fields: [f("a"), f("b")] }), n("svc.in", "service"), n("svc.out", "service")];
    const edges = [
      e("svc.in", "contract.c", "consumes", { fields: ["b"] }),
      e("svc.out", "contract.c", "consumes", { fields: ["a"], verified_at: null }),
    ];
    const base = manifest(nodes, edges) as unknown as Doc;
    const proposed = clone(base);
    proposed.nodes[0]!.contract.fields = [f("a")];
    const a = verdict(base, proposed);
    expect(a.assessment).toBe("INCOMPLETE");
    expect(a.findings.map((x) => x.consumer_id)).toEqual(["svc.in"]);
    expect(a.unknowns.map((u) => u.code)).toEqual(["UNVERIFIED_CONTRACT"]);
  });
});

describe("R1 P1: requiredness changes reach declared consumers in both directions (diff.ts:276)", () => {
  it("required to optional reaches a consumer that declared the field, and an undeclared consumer", () => {
    const nodes = [n("contract.c", "contract", { fields: [f("a"), f("b")] }), n("svc.declared", "service"), n("svc.undeclared", "service")];
    const edges = [e("svc.declared", "contract.c", "consumes", { fields: ["b"] }), e("svc.undeclared", "contract.c", "consumes")];
    const base = manifest(nodes, edges) as unknown as Doc;
    const proposed = clone(base);
    proposed.nodes[0]!.contract.fields = [f("a"), f("b", "string", false)];
    const a = verdict(base, proposed);
    expect(a.assessment).toBe("AFFECTED");
    expect(a.findings.map((x) => x.consumer_id).sort()).toEqual(["svc.declared", "svc.undeclared"]);
    expect(a.changes.map((c) => [c.kind, c.propagation])).toEqual([["contract_field_requirement_changed", "field"]]);
  });

  it("a consumer that declared only other fields is not reached by the change", () => {
    const { base, proposed } = declaredConsumer(["a"], FRESH, (p) => {
      p.nodes[0]!.contract.fields = [f("a"), f("b", "string", false)];
    });
    expect(verdict(base, proposed).assessment).toBe("NO_KNOWN_IMPACT");
  });
});

describe("R1 P1: contract field change matrix (diff.ts:272 required_relevant, type x requiredness x consumer declaration)", () => {
  type FieldState = { type: "string" | "integer"; required: boolean } | null;
  const states: FieldState[] = [
    { type: "string", required: true },
    { type: "string", required: false },
    { type: "integer", required: true },
    { type: "integer", required: false },
    null,
  ];
  const declarations: (string[] | undefined)[] = [undefined, ["g"], ["g", "other"], []];

  /** Oracle written from docs/DOMAIN.md section 7, independent of the implementation. */
  function oracleBreaks(before: FieldState, after: FieldState, declared: string[] | undefined): boolean {
    // Round 3 (logic finding, diff.ts:273): a NEW requirement (a required field added, an optional field made required)
    // is a demand on every consumer, so no declaration can exempt one from it. Everything else is unchanged.
    if (after && after.required && (!before || !before.required)) return true;
    const reaches = (requiredOnEitherSide: boolean, relevant: boolean): boolean =>
      declared !== undefined ? declared.includes("g") : relevant && requiredOnEitherSide;
    if (before && !after) return reaches(before.required, before.required);
    if (!before && after) return after.required && reaches(after.required, after.required);
    if (before && after) {
      const typeChanged = before.type !== after.type;
      const reqChanged = before.required !== after.required;
      const eitherRequired = before.required || after.required;
      return (typeChanged && reaches(eitherRequired, eitherRequired)) || (reqChanged && reaches(eitherRequired, eitherRequired));
    }
    return false;
  }

  const label = (s: FieldState) => (s ? `${s.type}/${s.required ? "req" : "opt"}` : "absent");
  let combos = 0;
  for (const before of states) {
    for (const after of states) {
      for (const declared of declarations) {
        combos += 1;
        it(`${label(before)} -> ${label(after)}, consumer declares ${JSON.stringify(declared ?? null)}`, () => {
          const fieldsOf = (s: FieldState) => [f("keep"), ...(s ? [f("g", s.type, s.required)] : [])];
          const nodes = [n("contract.c", "contract", { fields: fieldsOf(before) }), n("svc.x", "service")];
          const edges = [e("svc.x", "contract.c", "consumes", declared ? { fields: declared } : {})];
          const base = manifest(nodes, edges) as unknown as Doc;
          const proposed = clone(base);
          proposed.nodes[0]!.contract.fields = fieldsOf(after);
          const a = verdict(base, proposed);
          const identical = canonicalJson(before) === canonicalJson(after);
          // Round 2 (logic P1): a declaration naming a field the BASELINE contract does not have (a typo, a stale
          // rename, or a valid name mixed with an invalid one) is unusable: the edge counts as undeclared AND the
          // unreliable evidence is recorded as an unknown, so the verdict can never be a silent NO_KNOWN_IMPACT.
          const unusable = declared !== undefined && declared.some((name) => name !== "g" || before === null);
          const expected = oracleBreaks(before, after, unusable ? undefined : declared);
          // Adding an optional field is not a change that can break anyone, so no edge is examined and nothing is recorded.
          const examined = !identical && !(before === null && after !== null && !after.required);
          if (unusable && examined) {
            expect(a.unknowns.map((u) => u.code)).toEqual(["EDGE_FIELD_NOT_IN_CONTRACT"]);
            expect(a.assessment).toBe("INCOMPLETE");
            expect(a.findings.length > 0, "the undeclared rule still decides whether a finding exists").toBe(expected);
            return;
          }
          expect(a.unknowns).toEqual([]);
          expect(a.assessment, identical ? "no change" : "change").toBe(expected ? "AFFECTED" : "NO_KNOWN_IMPACT");
        });
      }
    }
  }
  it("covers 100 combinations", () => {
    expect(combos).toBe(100);
  });
});

describe("R1 P1: version change rules (diff.ts:196), including downgrades, prereleases and the v prefix", () => {
  const versions = ["1.2.3", "v1.2.3", "1.2.4", "1.3.0", "1.2.2", "1.1.9", "2.0.0", "0.9.0", "0.1.0", "0.2.0", "1.2.3-rc.1", "1.2.3+build.5", "1.2.3-rc.2", "release-7"];

  /** Oracle: what a careful reader of DOMAIN.md would call breaking for dependents. */
  function oracleBreaking(before: string, after: string): boolean {
    const parse = (v: string) => {
      const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v);
      return m ? { core: [Number(m[1]), Number(m[2]), Number(m[3])] as const, pre: m[4] ?? null } : null;
    };
    const b = parse(before);
    const a = parse(after);
    if (!b || !a) return true;
    if (b.core[0] !== a.core[0]) return true;
    if (b.core[0] === 0 && b.core[1] !== a.core[1]) return true;
    // Round 2: 0.0.x is breaking on any patch change, and a prerelease TARGET is breaking unless it is unchanged.
    if (b.core[0] === 0 && b.core[1] === 0 && b.core[2] !== a.core[2]) return true;
    const sameCore = b.core[1] === a.core[1] && b.core[2] === a.core[2];
    if (a.pre !== null && !(sameCore && b.pre === a.pre)) return true;
    for (let i = 1; i < 3; i += 1) {
      if (a.core[i]! < b.core[i]!) return true;
      if (a.core[i]! > b.core[i]!) return false;
    }
    if (b.pre === a.pre) return false;
    if (b.pre !== null && a.pre === null) return false;
    return true;
  }

  const contractDoc = (version: string) => {
    const nodes = [n("contract.c", "contract", { fields: [f("a")], version }), n("svc.x", "service")];
    return manifest(nodes, [e("svc.x", "contract.c", "consumes")]);
  };
  let compared = 0;
  for (const before of versions) {
    for (const after of versions) {
      if (before === after) continue;
      compared += 1;
      it(`${before} -> ${after}`, () => {
        const a = verdict(contractDoc(before), contractDoc(after));
        expect(a.unknowns).toEqual([]);
        expect(a.assessment).toBe(oracleBreaking(before, after) ? "AFFECTED" : "NO_KNOWN_IMPACT");
      });
    }
  }
  it("compared every ordered pair", () => {
    expect(compared).toBe(versions.length * (versions.length - 1));
  });
  it("a major version downgrade is breaking (rollback 1.2.3 to 0.9.0)", () => {
    expect(verdict(contractDoc("1.2.3"), contractDoc("0.9.0")).assessment).toBe("AFFECTED");
  });
});

describe("R1 P2: baseline hash comparison is exact (assess.ts:130)", () => {
  const actual = "sha256:" + "0123456789abcdef".repeat(4);
  it("a single flipped hex digit at any position is stale", () => {
    for (let i = 0; i < 64; i += 1) {
      const at = "sha256:".length + i;
      const flipped = actual.slice(0, at) + (actual[at] === "0" ? "1" : "0") + actual.slice(at + 1);
      expect(checkBaselineHash(actual, flipped), `position ${i}`).toBeInstanceOf(StaleBaselineError);
    }
    expect(checkBaselineHash(actual, actual)).toBeNull();
    expect(checkBaselineHash(actual, actual.toUpperCase())).toBeInstanceOf(InvalidExpectedHashError);
  });
});

/* ---------- combination and metamorphic properties ---------- */

/** contract.c (a, b) <- svc.d1 <- svc.d2; svc.d3 declares only `a` (so a removal of b excludes it). */
function pristine(): { base: Doc; proposed: Doc } {
  const nodes = [
    n("contract.c", "contract", { owner: "team-c", fields: [f("a"), f("b")] }),
    n("svc.d1", "service", { owner: "team-1" }),
    n("svc.d2", "service", { owner: "team-2" }),
    n("svc.d3", "service", { owner: "team-3" }),
  ];
  const edges = [
    e("svc.d1", "contract.c", "consumes"),
    e("svc.d2", "svc.d1", "consumes"),
    e("svc.d3", "contract.c", "consumes", { fields: ["a"] }),
  ];
  const base = manifest(nodes, edges) as unknown as Doc;
  const proposed = clone(base);
  proposed.nodes[0]!.contract.fields = [f("a")];
  return { base, proposed };
}

interface Scenario {
  base: Doc;
  proposed: Doc;
  checks: ContractCheckResult[];
}
const edgeOf = (d: Doc, source: string, target: string) => d.edges.find((x) => x.source_id === source && x.target_id === target)!;
const nodeOf = (d: Doc, id: string) => d.nodes.find((x) => x.id === id)!;

/** Fourteen independent sources of uncertainty. Each must force INCOMPLETE on its own. */
const SOURCES: [string, (s: Scenario) => void][] = [
  ["stale direct edge", (s) => (edgeOf(s.base, "svc.d1", "contract.c").verified_at = STALE)],
  ["stale edge further along the path", (s) => (edgeOf(s.base, "svc.d2", "svc.d1").verified_at = STALE)],
  ["never verified direct edge", (s) => (edgeOf(s.base, "svc.d1", "contract.c").verified_at = null)],
  ["never verified path edge", (s) => (edgeOf(s.base, "svc.d2", "svc.d1").verified_at = null)],
  ["future dated edge", (s) => (edgeOf(s.base, "svc.d1", "contract.c").verified_at = FUTURE)],
  ["consumer without owner", (s) => delete nodeOf(s.base, "svc.d1").owner],
  ["origin without owner", (s) => delete nodeOf(s.base, "contract.c").owner],
  ["placeholder consumer", (s) => (nodeOf(s.base, "svc.d2").placeholder = true)],
  ["excluded (declared) consumer with a stale edge", (s) => (edgeOf(s.base, "svc.d3", "contract.c").verified_at = STALE)],
  ["excluded (declared) consumer with a never verified edge", (s) => (edgeOf(s.base, "svc.d3", "contract.c").verified_at = null)],
  ["check FAILED", (s) => s.checks.push(result("FAILED", "chk.failed", "contract.c"))],
  ["check TIMED_OUT", (s) => s.checks.push(result("TIMED_OUT", "chk.timeout", "contract.c"))],
  ["check ERROR", (s) => s.checks.push(result("ERROR", "chk.error", "contract.c"))],
  ["check UNKNOWN", (s) => s.checks.push(result("UNKNOWN", "chk.unknown", "svc.d1"))],
];

function scenarioWith(indexes: number[]): Scenario {
  const { base, proposed } = pristine();
  const s: Scenario = { base, proposed, checks: [] };
  for (const i of indexes) SOURCES[i]![1](s);
  return s;
}
const run = (s: Scenario) => verdict(s.base, s.proposed, s.checks);

describe("R1 combinations: every uncertainty source alone and in pairs forces INCOMPLETE and keeps the known findings", () => {
  it("pristine control: the change is AFFECTED with two findings and no unknowns", () => {
    const a = run(scenarioWith([]));
    expect(a.assessment).toBe("AFFECTED");
    expect(a.findings.map((x) => x.consumer_id)).toEqual(["svc.d1", "svc.d2"]);
    expect(a.unknowns).toEqual([]);
  });

  SOURCES.forEach(([name], i) => {
    it(`alone: ${name}`, () => {
      const a = run(scenarioWith([i]));
      expect(a.assessment).toBe("INCOMPLETE");
      expect(a.unknowns.length).toBeGreaterThan(0);
      expect(a.findings.map((x) => x.consumer_id)).toEqual(["svc.d1", "svc.d2"]);
    });
  });

  let pairs = 0;
  for (let i = 0; i < SOURCES.length; i += 1) {
    for (let j = i + 1; j < SOURCES.length; j += 1) {
      pairs += 1;
      it(`pair: ${SOURCES[i]![0]} + ${SOURCES[j]![0]}`, () => {
        const a = run(scenarioWith([i, j]));
        expect(a.assessment).toBe("INCOMPLETE");
        expect(a.findings.map((x) => x.consumer_id)).toEqual(["svc.d1", "svc.d2"]);
      });
    }
  }
  it("covers all 91 pairs", () => expect(pairs).toBe(91));

  it("uncertainty from check results alone forces INCOMPLETE even when the proposal changes nothing that propagates", () => {
    const { base } = pristine();
    for (const state of ["FAILED", "TIMED_OUT", "ERROR", "UNKNOWN"] as const) {
      const a = verdict(base, base, [result(state, "chk.x", "contract.c")]);
      expect(a.assessment, state).toBe("INCOMPLETE");
      expect(a.findings).toEqual([]);
    }
    expect(verdict(base, base).assessment).toBe("NO_KNOWN_IMPACT");
  });

  it("an undeclared contract on either side is an unknown", () => {
    const { base, proposed } = pristine();
    delete proposed.nodes[0]!.contract;
    const a = verdict(base, proposed);
    expect(a.assessment).toBe("INCOMPLETE");
    expect(a.unknowns.map((u) => u.code)).toContain("UNDECLARED_CONTRACT");
  });
});

describe("R1 metamorphic properties of the assessment", () => {
  /** Random graph: a contract with fields, services consuming it and each other, some evidence gaps. */
  function randomScenario(seed: number): Scenario {
    const rnd = prng(seed);
    const count = 4 + Math.floor(rnd() * 8);
    const nodes: Record<string, unknown>[] = [n("contract.c", "contract", { owner: "team-c", fields: [f("a"), f("b"), f("c", "number", false)] })];
    const edges: Record<string, unknown>[] = [];
    for (let i = 0; i < count; i += 1) {
      const owned = rnd() > 0.15;
      nodes.push(n(`svc.n${i}`, "service", owned ? {} : { owner: null }));
      const verified = rnd() < 0.6 ? FRESH : rnd() < 0.5 ? STALE : null;
      if (i === 0 || rnd() < 0.4) {
        edges.push(e(`svc.n${i}`, "contract.c", "consumes", { verified_at: verified, ...(rnd() < 0.4 ? { fields: rnd() < 0.5 ? ["a"] : ["b", "c"] } : {}) }));
      } else {
        edges.push(e(`svc.n${i}`, `svc.n${Math.floor(rnd() * i)}`, "consumes", { verified_at: verified }));
      }
    }
    const base = manifest(nodes, edges) as unknown as Doc;
    const proposed = clone(base);
    const fields = proposed.nodes[0]!.contract.fields as any[];
    const pick = rnd();
    if (pick < 0.4) fields.splice(Math.floor(rnd() * 2), 1);
    else if (pick < 0.7) fields[0].type = "integer";
    else fields[1].required = false;
    return { base, proposed, checks: [] };
  }

  const seeds = Array.from({ length: 200 }, (_, i) => 1000 + i);

  it("adding PASSED evidence never changes the assessment", () => {
    for (const seed of seeds) {
      const s = randomScenario(seed);
      const plain = run(s);
      const withPassed = verdict(s.base, s.proposed, [result("PASSED", "chk.ok1", "contract.c"), result("PASSED", "chk.ok2", "svc.n0")]);
      expect(canonicalJson(withPassed), `seed ${seed}`).toBe(canonicalJson(plain));
    }
  });

  it("adding any non-PASSED evidence forces INCOMPLETE and never removes or adds a finding", () => {
    for (const seed of seeds) {
      const s = randomScenario(seed);
      const plain = run(s);
      for (const state of ["FAILED", "TIMED_OUT", "ERROR", "UNKNOWN"] as const) {
        const worse = verdict(s.base, s.proposed, [result(state, "chk.bad", "contract.c")]);
        expect(worse.assessment, `seed ${seed} ${state}`).toBe("INCOMPLETE");
        expect(canonicalJson(worse.findings)).toBe(canonicalJson(plain.findings));
      }
    }
  });

  it("the order of the check results never changes the output", () => {
    const s = scenarioWith([]);
    const results = [result("PASSED", "chk.a", "contract.c"), result("FAILED", "chk.b", "svc.d1"), result("TIMED_OUT", "chk.c", "svc.d2"), result("PASSED", "chk.d", "svc.d3")];
    const reference = canonicalJson(verdict(s.base, s.proposed, results));
    const rnd = prng(7);
    for (let i = 0; i < 25; i += 1) {
      expect(canonicalJson(verdict(s.base, s.proposed, shuffled(results, rnd)))).toBe(reference);
    }
  });

  it("several requirements sharing one receipt: a failing check is never hidden by another check that passed, in either order", () => {
    const s = scenarioWith([]);
    const failed = result("FAILED", "chk.shared", "contract.c");
    const passed = result("PASSED", "chk.shared", "contract.c");
    for (const order of [[failed, passed], [passed, failed]]) {
      const a = verdict(s.base, s.proposed, order);
      expect(a.assessment).toBe("INCOMPLETE");
      expect(a.unknowns.map((u) => u.code)).toEqual(["CHECK_FAILED"]);
    }
    // Several checks on different nodes: one bad receipt among many good ones is still visible.
    const many = [result("PASSED", "chk.1", "contract.c"), result("PASSED", "chk.2", "svc.d1"), result("ERROR", "chk.3", "svc.d2"), result("PASSED", "chk.4", "svc.d3")];
    const b = verdict(s.base, s.proposed, many);
    expect(b.unknowns.map((u) => u.code)).toEqual(["CHECK_ERROR"]);
  });

  it("degrading the baseline evidence never lowers the verdict rank", () => {
    const rank = { NO_KNOWN_IMPACT: 0, AFFECTED: 1, INCOMPLETE: 2 } as const;
    let stricter = 0;
    for (const seed of seeds) {
      const s = randomScenario(seed);
      const good = clone(s.base);
      for (const edge of good.edges) edge.verified_at = FRESH;
      for (const node of good.nodes) node.owner = node.owner ?? "team-x";
      const proposedGood = clone(s.proposed);
      for (const edge of proposedGood.edges) edge.verified_at = FRESH;
      for (const node of proposedGood.nodes) node.owner = node.owner ?? "team-x";
      const pristineVerdict = verdict(good, proposedGood).assessment;
      const degraded = run(s).assessment;
      expect(rank[degraded], `seed ${seed}`).toBeGreaterThanOrEqual(rank[pristineVerdict]);
      if (rank[degraded] > rank[pristineVerdict]) stricter += 1;
    }
    expect(stricter).toBeGreaterThan(20);
  });

  it("NO_KNOWN_IMPACT never coexists with an unknown or a finding", () => {
    for (const seed of seeds) {
      const a = run(randomScenario(seed));
      if (a.assessment === "NO_KNOWN_IMPACT") {
        expect(a.unknowns).toEqual([]);
        expect(a.findings).toEqual([]);
      }
      if (a.unknowns.length > 0) expect(a.assessment).toBe("INCOMPLETE");
    }
  });
});

describe("R1 P2: consumer-side changes and coverage statements", () => {
  it("a proposal that makes a consumer declare a field the contract does not have is INCOMPLETE (EDGE_FIELD_NOT_IN_CONTRACT)", () => {
    const base = manifest([n("contract.c", "contract", { fields: [f("a")] }), n("svc.x", "service")], [e("svc.x", "contract.c", "consumes", { fields: ["a"] })]) as unknown as Doc;
    const proposed = clone(base);
    proposed.edges[0]!.fields = ["a", "ghost"];
    const a = verdict(base, proposed);
    expect(a.assessment).toBe("INCOMPLETE");
    expect(a.unknowns.map((u) => u.code)).toEqual(["EDGE_FIELD_NOT_IN_CONTRACT"]);
    expect(a.unknowns[0]!.message).toContain("ghost");
  });

  it("controls: an unchanged pre-existing ghost declaration, or a valid new declaration, is not flagged", () => {
    const ghost = manifest([n("contract.c", "contract", { fields: [f("a")] }), n("svc.x", "service")], [e("svc.x", "contract.c", "consumes", { fields: ["a", "ghost"] })]) as unknown as Doc;
    expect(verdict(ghost, clone(ghost)).unknowns).toEqual([]);
    const valid = manifest([n("contract.c", "contract", { fields: [f("a"), f("b")] }), n("svc.x", "service")], [e("svc.x", "contract.c", "consumes", { fields: ["a"] })]) as unknown as Doc;
    const proposed = clone(valid);
    proposed.edges[0]!.fields = ["a", "b"];
    expect(verdict(valid, proposed).unknowns).toEqual([]);
  });

  it("live_checks disabled or none_selected adds the LIVE_CHECKS_NOT_RUN limit, ran does not, and omitting it says nothing", () => {
    const { base, proposed } = pristine();
    const limitsFor = (live?: "ran" | "disabled" | "none_selected") => {
      const b = build(base);
      const r = assess({ baseline: b, proposed: build(proposed), expected_hash: b.hash, clock, ...(live ? { live_checks: live } : {}) });
      if (!r.ok) throw new Error("assess failed");
      return r.assessment.coverage.limits.map((l) => l.code);
    };
    expect(limitsFor("disabled")).toContain("LIVE_CHECKS_NOT_RUN");
    expect(limitsFor("none_selected")).toContain("LIVE_CHECKS_NOT_RUN");
    expect(limitsFor("ran")).not.toContain("LIVE_CHECKS_NOT_RUN");
    expect(limitsFor()).not.toContain("LIVE_CHECKS_NOT_RUN");
  });

  it("missing_check_keys are unknowns even when nothing else propagates, and are deduplicated by key", () => {
    const { base } = pristine();
    const b = build(base);
    const r = assess({ baseline: b, proposed: b, expected_hash: b.hash, clock, missing_check_keys: ["chk.b", "chk.a", "chk.a"] });
    if (!r.ok) throw new Error("assess failed");
    expect(r.assessment.assessment).toBe("INCOMPLETE");
    expect(r.assessment.unknowns.map((u) => u.code)).toEqual(["CHECK_NOT_RUN", "CHECK_NOT_RUN"]);
  });
});
