import { billingManifest, clone, e, f, FRESH, manifest, n } from "./builders.js";

/** Reference scenario documents (see builders.ts for the graph drawing). */
export const baselineDoc = (): Record<string, unknown> => billingManifest();

/** Proposal that removes the required `amount` field of contract.invoice. */
export const removeAmountDoc = (): Record<string, unknown> =>
  billingManifest((nodes) => {
    const contract = nodes[1] as { contract: { fields: { name: string }[] } };
    contract.contract.fields = contract.contract.fields.filter((x) => x.name !== "amount");
  });

/** Proposal that only adds an optional field: informational, no consumer can break. */
export const addOptionalFieldDoc = (): Record<string, unknown> =>
  billingManifest((nodes) => {
    const contract = nodes[1] as { contract: { fields: unknown[] } };
    contract.contract.fields.push({ name: "memo", type: "string", required: false });
  });

/** Same manifest with one edge left unverified: an unknown that forces INCOMPLETE. */
export const unverifiedEdgeDoc = (): Record<string, unknown> => {
  const doc = clone(baselineDoc()) as { edges: Record<string, unknown>[] };
  const edge = doc.edges.find((x) => x.source_id === "job.export" && x.target_id === "contract.invoice") as Record<string, unknown>;
  edge.verified_at = null;
  return doc as Record<string, unknown>;
};

/** One contract with `consumers` direct consumers (services), each verified fresh. */
export function fanOutManifest(consumers: number, opts: { dropAmount?: boolean } = {}): Record<string, unknown> {
  const fields = [f("invoice_id"), f("amount", "number")].filter((x) => !(opts.dropAmount && x.name === "amount"));
  const nodes: Record<string, unknown>[] = [n("contract.invoice", "contract", { owner: "team-billing", fields })];
  const edges: Record<string, unknown>[] = [];
  for (let i = 0; i < consumers; i += 1) {
    const id = `svc.consumer-${String(i).padStart(4, "0")}`;
    nodes.push(n(id, "service", { owner: "team-consumers" }));
    edges.push(e(id, "contract.invoice", "consumes", { verified_at: FRESH }));
  }
  return manifest(nodes, edges);
}

/** Deterministic synthetic graph of exactly `nodeCount` nodes and `edgeCount` edges (no self loops or duplicates). */
export function syntheticManifest(nodeCount: number, edgeCount: number): Record<string, unknown> {
  const nodes: Record<string, unknown>[] = [];
  for (let i = 0; i < nodeCount; i += 1) {
    const kind = i % 10 === 0 ? "contract" : i % 10 === 1 ? "artifact" : "service";
    nodes.push(n(`node-${i}`, kind, kind === "contract" ? { owner: `team-${i % 7}`, fields: [f("id"), f("value", "number")] } : { owner: `team-${i % 7}` }));
  }
  const edges: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let step = 1;
  while (edges.length < edgeCount) {
    for (let i = 0; i < nodeCount && edges.length < edgeCount; i += 1) {
      const j = (i * 7 + step * 13 + 1) % nodeCount;
      if (i === j) continue;
      const key = `${i}>${j}`;
      if (seen.has(key)) continue;
      const sourceKind = i % 10;
      // Only service nodes consume; the target may be any node.
      if (sourceKind === 0 || sourceKind === 1) continue;
      seen.add(key);
      edges.push(e(`node-${i}`, `node-${j}`, "consumes", { file: `m/${i % 100}.yaml`, line: (i % 500) + 1 }));
    }
    step += 1;
  }
  return manifest(nodes, edges);
}
