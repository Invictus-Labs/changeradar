import { describe, expect, it } from "vitest";
import { assess } from "../../src/services/assess.js";
import { buildGraph, buildGraphFromJson } from "../../src/services/graph.js";
import { clock, e, manifest, n, prng } from "../helpers/builders.js";

/** A DAG with exactly `nodeCount` nodes and `edgeCount` unique edges. */
function scaled(nodeCount: number, edgeCount: number) {
  const random = prng(2026);
  const nodes = Array.from({ length: nodeCount }, (_, i) => n(`n${i}`, i === 0 ? "contract" : "service", { owner: `team-${i % 25}` }));
  const seen = new Set<string>();
  const edges: Record<string, unknown>[] = [];
  while (edges.length < edgeCount) {
    const s = 1 + Math.floor(random() * (nodeCount - 1));
    const t = Math.floor(random() * s);
    const key = `${s}|${t}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push(e(`n${s}`, `n${t}`, "consumes"));
  }
  return manifest(nodes, edges);
}

describe("AC-09 limits at full scale (10,000 nodes / 50,000 edges)", () => {
  it("accepts exactly the documented maximum, builds, and assesses it", () => {
    const doc = scaled(10_000, 50_000);
    const text = JSON.stringify(doc);
    expect(Buffer.byteLength(text)).toBeLessThan(25 * 1024 * 1024);
    const result = buildGraphFromJson(text);
    if (!result.ok) throw new Error("rejected: " + JSON.stringify(result.failure.issues));
    expect(result.graph.nodes).toHaveLength(10_000);
    expect(result.graph.edges).toHaveLength(50_000);

    const proposedDoc = JSON.parse(text) as { nodes: { version: string }[] };
    proposedDoc.nodes[0]!.version = "2.0.0";
    const proposed = buildGraph(proposedDoc);
    if (!proposed.ok) throw new Error("proposal rejected");
    const assessed = assess({ baseline: result.graph, proposed: proposed.graph, expected_hash: result.graph.hash, clock });
    if (!assessed.ok) throw new Error("assess failed");
    expect(assessed.assessment.summary.findings).toBeGreaterThan(0);
  });

  it("rejects one node over the maximum and one edge over the maximum", () => {
    const tooManyNodes = buildGraph(scaled(10_001, 100));
    expect(tooManyNodes.ok).toBe(false);
    if (!tooManyNodes.ok) expect(tooManyNodes.failure.code).toBe("TOO_MANY_NODES");

    const doc = scaled(1000, 100) as { edges: unknown[] };
    doc.edges = new Array(50_001).fill(null);
    const tooManyEdges = buildGraph(doc);
    expect(tooManyEdges.ok).toBe(false);
    if (!tooManyEdges.ok) expect(tooManyEdges.failure.code).toBe("TOO_MANY_EDGES");
  });
});
