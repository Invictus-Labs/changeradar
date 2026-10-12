import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../src/domain/canonical.js";
import { fixedClock } from "../../src/domain/clock.js";
import { assess, type Assessment } from "../../src/services/assess.js";
import { PATH_HEAD_HOPS, PATH_TAIL_HOPS, traverseDependents } from "../../src/services/diff.js";
import { NOW_ISO, STALE, build, e, f, manifest, n, shuffled, prng } from "../helpers/builders.js";
import { bumped, chain, lattice, star, starWithoutFields } from "../helpers/scale-shapes.js";

/**
 * Review round 1 P1: assessment output was quadratic in chain depth and F x K in fan-in. These tests pin the
 * bounded behaviour: caps hold, reaching a cap is an explicit INCOMPLETE unknown (never a safe verdict), stored
 * paths are elided at both ends, and a 10,000 node chain finishes in a small heap.
 */

const clock = fixedClock(NOW_ISO);
const probe = fileURLToPath(new URL("../helpers/scale-probe.ts", import.meta.url));

function run(baselineDoc: unknown, proposedDoc: unknown, config: Record<string, number> = {}): Assessment {
  const baseline = build(baselineDoc);
  const proposed = build(proposedDoc);
  const result = assess({ baseline, proposed, expected_hash: baseline.hash, clock, config });
  if (!result.ok) throw new Error("assess refused: " + result.error.code);
  return result.assessment;
}
const bytes = (a: Assessment): number => JSON.stringify(a).length;

