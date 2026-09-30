import { randomUUID } from "node:crypto";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { Queryable } from "../db/index.js";
import { canonicalJson } from "../domain/canonical.js";
import { capLeaves, capText } from "../domain/derived-text.js";
import type { Ctx } from "../platform/context.js";
import { audit } from "./audit.js";
import { type EvidenceBundle, BundleError, staleEngineRuns, verifyBundle } from "./evidence.js";
import { buildGraph } from "./graph.js";
import { insertGraphRows } from "./snapshots.js";

export interface RestoreSummary {
  workspace_id: string;
  snapshots: number;
  impact_runs: number;
  findings: number;
  contract_checks: number;
  /** Runs that were still queued or running when the bundle was written; restored as FAILED, never as finished. */
  interrupted_runs: string[];
  /** Finished runs that were assessed by an older decision engine: restored as history, shown as "re-run required". */
  stale_runs: string[];
}

// Free text of an untrusted bundle is kept bounded (capText, capLeaves: src/domain/derived-text.ts): it becomes live state
// (names, run errors, event notes), and the decision engine derives its own text within the same bound.

export interface RestoreHooks {
  /** Test hook: called after each table group is written, inside the transaction. Throwing aborts the restore. */
  afterStep?: (step: "workspace" | "snapshots" | "checks" | "runs" | "findings") => void | Promise<void>;
}

/**
 * The restore transaction. A verified bundle can still hold a value the database refuses (verification checks what it can:
 * bundle-bounds.ts); whatever it still refuses (SQLSTATE class 22 data exceptions, class 23 constraint violations) is a
 * REJECTED BUNDLE, reported under its own code (exit 2, nothing written), not an unexplained failure carrying a database
 * message. Other errors (a conflict, a lost connection) pass through unchanged.
 */
async function restoreTransaction(ctx: Ctx, work: (tx: Queryable) => Promise<void>): Promise<void> {
  try {
    await ctx.db.transaction(work);
  } catch (error) {
    const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
    if (typeof code === "string" && /^2[23][0-9A-Z]{3}$/.test(code)) {
      throw new BundleError("BUNDLE_SCHEMA_INVALID", "the bundle holds a value the database refuses; nothing was restored");
    }
    throw error;
  }
}

export class RestoreConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RestoreConflictError";
  }
}

/**
 * Restore a verified bundle into a clean installation. The bundle is fully verified in memory first
 * (`verifyBundle`); the write then happens inside ONE database transaction that either commits the whole
 * workspace or leaves the database untouched, which is what makes the swap atomic. Snapshot, run and
 * finding ids are preserved. Users, sessions and credential values are never part of a bundle: create
 * administrators with `changeradar admin create --workspace-id` afterwards.
 */
