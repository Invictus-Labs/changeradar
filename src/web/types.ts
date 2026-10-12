import type { Verdict } from "../report/wording";

/** Shapes of the API responses this UI reads (docs/API.md). Fields the UI does not use are left out. */

export interface Hop {
  from?: string;
  to?: string;
  relation?: string;
  source_id?: string;
  target_id?: string;
  source_file?: string;
  source_line?: number;
}

export interface Finding {
  id: string;
  origin_id: string;
  consumer_id: string;
  consumer_kind: string;
  consumer_owner: string | null;
  severity: "high" | "medium";
  direct: boolean;
  depth: number;
  path: string[];
  hops: Hop[];
  /** Hops left out of a very long path (only its first and last hops are kept). Absent when the path is whole. */
  path_omitted_hops?: number;
  change_ids: string[];
  /** Change ids left out of `change_ids`. Absent when the list is complete. */
  change_ids_omitted?: number;
  reason: string;
}

export interface Unknown {
  id: string;
  code: string;
  node_id: string | null;
  edge: { source_id: string; target_id: string; relation: string } | null;
  message: string;
}

export interface CoverageLimit {
  code: string;
  message: string;
  node_ids?: string[];
}

export interface Coverage {
  scope: string;
  baseline?: { nodes: number; edges: number };
  proposed?: { nodes: number; edges: number };
  nodes_examined?: number;
  edges_examined?: number;
  consumers_found?: number;
  known: string[];
  limits: CoverageLimit[];
}

export interface Summary {
  changes: number;
  findings: number;
  direct_findings: number;
  transitive_findings: number;
  unknowns: number;
  known_impact: boolean;
}

export interface Change {
  id: string;
  kind: string;
  node_id: string;
  description: string;
  propagation?: string;
}

export interface Cycle {
  id: string;
  members: string[];
}

export interface CheckResult {
  check_key: string;
  node_id: string;
  state: string;
  attempts: number | null;
  detail: string | null;
  error_code: string | null;
  started_at: string;
  finished_at: string | null;
}

export type RunStatus = "queued" | "running" | "complete" | "failed";

export interface RunDetail {
  id: string;
  snapshot_id: string;
  status: RunStatus;
  /** Null for a finished run assessed by an older engine (see `recorded_assessment`). */
  assessment: Verdict | null;
  /** The verdict an older engine recorded, only when `engine.rerun_required`; absent from servers that predate the field. */
  recorded_assessment?: Verdict | null;
  baseline_hash: string;
  proposed_hash: string;
  baseline_version: number;
  allow_superseded: boolean;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  error: { code: string; detail: string } | null;
  /** Which decision engine assessed the run; absent from responses of servers that predate the stamp. */
  engine?: { version: number; current: number; rerun_required: boolean; note?: string };
  summary: Summary | null;
  coverage: Coverage | null;
  cycles: Cycle[];
  changes: Change[];
  unknowns: Unknown[];
  checks: CheckResult[];
  totals: { findings: number; unknowns: number };
  truncated: { findings: boolean; unknowns: boolean };
}

export interface RunSummary {
  id: string;
  snapshot_id: string;
  status: RunStatus;
  assessment: Verdict | null;
  recorded_assessment?: Verdict | null;
  proposed_hash: string;
  created_at: string;
  finished_at: string | null;
  /** True for a finished run assessed by an older decision engine; absent from responses of servers that predate the field. */
  rerun_required?: boolean;
}

export interface SnapshotWarning {
  code: string;
  message: string;
  count: number;
  sample_ids: string[];
}

export interface SnapshotSummary {
  id: string;
  revision: string;
  hash: string;
  document_hash: string;
  node_count: number;
  edge_count: number;
  baseline_version: number;
  is_baseline: boolean;
  imported_at: string;
  warnings: SnapshotWarning[];
}

export interface NodeRow {
  id: string;
  kind: string;
  owner: string | null;
  version: string;
  placeholder: boolean;
}

export interface EdgeRow {
  source_id: string;
  target_id: string;
  relation: string;
  source_file: string;
  source_line: number;
  verified_at: string | null;
}

export interface CheckDefinition {
  id: string;
  key: string;
  node_id: string;
  url: string;
  method: "GET" | "HEAD";
  timeout_ms: number;
  retries: number;
  expect_status: number;
  required_fields: { name: string; type: string }[];
  credential_alias: string | null;
  credential_configured: boolean;
  enabled: boolean;
  created_at: string;
  disabled_at: string | null;
}
