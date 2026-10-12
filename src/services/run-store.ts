import { randomUUID } from "node:crypto";
import type { Queryable } from "../db/index.js";
import type { ContractCheckDefinition, ContractCheckResult } from "../domain/contract-checks.js";
import { type ErrorCode } from "../domain/errors.js";
import { transition } from "../domain/run-state.js";
import type { RunStatus } from "../domain/types.js";
import type { Assessment } from "./assess.js";
import { audit } from "./audit.js";
import { appendEvent } from "./outbox.js";

/** Persistence primitives for the impact run lifecycle. Every function takes the caller's transaction. */

export interface RunRow {
  id: string;
  workspace_id: string;
  snapshot_id: string;
  status: RunStatus;
  proposed_hash: string;
  expected_hash: string;
  baseline_hash: string;
  proposed_manifest: string;
  run_checks: boolean;
  check_keys: string[];
  created_at: Date;
  started_at: Date | null;
}

export async function lockRun(tx: Queryable, workspaceId: string, runId: string): Promise<RunRow | null> {
  const rows = await tx.query<RunRow>(
    `SELECT id, workspace_id, snapshot_id, status, proposed_hash, expected_hash, baseline_hash, proposed_manifest, run_checks, check_keys, created_at, started_at
       FROM impact_runs WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
    [workspaceId, runId],
  );
  return rows.rows[0] ?? null;
}

export async function recordRunEvent(tx: Queryable, workspaceId: string, runId: string, from: RunStatus | null, to: RunStatus, note: string | null, at: Date): Promise<void> {
  await tx.query("INSERT INTO run_events (workspace_id, run_id, from_status, to_status, note, at) VALUES ($1,$2,$3,$4,$5,$6)", [workspaceId, runId, from, to, note, at]);
}

/**
 * Move a locked run to RUNNING for a (re)claimed job. A run that is already RUNNING was left by a worker whose
 * lease expired: the state machine takes it back to QUEUED first (RUNNING to QUEUED is the documented reclaim
 * edge), which is recorded as history and reported as `reclaimed`. A terminal run needs no work.
 */
export async function beginRun(tx: Queryable, run: RunRow, at: Date): Promise<{ proceed: boolean; reclaimed: boolean }> {
  let status = run.status;
  let reclaimed = false;
  if (status === "COMPLETE" || status === "FAILED") return { proceed: false, reclaimed: false };
  if (status === "RUNNING") {
    status = transition("RUNNING", "QUEUED");
    await recordRunEvent(tx, run.workspace_id, run.id, "RUNNING", "QUEUED", "job lease expired; run reclaimed by a new worker", at);
    reclaimed = true;
  }
  transition(status, "RUNNING");
  await tx.query("UPDATE impact_runs SET status = 'RUNNING', started_at = COALESCE(started_at, $3) WHERE workspace_id = $1 AND id = $2", [run.workspace_id, run.id, at]);
  await recordRunEvent(tx, run.workspace_id, run.id, "QUEUED", "RUNNING", null, at);
  return { proceed: true, reclaimed };
}

export type CheckStart = "started" | "interrupted" | "concluded";

/**
 * Mark a check STARTED before its request leaves the process. If a row already exists the check ran in an
 * earlier attempt of this job: a STARTED row means the external outcome is uncertain, so it becomes UNKNOWN
 * (visible, and forcing INCOMPLETE); it is never re-run into a pass. A concluded row is reused as is.
 */
export async function startCheck(
  tx: Queryable,
  run: RunRow,
  definition: ContractCheckDefinition,
  spec: unknown,
  at: Date,
): Promise<{ outcome: CheckStart; result?: ContractCheckResult }> {
  const existing = await tx.query<{ state: string; result: ContractCheckResult | null }>(
    "SELECT state, result FROM check_results WHERE run_id = $1 AND check_key = $2 FOR UPDATE",
    [run.id, definition.id],
  );
  const row = existing.rows[0];
  if (!row) {
    await tx.query(
      `INSERT INTO check_results (id, workspace_id, run_id, check_key, node_id, state, definition, started_at)
       VALUES ($1,$2,$3,$4,$5,'STARTED',$6::jsonb,$7)`,
      [randomUUID(), run.workspace_id, run.id, definition.id, definition.node_id, JSON.stringify(spec), at],
    );
    return { outcome: "started" };
  }
  if (row.state === "STARTED") {
    const result: ContractCheckResult = {
      check_id: definition.id,
      node_id: definition.node_id,
      state: "UNKNOWN",
      attempts: 1,
      started_at: at.toISOString(),
      finished_at: at.toISOString(),
      duration_ms: 0,
      detail: "interrupted by a worker restart; the external outcome is unknown and was not retried",
      error_code: null,
      attempt_log: [{ attempt: 1, state: "UNKNOWN", detail: "interrupted by a worker restart", error_code: null }],
    };
    await concludeCheck(tx, run, result);
    return { outcome: "interrupted", result };
  }
  return { outcome: "concluded", result: row.result as ContractCheckResult };
}

export async function concludeCheck(tx: Queryable, run: RunRow, result: ContractCheckResult): Promise<void> {
  await tx.query(
    "UPDATE check_results SET state = $3, result = $4::jsonb, finished_at = $5 WHERE run_id = $1 AND check_key = $2 AND state = 'STARTED'",
    [run.id, result.check_id, result.state, JSON.stringify(result), result.finished_at],
  );
}

/** Persist the assessment, its findings, the terminal state, and the announcing event atomically. */
export async function completeRun(tx: Queryable, run: RunRow, assessment: Assessment, revision: string, at: Date): Promise<void> {
  transition("RUNNING", "COMPLETE");
  const { findings, unknowns, ...rest } = assessment;
  for (let i = 0; i < findings.length; i += 500) {
    const slice = findings.slice(i, i + 500).map((f, j) => ({
      id: randomUUID(),
      finding_key: f.id,
      position: i + j,
      origin_id: f.origin_id,
      consumer_id: f.consumer_id,
      consumer_kind: f.consumer_kind,
      consumer_owner: f.consumer_owner,
      severity: f.severity,
      direct: f.direct,
      depth: f.depth,
      path: f.path,
      hops: f.hops,
      path_omitted_hops: f.path_omitted_hops ?? 0,
      change_ids: f.change_ids,
      change_ids_omitted: f.change_ids_omitted ?? 0,
      reason: f.reason,
    }));
    await tx.query(
      `INSERT INTO findings (id, workspace_id, run_id, finding_key, position, origin_id, consumer_id, consumer_kind, consumer_owner, severity, direct, depth, path, hops, path_omitted_hops, change_ids, change_ids_omitted, reason)
       SELECT x.id, $1::uuid, $2::uuid, x.finding_key, x.position, x.origin_id, x.consumer_id, x.consumer_kind, x.consumer_owner, x.severity, x.direct, x.depth, x.path, x.hops, x.path_omitted_hops, x.change_ids, x.change_ids_omitted, x.reason
         FROM jsonb_to_recordset($3::jsonb) AS x(id uuid, finding_key text, position integer, origin_id text, consumer_id text, consumer_kind text, consumer_owner text, severity text, direct boolean, depth integer, path jsonb, hops jsonb, path_omitted_hops integer, change_ids jsonb, change_ids_omitted integer, reason text)`,
      [run.workspace_id, run.id, JSON.stringify(slice)],
    );
  }
  await tx.query(
    `UPDATE impact_runs SET status = 'COMPLETE', verdict = $3, assessment = $4::jsonb, unknowns = $5::jsonb, finished_at = $6
      WHERE workspace_id = $1 AND id = $2`,
    [run.workspace_id, run.id, assessment.assessment, JSON.stringify(rest), JSON.stringify(unknowns), at],
  );
  await recordRunEvent(tx, run.workspace_id, run.id, "RUNNING", "COMPLETE", `verdict ${assessment.assessment}`, at);
  await appendEvent(tx, {
    workspaceId: run.workspace_id,
    eventType: "impact_run.completed",
    resourceId: run.id,
    revision,
    evidenceRef: `/api/v1/impact-runs/${run.id}`,
    occurredAt: at,
  });
  await audit(tx, {
    workspaceId: run.workspace_id,
    actorType: "worker",
    actorId: null,
    action: "impact_run.completed",
    resourceType: "impact_run",
    resourceId: run.id,
    at,
    metadata: { verdict: assessment.assessment, findings: findings.length, unknowns: unknowns.length },
  });
}

/** Terminal failure with a visible reason. Nothing else about the run is invented. */
export async function failRun(tx: Queryable, run: RunRow, from: RunStatus, code: ErrorCode | string, detail: string, revision: string, at: Date): Promise<void> {
  transition(from, "FAILED");
  await tx.query(
    "UPDATE impact_runs SET status = 'FAILED', error_code = $3, error_detail = $4, finished_at = $5 WHERE workspace_id = $1 AND id = $2",
    [run.workspace_id, run.id, code, detail.slice(0, 500), at],
  );
  await recordRunEvent(tx, run.workspace_id, run.id, from, "FAILED", `${code}`, at);
  await appendEvent(tx, {
    workspaceId: run.workspace_id,
    eventType: "impact_run.failed",
    resourceId: run.id,
    revision,
    evidenceRef: `/api/v1/impact-runs/${run.id}`,
    occurredAt: at,
  });
  await audit(tx, {
    workspaceId: run.workspace_id,
    actorType: "worker",
    actorId: null,
    action: "impact_run.failed",
    resourceType: "impact_run",
    resourceId: run.id,
    at,
    metadata: { code },
  });
}