describe("R1 P1 scale: bounded findings (assess.ts:201, diff.ts:391)", () => {
  it("a 200 node chain with every node bumped no longer produces 19,900 findings or a 199 MB document", () => {
    const a = run(chain(200), bumped(chain(200), "all"));
    expect(a.findings.length).toBeLessThanOrEqual(5_000);
    expect(bytes(a)).toBeLessThan(20 * 1024 * 1024);
    expect(a.assessment).toBe("INCOMPLETE");
    expect(a.unknowns.map((u) => u.code)).toContain("FINDINGS_TRUNCATED");
    expect(a.coverage.limits.map((l) => l.code)).toContain("FINDINGS_TRUNCATED");
    expect(a.summary.findings_omitted).toBe(19_900 - a.findings.length);
    // What was found is still shown: the direct consumers come first.
    expect(a.findings[0]).toMatchObject({ direct: true, severity: "high" });
    expect(a.summary.known_impact).toBe(true);
  });

  it("a 2000 node chain bumped at its head records at most the per-origin cap, with elided paths, in a few MB", () => {
    const a = run(chain(2000), bumped(chain(2000), [0]));
    expect(a.findings.length).toBe(1_000);
    expect(a.assessment).toBe("INCOMPLETE");
    expect(a.unknowns.map((u) => u.code)).toEqual(["FINDINGS_TRUNCATED"]);
    expect(a.summary.findings_omitted).toBe(999);
    expect(bytes(a)).toBeLessThan(6 * 1024 * 1024);
    const deepest = a.findings.at(-1)!;
    expect(deepest.depth).toBe(1_000);
    expect(deepest.path).toHaveLength(1 + PATH_HEAD_HOPS + PATH_TAIL_HOPS);
    expect(deepest.hops).toHaveLength(PATH_HEAD_HOPS + PATH_TAIL_HOPS);
    expect(deepest.path_omitted_hops).toBe(1_000 - PATH_HEAD_HOPS - PATH_TAIL_HOPS);
  });

  it("a chain below the caps is not truncated: complete paths, no unknown, no extra fields", () => {
    const a = run(chain(PATH_HEAD_HOPS + PATH_TAIL_HOPS + 1), bumped(chain(PATH_HEAD_HOPS + PATH_TAIL_HOPS + 1), [0]));
    expect(a.assessment).toBe("AFFECTED");
    expect(a.findings).toHaveLength(PATH_HEAD_HOPS + PATH_TAIL_HOPS);
    for (const finding of a.findings) {
      expect(finding.hops).toHaveLength(finding.depth);
      expect(finding.path).toHaveLength(finding.depth + 1);
      expect(finding).not.toHaveProperty("path_omitted_hops");
      expect(finding).not.toHaveProperty("change_ids_omitted");
    }
    expect(a.summary).not.toHaveProperty("findings_omitted");
  });

  it("F x K: 300 fields x 300 consumers stays small (change ids and reason text are capped)", () => {
    const a = run(star(300, 300), starWithoutFields(star(300, 300)));
    expect(a.findings).toHaveLength(300);
    expect(a.assessment).toBe("AFFECTED");
    for (const finding of a.findings) {
      expect(finding.change_ids.length).toBeLessThanOrEqual(20);
      expect(finding.change_ids_omitted).toBe(280);
      expect(finding.reason.length).toBeLessThan(600);
      expect(finding.reason).toContain("and 297 more change(s)");
    }
    expect(bytes(a)).toBeLessThan(2 * 1024 * 1024);
    // All 300 changes were evaluated and are listed, in one place.
    expect(a.changes).toHaveLength(300);
  });

  it("a 20 x 20 lattice with every node bumped stops at the caps instead of listing 76,000 findings", () => {
    // CPU time, not wall time: a loaded host stretches the wall clock of a test, not the work it does (a wall-clock overrun is never a finding)
    const before = process.cpuUsage();
    const a = run(lattice(20, 20), bumped(lattice(20, 20), "all"));
    expect(a.findings.length).toBeLessThanOrEqual(5_000);
    expect(a.assessment).toBe("INCOMPLETE");
    expect(a.unknowns.map((u) => u.code)).toContain("FINDINGS_TRUNCATED");
    const used = process.cpuUsage(before);
    expect((used.user + used.system) / 1000).toBeLessThan(30_000);
  });

  it("the traversal work budget stops a run and reports it (no safe verdict)", () => {
    const a = run(chain(400), bumped(chain(400), "all"), { max_traversal_links: 1_000 });
    expect(a.assessment).toBe("INCOMPLETE");
    expect(a.unknowns.find((u) => u.code === "FINDINGS_TRUNCATED")!.message).toMatch(/not analysed|only partly analysed/);
    const clean = run(chain(400), bumped(chain(400), [0]));
    expect(clean.unknowns.map((u) => u.code)).not.toContain("FINDINGS_TRUNCATED");
  });

  it("the finding byte budget is a hard cap", () => {
    const a = run(chain(300), bumped(chain(300), "all"), { max_finding_bytes: 100_000 });
    const findingBytes = a.findings.reduce((sum, x) => sum + JSON.stringify(x).length, 0);
    expect(findingBytes).toBeLessThanOrEqual(100_000);
    expect(a.assessment).toBe("INCOMPLETE");
  });

  it("the global finding cap applies across origins", () => {
    const a = run(chain(50), bumped(chain(50), "all"), { max_findings: 100 });
    expect(a.findings).toHaveLength(100);
    expect(a.assessment).toBe("INCOMPLETE");
    expect(a.summary.findings_omitted).toBe(50 * 49 / 2 - 100);
  });

  it("unknowns are capped and say so", () => {
    const nodes = [n("contract.c", "contract", { fields: [f("a")] })];
    const edges: Record<string, unknown>[] = [];
    for (let i = 0; i < 30; i += 1) {
      nodes.push(n(`svc.s${i}`, "service"));
      edges.push(e(`svc.s${i}`, "contract.c", "consumes", { verified_at: i % 2 === 0 ? STALE : null }));
    }
    const base = manifest(nodes, edges);
    const proposed = JSON.parse(JSON.stringify(base));
    proposed.nodes[0].contract.fields = [];
    const a = run(base, proposed, { max_unknowns: 10 });
    expect(a.assessment).toBe("INCOMPLETE");
    expect(a.unknowns).toHaveLength(11);
    expect(a.unknowns.map((u) => u.code)).toContain("UNKNOWNS_TRUNCATED");
  });

  it("the changes list is capped but every change is evaluated, propagating ones first", () => {
    const nodes = [n("contract.c", "contract", { fields: [f("a")] }), n("svc.x", "service")];
    for (let i = 0; i < 12; i += 1) nodes.push(n(`svc.owner${i}`, "service", { owner: "team-a" }));
    const base = manifest(nodes, [e("svc.x", "contract.c", "consumes")]);
    const proposed = JSON.parse(JSON.stringify(base));
    proposed.nodes[0].contract.fields = [];
    for (let i = 0; i < 12; i += 1) proposed.nodes[2 + i].owner = "team-b";
    const a = run(base, proposed, { max_changes_listed: 5 });
    expect(a.changes).toHaveLength(5);
    expect(a.changes.map((c) => c.kind)).toContain("contract_field_removed");
    expect(a.summary.changes).toBe(13);
    expect(a.summary.changes_omitted).toBe(8);
    expect(a.coverage.limits.map((l) => l.code)).toContain("CHANGES_LIST_TRUNCATED");
    expect(a.findings.map((x) => x.consumer_id)).toEqual(["svc.x"]);
  });

  it("truncated assessments are deterministic and independent of input order", () => {
    const base = chain(120);
    const proposed = bumped(base, "all");
    const first = run(base, proposed, { max_findings: 500 });
    const second = run(base, proposed, { max_findings: 500 });
    expect(canonicalJson(first)).toBe(canonicalJson(second));
    const rnd = prng(3);
    const shuffledBase = { ...base, nodes: shuffled(base.nodes, rnd), edges: shuffled(base.edges, rnd) };
    const shuffledProposed = { ...proposed, nodes: shuffled(proposed.nodes, rnd), edges: shuffled(proposed.edges, rnd) };
    expect(canonicalJson(run(shuffledBase, shuffledProposed, { max_findings: 500 }))).toBe(canonicalJson(first));
  });
});

