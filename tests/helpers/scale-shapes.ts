import { FRESH, e, f, manifest, n } from "./builders.js";

/**
 * Valid manifests whose impact output is far larger than the manifest itself. Used by the scale and hostile-size
 * tests (review round 1: quadratic findings, path materialisation, F x K repetition).
 */

type Doc = { nodes: Record<string, any>[]; edges: Record<string, any>[] };

/** svc.n0 <- svc.n1 <- ... <- svc.n(count-1): every node depends on the previous one. */
export function chain(count: number): Doc {
  const nodes: Record<string, unknown>[] = [];
  const edges: Record<string, unknown>[] = [];
  for (let i = 0; i < count; i += 1) {
    nodes.push(n(`svc.n${i}`, "service", { owner: "team-chain" }));
    if (i > 0) edges.push(e(`svc.n${i}`, `svc.n${i - 1}`, "consumes", { verified_at: FRESH }));
  }
  return manifest(nodes, edges) as unknown as Doc;
}

/** The same graph with the given nodes moved to a new major version (each becomes an origin of its own). */
export function bumped(doc: Doc, indexes: readonly number[] | "all"): Doc {
  const copy = JSON.parse(JSON.stringify(doc)) as Doc;
  copy.nodes.forEach((node, i) => {
    if (indexes === "all" || indexes.includes(i)) node.version = "2.0.0";
  });
  return copy;
}

/** One contract with `fields` required fields and `consumers` undeclared consumers. */
export function star(fields: number, consumers: number): Doc {
  const names = Array.from({ length: fields }, (_, i) => f(`field_${i}`));
  const nodes: Record<string, unknown>[] = [n("contract.big", "contract", { owner: "team-big", fields: names })];
  const edges: Record<string, unknown>[] = [];
  for (let i = 0; i < consumers; i += 1) {
    nodes.push(n(`svc.c${i}`, "service", { owner: "team-star" }));
    edges.push(e(`svc.c${i}`, "contract.big", "consumes"));
  }
  return manifest(nodes, edges) as unknown as Doc;
}

/** Every field removed from the star contract. */
export function starWithoutFields(doc: Doc): Doc {
  const copy = JSON.parse(JSON.stringify(doc)) as Doc;
  copy.nodes[0]!.contract.fields = [];
  return copy;
}

/** layers x width; each node consumes up to three neighbours of the layer below. */
export function lattice(layers: number, width: number): Doc {
  const nodes: Record<string, unknown>[] = [];
  const edges: Record<string, unknown>[] = [];
  for (let l = 0; l < layers; l += 1) {
    for (let w = 0; w < width; w += 1) {
      nodes.push(n(`svc.l${l}w${w}`, "service", { owner: "team-lattice" }));
      if (l === 0) continue;
      for (const d of [-1, 0, 1]) {
        const x = w + d;
        if (x >= 0 && x < width) edges.push(e(`svc.l${l}w${w}`, `svc.l${l - 1}w${x}`, "consumes", { verified_at: FRESH }));
      }
    }
  }
  return manifest(nodes, edges) as unknown as Doc;
}
