import { randomUUID } from "node:crypto";
import type { Database, Queryable } from "../db/index.js";
import type { Clock } from "../domain/clock.js";
import { redactSecrets } from "../domain/redaction.js";
import { type Ctx, addSeconds } from "../platform/context.js";
import { type Page, decodeCursor, encodeCursor } from "../platform/cursor.js";
import { type Principal, requireRole } from "./auth.js";

export const EVENT_SCHEMA_VERSION = 1;
export const EVENT_SOURCE = "changeradar";

export const EVENT_TYPES = ["snapshot.imported", "impact_run.completed", "impact_run.failed"] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** The versioned adapter envelope from PRD section 6. */
export interface EventEnvelope {
  schema_version: 1;
  event_id: string;
  source: "changeradar";
  resource_id: string;
  event_type: EventType;
  occurred_at: string;
  revision: string;
  evidence_ref: string;
  correlation_id?: string;
}

/**
 * The envelope as it leaves the server (served by GET /events, pushed to the sink): its free-text members are redacted with the log
 * redactor, whatever was stored. A revision is text a person typed, and a row written by an earlier build may hold a value that the
 * validator of that build accepted and the current one refuses (`release pin: 5533xyz`); the stored row is never rewritten.
 */
export function redactEnvelope(envelope: EventEnvelope): EventEnvelope {
  return {
    ...envelope,
    revision: redactSecrets(envelope.revision),
    evidence_ref: redactSecrets(envelope.evidence_ref),
    ...(envelope.correlation_id !== undefined ? { correlation_id: redactSecrets(envelope.correlation_id) } : {}),
  };
}

/** Append an event in the same transaction as the state change it announces (transactional outbox). */
export async function appendEvent(
  tx: Queryable,
  input: { workspaceId: string; eventType: EventType; resourceId: string; revision: string; evidenceRef: string; occurredAt: Date; correlationId?: string },
): Promise<EventEnvelope> {
  const envelope: EventEnvelope = {
    schema_version: EVENT_SCHEMA_VERSION,
    event_id: randomUUID(),
    source: EVENT_SOURCE,
    resource_id: input.resourceId,
    event_type: input.eventType,
    occurred_at: input.occurredAt.toISOString(),
    revision: input.revision,
    evidence_ref: input.evidenceRef,
    ...(input.correlationId ? { correlation_id: input.correlationId } : {}),
  };
  const stored = redactEnvelope(envelope);
  await tx.query(
    `INSERT INTO outbox_events (id, workspace_id, envelope, state, next_attempt_at, created_at)
     VALUES ($1,$2,$3::jsonb,'pending',$4,$4)`,
    [envelope.event_id, input.workspaceId, JSON.stringify(stored), input.occurredAt],
  );
  return stored;
}

export interface OutboxRecord {
  seq: number;
  state: "pending" | "delivered";
  envelope: EventEnvelope;
}

/**
 * Pull interface for adapters (operator and admin). `seq` is assigned at insert, so a reader that must not
 * miss a late-committing transaction re-reads from a little before its last cursor and deduplicates on
 * event_id; delivery is at least once.
 */
export async function listEvents(ctx: Ctx, principal: Principal, opts: { limit: number; cursor?: string | undefined }): Promise<Page<OutboxRecord>> {
  requireRole(principal, "operator");
  const after = decodeCursor(opts.cursor, ["number"]);
  const rows = await ctx.db.query<{ seq: string; state: "pending" | "delivered"; envelope: EventEnvelope }>(
    `SELECT seq::text AS seq, state, envelope FROM outbox_events
      WHERE workspace_id = $1 AND seq > $2::bigint ORDER BY seq LIMIT $3`,
    [principal.workspaceId, after ? after[0] : 0, opts.limit + 1],
  );
  const items = rows.rows.slice(0, opts.limit).map((r) => ({ seq: Number(r.seq), state: r.state, envelope: redactEnvelope(r.envelope) }));
  const last = items[items.length - 1];
  return { items, next_cursor: rows.rows.length > opts.limit && last ? encodeCursor([last.seq]) : null };
}

export interface ClaimedEvent {
  id: string;
  workspace_id: string;
  envelope: EventEnvelope;
  attempts: number;
}

/** Claim a bounded batch of due events with a lease (no row lock is held while delivering). */
export async function claimEvents(db: Database, clock: Clock, leaseSeconds: number, batch: number): Promise<ClaimedEvent[]> {
  const now = clock.now();
  const result = await db.query<ClaimedEvent>(
    `UPDATE outbox_events SET attempts = attempts + 1, lease_until = $1
      WHERE id IN (
        SELECT id FROM outbox_events
         WHERE state = 'pending' AND next_attempt_at <= $2 AND (lease_until IS NULL OR lease_until < $2)
         ORDER BY seq LIMIT $3 FOR UPDATE SKIP LOCKED)
      RETURNING id, workspace_id, envelope, attempts`,
    [addSeconds(now, leaseSeconds), now, batch],
  );
  return result.rows.map((row) => ({ ...row, envelope: redactEnvelope(row.envelope) }));
}

export async function markDelivered(db: Database, clock: Clock, id: string): Promise<void> {
  await db.query("UPDATE outbox_events SET state = 'delivered', delivered_at = $2, lease_until = NULL, last_error = NULL WHERE id = $1", [id, clock.now()]);
}

/** Failed delivery keeps the event pending and schedules the next attempt with exponential backoff. */
export async function markDeliveryFailed(db: Database, clock: Clock, event: ClaimedEvent, error: string): Promise<void> {
  const delay = Math.min(3600, 2 ** Math.min(event.attempts, 12));
  await db.query(
    "UPDATE outbox_events SET lease_until = NULL, next_attempt_at = $2, last_error = $3 WHERE id = $1",
    [event.id, addSeconds(clock.now(), delay), redactSecrets(error).slice(0, 300)],
  );
}
