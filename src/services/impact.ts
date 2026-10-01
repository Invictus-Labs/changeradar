import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Queryable } from "../db/index.js";
import { canonicalJson } from "../domain/canonical.js";
import { redactDeep } from "../domain/redaction.js";
import type { ContractCheckResult } from "../domain/contract-checks.js";
import type { RunStatus } from "../domain/types.js";
import type { Ctx } from "../platform/context.js";
import { type Page, decodeCursor, encodeCursor } from "../platform/cursor.js";
import { conflict, fromDomainError, notFound, requestIssues, unprocessable } from "../platform/errors.js";
import { IDENTIFIER, isUuid } from "../platform/ids.js";
import { checkBaselineHash, ENGINE_VERSION, isStaleEngineRun } from "./assess.js";
import { audit } from "./audit.js";
import { type Principal, requireRole } from "./auth.js";
import { existingCheckKeys, selectChecks } from "./checks.js";
import { diffGraphs } from "./diff.js";
import { exportManifest } from "./graph.js";
import { idempotent, type IdempotentOutcome, replayOf } from "./idempotency.js";
import { enqueue } from "./jobs.js";
import { recordRunEvent } from "./run-store.js";
import { buildGraphOrThrow, rebuildVerified } from "./snapshots.js";

/** The API reports run status in lower case (`queued`, `running`, `complete`, `failed`), like the POST receipt. */
export type ApiRunStatus = Lowercase<RunStatus>;
export const apiStatus = (status: RunStatus): ApiRunStatus => status.toLowerCase() as ApiRunStatus;

export interface ImpactRunReceipt {
  id: string;
  status: "queued";
  snapshot_id: string;
  baseline_hash: string;
  proposed_hash: string;
  baseline_version: number;
}

export const RequestSchema = z.strictObject({
  snapshot_id: z.string().refine(isUuid, "snapshot_id must be a UUID"),
  proposed_manifest: z.record(z.string(), z.unknown()),
  expected_hash: z.string().min(1).max(200),
  run_checks: z.boolean().default(true),
  check_keys: z.array(z.string().regex(IDENTIFIER)).max(50).optional(),
  allow_superseded: z.boolean().default(false),
});

/**
 * POST /api/v1/impact-runs. Order of decisions, cheapest first, nothing persisted until the last step:
 * role, shape (422), snapshot visibility in this workspace (404, so a foreign id changes nothing),
 * expected_hash against the snapshot hash (422 malformed or 409 stale), proposed manifest limits and validity
 * (413/422), then one transaction that locks the workspace row and rejects (409) a request whose snapshot is
 * no longer the workspace baseline. The lock orders this acceptance against a concurrent snapshot import:
 * either the run is accepted against the baseline that was current at that instant, or it is refused.
 */
