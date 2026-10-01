import { compareStrings, stableId } from "../domain/canonical.js";
import { classifyVersionChange } from "../domain/semver.js";
import {
  edgeKeyString,
  type ContractField,
  type Cycle,
  type EdgeKey,
  type GraphEdge,
  type GraphNode,
  type ImpactLink,
} from "../domain/types.js";
import type { DependencyGraph } from "./graph.js";

export type ChangeKind =
  | "node_added"
  | "node_removed"
  | "node_kind_changed"
  | "node_owner_changed"
  | "node_version_changed"
  | "node_placeholder_changed"
  | "contract_declaration_changed"
  | "contract_field_added"
  | "contract_field_removed"
  | "contract_field_type_changed"
  | "contract_field_requirement_changed"
  | "edge_added"
  | "edge_removed";

/**
 * How a change reaches consumers:
 * - none:  informational, no consumer can break because of it.
 * - all:   every dependent of the origin node may break.
 * - field: consumers relying on `field` may break. A consumer that declares `fields` on its edge is
 *          affected only if the list contains the field; a consumer that declares nothing is assumed
 *          to rely on every REQUIRED field (`required_relevant`).
 */
export type Propagation = "none" | "all" | "field";

export interface Change {
  /** Stable, content derived id (`chg_` + 20 hex). */
  readonly id: string;
  readonly kind: ChangeKind;
  /** Node the change is declared on (source node for edge changes). */
  readonly node_id: string;
  /** Node whose dependents are traversed. Equals node_id except for removed `produces` edges (the target). */
  readonly origin_id: string;
  readonly field: string | null;
  readonly edge: EdgeKey | null;
  readonly before: string | null;
  readonly after: string | null;
  readonly propagation: Propagation;
  readonly required_relevant: boolean;
  readonly description: string;
}

function makeChange(
  parts: Omit<Change, "id" | "field" | "edge" | "before" | "after" | "origin_id" | "required_relevant"> &
    Partial<Pick<Change, "field" | "edge" | "before" | "after" | "origin_id" | "required_relevant">>,
): Change {
  const change = {
    kind: parts.kind,
    node_id: parts.node_id,
    origin_id: parts.origin_id ?? parts.node_id,
    field: parts.field ?? null,
    edge: parts.edge ?? null,
    before: parts.before ?? null,
    after: parts.after ?? null,
    propagation: parts.propagation,
    required_relevant: parts.required_relevant ?? false,
    description: parts.description,
  };
  return Object.freeze({
    id: stableId("chg", {
      kind: change.kind,
      node_id: change.node_id,
      origin_id: change.origin_id,
      field: change.field,
      edge: change.edge,
      before: change.before,
      after: change.after,
    }),
    ...change,
  });
}

function describeField(field: ContractField): string {
  return `${field.type}${field.required ? " (required)" : " (optional)"}`;
}

/** Diff a baseline graph against a proposed graph. Result is sorted and fully deterministic. */
export function diffGraphs(baseline: DependencyGraph, proposed: DependencyGraph): Change[] {
  const changes: Change[] = [];

  for (const before of baseline.nodes) {
    const after = proposed.getNode(before.id);
    if (!after) {
      changes.push(
        makeChange({
          kind: "node_removed",
          node_id: before.id,
          before: before.kind,
          propagation: "all",
          description: `${before.kind} ${before.id} was removed`,
        }),
      );
      continue;
    }
    diffNode(before, after, changes);
  }
  for (const after of proposed.nodes) {
    if (!baseline.hasNode(after.id)) {
      changes.push(
        makeChange({
          kind: "node_added",
          node_id: after.id,
          after: after.kind,
          propagation: "none",
          description: `${after.kind} ${after.id} was added`,
        }),
      );
    }
  }

  for (const edge of baseline.edges) {
    if (proposed.getEdge(edge)) continue;
    // Edges attached to a removed node are covered by the node_removed change.
    if (!proposed.hasNode(edge.source_id) || !proposed.hasNode(edge.target_id)) continue;
    const key: EdgeKey = { source_id: edge.source_id, target_id: edge.target_id, relation: edge.relation };
    const producesLoss = edge.relation === "produces";
    changes.push(
      makeChange({
        kind: "edge_removed",
        node_id: edge.source_id,
        origin_id: producesLoss ? edge.target_id : edge.source_id,
        edge: key,
        propagation: producesLoss ? "all" : "none",
        description: producesLoss
          ? `${edge.source_id} no longer produces ${edge.target_id}`
          : `${edge.source_id} no longer ${edge.relation} ${edge.target_id}`,
      }),
    );
  }
  for (const edge of proposed.edges) {
    if (baseline.getEdge(edge)) continue;
    if (!baseline.hasNode(edge.source_id) || !baseline.hasNode(edge.target_id)) continue;
    changes.push(
      makeChange({
        kind: "edge_added",
        node_id: edge.source_id,
        edge: { source_id: edge.source_id, target_id: edge.target_id, relation: edge.relation },
        propagation: "none",
        description: `${edge.source_id} now ${edge.relation} ${edge.target_id}`,
      }),
    );
  }

  return changes.sort(
    (a, b) =>
      compareStrings(a.node_id, b.node_id) ||
      compareStrings(a.kind, b.kind) ||
      compareStrings(a.field ?? "", b.field ?? "") ||
      compareStrings(a.edge ? edgeKeyString(a.edge) : "", b.edge ? edgeKeyString(b.edge) : ""),
  );
}

