import { randomUUID } from "node:crypto";
import type { Queryable } from "../db/index.js";
import { runContractCheck, type ContractCheckResult } from "../domain/contract-checks.js";
import type { RunStatus } from "../domain/types.js";
import type { Ctx } from "../platform/context.js";
import { assess } from "../services/assess.js";
import { diffGraphs } from "../services/diff.js";
import { loadCredential, selectChecks, toSpec } from "../services/checks.js";
import { assertLease, claimJob, completeWith, extendLease, failJob, type Job, LeaseLostError, reapExhausted } from "../services/jobs.js";
import { claimEvents, markDelivered, markDeliveryFailed } from "../services/outbox.js";
import { beginRun, completeRun, concludeCheck, failRun, lockRun, type RunRow, startCheck } from "../services/run-store.js";
import { liveChecksOf } from "../services/evidence.js";
import { IntegrityError, rebuildVerified } from "../services/snapshots.js";
import { definitionFor, httpCheckRunner } from "./checks.js";
import { safePost } from "./safe-fetch.js";

/** Thrown by test hooks to model a process dying: no cleanup, no failure record, the lease simply expires. */
export class SimulatedCrash extends Error {
  constructor() {
    super("simulated worker crash");
    this.name = "SimulatedCrash";
  }
}

export interface WorkerHooks {
  /** Called right after a job is claimed. */
  afterClaim?: (job: Job) => void | Promise<void>;
  /** Called after a check is durably marked STARTED and before its request is made. */
  afterCheckStarted?: (checkKey: string) => void | Promise<void>;
  /** Called after a check's final state is durably recorded and before the run is completed. */
  afterCheckConcluded?: (checkKey: string) => void | Promise<void>;
}

export interface WorkerOptions {
  workerId?: string;
  /** Lease heartbeat period. Defaults to a third of the lease (at least one second); tests shorten it. */
  heartbeatMs?: number;
  hooks?: WorkerHooks;
}

export type WorkerResult = "idle" | "done" | "crashed" | "lease_lost" | "retry" | "dead";

/** Process at most one job. Returns what happened, for tests and logs. */
export async function runWorkerOnce(ctx: Ctx, options: WorkerOptions = {}): Promise<{ job: Job | null; result: WorkerResult }> {
  const workerId = options.workerId ?? `worker-${randomUUID()}`;
  await reapExhausted(ctx.db, ctx.clock, (tx, dead) => surfaceDeadJob(tx, ctx, dead));
  const job = await claimJob(ctx.db, workerId, ctx.clock, ctx.settings.jobLeaseSeconds);
  if (!job) return { job: null, result: "idle" };
  // A heartbeat keeps a healthy long-running job's lease alive; a crashed worker stops beating and loses it.
  const beat = setInterval(() => {
    void extendLease(ctx.db, job, ctx.clock, ctx.settings.jobLeaseSeconds).catch(() => undefined);
  }, options.heartbeatMs ?? Math.max(1000, (ctx.settings.jobLeaseSeconds * 1000) / 3));
  try {
    await options.hooks?.afterClaim?.(job);
    await processAssessRun(ctx, job, options.hooks);
    return { job, result: "done" };
  } catch (error) {
    if (error instanceof SimulatedCrash) return { job, result: "crashed" };
    if (error instanceof LeaseLostError) return { job, result: "lease_lost" };
    try {
      const state = await failJob(ctx.db, job, error as Error, ctx.clock, (tx, dead) => surfaceDeadJob(tx, ctx, dead));
      ctx.diagnostics({ event: "worker.job_failed", level: "warn", job_id: job.id, code: error instanceof Error ? error.name : "error" });
      return { job, result: state === "dead" ? "dead" : "retry" };
    } catch (failure) {
      if (failure instanceof LeaseLostError) return { job, result: "lease_lost" };
      throw failure;
    }
  } finally {
    clearInterval(beat);
  }
}

interface RunContext {
  run: RunRow;
  revision: string;
  baselineManifest: string;
  baselineDocHash: string;
}