export async function requestImpactRun(
  ctx: Ctx,
  principal: Principal,
  input: { body: unknown; idempotencyKey: string | undefined; requestHash: string },
): Promise<IdempotentOutcome<ImpactRunReceipt>> {
  requireRole(principal, "operator");
  const route = { route: "POST /impact-runs", key: input.idempotencyKey, requestHash: input.requestHash };
  const replay = await replayOf<ImpactRunReceipt>(ctx, principal, route);
  if (replay) return replay;
  const parsed = RequestSchema.safeParse(input.body);
  if (!parsed.success) {
    throw unprocessable("SCHEMA_INVALID", "impact run request is not valid", { issues: requestIssues(parsed.error.issues) });
  }
  const body = parsed.data;

  const snap = await ctx.db.query<{ manifest_hash: string; document_hash: string; manifest: string; revision: string }>(
    "SELECT manifest_hash, document_hash, manifest, revision FROM snapshots WHERE workspace_id = $1 AND id = $2",
    [principal.workspaceId, body.snapshot_id],
  );
  const snapshot = snap.rows[0];
  if (!snapshot) throw notFound();

  const hashProblem = checkBaselineHash(snapshot.manifest_hash, body.expected_hash);
  if (hashProblem) throw fromDomainError(hashProblem);

  const { graph } = buildGraphOrThrow(ctx, body.proposed_manifest);
  let keys = body.check_keys ? [...new Set(body.check_keys)] : null;
  if (keys) {
    const known = await existingCheckKeys(ctx.db, principal.workspaceId, keys);
    const unknown = keys.filter((k) => !known.has(k));
    if (unknown.length > 0) throw unprocessable("UNKNOWN_CHECK", "check_keys refers to a check that does not exist or is disabled", { count: unknown.length, indexes: keys.flatMap((k, i) => (known.has(k) ? [] : [i])) });
  } else if (body.run_checks) {
    // "The checks on the changed nodes" is resolved NOW and stored, so a check disabled or removed before the
    // worker runs is still a named request that was not honoured (CHECK_NOT_RUN), never a silent omission.
    const baseline = rebuildVerified(snapshot.manifest, snapshot.manifest_hash, snapshot.document_hash, "baseline snapshot");
    const changedNodeIds = [...new Set(diffGraphs(baseline, graph).map((c) => c.node_id))];
    const limit = ctx.settings.checks.maxChecksPerRun;
    const selected = await selectChecks(ctx.db, principal.workspaceId, { keys: null, changedNodeIds, limit });
    keys = selected.map((row) => row.check_key);
  }
  const proposedText = canonicalJson(exportManifest(graph));
  const now = ctx.clock.now();

  return idempotent(ctx, principal, route, async (tx) => {
    // FOR SHARE conflicts with the FOR UPDATE an import takes, so the two are strictly ordered.
    const ws = await tx.query<{ baseline_snapshot_id: string | null; baseline_version: number }>(
      "SELECT baseline_snapshot_id, baseline_version FROM workspaces WHERE id = $1 FOR SHARE",
      [principal.workspaceId],
    );
    const current = ws.rows[0];
    if (!body.allow_superseded && current?.baseline_snapshot_id !== body.snapshot_id) {
      throw conflict("STALE_BASELINE", "the workspace baseline changed since this snapshot was read; re-read the baseline and retry", {
        current_baseline_snapshot_id: current?.baseline_snapshot_id ?? null,
        baseline_version: current?.baseline_version ?? 0,
      });
    }
    const id = randomUUID();
    await tx.query(
      `INSERT INTO impact_runs (id, workspace_id, snapshot_id, proposed_hash, expected_hash, baseline_hash, baseline_version, proposed_manifest, run_checks, check_keys, allow_superseded, status, requested_by, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,'QUEUED',$12,$13)`,
      [id, principal.workspaceId, body.snapshot_id, graph.hash, body.expected_hash, snapshot.manifest_hash, current?.baseline_version ?? 0, proposedText, body.run_checks, JSON.stringify(keys ?? []), body.allow_superseded, principal.userId, now],
    );
    await recordRunEvent(tx, principal.workspaceId, id, null, "QUEUED", null, now);
    await enqueue(tx, {
      workspaceId: principal.workspaceId,
      type: "assess_run",
      objectId: id,
      payload: { run_id: id },
      runAt: now,
      dedupKey: `assess:${id}`,
      maxAttempts: ctx.settings.jobMaxAttempts,
      now,
    });
    await audit(tx, {
      workspaceId: principal.workspaceId,
      actorType: "user",
      actorId: principal.userId,
      action: "impact_run.requested",
      resourceType: "impact_run",
      resourceId: id,
      at: now,
      metadata: { snapshot_id: body.snapshot_id, baseline_hash: snapshot.manifest_hash, proposed_hash: graph.hash, allow_superseded: body.allow_superseded },
    });
    return {
      status: 202,
      body: { id, status: "queued", snapshot_id: body.snapshot_id, baseline_hash: snapshot.manifest_hash, proposed_hash: graph.hash, baseline_version: current?.baseline_version ?? 0 },
    };
  });
}

// ---- reads ----

export interface FindingView {
  id: string;
  origin_id: string;
  consumer_id: string;
  consumer_kind: string;
  consumer_owner: string | null;
  severity: "high" | "medium";
  direct: boolean;
  depth: number;
  path: string[];
  hops: unknown[];
  /** Hops left out of a very long path; absent when the whole path is shown. */
  path_omitted_hops?: number;
  change_ids: string[];
  /** Change ids left out of `change_ids`; absent when the list is complete. */
  change_ids_omitted?: number;
  reason: string;
}

interface FindingRow {
  finding_key: string;
  position: number;
  origin_id: string;
  consumer_id: string;
  consumer_kind: string;
  consumer_owner: string | null;
  severity: "high" | "medium";
  direct: boolean;
  depth: number;
  path: string[];
  hops: unknown[];
  path_omitted_hops: number;
  change_ids: string[];
  change_ids_omitted: number;
  reason: string;
}

const FINDING_COLUMNS = "finding_key, position, origin_id, consumer_id, consumer_kind, consumer_owner, severity, direct, depth, path, hops, path_omitted_hops, change_ids, change_ids_omitted, reason";