describe("R1 P1 scale: bounded path form (diff.ts)", () => {
  it("boundedPath keeps the first and last hops in order and counts the ones in between", () => {
    const graph = build(chain(80));
    const t = traverseDependents(graph, "svc.n0");
    const deepest = t.reached.at(-1)!;
    expect(deepest.depth).toBe(79);
    const full = deepest.hops;
    const bounded = deepest.boundedPath();
    expect(full).toHaveLength(79);
    expect(bounded.omitted).toBe(79 - PATH_HEAD_HOPS - PATH_TAIL_HOPS);
    expect(bounded.hops.slice(0, PATH_HEAD_HOPS)).toEqual(full.slice(0, PATH_HEAD_HOPS));
    expect(bounded.hops.slice(PATH_HEAD_HOPS)).toEqual(full.slice(-PATH_TAIL_HOPS));
    expect(bounded.hops[0]!.from).toBe("svc.n0");
    expect(bounded.hops.at(-1)!.to).toBe("svc.n79");
  });

  it("a path of exactly head + tail hops is kept whole; one more is elided by one hop", () => {
    const graph = build(chain(PATH_HEAD_HOPS + PATH_TAIL_HOPS + 2));
    const t = traverseDependents(graph, "svc.n0");
    const at = (depth: number) => t.reached.find((r) => r.depth === depth)!.boundedPath();
    expect(at(PATH_HEAD_HOPS + PATH_TAIL_HOPS).omitted).toBe(0);
    expect(at(PATH_HEAD_HOPS + PATH_TAIL_HOPS + 1).omitted).toBe(1);
  });

  it("a traversal is a linear parent tree: a 10,000 node chain is traversed without materialising paths", () => {
    const graph = build(chain(10_000));
    const before = process.cpuUsage();
    const t = traverseDependents(graph, "svc.n0");
    expect(t.reached).toHaveLength(9_999);
    expect(t.truncated).toBe(false);
    const used = process.cpuUsage(before);
    expect((used.user + used.system) / 1000, "CPU milliseconds").toBeLessThan(10_000);
  });
});

interface ProbeSummary {
  verdict: string;
  findings: number;
  unknown_codes: string[];
  bytes: number;
  ms: number;
  longest_path: number;
}

function probeChild(args: string[], heapMb: number): { status: number | null; signal: string | null; summary: ProbeSummary | null; stderr: string } {
  const child = spawnSync(process.execPath, [`--max-old-space-size=${heapMb}`, "--import", "tsx", probe, ...args], { encoding: "utf8", timeout: 240_000, maxBuffer: 16 * 1024 * 1024 });
  let summary: ProbeSummary | null = null;
  try {
    summary = JSON.parse(child.stdout.trim().split("\n").at(-1) ?? "") as ProbeSummary;
  } catch {
    summary = null;
  }
  return { status: child.status, signal: child.signal, summary, stderr: child.stderr.slice(0, 400) };
}

describe("R1 P1 scale: hostile shapes in a small V8 heap (a crash here is an out-of-memory abort)", () => {
  it("a 10,000 node chain bumped at its head assesses in a 384 MB heap and reports truncation", () => {
    const r = probeChild(["chain", "10000", "head"], 384);
    expect(r.stderr).not.toMatch(/heap out of memory/i);
    expect(r.status).toBe(0);
    expect(r.summary!.verdict).toBe("INCOMPLETE");
    expect(r.summary!.unknown_codes).toContain("FINDINGS_TRUNCATED");
    expect(r.summary!.bytes).toBeLessThan(5 * 1024 * 1024);
    expect(r.summary!.longest_path).toBeLessThanOrEqual(1 + PATH_HEAD_HOPS + PATH_TAIL_HOPS);
  }, 300_000);

  it("a 10,000 node chain with EVERY node bumped is bounded in time and heap too", () => {
    const r = probeChild(["chain", "10000", "all"], 512);
    expect(r.stderr).not.toMatch(/heap out of memory/i);
    expect(r.status).toBe(0);
    expect(r.summary!.verdict).toBe("INCOMPLETE");
    expect(r.summary!.findings).toBeLessThanOrEqual(5_000);
    expect(r.summary!.bytes).toBeLessThan(40 * 1024 * 1024);
    expect(r.summary!.ms).toBeLessThan(120_000);
  }, 300_000);

  it("a 1000 x 1000 star (260 KB manifest, 1M change x consumer pairs) stays under a few MB", () => {
    const r = probeChild(["star", "1000"], 512);
    expect(r.stderr).not.toMatch(/heap out of memory/i);
    expect(r.status).toBe(0);
    expect(r.summary!.bytes).toBeLessThan(8 * 1024 * 1024);
  }, 300_000);

  it("a 30 x 30 lattice with every node bumped is bounded", () => {
    const r = probeChild(["lattice", "30", "all"], 512);
    expect(r.status).toBe(0);
    expect(r.summary!.verdict).toBe("INCOMPLETE");
    expect(r.summary!.findings).toBeLessThanOrEqual(5_000);
    expect(r.summary!.ms).toBeLessThan(60_000);
  }, 300_000);

  it("control: the probe itself reports a crash when the heap is far too small", () => {
    const r = probeChild(["chain", "3000", "head"], 8);
    expect(r.status === 0).toBe(false);
  }, 120_000);
});
