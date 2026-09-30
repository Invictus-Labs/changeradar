/**
 * Performance experiment for the deterministic core (docs/BENCHMARK.md).
 * Usage: npm run bench [-- --runs 5]
 * Generates synthetic manifests at the documented limits, then times import, diff and assessment.
 */
import os from "node:os";
import { fixedClock } from "../src/domain/clock.js";
import { assess } from "../src/services/assess.js";
import { buildGraphFromJson, type DependencyGraph } from "../src/services/graph.js";

const FRESH = "2026-09-28T00:00:00Z";
const clock = fixedClock("2026-09-29T00:00:00Z");

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Doc = { schema_version: 1; revision: string; provenance: { source: string }; nodes: any[]; edges: any[] };

/**
 * Layered synthetic graph: node i may only consume/require lower numbered nodes (a DAG), plus a
 * sprinkling of back edges so cycles exist. Contracts carry 12 fields.
 */
function generate(nodeCount: number, edgeCount: number, seed: number): Doc {
  const random = prng(seed);
  const kinds = ["service", "job", "contract", "credential_alias", "artifact"] as const;
  const nodes: any[] = [];
  for (let i = 0; i < nodeCount; i += 1) {
    const kind = i === 0 ? "contract" : kinds[i % kinds.length]!;
    const node: any = { id: `n${i}`, kind, owner: `team-${i % 40}`, version: "1.0.0" };
    if (kind === "contract") {
      node.contract = { fields: Array.from({ length: 12 }, (_, j) => ({ name: `field_${j}`, type: "string", required: j < 8 })) };
    }
    nodes.push(node);
  }
  const seen = new Set<string>();
  const edges: any[] = [];
  let guard = 0;
  while (edges.length < edgeCount && guard < edgeCount * 20) {
    guard += 1;
    const s = 1 + Math.floor(random() * (nodeCount - 1));
    const back = random() < 0.002;
    const t = back ? Math.min(nodeCount - 1, s + 1 + Math.floor(random() * 50)) : Math.floor(random() * s);
    const relation = random() < 0.8 ? "consumes" : "requires";
    const key = `${s}|${t}|${relation}`;
    if (seen.has(key) || s === t) continue;
    seen.add(key);
    edges.push({
      source_id: `n${s}`,
      target_id: `n${t}`,
      relation,
      source_file: `manifests/n${s}.yaml`,
      source_line: 1 + (edges.length % 400),
      verified_at: FRESH,
    });
  }
  return { schema_version: 1, revision: "bench", provenance: { source: "benchmark" }, nodes, edges };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function time<T>(fn: () => T): { ms: number; value: T } {
  const start = performance.now();
  const value = fn();
  return { ms: performance.now() - start, value };
}

function mem(): number {
  return Math.round(process.memoryUsage().rss / 1024 / 1024);
}

interface Row {
  scenario: string;
  bytes: number;
  import_ms: number[];
  assess_ms: number[];
  findings: number;
  verdict: string;
  rss_mb: number;
}

function scenario(name: string, nodes: number, edges: number, runs: number): Row {
  const doc = generate(nodes, edges, 7);
  const text = JSON.stringify(doc);
  const bytes = Buffer.byteLength(text, "utf8");
  const importTimes: number[] = [];
  const assessTimes: number[] = [];
  let graph: DependencyGraph | undefined;
  let findings = 0;
  let verdict = "";

  for (let r = 0; r < runs; r += 1) {
    const imported = time(() => buildGraphFromJson(text));
    if (!imported.value.ok) throw new Error("benchmark manifest rejected: " + imported.value.failure.code);
    graph = imported.value.graph;
    importTimes.push(imported.ms);

    // Proposal: bump the root contract to a new major version. Every node that depends (transitively) on n0 is a finding.
    const proposedDoc: Doc = { ...doc, nodes: doc.nodes.map((n, i) => (i === 0 ? { ...n, version: "2.0.0" } : n)) };
    const proposed = buildGraphFromJson(JSON.stringify(proposedDoc));
    if (!proposed.ok) throw new Error("proposal rejected");
    const assessed = time(() => assess({ baseline: graph!, proposed: proposed.graph, expected_hash: graph!.hash, clock }));
    if (!assessed.value.ok) throw new Error("assess failed");
    assessTimes.push(assessed.ms);
    findings = assessed.value.assessment.findings.length;
    verdict = assessed.value.assessment.assessment;
  }
  return { scenario: name, bytes, import_ms: importTimes, assess_ms: assessTimes, findings, verdict, rss_mb: mem() };
}

const runsArg = process.argv.indexOf("--runs");
const runs = runsArg > 0 ? Number(process.argv[runsArg + 1]) : 5;

const cpus = os.cpus();
console.log(`node ${process.version}, ${process.platform}/${process.arch}, ${cpus.length} logical CPUs (${cpus[0]?.model ?? "unknown"}), ${Math.round(os.totalmem() / 1024 ** 3)} GB RAM`);
console.log(`runs per scenario: ${runs}`);
console.log("");
console.log("| scenario | manifest size | import (median / min / max ms) | diff+assess (median / min / max ms) | findings | verdict | RSS after (MB) |");
console.log("| --- | --- | --- | --- | --- | --- | --- |");
for (const [name, nodes, edges] of [
  ["1,000 nodes / 5,000 edges", 1_000, 5_000],
  ["5,000 nodes / 25,000 edges", 5_000, 25_000],
  ["10,000 nodes / 50,000 edges (limit)", 10_000, 50_000],
] as const) {
  const row = scenario(name, nodes, edges, runs);
  const fmt = (v: number[]) => `${median(v).toFixed(0)} / ${Math.min(...v).toFixed(0)} / ${Math.max(...v).toFixed(0)}`;
  console.log(
    `| ${row.scenario} | ${(row.bytes / 1024 / 1024).toFixed(2)} MB | ${fmt(row.import_ms)} | ${fmt(row.assess_ms)} | ${row.findings} | ${row.verdict} | ${row.rss_mb} |`,
  );
}

/**
 * Adversarial shapes (review round 1): a valid manifest whose IMPACT output is far larger than the manifest. Long chains,
 * many changed origins and fan-in of many fields on many consumers. Output is bounded, so these finish quickly and say
 * INCOMPLETE (FINDINGS_TRUNCATED) instead of listing millions of findings.
 */
const own = (i: number) => `team-${i % 40}`;
function chainDoc(n: number, bump: "head" | "all"): { base: Doc; proposed: Doc } {
  const nodes = Array.from({ length: n }, (_, i) => ({ id: `n${i}`, kind: "service", owner: own(i), version: "1.0.0" }));
  const edges = Array.from({ length: n - 1 }, (_, i) => ({ source_id: `n${i + 1}`, target_id: `n${i}`, relation: "consumes", source_file: `manifests/n${i + 1}.yaml`, source_line: 1, verified_at: FRESH }));
  const base: Doc = { schema_version: 1, revision: "r", provenance: { source: "bench" }, nodes, edges };
  return { base, proposed: { ...base, nodes: nodes.map((x, i) => (bump === "all" || i === 0 ? { ...x, version: "2.0.0" } : x)) } };
}
function latticeDoc(layers: number, width: number): { base: Doc; proposed: Doc } {
  const nodes: any[] = [];
  const edges: any[] = [];
  for (let l = 0; l < layers; l += 1) {
    for (let w = 0; w < width; w += 1) {
      nodes.push({ id: `l${l}w${w}`, kind: "service", owner: own(l * width + w), version: "1.0.0" });
      if (l === 0) continue;
      for (const d of [-1, 0, 1]) if (w + d >= 0 && w + d < width) edges.push({ source_id: `l${l}w${w}`, target_id: `l${l - 1}w${w + d}`, relation: "consumes", source_file: "manifests/x.yaml", source_line: 1, verified_at: FRESH });
    }
  }
  const base: Doc = { schema_version: 1, revision: "r", provenance: { source: "bench" }, nodes, edges };
  return { base, proposed: { ...base, nodes: nodes.map((x) => ({ ...x, version: "2.0.0" })) } };
}
function starDoc(fields: number, consumers: number): { base: Doc; proposed: Doc } {
  const contract = { id: "contract.big", kind: "contract", owner: "team-big", version: "1.0.0", contract: { fields: Array.from({ length: fields }, (_, j) => ({ name: `f${j}`, type: "string", required: true })) } };
  const services = Array.from({ length: consumers }, (_, i) => ({ id: `s${i}`, kind: "service", owner: own(i), version: "1.0.0" }));
  const edges = services.map((s) => ({ source_id: s.id, target_id: "contract.big", relation: "consumes", source_file: "manifests/s.yaml", source_line: 1, verified_at: FRESH }));
  const base: Doc = { schema_version: 1, revision: "r", provenance: { source: "bench" }, nodes: [contract, ...services], edges };
  return { base, proposed: { ...base, nodes: [{ ...contract, contract: { fields: [] } }, ...services] } };
}

console.log("");
console.log("Adversarial shapes (output is bounded; a truncated run is INCOMPLETE):");
console.log("");
console.log("| shape | nodes / edges | diff+assess (median / min / max ms) | findings recorded | verdict | assessment JSON (MB) |");
console.log("| --- | --- | --- | --- | --- | --- |");
for (const [name, pair] of [
  ["chain 2,000, head bumped", chainDoc(2_000, "head")],
  ["chain 10,000, head bumped", chainDoc(10_000, "head")],
  ["chain 10,000, every node bumped", chainDoc(10_000, "all")],
  ["lattice 30 x 30, every node bumped", latticeDoc(30, 30)],
  ["1,000 fields x 1,000 consumers, all fields removed", starDoc(1_000, 1_000)],
] as const) {
  const baseline = buildGraphFromJson(JSON.stringify(pair.base));
  const proposed = buildGraphFromJson(JSON.stringify(pair.proposed));
  if (!baseline.ok || !proposed.ok) throw new Error(`shape ${name} rejected`);
  const times: number[] = [];
  let last: ReturnType<typeof assess> | undefined;
  for (let r = 0; r < Math.min(runs, 3); r += 1) {
    const t = time(() => assess({ baseline: baseline.graph, proposed: proposed.graph, expected_hash: baseline.graph.hash, clock }));
    times.push(t.ms);
    last = t.value;
  }
  if (!last || !last.ok) throw new Error("assess failed");
  const fmt = (v: number[]) => `${median(v).toFixed(0)} / ${Math.min(...v).toFixed(0)} / ${Math.max(...v).toFixed(0)}`;
  console.log(
    `| ${name} | ${pair.base.nodes.length} / ${pair.base.edges.length} | ${fmt(times)} | ${last.assessment.findings.length} | ${last.assessment.assessment} | ${(JSON.stringify(last.assessment).length / 1024 / 1024).toFixed(1)} |`,
  );
}