const toFindingView = (r: FindingRow): FindingView => ({
  id: r.finding_key,
  origin_id: r.origin_id,
  consumer_id: r.consumer_id,
  consumer_kind: r.consumer_kind,
  consumer_owner: r.consumer_owner,
  severity: r.severity,
  direct: r.direct,
  depth: r.depth,
  path: r.path,
  hops: r.hops,
  ...(r.path_omitted_hops > 0 ? { path_omitted_hops: r.path_omitted_hops } : {}),
  change_ids: r.change_ids,
  ...(r.change_ids_omitted > 0 ? { change_ids_omitted: r.change_ids_omitted } : {}),
  reason: r.reason,
});

export interface CheckResultView {
  check_key: string;
  node_id: string;
  state: string;
  attempts: number | null;
  detail: string | null;
  error_code: string | null;
  attempt_log: unknown[];
  started_at: string;
  finished_at: string | null;
}

/** Which decision engine produced a run, and whether this build would decide it differently (see ENGINE_VERSION). */
export interface RunEngine {
  /** The engine version stamped on the assessment; runs stored before the stamp existed are version 1. */
  version: number;
  /** The engine version of this build. */
  current: number;
  /** True for a finished run assessed by an older engine: its verdict may differ today, so request a new run. */
  rerun_required: boolean;
  /** Set when `rerun_required`: the sentence a reader should see. */
  note?: string;
}

/** Engine provenance of a stored run, from its assessment detail (`null` until the run has finished). */
export function engineOf(detail: Record<string, unknown> | null, finished: boolean): RunEngine {
  const stamped = typeof detail?.engine_version === "number" ? detail.engine_version : 1;
  const stale = isStaleEngineRun(finished, detail?.engine_version);
  return {
    version: stamped,
    current: ENGINE_VERSION,
    rerun_required: stale,
    ...(stale ? { note: `assessed by an older decision engine (version ${stamped}, this build is ${ENGINE_VERSION}): re-run required; the recorded verdict is history and must not be read as a current answer` } : {}),
  };
}

/**
 * The verdict a reader may act on: `null` for a finished run whose engine is not the current one (its recorded verdict may be
 * a wrong NO_KNOWN_IMPACT), so a script that gates on `assessment == "NO_KNOWN_IMPACT"` cannot accept it. The old verdict is
 * kept in `recorded_assessment`, next to `engine.rerun_required`.
 */
export function currentAssessment(verdict: string | null, engine: RunEngine): string | null {
  return engine.rerun_required ? null : verdict;
}
export function recordedAssessment(verdict: string | null, engine: RunEngine): string | null {
  return engine.rerun_required ? verdict : null;
}

export interface ImpactRunView {
  id: string;
  snapshot_id: string;
  status: ApiRunStatus;
  /**
   * AFFECTED, NO_KNOWN_IMPACT or INCOMPLETE once complete, else null. `complete` describes computation, not safety. Also null
   * for a finished run assessed by an older engine (see `currentAssessment`): its verdict is in `recorded_assessment`.
   */
  assessment: "AFFECTED" | "NO_KNOWN_IMPACT" | "INCOMPLETE" | null;
  /** The verdict an OLDER engine recorded, only for a run with `engine.rerun_required`; history, never a current answer. */
  recorded_assessment: "AFFECTED" | "NO_KNOWN_IMPACT" | "INCOMPLETE" | null;
  baseline_hash: string;
  proposed_hash: string;
  baseline_version: number;
  /** True when the request explicitly assessed against a snapshot that was no longer the workspace baseline. */
  allow_superseded: boolean;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  error: { code: string; detail: string } | null;
  engine: RunEngine;
  summary: unknown;
  coverage: unknown;
  cycles: unknown;
  changes: unknown;
  /** First 100 findings; use the findings endpoint for the rest. */
  affected: Omit<FindingView, "path" | "hops">[];
  paths: { finding_id: string; path: string[]; hops: unknown[]; path_omitted_hops?: number }[];
  unknowns: unknown[];
  checks: CheckResultView[];
  totals: { findings: number; unknowns: number };
  truncated: { findings: boolean; unknowns: boolean };
}

interface RunDetailRow {
  id: string;
  snapshot_id: string;
  status: RunStatus;
  verdict: "AFFECTED" | "NO_KNOWN_IMPACT" | "INCOMPLETE" | null;
  baseline_hash: string;
  proposed_hash: string;
  baseline_version: number;
  allow_superseded: boolean;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  error_code: string | null;
  error_detail: string | null;
  assessment: Record<string, unknown> | null;
  unknowns: unknown[];
}

