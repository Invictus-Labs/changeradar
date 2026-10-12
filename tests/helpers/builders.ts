import { fixedClock } from "../../src/domain/clock.js";
import type { ContractField, NodeKind, Relation } from "../../src/domain/types.js";
import { buildGraph, type DependencyGraph } from "../../src/services/graph.js";

/** Deterministic UTC "now" for every test that touches staleness. */
export const NOW_ISO = "2026-09-29T00:00:00Z";
export const clock = fixedClock(NOW_ISO);
/** Fresh: one day before NOW. */
export const FRESH = "2026-09-28T00:00:00Z";
/** Stale: 60 days before NOW (default max age is 30 days). */
export const STALE = "2026-07-31T00:00:00Z";

export interface NodeSpec {
  id: string;
  kind: NodeKind;
  owner?: string | null;
  version?: string;
  placeholder?: boolean;
  fields?: ContractField[];
}

export interface EdgeSpec {
  source: string;
  target: string;
  relation: Relation;
  verified_at?: string | null;
  fields?: string[];
  file?: string;
  line?: number;
}

export function n(id: string, kind: NodeKind, extra: Partial<NodeSpec> = {}): Record<string, unknown> {
  const spec: NodeSpec = { id, kind, ...extra };
  const out: Record<string, unknown> = {
    id,
    kind,
    version: spec.version ?? "1.0.0",
  };
  if (spec.owner !== undefined) out.owner = spec.owner;
  else out.owner = "team-" + id.split(".")[0];
  if (spec.placeholder !== undefined) out.placeholder = spec.placeholder;
  if (spec.fields !== undefined) out.contract = { fields: spec.fields };
  return out;
}

export function e(source: string, target: string, relation: Relation, extra: Partial<EdgeSpec> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {
    source_id: source,
    target_id: target,
    relation,
    source_file: extra.file ?? `manifests/${source}.yaml`,
    source_line: extra.line ?? 10,
  };
  out.verified_at = extra.verified_at === undefined ? FRESH : extra.verified_at;
  if (extra.fields !== undefined) out.fields = extra.fields;
  return out;
}

export function f(name: string, type: ContractField["type"] = "string", required = true): ContractField {
  return { name, type, required };
}

export function manifest(
  nodes: Record<string, unknown>[],
  edges: Record<string, unknown>[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema_version: 1,
    revision: "rev-1",
    provenance: { source: "synthetic-test" },
    nodes,
    edges,
    ...overrides,
  };
}

export function build(doc: unknown): DependencyGraph {
  const result = buildGraph(doc);
  if (!result.ok) {
    throw new Error("fixture rejected: " + JSON.stringify(result.failure.issues));
  }
  return result.graph;
}

/**
 * Reference scenario used across suites:
 *
 *   svc.billing --produces--> contract.invoice <--consumes-- job.export --produces--> artifact.report <--consumes-- svc.dashboard
 *                                       ^
 *                                       +--consumes(fields: invoice_id)-- svc.mailer --requires--> cred.smtp
 */
export function billingManifest(mutate?: (nodes: Record<string, unknown>[], edges: Record<string, unknown>[]) => void): Record<string, unknown> {
  const nodes = [
    n("svc.billing", "service"),
    n("contract.invoice", "contract", {
      owner: "team-billing",
      fields: [f("invoice_id"), f("amount", "number"), f("note", "string", false)],
    }),
    n("job.export", "job", { owner: "team-data" }),
    n("artifact.report", "artifact", { owner: "team-data" }),
    n("svc.dashboard", "service", { owner: "team-web" }),
    n("svc.mailer", "service", { owner: "team-comms" }),
    n("cred.smtp", "credential_alias", { owner: "team-comms" }),
  ];
  const edges = [
    e("svc.billing", "contract.invoice", "produces"),
    e("job.export", "contract.invoice", "consumes"),
    e("job.export", "artifact.report", "produces"),
    e("svc.dashboard", "artifact.report", "consumes"),
    e("svc.mailer", "contract.invoice", "consumes", { fields: ["invoice_id"] }),
    e("svc.mailer", "cred.smtp", "requires"),
  ];
  mutate?.(nodes, edges);
  return manifest(nodes, edges);
}

/** Deep clone of a JSON-compatible value. */
export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Seeded PRNG (mulberry32) so property style tests are reproducible. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