async function processAssessRun(ctx: Ctx, job: Job, hooks: WorkerHooks | undefined): Promise<void> {
  const workspaceId = job.workspace_id;
  const runId = job.object_id;

  // Phase A (fenced transaction): take the run to RUNNING, or finish immediately when there is nothing to do.
  const started = await ctx.db.transaction(async (tx): Promise<RunContext | "nothing"> => {
    await assertLease(tx, job);
    const run = await lockRun(tx, workspaceId, runId);
    if (!run) return "nothing";
    const begun = await beginRun(tx, run, ctx.clock.now());
    if (!begun.proceed) return "nothing";
    const snap = await tx.query<{ manifest: string; document_hash: string; revision: string }>(
      "SELECT manifest, document_hash, revision FROM snapshots WHERE workspace_id = $1 AND id = $2",
      [workspaceId, run.snapshot_id],
    );
    const s = snap.rows[0] as { manifest: string; document_hash: string; revision: string };
    return { run, revision: s.revision, baselineManifest: s.manifest, baselineDocHash: s.document_hash };
  });
  if (started === "nothing") {
    await completeWith(ctx.db, job, async () => undefined, ctx.clock);
    return;
  }
  const { run, revision } = started;
  const failWith = async (code: string, detail: string): Promise<void> => {
    await completeWith(
      ctx.db,
      job,
      async (tx) => {
        await failRun(tx, run, "RUNNING", code, detail, revision, ctx.clock.now());
        await concludeStartedChecksUnknown(tx, run, ctx);
      },
      ctx.clock,
    );
  };

  // Phase B (no transaction): rebuild both graphs from stored canonical text and verify their hashes.
  let baseline;
  let proposed;
  try {
    baseline = rebuildVerified(started.baselineManifest, run.baseline_hash, started.baselineDocHash, "baseline snapshot");
    proposed = rebuildVerified(run.proposed_manifest, run.proposed_hash, null, "proposed manifest");
  } catch (error) {
    if (error instanceof IntegrityError) return failWith("INTEGRITY_FAILURE", error.message);
    throw error;
  }

  // Phase C: contract checks. Each is made durable as STARTED before any request leaves the process.
  const changedNodes = [...new Set(diffGraphs(baseline, proposed).map((c) => c.node_id))];
  const limit = ctx.settings.checks.maxChecksPerRun;
  const selected = run.run_checks
    ? await selectChecks(ctx.db, workspaceId, { keys: run.check_keys.length > 0 ? run.check_keys : null, changedNodeIds: changedNodes, limit })
    : [];
  if (selected.length > limit) {
    return failWith("TOO_MANY_CHECKS", `the run selects more than ${limit} contract checks; narrow check_keys`);
  }
  const checksStarted = Date.now();
  for (const row of selected) {
    const spec = toSpec(row);
    const definition = definitionFor(spec, ctx.settings.checks.backoffBaseMs);
    const begin = await ctx.db.transaction(async (tx) => {
      await assertLease(tx, job);
      return startCheck(tx, run, definition, { ...spec }, ctx.clock.now());
    });
    if (begin.outcome !== "started") continue;
    if (Date.now() - checksStarted >= ctx.settings.checks.runBudgetMs) {
      // Budget used up: this check is recorded as not run (TIMED_OUT, an unknown), never skipped silently.
      const at = ctx.clock.now().toISOString();
      const notRun: ContractCheckResult = {
        check_id: spec.key,
        node_id: spec.node_id,
        state: "TIMED_OUT",
        attempts: 0,
        started_at: at,
        finished_at: at,
        duration_ms: 0,
        detail: "not run: the time budget for this run's contract checks was used up",
        error_code: "TIMEOUT",
        attempt_log: [{ attempt: 0, state: "TIMED_OUT", detail: "not run: run check budget used up", error_code: "TIMEOUT" }],
      };
      await ctx.db.transaction(async (tx) => {
        await assertLease(tx, job);
        await concludeCheck(tx, run, notRun);
      });
      continue;
    }
    await hooks?.afterCheckStarted?.(spec.key);
    const runner = httpCheckRunner(spec, {
      policy: { allowedHosts: ctx.settings.checks.allowedHosts, allowPrivateNetwork: ctx.settings.checks.allowPrivateNetwork },
      resolver: ctx.resolver,
      maxBodyBytes: ctx.settings.checks.maxBodyBytes,
      maxRedirects: ctx.settings.checks.maxRedirects,
      backoffBaseMs: ctx.settings.checks.backoffBaseMs,
      loadCredential: (alias) => loadCredential(ctx, workspaceId, alias),
    });
    const result = await runContractCheck(definition, runner, { clock: ctx.clock, max_timeout_ms: ctx.settings.checks.maxTimeoutMs });
    await ctx.db.transaction(async (tx) => {
      await assertLease(tx, job);
      await concludeCheck(tx, run, result);
    });
    await hooks?.afterCheckConcluded?.(spec.key);
  }

  // Phase D: assess with EVERY recorded check outcome of this run (including ones from an earlier attempt).
  // A check left STARTED by an earlier attempt that is no longer selected still has an unknown outcome.
  await ctx.db.transaction(async (tx) => {
    await assertLease(tx, job);
    await concludeStartedChecksUnknown(tx, run, ctx);
  });
  const recorded = await ctx.db.query<{ check_key: string; state: string; result: ContractCheckResult | null }>(
    "SELECT check_key, state, result FROM check_results WHERE workspace_id = $1 AND run_id = $2 ORDER BY check_key COLLATE \"C\"",
    [workspaceId, runId],
  );
  const withResults = recorded.rows.filter((r): r is { check_key: string; state: string; result: ContractCheckResult } => r.result !== null);
  const checkResults = withResults.map((r) => r.result);
  // A check the request named that has no recorded outcome (disabled or removed before this worker ran) was
  // never run: that is an unknown, not "no check needed".
  const recordedKeys = new Set(withResults.map((r) => r.check_key));
  const missingCheckKeys = run.run_checks ? run.check_keys.filter((k) => !recordedKeys.has(k)) : [];
  const outcome = assess({
    baseline,
    proposed,
    expected_hash: run.baseline_hash,
    clock: ctx.clock,
    check_results: checkResults,
    missing_check_keys: missingCheckKeys,
    live_checks: liveChecksOf(run.run_checks, checkResults.length),
    config: ctx.settings.assess,
  });
  /* v8 ignore start -- defensive: both hashes were verified against the recorded ones above, so assess() cannot
     report a stale or malformed baseline hash here. Kept so an impossible refusal fails the run visibly. */
  if (!outcome.ok) return failWith(outcome.error.code, outcome.error.message);
  /* v8 ignore stop */
  // Backstop for the assessment's own bounds: never persist (or export) an oversized result, fail the run visibly.
  const outputBytes = JSON.stringify(outcome.assessment).length;
  if (outputBytes > ctx.settings.maxAssessmentBytes) {
    return failWith("OUTPUT_TOO_LARGE", `the assessment is ${outputBytes} bytes, above the limit of ${ctx.settings.maxAssessmentBytes}; narrow the change`);
  }

  // Phase E (fenced): findings, terminal state, event and job completion in ONE transaction.
  await completeWith(
    ctx.db,
    job,
    async (tx) => {
      await completeRun(tx, run, outcome.assessment, revision, ctx.clock.now());
    },
    ctx.clock,
  );
}