function diffNode(before: GraphNode, after: GraphNode, out: Change[]): void {
  if (before.kind !== after.kind) {
    out.push(
      makeChange({
        kind: "node_kind_changed",
        node_id: before.id,
        before: before.kind,
        after: after.kind,
        propagation: "all",
        description: `${before.id} changed kind from ${before.kind} to ${after.kind}`,
      }),
    );
  }
  if (before.owner !== after.owner) {
    out.push(
      makeChange({
        kind: "node_owner_changed",
        node_id: before.id,
        before: before.owner,
        after: after.owner,
        propagation: "none",
        description: `${before.id} owner changed from ${before.owner ?? "(none)"} to ${after.owner ?? "(none)"}`,
      }),
    );
  }
  if (before.version !== after.version) {
    const change = classifyVersionChange(before.version, after.version);
    out.push(
      makeChange({
        kind: "node_version_changed",
        node_id: before.id,
        before: before.version,
        after: after.version,
        propagation: change.breaking ? "all" : "none",
        description: change.comparable
          ? `${before.id} version changed from ${before.version} to ${after.version}${change.breaking ? ` (${change.why})` : ""}`
          : `${before.id} version changed from ${before.version} to ${after.version} (not comparable as semantic versions, treated as breaking)`,
      }),
    );
  }
  if (before.placeholder !== after.placeholder) {
    out.push(
      makeChange({
        kind: "node_placeholder_changed",
        node_id: before.id,
        before: String(before.placeholder),
        after: String(after.placeholder),
        propagation: "none",
        description: `${before.id} placeholder flag changed from ${before.placeholder} to ${after.placeholder}`,
      }),
    );
  }
  if (before.contract && after.contract) {
    diffContract(before.id, before.contract, after.contract, out);
  } else if ((before.contract === null) !== (after.contract === null)) {
    out.push(
      makeChange({
        kind: "contract_declaration_changed",
        node_id: before.id,
        before: before.contract ? "declared" : "undeclared",
        after: after.contract ? "declared" : "undeclared",
        propagation: "none",
        description: `${before.id} contract fields went from ${before.contract ? "declared" : "undeclared"} to ${after.contract ? "declared" : "undeclared"}`,
      }),
    );
  }
}

function diffContract(
  nodeId: string,
  before: readonly ContractField[],
  after: readonly ContractField[],
  out: Change[],
): void {
  const afterByName = new Map(after.map((f) => [f.name, f]));
  const beforeByName = new Map(before.map((f) => [f.name, f]));

  for (const b of before) {
    const a = afterByName.get(b.name);
    if (!a) {
      out.push(
        makeChange({
          kind: "contract_field_removed",
          node_id: nodeId,
          field: b.name,
          before: describeField(b),
          propagation: "field",
          required_relevant: b.required,
          description: `${b.required ? "required" : "optional"} field ${b.name} was removed from contract ${nodeId}`,
        }),
      );
      continue;
    }
    if (b.type !== a.type) {
      out.push(
        makeChange({
          kind: "contract_field_type_changed",
          node_id: nodeId,
          field: b.name,
          before: b.type,
          after: a.type,
          propagation: "field",
          required_relevant: b.required || a.required,
          description: `field ${b.name} of contract ${nodeId} changed type from ${b.type} to ${a.type}`,
        }),
      );
    }
    if (b.required !== a.required) {
      // A change of requiredness in either direction can break someone: consumers of a producer's output lose a
      // guaranteed field when it becomes optional, and callers must start sending it when it becomes required.
      // The field is required on exactly one side, so an undeclared consumer (assumed to rely on every required
      // field) is always in scope, and so is a consumer that declares the field.
      out.push(
        makeChange({
          kind: "contract_field_requirement_changed",
          node_id: nodeId,
          field: b.name,
          before: b.required ? "required" : "optional",
          after: a.required ? "required" : "optional",
          propagation: "field",
          required_relevant: true,
          description: `field ${b.name} of contract ${nodeId} changed from ${b.required ? "required" : "optional"} to ${a.required ? "required" : "optional"}`,
        }),
      );
    }
  }
  for (const a of after) {
    if (beforeByName.has(a.name)) continue;
    out.push(
      makeChange({
        kind: "contract_field_added",
        node_id: nodeId,
        field: a.name,
        after: describeField(a),
        propagation: a.required ? "field" : "none",
        required_relevant: a.required,
        description: `${a.required ? "required" : "optional"} field ${a.name} was added to contract ${nodeId}`,
      }),
    );
  }
}

