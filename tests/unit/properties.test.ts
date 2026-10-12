import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../src/domain/canonical.js";
import { NODE_KINDS, RELATIONS, type NodeKind, type Relation } from "../../src/domain/types.js";
import { assess } from "../../src/services/assess.js";
import { traverseDependents } from "../../src/services/diff.js";
import type { DependencyGraph } from "../../src/services/graph.js";
import { FRESH, STALE, build, clock, manifest, prng, shuffled } from "../helpers/builders.js";

interface GenOptions {
  nodes: number;
  edges: number;
  /** Probability scale for missing owners, placeholders, unverified and stale edges (0 = fully specified). */
  gaps: number;
}

type Doc = { nodes: Record<string, any>[]; edges: Record<string, any>[] };

/** Random but always valid manifest, including self loops and back edges (cycles). */
function randomDoc(random: () => number, { nodes: nodeCount, edges: edgeCount, gaps }: GenOptions): Doc {
  const nodes: Record<string, any>[] = [];
  for (let i = 0; i < nodeCount; i += 1) {
    const kind: NodeKind = NODE_KINDS[Math.floor(random() * NODE_KINDS.length)]!;
    const node: Record<string, any> = {
      id: `n${i}`,
      kind,
      version: "1.0.0",
      owner: random() < gaps * 1.5 ? null : `team-${i % 5}`,
    };
    if (random() < gaps * 0.5) node.placeholder = true;
    if (kind === "contract") node.contract = { fields: [{ name: "f", type: "string", required: true }] };
    nodes.push(node);
  }
  const seen = new Set<string>();
  const edges: Record<string, any>[] = [];
  for (let i = 0; i < edgeCount; i += 1) {
    const s = Math.floor(random() * nodeCount);
    const t = Math.floor(random() * nodeCount);
    const relation: Relation = RELATIONS[Math.floor(random() * RELATIONS.length)]!;
    const key = `${s}|${t}|${relation}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let verified: string | null = FRESH;
    const roll = random();
    if (roll < gaps) verified = null;
    else if (roll < gaps * 2) verified = STALE;
    edges.push({ source_id: `n${s}`, target_id: `n${t}`, relation, source_file: "gen.yaml", source_line: 1 + (i % 50), verified_at: verified });
  }
  return manifest(nodes, edges) as unknown as Doc;
}

/** Independent oracle: impact successors computed straight from the manifest document. */
function successors(doc: Doc): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const node of doc.nodes) map.set(node.id, []);
  for (const edge of doc.edges) {
    const [from, to] = edge.relation === "produces" ? [edge.source_id, edge.target_id] : [edge.target_id, edge.source_id];
    map.get(from)!.push(to);
  }
  return map;
}

function reachable(succ: Map<string, string[]>, origin: string): Set<string> {
  const seen = new Set<string>();
  const stack = [...succ.get(origin)!];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    stack.push(...succ.get(cur)!);
  }
  return seen; // may include origin when it sits on a cycle
}

const SEEDS = Array.from({ length: 150 }, (_, i) => i + 1);

describe("property: cycle termination on generated graphs (AC-03)", () => {
  it("every traversal terminates, visits each node once, and matches an independent reachability oracle", () => {
    for (const seed of SEEDS) {
      const random = prng(seed);
      const doc = randomDoc(random, { nodes: 3 + Math.floor(random() * 40), edges: Math.floor(random() * 120), gaps: 0 });
      const graph = build(doc);
      const succ = successors(doc);
      for (const node of graph.nodes) {
        const traversal = traverseDependents(graph, node.id);
        const ids = traversal.reached.map((r) => r.node_id);
        expect(new Set(ids).size, `seed ${seed} origin ${node.id}: duplicates`).toBe(ids.length);
        expect(ids).not.toContain(node.id);
        const expected = reachable(succ, node.id);
        expected.delete(node.id);
        expect(new Set(ids), `seed ${seed} origin ${node.id}: reachable set`).toEqual(expected);
        for (const reached of traversal.reached) {
          expect(reached.hops).toHaveLength(reached.depth);
          expect(reached.hops[0]!.from).toBe(node.id);
          expect(reached.hops.at(-1)!.to).toBe(reached.node_id);
          reached.hops.forEach((hop, i) => {
            if (i > 0) expect(hop.from).toBe(reached.hops[i - 1]!.to);
          });
        }
      }
    }
  });

  it("cycle detection agrees with an independent transitive-closure oracle", () => {
    for (const seed of SEEDS) {
      const random = prng(seed * 7919);
      const doc = randomDoc(random, { nodes: 3 + Math.floor(random() * 25), edges: Math.floor(random() * 60), gaps: 0 });
      const graph = build(doc);
      const succ = successors(doc);
      const onCycle = new Set(doc.nodes.map((n) => n.id).filter((id) => reachable(succ, id).has(id)));
      const reported = new Set(graph.cycles.flatMap((c) => [...c.members]));
      expect(reported, `seed ${seed}`).toEqual(onCycle);
      // Members of one reported cycle can all reach each other.
      for (const cycle of graph.cycles) {
        for (const a of cycle.members) for (const b of cycle.members) if (a !== b) expect(reachable(succ, a).has(b)).toBe(true);
      }
    }
  });
});

describe("property: determinism under shuffled input (AC-03)", () => {
  it("shuffling nodes, edges and contract fields never changes the hash or the assessment", () => {
    for (const seed of SEEDS.slice(0, 60)) {
      const random = prng(seed * 31);
      const doc = randomDoc(random, { nodes: 4 + Math.floor(random() * 20), edges: Math.floor(random() * 60), gaps: 0.1 });
      const proposedDoc = JSON.parse(JSON.stringify(doc)) as Doc;
      const target = proposedDoc.nodes[Math.floor(random() * proposedDoc.nodes.length)]!;
      target.version = "2.0.0";

      const baseline = build(doc);
      const proposed = build(proposedDoc);
      const first = assess({ baseline, proposed, expected_hash: baseline.hash, clock });

      const doc2 = { ...doc, nodes: shuffled(doc.nodes, random), edges: shuffled(doc.edges, random) };
      const proposed2 = { ...proposedDoc, nodes: shuffled(proposedDoc.nodes, random), edges: shuffled(proposedDoc.edges, random) };
      const b2 = build(doc2);
      const p2 = build(proposed2);
      const second = assess({ baseline: b2, proposed: p2, expected_hash: b2.hash, clock });

      expect(b2.hash).toBe(baseline.hash);
      expect(p2.hash).toBe(proposed.hash);
      expect(canonicalJson(second)).toBe(canonicalJson(first));
    }
  });
});

describe("property: unknowns never become a safe verdict (AC-04)", () => {
  it("verdict equals an independent oracle for random graphs with missing owners, stale and unverified edges", () => {
    let incomplete = 0;
    let affected = 0;
    let safe = 0;
    for (const seed of SEEDS) {
      const random = prng(seed * 104729);
      const doc = randomDoc(random, { nodes: 3 + Math.floor(random() * 25), edges: Math.floor(random() * 70), gaps: [0, 0.01, 0.04, 0.1][seed % 4]! });
      const proposedDoc = JSON.parse(JSON.stringify(doc)) as Doc;
      const originIndex = Math.floor(random() * proposedDoc.nodes.length);
      const origin = proposedDoc.nodes[originIndex]!;
      origin.version = "2.0.0"; // major bump: propagates to all dependents, no field level filtering

      const baseline: DependencyGraph = build(doc);
      const proposed = build(proposedDoc);
      const result = assess({ baseline, proposed, expected_hash: baseline.hash, clock });
      if (!result.ok) throw new Error("unexpected stale");

      // Oracle
      const succ = successors(doc);
      const reach = reachable(succ, origin.id);
      reach.delete(origin.id);
      const examinedNodes = new Set([origin.id, ...reach]);
      let unknown = false;
      for (const id of examinedNodes) {
        const node = doc.nodes.find((n) => n.id === id)!;
        if (node.owner === null || node.placeholder === true) unknown = true;
      }
      for (const edge of doc.edges) {
        const from = edge.relation === "produces" ? edge.source_id : edge.target_id;
        if (!examinedNodes.has(from)) continue;
        if (edge.verified_at === null || edge.verified_at === STALE) unknown = true;
      }
      const expected = unknown ? "INCOMPLETE" : reach.size > 0 ? "AFFECTED" : "NO_KNOWN_IMPACT";
      expect(result.assessment.assessment, `seed ${seed}`).toBe(expected);
      expect(new Set(result.assessment.findings.map((f) => f.consumer_id))).toEqual(reach);

      // The invariant itself: a safe verdict never coexists with an unknown.
      if (result.assessment.assessment === "NO_KNOWN_IMPACT") expect(result.assessment.unknowns).toEqual([]);
      if (expected === "INCOMPLETE") incomplete += 1;
      else if (expected === "AFFECTED") affected += 1;
      else safe += 1;
    }
    // The generator must actually exercise all three verdicts, otherwise the test proves little.
    expect(incomplete).toBeGreaterThan(10);
    expect(affected).toBeGreaterThan(3);
    expect(safe).toBeGreaterThan(3);
  });
});