const RUN_COLUMNS = "id, snapshot_id, status, verdict, baseline_hash, proposed_hash, baseline_version, allow_superseded, created_at, started_at, finished_at, error_code, error_detail, assessment, unknowns";

export async function loadChecks(db: Queryable, workspaceId: string, runId: string): Promise<CheckResultView[]> {
  const rows = await db.query<{ check_key: string; node_id: string; state: string; result: ContractCheckResult | null; started_at: Date; finished_at: Date | null }>(
    "SELECT check_key, node_id, state, result, started_at, finished_at FROM check_results WHERE workspace_id = $1 AND run_id = $2 ORDER BY check_key COLLATE \"C\"",
    [workspaceId, runId],
  );
  return rows.rows.map((r) => ({
    check_key: r.check_key,
    node_id: r.node_id,
    state: r.state,
    attempts: r.result?.attempts ?? null,
    detail: r.result?.detail ?? null,
    error_code: r.result?.error_code ?? null,
    attempt_log: (r.result?.attempt_log as unknown[] | undefined) ?? [],
    started_at: r.started_at.toISOString(),
    finished_at: r.finished_at ? r.finished_at.toISOString() : null,
  }));
}

export async function getImpactRun(ctx: Ctx, principal: Principal, id: string): Promise<ImpactRunView> {
  requireRole(principal, "viewer");
  if (!isUuid(id)) throw notFound();
  const found = await ctx.db.query<RunDetailRow>(`SELECT ${RUN_COLUMNS} FROM impact_runs WHERE workspace_id = $1 AND id = $2`, [principal.workspaceId, id]);
  const run = found.rows[0];
  if (!run) throw notFound();
  const findings = await ctx.db.query<FindingRow>(`SELECT ${FINDING_COLUMNS} FROM findings WHERE workspace_id = $1 AND run_id = $2 ORDER BY position LIMIT 100`, [principal.workspaceId, id]);
  const total = await ctx.db.query<{ n: number }>("SELECT count(*)::int AS n FROM findings WHERE workspace_id = $1 AND run_id = $2", [principal.workspaceId, id]);
  const totalFindings = total.rows[0]?.n ?? 0;
  const detail = run.assessment ?? {};
  const engine = engineOf(run.assessment, run.status === "COMPLETE");
  const unknownsAll = Array.isArray(run.unknowns) ? run.unknowns : [];
  const views = findings.rows.map((r) => redactDeep(toFindingView(r)) as FindingView);
  return redactDeep({
    id: run.id,
    snapshot_id: run.snapshot_id,
    status: apiStatus(run.status),
    assessment: currentAssessment(run.verdict, engine),
    recorded_assessment: recordedAssessment(run.verdict, engine),
    baseline_hash: run.baseline_hash,
    proposed_hash: run.proposed_hash,
    baseline_version: run.baseline_version,
    allow_superseded: run.allow_superseded,
    created_at: run.created_at.toISOString(),
    started_at: run.started_at ? run.started_at.toISOString() : null,
    finished_at: run.finished_at ? run.finished_at.toISOString() : null,
    error: run.error_code ? { code: run.error_code, detail: run.error_detail ?? "" } : null,
    engine,
    summary: detail.summary ?? null,
    coverage: detail.coverage ?? null,
    cycles: detail.cycles ?? [],
    changes: detail.changes ?? [],
    affected: views.map(({ path: _p, hops: _h, ...rest }) => rest),
    paths: views.map((f) => ({ finding_id: f.id, path: f.path, hops: f.hops, ...(f.path_omitted_hops ? { path_omitted_hops: f.path_omitted_hops } : {}) })),
    unknowns: visibleUnknowns(unknownsAll),
    checks: await loadChecks(ctx.db, principal.workspaceId, id),
    totals: { findings: totalFindings, unknowns: unknownsAll.length },
    truncated: { findings: totalFindings > views.length, unknowns: unknownsAll.length > 100 },
  }) as ImpactRunView;
}

/** The first 100 unknowns of a run view, the markers that say a list is incomplete first so they are never cut off. */
export function visibleUnknowns(all: unknown[]): unknown[] {
  const marker = (u: unknown): boolean => {
    const code = (u as { code?: unknown } | null)?.code;
    return code === "FINDINGS_TRUNCATED" || code === "UNKNOWNS_TRUNCATED";
  };
  return [...all.filter(marker), ...all.filter((u) => !marker(u))].slice(0, 100);
}

