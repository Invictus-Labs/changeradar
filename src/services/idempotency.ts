import type { Queryable } from "../db/index.js";
import { type Ctx, MIN_IDEMPOTENCY_RETENTION_DAYS } from "../platform/context.js";
import { badRequest, conflict } from "../platform/errors.js";
import type { Principal } from "./auth.js";

const KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export interface IdempotentOutcome<T> {
  status: number;
  body: T;
  /** True when the receipt of an earlier identical request was returned and nothing was executed. */
  replayed: boolean;
}

export function parseIdempotencyKey(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  if (!KEY_PATTERN.test(raw)) {
    throw badRequest("INVALID_IDEMPOTENCY_KEY", "Idempotency-Key must be 1 to 128 characters of letters, digits, . _ : -");
  }
  return raw;
}

async function storedReceipt<T>(db: Queryable, principal: Principal, args: { route: string; key: string; requestHash: string }): Promise<IdempotentOutcome<T> | null> {
  const prior = await db.query<{ body_hash: string; status: number; response: T }>(
    "SELECT body_hash, status, response FROM idempotency_keys WHERE workspace_id = $1 AND actor_id = $2 AND route = $3 AND key = $4",
    [principal.workspaceId, principal.userId, args.route, args.key],
  );
  const stored = prior.rows[0];
  if (!stored) return null;
  if (stored.body_hash !== args.requestHash) {
    throw conflict("IDEMPOTENCY_CONFLICT", "This Idempotency-Key was already used with a different request");
  }
  return { status: stored.status, body: stored.response, replayed: true };
}

/**
 * Cheap early check, run BEFORE any validation that depends on current state (baseline hash, allowlist, ...):
 * a retry of an accepted request must return its original receipt even if the world has moved on since, and a
 * key reused with a different body is a conflict regardless of what else is wrong with the new body.
 */
export async function replayOf<T>(
  ctx: Ctx,
  principal: Principal,
  args: { route: string; key: string | undefined; requestHash: string },
): Promise<IdempotentOutcome<T> | null> {
  if (args.key === undefined) return null;
  return storedReceipt<T>(ctx.db, principal, { route: args.route, key: args.key, requestHash: args.requestHash });
}

/**
 * Execute a mutation exactly once per (workspace, actor, route, key). `requestHash` identifies the request
 * body (and any route parameters). Same key and same request returns the stored receipt; the same key with a
 * different request is a 409. Without a key the mutation simply runs in a transaction.
 *
 * The receipt is written in the same transaction as the effect, so a crash never leaves an effect without a
 * receipt or a receipt without an effect. An advisory lock serializes concurrent replays of one key.
 * Failed requests store nothing (their transaction rolls back), so a corrected retry is a fresh attempt.
 */
export async function idempotent<T>(
  ctx: Ctx,
  principal: Principal,
  args: { route: string; key: string | undefined; requestHash: string },
  effect: (tx: Queryable) => Promise<{ status: number; body: T }>,
): Promise<IdempotentOutcome<T>> {
  if (args.key === undefined) {
    const result = await ctx.db.transaction(effect);
    return { ...result, replayed: false };
  }
  const key = args.key;
  return ctx.db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${principal.workspaceId}:${principal.userId}:${args.route}:${key}`]);
    const replay = await storedReceipt<T>(tx, principal, { route: args.route, key, requestHash: args.requestHash });
    if (replay) return replay;
    const result = await effect(tx);
    await tx.query(
      "INSERT INTO idempotency_keys (workspace_id, actor_id, route, key, body_hash, status, response, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)",
      [principal.workspaceId, principal.userId, args.route, key, args.requestHash, result.status, JSON.stringify(result.body), ctx.clock.now()],
    );
    return { ...result, replayed: false };
  });
}

/**
 * Delete idempotency keys older than `olderThanDays`. Retention below the seven day minimum is refused:
 * a client retrying within a week must always see its original receipt.
 */
export async function pruneIdempotencyKeys(ctx: Ctx, olderThanDays: number): Promise<number> {
  if (!Number.isFinite(olderThanDays) || olderThanDays < MIN_IDEMPOTENCY_RETENTION_DAYS) {
    throw new Error(`idempotency keys must be retained at least ${MIN_IDEMPOTENCY_RETENTION_DAYS} days`);
  }
  const cutoff = new Date(ctx.clock.now().getTime() - olderThanDays * 86_400_000);
  const result = await ctx.db.query<{ n: number }>(
    "WITH gone AS (DELETE FROM idempotency_keys WHERE created_at < $1 RETURNING 1) SELECT count(*)::int AS n FROM gone",
    [cutoff],
  );
  return result.rows[0]?.n ?? 0;
}