/** Any check still STARTED when a run ends has an unknown external outcome: record that, never a pass. */
async function concludeStartedChecksUnknown(tx: Queryable, run: RunRow, ctx: Ctx): Promise<void> {
  const rows = await tx.query<{ check_key: string; node_id: string }>("SELECT check_key, node_id FROM check_results WHERE run_id = $1 AND state = 'STARTED' FOR UPDATE", [run.id]);
  const at = ctx.clock.now().toISOString();
  for (const r of rows.rows) {
    await concludeCheck(tx, run, {
      check_id: r.check_key,
      node_id: r.node_id,
      state: "UNKNOWN",
      attempts: 1,
      started_at: at,
      finished_at: at,
      duration_ms: 0,
      detail: "the run ended before this check concluded; the external outcome is unknown",
      error_code: null,
      attempt_log: [{ attempt: 1, state: "UNKNOWN", detail: "run ended before the check concluded", error_code: null }],
    });
  }
}

/** A job that exhausted its attempts must surface as a visible FAILED run, never linger as queued or pass. */
async function surfaceDeadJob(tx: Queryable, ctx: Ctx, job: Job): Promise<void> {
  const run = await lockRun(tx, job.workspace_id, job.object_id);
  if (!run || run.status === "COMPLETE" || run.status === "FAILED") return;
  const snap = await tx.query<{ revision: string }>("SELECT revision FROM snapshots WHERE workspace_id = $1 AND id = $2", [job.workspace_id, run.snapshot_id]);
  await concludeStartedChecksUnknown(tx, run, ctx);
  await failRun(tx, run, run.status as RunStatus, "WORKER_EXHAUSTED", "the worker exhausted its attempts before the run finished; no verdict exists", snap.rows[0]?.revision ?? "unknown", ctx.clock.now());
}

