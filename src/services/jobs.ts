import { randomUUID } from "node:crypto";
import type { Database, Queryable } from "../db/index.js";
import type { Clock } from "../domain/clock.js";
import { addSeconds } from "../platform/context.js";

export type JobType = "assess_run";

export interface Job {
  id: string;
  workspace_id: string;
  type: JobType;
  object_id: string;
  payload: Record<string, unknown>;
  schema_version: number;
  state: "queued" | "running" | "done" | "dead";
  attempt: number;
  max_attempts: number;
  lease_until: Date | null;
  locked_by: string | null;
  next_attempt_at: Date;
  deduplication_key: string;
  last_error: string | null;
}

/** Enqueue inside the caller's transaction; the deduplication key makes enqueue idempotent. */
export async function enqueue(
  tx: Queryable,
  job: { workspaceId: string; type: JobType; objectId: string; payload: Record<string, unknown>; runAt: Date; dedupKey: string; maxAttempts: number; now: Date },
): Promise<string> {
  const id = randomUUID();
  await tx.query(
    `INSERT INTO jobs (id, workspace_id, type, object_id, payload, state, next_attempt_at, deduplication_key, max_attempts, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5::jsonb,'queued',$6,$7,$8,$9,$9)
     ON CONFLICT (deduplication_key) DO NOTHING`,
    [id, job.workspaceId, job.type, job.objectId, JSON.stringify(job.payload), job.runAt, job.dedupKey, job.maxAttempts, job.now],
  );
  return id;
}

/**
 * Claim one due job with a row lock and a bounded lease. A running job whose lease expired (the worker
 * crashed between claim and completion) becomes reclaimable. `attempt` counts claims, so a job that keeps
 * killing its worker is eventually dead rather than retried forever.
 */
export async function claimJob(db: Database, workerId: string, clock: Clock, leaseSeconds: number): Promise<Job | null> {
  const now = clock.now();
  const result = await db.query<Job>(
    `UPDATE jobs SET state = 'running', attempt = attempt + 1, locked_by = $1, lease_until = $2, updated_at = $3
      WHERE id = (
        SELECT id FROM jobs
         WHERE attempt < max_attempts
           AND ((state = 'queued' AND next_attempt_at <= $3) OR (state = 'running' AND lease_until < $3))
         ORDER BY next_attempt_at, created_at
         LIMIT 1
         FOR UPDATE SKIP LOCKED)
      RETURNING *`,
    [workerId, addSeconds(now, leaseSeconds), now],
  );
  return result.rows[0] ?? null;
}

export class LeaseLostError extends Error {
  constructor() {
    super("job lease lost to another worker");
    this.name = "LeaseLostError";
  }
}

/** Extend a live lease. Fenced on (locked_by, attempt): a worker that lost its lease cannot revive it. */
export async function extendLease(db: Queryable, job: Job, clock: Clock, leaseSeconds: number): Promise<boolean> {
  const now = clock.now();
  const result = await db.query(
    `UPDATE jobs SET lease_until = $1, updated_at = $2
      WHERE id = $3 AND locked_by = $4 AND attempt = $5 AND state = 'running' AND lease_until >= $2
      RETURNING id`,
    [addSeconds(now, leaseSeconds), now, job.id, job.locked_by, job.attempt],
  );
  return result.rows.length > 0;
}

/** Assert (and lock) that this worker still owns the job. Used inside every fenced write transaction. */
export async function assertLease(tx: Queryable, job: Job): Promise<void> {
  const fence = await tx.query(
    "SELECT id FROM jobs WHERE id = $1 AND locked_by = $2 AND attempt = $3 AND state = 'running' FOR UPDATE",
    [job.id, job.locked_by, job.attempt],
  );
  if (fence.rows.length === 0) throw new LeaseLostError();
}

/** Run the handler and mark the job done in one transaction, fenced on (locked_by, attempt). */
export async function completeWith(db: Database, job: Job, handler: (tx: Queryable) => Promise<void>, clock: Clock): Promise<void> {
  await db.transaction(async (tx) => {
    await assertLease(tx, job);
    await handler(tx);
    await tx.query("UPDATE jobs SET state = 'done', lease_until = NULL, updated_at = $2 WHERE id = $1", [job.id, clock.now()]);
  });
}

/** Record a fenced failure (retry with exponential backoff, or dead) and its terminal effect atomically. */
export async function failJob(
  db: Database,
  job: Job,
  error: Error,
  clock: Clock,
  onDead: (tx: Queryable, job: Job) => Promise<void>,
): Promise<"queued" | "dead"> {
  return db.transaction(async (tx) => {
    const now = clock.now();
    const dead = job.attempt >= job.max_attempts;
    const result = await tx.query<Job>(
      `UPDATE jobs SET state = $2, lease_until = NULL, next_attempt_at = $3, last_error = $4, updated_at = $5
        WHERE id = $1 AND locked_by = $6 AND attempt = $7 AND state = 'running' RETURNING *`,
      [job.id, dead ? "dead" : "queued", addSeconds(now, 2 ** job.attempt), error.message.slice(0, 500), now, job.locked_by, job.attempt],
    );
    if (!result.rows[0]) throw new LeaseLostError();
    if (dead) await onDead(tx, result.rows[0]);
    return dead ? "dead" : "queued";
  });
}

/** Terminal status and its visible effect share one transaction; a crash rolls both back. */
export async function reapExhausted(
  db: Database,
  clock: Clock,
  onDead: (tx: Queryable, job: Job) => Promise<void>,
): Promise<Job[]> {
  return db.transaction(async (tx) => {
    const result = await tx.query<Job>(
      `UPDATE jobs SET state = 'dead', lease_until = NULL, last_error = COALESCE(last_error, 'lease expired on final attempt'), updated_at = $1
        WHERE state = 'running' AND lease_until < $1 AND attempt >= max_attempts RETURNING *`,
      [clock.now()],
    );
    for (const job of result.rows) await onDead(tx, job);
    return result.rows;
  });
}