/**
 * The field list of `edge` that says which fields of the ORIGIN contract the dependent relies on, or null when there
 * is no usable declaration (the dependent is then assumed to rely on every required field). Not usable:
 * - a `produces` edge: there `fields` names fields of the produced (target) contract, not of the origin, so it says
 *   nothing about what depends on the origin (round 2: it used to drop consumers from required-field removals);
 * - a list naming a field the origin contract does not have (a typo, or a name left over from a rename): the
 *   consumer's real dependency is unknown, and an unusable declaration must not exclude it (round 2).
 * `originFields` is the origin's field names in the graph being assessed, or null when the origin declares none.
 */
export function usableDeclaredFields(edge: GraphEdge, originFields: ReadonlySet<string> | null): readonly string[] | null {
  if (edge.relation === "produces" || edge.fields === null) return null;
  if (originFields !== null && edge.fields.some((name) => !originFields.has(name))) return null;
  return edge.fields;
}

/** Does `change` reach the dependent at the end of `link` (a first hop out of the change origin)? */
export function affectsLink(change: Change, link: ImpactLink, originFields: ReadonlySet<string> | null = null): boolean {
  switch (change.propagation) {
    case "none":
      return false;
    case "all":
      return true;
    case "field": {
      // A NEW requirement (a required field added, an optional field made required) is a demand on every consumer of
      // the contract: a declared list can only name fields that already exist, so it can never exempt a consumer from it.
      if (change.kind === "contract_field_added" || (change.kind === "contract_field_requirement_changed" && change.after === "required")) return true;
      const declared = usableDeclaredFields(link.edge, originFields);
      if (declared !== null && change.field !== null) return declared.includes(change.field);
      return change.required_relevant;
    }
  }
}

/** One traversed step of a path, in impact direction (from changes, to may break). */
export interface PathHop {
  readonly from: string;
  readonly to: string;
  readonly relation: GraphEdge["relation"];
  /** Declared edge direction and provenance. */
  readonly source_id: string;
  readonly target_id: string;
  readonly source_file: string;
  readonly source_line: number;
}

/** Hops kept at each end of a finding path that is too long to store in full. */
export const PATH_HEAD_HOPS = 12;
export const PATH_TAIL_HOPS = 12;

export interface ReachedNode {
  readonly node_id: string;
  /** 1 for direct consumers of the origin. */
  readonly depth: number;
  /** The first link out of the origin on the path to this node. */
  readonly first: ImpactLink;
  /**
   * Ordered origin-to-consumer hops (`hops.length === depth`), materialised on access. Cheap for a single node;
   * never call it for every node of a long chain (that is quadratic): use `boundedPath` instead.
   */
  readonly hops: readonly PathHop[];
  /**
   * The path in bounded form: all hops when the path has at most PATH_HEAD_HOPS + PATH_TAIL_HOPS hops, otherwise
   * the first PATH_HEAD_HOPS and the last PATH_TAIL_HOPS with `omitted` counting the hops in between.
   */
  boundedPath(): { readonly hops: readonly PathHop[]; readonly omitted: number };
}

/** A node of the breadth-first parent tree. Holds one hop and a pointer, so a whole tree is linear in its size. */
class Reached implements ReachedNode {
  readonly first: ImpactLink;
  private readonly hop: PathHop;
  /** The first PATH_HEAD_HOPS hops of the path, shared with the parent once the path is longer than that. */
  private readonly head: readonly PathHop[];