/**
 * Deliver pending outbox events to the optional sink. Disabled unless CHANGERADAR_EVENT_SINK_URL is set. The
 * sink URL follows the same egress rules as contract checks. At least once: an event is marked delivered only
 * after a 2xx answer, so a crash in between causes a redelivery that consumers deduplicate on event_id.
 */
export async function relayOutboxOnce(ctx: Ctx): Promise<{ delivered: number; failed: number }> {
  const sink = ctx.settings.eventSinkUrl;
  if (!sink) return { delivered: 0, failed: 0 };
  const events = await claimEvents(ctx.db, ctx.clock, ctx.settings.jobLeaseSeconds, 20);
  let delivered = 0;
  let failed = 0;
  for (const event of events) {
    try {
      const response = await safePost(sink, Buffer.from(JSON.stringify(event.envelope), "utf8"), {
        policy: { allowedHosts: ctx.settings.checks.allowedHosts, allowPrivateNetwork: ctx.settings.checks.allowPrivateNetwork },
        resolver: ctx.resolver,
        timeoutMs: 10_000,
        maxBodyBytes: 64 * 1024,
        maxRedirects: 0,
      });
      if (response.status >= 200 && response.status < 300) {
        await markDelivered(ctx.db, ctx.clock, event.id);
        delivered += 1;
      } else {
        await markDeliveryFailed(ctx.db, ctx.clock, event, `sink answered HTTP ${response.status}`);
        failed += 1;
      }
    } catch (error) {
      await markDeliveryFailed(ctx.db, ctx.clock, event, error instanceof Error ? error.message : "delivery failed");
      failed += 1;
    }
  }
  return { delivered, failed };
}

/** Poll loop for `serve` and `worker`. */
export function startWorker(ctx: Ctx, options: { intervalMs?: number; hooks?: WorkerHooks } = {}): () => Promise<void> {
  const workerId = `worker-${randomUUID()}`;
  let stopped = false;
  let running: Promise<void> = Promise.resolve();
  const tick = async (): Promise<void> => {
    while (!stopped) {
      const { job, result } = await runWorkerOnce(ctx, { workerId, ...(options.hooks ? { hooks: options.hooks } : {}) });
      if (!job) break;
      ctx.diagnostics({ event: "worker.job", level: "info", job_id: job.id, code: result });
    }
    if (!stopped) await relayOutboxOnce(ctx);
  };
  const timer = setInterval(() => {
    running = running.then(tick).catch(() => ctx.diagnostics({ event: "worker.error", level: "error", code: "worker_poll_failed" }));
  }, options.intervalMs ?? 500);
  return async () => {
    stopped = true;
    clearInterval(timer);
    await running;
  };
}
