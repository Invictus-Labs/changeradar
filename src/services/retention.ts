import type { Ctx } from "../platform/context.js";
import { audit } from "./audit.js";

/**
 * Operator-approved retention. Nothing here runs by itself: the server never deletes evidence on a timer.
 * The PRD defaults (redacted evidence 90 days, primary deletion within 24 hours of an approved request, backup
 * expiry 30 days) are proposals the operator must approve before customer data is ingested; `plan` shows what
 * a window would remove, `apply` removes it inside one transaction that sets the purge flag the append-only
 * triggers require. The current baseline snapshot and every snapshot still referenced by a kept run survive.
 */
export interface RetentionPlan {
  cutoff: string;
  older_than_days: number;
  workspace_id: string | null;
  impact_runs: number;
  findings: number;
  snapshots: number;
}

const ELIGIBLE_RUNS = `
  SELECT r.id FROM impact_runs r
   WHERE r.status IN ('COMPLETE', 'FAILED') AND coalesce(r.finished_at, r.created_at) < $1
     AND ($2::uuid IS NULL OR r.workspace_id = $2::uuid)`;

const ELIGIBLE_SNAPSHOTS = `
  SELECT s.id, s.workspace_id FROM snapshots s JOIN workspaces w ON w.id = s.workspace_id
   WHERE s.imported_at < $1 AND ($2::uuid IS NULL OR s.workspace_id = $2::uuid)
     AND w.baseline_snapshot_id IS DISTINCT FROM s.id
     AND NOT EXISTS (SELECT 1 FROM impact_runs r WHERE r.snapshot_id = s.id AND r.id NOT IN (${ELIGIBLE_RUNS}))`;

function cutoffFor(ctx: Ctx, days: number): Date {
  if (!Number.isInteger(days) || days < 1) throw new Error("retention window must be a whole number of days, at least 1");
  return new Date(ctx.clock.now().getTime() - days * 86_400_000);
}

export async function planRetention(ctx: Ctx, days: number, workspaceId?: string): Promise<RetentionPlan> {
  const cutoff = cutoffFor(ctx, days);
  const params = [cutoff, workspaceId ?? null];
  const runs = await ctx.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${ELIGIBLE_RUNS}) x`, params);
  const findings = await ctx.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM findings WHERE run_id IN (${ELIGIBLE_RUNS})`, params);
  const snapshots = await ctx.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${ELIGIBLE_SNAPSHOTS}) x`, params);
  return {
    cutoff: cutoff.toISOString(),
    older_than_days: days,
    workspace_id: workspaceId ?? null,
    impact_runs: runs.rows[0]?.n ?? 0,
    findings: findings.rows[0]?.n ?? 0,
    snapshots: snapshots.rows[0]?.n ?? 0,
  };
}

/** Delete what `planRetention` reports, atomically. The audit trail is never purged; it records that this happened. */
export async function applyRetention(ctx: Ctx, days: number, workspaceId?: string): Promise<RetentionPlan> {
  const cutoff = cutoffFor(ctx, days);
  const params = [cutoff, workspaceId ?? null];
  const now = ctx.clock.now();
  return ctx.db.transaction(async (tx) => {
    await tx.query("SET LOCAL changeradar.purge = 'on'");
    // Snapshots are chosen BEFORE their runs disappear, so "still referenced by a kept run" is decided correctly.
    const snapshotRows = (await tx.query<{ id: string; workspace_id: string }>(ELIGIBLE_SNAPSHOTS, params)).rows;
    const snapshotIds = snapshotRows.map((r) => r.id);
    const runs = await tx.query<{ id: string; workspace_id: string }>(
      `SELECT r.id, r.workspace_id FROM impact_runs r WHERE r.id IN (${ELIGIBLE_RUNS})`,
      params,
    );
    const runIds = runs.rows.map((r) => r.id);
    let findings = 0;
    if (runIds.length > 0) {
      findings = (await tx.query<{ n: number }>("WITH gone AS (DELETE FROM findings WHERE run_id = ANY($1::uuid[]) RETURNING 1) SELECT count(*)::int AS n FROM gone", [runIds])).rows[0]?.n ?? 0;
      await tx.query("DELETE FROM check_results WHERE run_id = ANY($1::uuid[])", [runIds]);
      await tx.query("DELETE FROM run_events WHERE run_id = ANY($1::uuid[])", [runIds]);
      await tx.query("DELETE FROM impact_runs WHERE id = ANY($1::uuid[])", [runIds]);
    }
    if (snapshotIds.length > 0) {
      await tx.query("DELETE FROM edges WHERE snapshot_id = ANY($1::uuid[])", [snapshotIds]);
      await tx.query("DELETE FROM nodes WHERE snapshot_id = ANY($1::uuid[])", [snapshotIds]);
      await tx.query("DELETE FROM snapshots WHERE id = ANY($1::uuid[])", [snapshotIds]);
    }
    const workspaces = new Set([...runs.rows, ...snapshotRows].map((r) => r.workspace_id));
    for (const ws of workspaces) {
      await audit(tx, {
        workspaceId: ws,
        actorType: "cli",
        actorId: null,
        action: "retention.applied",
        resourceType: "workspace",
        resourceId: ws,
        at: now,
        metadata: { older_than_days: days, cutoff: cutoff.toISOString(), impact_runs: runIds.length, snapshots: snapshotIds.length },
      });
    }
    return { cutoff: cutoff.toISOString(), older_than_days: days, workspace_id: workspaceId ?? null, impact_runs: runIds.length, findings, snapshots: snapshotIds.length };
  });
}