export interface RunSummary {
  id: string;
  snapshot_id: string;
  status: ApiRunStatus;
  /** Null while unfinished and for a run assessed by an older engine (`recorded_assessment` holds its old verdict). */
  assessment: string | null;
  recorded_assessment: string | null;
  proposed_hash: string;
  created_at: string;
  finished_at: string | null;
  /** True for a finished run assessed by an older decision engine: its verdict may differ today, request a new run. */
  rerun_required: boolean;
}

export async function listImpactRuns(
  ctx: Ctx,
  principal: Principal,
  opts: { limit: number; cursor?: string | undefined; status?: string | undefined; snapshotId?: string | undefined },
): Promise<Page<RunSummary>> {
  requireRole(principal, "viewer");
  const after = decodeCursor(opts.cursor, ["iso", "uuid"]);
  let statusFilter: string | null = null;
  if (opts.status !== undefined) {
    const upper = opts.status.toUpperCase();
    if (!["QUEUED", "RUNNING", "COMPLETE", "FAILED"].includes(upper)) throw unprocessable("SCHEMA_INVALID", "status must be queued, running, complete or failed");
    statusFilter = upper;
  }
  if (opts.snapshotId !== undefined && !isUuid(opts.snapshotId)) throw unprocessable("SCHEMA_INVALID", "snapshot_id must be a UUID");
  const rows = await ctx.db.query<{ id: string; snapshot_id: string; status: RunStatus; verdict: string | null; proposed_hash: string; created_at: Date; finished_at: Date | null; engine_version: unknown }>(
    // The stamp as stored (jsonb, not text): the list decides "older engine" from the same raw value as the run view, so a
    // stamp that is not a number (a numeric string) is stale in both and never current in one of them.
    `SELECT id, snapshot_id, status, verdict, proposed_hash, created_at, finished_at, assessment->'engine_version' AS engine_version FROM impact_runs
      WHERE workspace_id = $1
        AND ($2::text IS NULL OR status = $2::text)
        AND ($3::uuid IS NULL OR snapshot_id = $3::uuid)
        AND ($4::timestamptz IS NULL OR (created_at, id) < ($4::timestamptz, $5::uuid))
      ORDER BY created_at DESC, id DESC LIMIT $6`,
    [principal.workspaceId, statusFilter, opts.snapshotId ?? null, after ? after[0] : null, after ? after[1] : null, opts.limit + 1],
  );
  const page = rows.rows.slice(0, opts.limit);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => {
      const engine = engineOf(r.engine_version === null ? {} : { engine_version: r.engine_version }, r.status === "COMPLETE");
      return {
        id: r.id,
        snapshot_id: r.snapshot_id,
        status: apiStatus(r.status),
        assessment: currentAssessment(r.verdict, engine),
        recorded_assessment: recordedAssessment(r.verdict, engine),
        proposed_hash: r.proposed_hash,
        created_at: r.created_at.toISOString(),
        finished_at: r.finished_at ? r.finished_at.toISOString() : null,
        rerun_required: engine.rerun_required,
      };
    }),
    next_cursor: rows.rows.length > opts.limit && last ? encodeCursor([last.created_at.toISOString(), last.id]) : null,
  };
}

export async function listFindings(ctx: Ctx, principal: Principal, runId: string, opts: { limit: number; cursor?: string | undefined }): Promise<Page<FindingView> & { rerun_required: boolean }> {
  requireRole(principal, "viewer");
  if (!isUuid(runId)) throw notFound();
  const exists = await ctx.db.query<{ status: string; assessment: Record<string, unknown> | null }>("SELECT status, assessment FROM impact_runs WHERE workspace_id = $1 AND id = $2", [principal.workspaceId, runId]);
  if (exists.rows.length === 0) throw notFound();
  // The rows of a run from an older decision engine are its recorded history: the page says so, like the run view does.
  const rerunRequired = engineOf(exists.rows[0]?.assessment ?? null, exists.rows[0]?.status === "COMPLETE").rerun_required;
  const after = decodeCursor(opts.cursor, ["int4"]);
  const rows = await ctx.db.query<FindingRow>(
    `SELECT ${FINDING_COLUMNS} FROM findings WHERE workspace_id = $1 AND run_id = $2 AND position > $3 ORDER BY position LIMIT $4`,
    [principal.workspaceId, runId, after ? after[0] : -1, opts.limit + 1],
  );
  const page = rows.rows.slice(0, opts.limit);
  const last = page[page.length - 1];
  return { items: page.map((r) => redactDeep(toFindingView(r)) as FindingView), next_cursor: rows.rows.length > opts.limit && last ? encodeCursor([last.position]) : null, rerun_required: rerunRequired };
}
