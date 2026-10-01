/** Core domain types. Frozen interface for stage B; see docs/DOMAIN.md. */

export const NODE_KINDS = ["service", "job", "contract", "credential_alias", "artifact"] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export const RELATIONS = ["consumes", "requires", "produces"] as const;
export type Relation = (typeof RELATIONS)[number];

/** Contract field types in the MVP required-field/type subset. */
export const FIELD_TYPES = ["string", "number", "integer", "boolean", "object", "array", "null"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export interface ContractField {
  readonly name: string;
  readonly type: FieldType;
  readonly required: boolean;
}

/** A node after normalization (defaults applied, contract fields sorted by name). */
export interface GraphNode {
  readonly id: string;
  readonly kind: NodeKind;
  /** null when the manifest declares no owner. */
  readonly owner: string | null;
  readonly version: string;
  /** true when the node is referenced but its own manifest is not imported (owner/contract unknown). */
  readonly placeholder: boolean;
  /** null when the node declares no contract fields (not the same as an empty contract). */
  readonly contract: readonly ContractField[] | null;
}

/** An edge after normalization. source_id --relation--> target_id. */
export interface GraphEdge {
  readonly source_id: string;
  readonly target_id: string;
  readonly relation: Relation;
  readonly source_file: string;
  readonly source_line: number;
  /** UTC timestamp; null when the edge was never verified (unknown). */
  readonly verified_at: string | null;
  /**
   * For edges that consume a contract: the contract fields this consumer relies on (sorted, unique).
   * null means "not declared": the consumer is assumed to rely on every required field.
   */
  readonly fields: readonly string[] | null;
}

/** Identity of an edge; metadata (source_file, source_line, verified_at, fields) is not part of it. */
export interface EdgeKey {
  readonly source_id: string;
  readonly target_id: string;
  readonly relation: Relation;
}

/**
 * One step of impact propagation. `from` -> `to` is the impact direction: when `from` changes,
 * `to` may break. `edge` is the underlying declared edge (its direction is source_id -> target_id).
 */
export interface ImpactLink {
  readonly from: string;
  readonly to: string;
  readonly edge: GraphEdge;
}

/** A strongly connected group of nodes that depend on each other (or a self loop). */
export interface Cycle {
  readonly id: string;
  /** Sorted node ids. */
  readonly members: readonly string[];
}

export interface Provenance {
  readonly source: string;
  readonly generator?: string | undefined;
  readonly generated_at?: string | undefined;
}

export type RunStatus = "QUEUED" | "RUNNING" | "COMPLETE" | "FAILED";
export type OverallAssessment = "AFFECTED" | "NO_KNOWN_IMPACT" | "INCOMPLETE";
export type Severity = "high" | "medium";

export function edgeKeyString(edge: EdgeKey): string {
  return `${edge.source_id}|${edge.relation}|${edge.target_id}`;
}