  constructor(
    readonly node_id: string,
    readonly depth: number,
    link: ImpactLink,
    private readonly parent: Reached | null,
  ) {
    this.first = parent === null ? link : parent.first;
    this.hop = {
      from: link.from,
      to: link.to,
      relation: link.edge.relation,
      source_id: link.edge.source_id,
      target_id: link.edge.target_id,
      source_file: link.edge.source_file,
      source_line: link.edge.source_line,
    };
    this.head = parent === null ? [this.hop] : parent.head.length < PATH_HEAD_HOPS ? [...parent.head, this.hop] : parent.head;
  }

  get hops(): readonly PathHop[] {
    const out: PathHop[] = [];
    for (let cursor: Reached | null = this; cursor !== null; cursor = cursor.parent) out.push(cursor.hop);
    return out.reverse();
  }

  boundedPath(): { readonly hops: readonly PathHop[]; readonly omitted: number } {
    if (this.depth <= PATH_HEAD_HOPS + PATH_TAIL_HOPS) return { hops: this.hops, omitted: 0 };
    const tail: PathHop[] = [];
    let cursor: Reached = this;
    for (let i = 0; i < PATH_TAIL_HOPS; i += 1) {
      tail.push(cursor.hop);
      cursor = cursor.parent!;
    }
    tail.reverse();
    return { hops: [...this.head, ...tail], omitted: this.depth - PATH_HEAD_HOPS - PATH_TAIL_HOPS };
  }
}

export interface Traversal {
  readonly origin_id: string;
  /** Breadth-first discovery order (deterministic). */
  readonly reached: readonly ReachedNode[];
  /** Every edge the traversal looked at, sorted and de-duplicated. */
  readonly examined_edges: readonly GraphEdge[];
  /** Cycles that contain the origin or any reached node (reported, never re-traversed). */
  readonly cycles: readonly Cycle[];
  /** true when the shared work budget ran out, so `reached` is a prefix of the full breadth-first order. */
  readonly truncated: boolean;
}

export interface TraverseOptions {
  /**
   * Restrict which first-hop links out of the origin are followed. A rejected first-hop edge is still reported in
   * `examined_edges`: the exclusion rests on what that edge declares, so its evidence must be checked too.
   */
  readonly acceptFirstHop?: (link: ImpactLink) => boolean;
  /**
   * Shared work budget: every dependent link looked at costs one unit. When it reaches zero the traversal stops
   * and reports `truncated`. The object is mutated so several traversals can draw on one budget.
   */
  readonly budget?: { remaining: number };
}

/**
 * Breadth-first traversal of dependents. Each node is visited once, so cycles terminate
 * deterministically; neighbours are pre-sorted so ties resolve identically on every run.
 * Iterative, so long dependency chains cannot overflow the call stack. The result is a parent tree:
 * memory is linear in the number of reached nodes whatever the depth.
 */
export function traverseDependents(
  graph: DependencyGraph,
  originId: string,
  options: TraverseOptions = {},
): Traversal {
  if (!graph.hasNode(originId)) {
    return { origin_id: originId, reached: [], examined_edges: [], cycles: [], truncated: false };
  }
  const visited = new Set<string>([originId]);
  const reached: Reached[] = [];
  const examined = new Map<string, GraphEdge>();
  const queue: (Reached | null)[] = [null];
  const budget = options.budget;
  let truncated = false;

  scan: for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head]!;
    const from = current === null ? originId : current.node_id;
    for (const link of graph.dependentsOf(from)) {
      if (budget) {
        if (budget.remaining <= 0) {
          truncated = true;
          break scan;
        }
        budget.remaining -= 1;
      }
      // Examined before the first-hop filter: an edge that only EXCLUDES a consumer (it declares other fields)
      // still carries the evidence for that exclusion, so it must reach the unverified/stale/future checks.
      examined.set(edgeKeyString(link.edge), link.edge);
      if (current === null && options.acceptFirstHop && !options.acceptFirstHop(link)) continue;
      if (visited.has(link.to)) continue;
      visited.add(link.to);
      const node = new Reached(link.to, current === null ? 1 : current.depth + 1, link, current);
      reached.push(node);
      queue.push(node);
    }
  }

  const cycleMap = new Map<string, Cycle>();
  const cycleIds = [originId, ...reached.map((r) => r.node_id)];
  for (const id of cycleIds) {
    const cycle = graph.cycleOf(id);
    if (cycle) cycleMap.set(cycle.id, cycle);
  }
  const cycles = [...cycleMap.values()].sort((a, b) => compareStrings(a.members[0]!, b.members[0]!));

  const examinedEdges = [...examined.entries()]
    .sort((a, b) => compareStrings(a[0], b[0]))
    .map(([, edge]) => edge);

  return { origin_id: originId, reached, examined_edges: examinedEdges, cycles, truncated };
}