export async function restoreBundle(ctx: Ctx, input: string | Uint8Array, hooks: RestoreHooks = {}): Promise<RestoreSummary> {
  const bundle = verifyBundle(input, { maxBytes: ctx.settings.maxBundleBytes });
  const now = ctx.clock.now();
  const interrupted: string[] = [];

  await restoreTransaction(ctx, async (tx) => {
    await assertClean(tx, bundle);
    await tx.query("INSERT INTO workspaces (id, name, created_at) VALUES ($1,$2,$3)", [bundle.workspace.id, capText(bundle.workspace.name), bundle.workspace.created_at]);
    await hooks.afterStep?.("workspace");

    for (const s of bundle.snapshots) {
      // The embedded database resolves every query as a microtask; without a turn of the event loop between
      // steps a SIGINT or SIGTERM waits for the whole restore. The transaction still commits or rolls back whole.
      await nextTurn();
      const built = buildGraph(s.manifest);
      /* c8 ignore next */
      if (!built.ok) throw new BundleError("BUNDLE_SNAPSHOT_MISMATCH", "snapshot no longer validates");
      await tx.query(
        `INSERT INTO snapshots (id, workspace_id, schema_version, revision, manifest_hash, document_hash, manifest, node_count, edge_count, warnings, baseline_version, imported_at)
         VALUES ($1,$2,1,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)`,
        [s.id, bundle.workspace.id, capText(s.revision), s.graph_hash, s.document_hash, canonicalJson(s.manifest), s.node_count, s.edge_count, JSON.stringify(capLeaves(s.warnings)), s.baseline_version, s.imported_at],
      );
      await insertGraphRows(tx, bundle.workspace.id, s.id, built.graph);
    }
    if (bundle.baseline.snapshot_id !== null) {
      await tx.query("UPDATE workspaces SET baseline_snapshot_id = $2, baseline_version = $3 WHERE id = $1", [bundle.workspace.id, bundle.baseline.snapshot_id, bundle.baseline.version]);
    }
    await hooks.afterStep?.("snapshots");

    // A bundle is not authenticated, so its check definitions never come back live: every check is restored
    // DISABLED (URL and credential alias untouched, for a reader to inspect). An administrator re-creates the
    // ones they still want through the API, where the allowlist and secret rules apply.
    for (const c of bundle.contract_checks) {
      await tx.query(
        `INSERT INTO contract_checks (id, workspace_id, check_key, node_id, url, method, timeout_ms, retries, expect_status, required_fields, credential_alias, enabled, created_at, disabled_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,false,$12,$13)`,
        [randomUUID(), bundle.workspace.id, capText(c.key), capText(c.node_id), capText(c.url), c.method, c.timeout_ms, c.retries, c.expect_status, JSON.stringify(capLeaves(c.required_fields)), capText(c.credential_alias), c.created_at, c.disabled_at ?? now],
      );
    }
    await hooks.afterStep?.("checks");

    let findingCount = 0;
    for (const r of bundle.impact_runs) {
      await nextTurn();
      const unfinished = r.status === "QUEUED" || r.status === "RUNNING";
      if (unfinished) interrupted.push(r.id);
      const status = unfinished ? "FAILED" : r.status;
      await tx.query(
        `INSERT INTO impact_runs (id, workspace_id, snapshot_id, proposed_hash, expected_hash, baseline_hash, baseline_version, proposed_manifest, run_checks, check_keys, allow_superseded,
                                  status, verdict, assessment, unknowns, error_code, error_detail, created_at, started_at, finished_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14::jsonb,$15::jsonb,$16,$17,$18,$19,$20)`,
        [
          r.id, bundle.workspace.id, r.snapshot_id, r.proposed_hash, capText(r.expected_hash), r.baseline_hash, r.baseline_version, canonicalJson(r.proposed_manifest), r.run_checks,
          JSON.stringify(capLeaves(r.check_keys)), r.allow_superseded, status, r.verdict, r.assessment_detail === null ? null : JSON.stringify(capLeaves(r.assessment_detail)), JSON.stringify(capLeaves(r.unknowns)),
          unfinished ? "RESTORED_UNFINISHED" : capText(r.error_code), unfinished ? "the run had not finished when the backup was taken; no verdict exists, request a new run" : capText(r.error_detail),
          r.created_at, r.started_at, unfinished ? now : r.finished_at,
        ],
      );
      for (const e of r.events) {
        await tx.query("INSERT INTO run_events (workspace_id, run_id, from_status, to_status, note, at) VALUES ($1,$2,$3,$4,$5,$6)", [bundle.workspace.id, r.id, capText(e.from_status), capText(e.to_status), capText(e.note), e.at]);
      }
      if (unfinished) {
        await tx.query("INSERT INTO run_events (workspace_id, run_id, from_status, to_status, note, at) VALUES ($1,$2,$3,'FAILED','restored from a backup while unfinished',$4)", [bundle.workspace.id, r.id, r.status, now]);
      }
      for (const c of r.checks) {
        const open = c.state === "STARTED";
        await tx.query(
          `INSERT INTO check_results (id, workspace_id, run_id, check_key, node_id, state, definition, result, started_at, finished_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10)`,
          [randomUUID(), bundle.workspace.id, r.id, capText(c.check_key), capText(c.node_id), open ? "UNKNOWN" : c.state, JSON.stringify(capLeaves(c.definition)), c.result === null ? null : JSON.stringify(capLeaves(c.result)), c.started_at, open ? now : c.finished_at],
        );
      }
      for (let i = 0; i < r.findings.length; i += 500) {
        // Every string of a finding is bounded like the rest (a run from an older engine is not re-derived, so its text is only hashed).
        const slice = r.findings.slice(i, i + 500).map((f) => ({ ...(capLeaves(f) as typeof f), id: randomUUID(), path_omitted_hops: f.path_omitted_hops ?? 0, change_ids_omitted: f.change_ids_omitted ?? 0 }));
        await tx.query(
          `INSERT INTO findings (id, workspace_id, run_id, finding_key, position, origin_id, consumer_id, consumer_kind, consumer_owner, severity, direct, depth, path, hops, path_omitted_hops, change_ids, change_ids_omitted, reason)
           SELECT x.id, $1::uuid, $2::uuid, x.finding_key, x.position, x.origin_id, x.consumer_id, x.consumer_kind, x.consumer_owner, x.severity, x.direct, x.depth, x.path, x.hops, x.path_omitted_hops, x.change_ids, x.change_ids_omitted, x.reason
             FROM jsonb_to_recordset($3::jsonb) AS x(id uuid, finding_key text, position integer, origin_id text, consumer_id text, consumer_kind text, consumer_owner text, severity text, direct boolean, depth integer, path jsonb, hops jsonb, path_omitted_hops integer, change_ids jsonb, change_ids_omitted integer, reason text)`,
          [bundle.workspace.id, r.id, JSON.stringify(slice)],
        );
      }
      findingCount += r.findings.length;
    }
    await hooks.afterStep?.("runs");
    await hooks.afterStep?.("findings");

    await audit(tx, {
      workspaceId: bundle.workspace.id,
      actorType: "cli",
      actorId: null,
      action: "bundle.restored",
      resourceType: "workspace",
      resourceId: bundle.workspace.id,
      at: now,
      metadata: { bundle_hash: bundle.bundle_hash, snapshots: bundle.snapshots.length, impact_runs: bundle.impact_runs.length, findings: findingCount, interrupted_runs: interrupted.length },
    });
  });

  return {
    workspace_id: bundle.workspace.id,
    snapshots: bundle.snapshots.length,
    impact_runs: bundle.impact_runs.length,
    findings: bundle.impact_runs.reduce((n, r) => n + r.findings.length, 0),
    contract_checks: bundle.contract_checks.length,
    interrupted_runs: interrupted,
    stale_runs: staleEngineRuns(bundle),
  };
}

/** A restore targets a clean installation: refuse before writing if any identifier is already present. */
async function assertClean(tx: Queryable, bundle: EvidenceBundle): Promise<void> {
  const ws = await tx.query("SELECT 1 FROM workspaces WHERE id = $1", [bundle.workspace.id]);
  if (ws.rows.length > 0) throw new RestoreConflictError("a workspace with this id already exists; restore targets a clean installation");
  const snapshotIds = bundle.snapshots.map((s) => s.id);
  if (snapshotIds.length > 0) {
    const clash = await tx.query("SELECT 1 FROM snapshots WHERE id = ANY($1::uuid[]) LIMIT 1", [snapshotIds]);
    if (clash.rows.length > 0) throw new RestoreConflictError("a snapshot id in the bundle already exists in this installation");
  }
  const runIds = bundle.impact_runs.map((r) => r.id);
  if (runIds.length > 0) {
    const clash = await tx.query("SELECT 1 FROM impact_runs WHERE id = ANY($1::uuid[]) LIMIT 1", [runIds]);
    if (clash.rows.length > 0) throw new RestoreConflictError("a run id in the bundle already exists in this installation");
  }
}
