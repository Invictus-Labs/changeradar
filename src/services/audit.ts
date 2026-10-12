import { randomUUID } from "node:crypto";
import { redactDeep } from "../domain/redaction.js";
import type { Queryable } from "../db/index.js";
import type { Ctx } from "../platform/context.js";
import { type Page, decodeCursor, encodeCursor } from "../platform/cursor.js";
import { type Principal, requireRole } from "./auth.js";

export interface AuditInput {
  workspaceId: string;
  actorType: "user" | "system" | "cli" | "worker";
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId: string;
  at: Date;
  metadata?: Record<string, unknown>;
}

/** Append one audit row inside the caller's transaction. Metadata is redacted before storage. */
export async function audit(tx: Queryable, input: AuditInput): Promise<void> {
  await tx.query(
    `INSERT INTO audit_events (id, workspace_id, actor_type, actor_id, action, resource_type, resource_id, created_at, redacted_metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
    [
      randomUUID(),
      input.workspaceId,
      input.actorType,
      input.actorId,
      input.action,
      input.resourceType,
      input.resourceId,
      input.at,
      JSON.stringify(redactDeep(input.metadata ?? {})),
    ],
  );
}

export interface AuditRecord {
  seq: number;
  actor_type: string;
  actor_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string;
  created_at: string;
  metadata: unknown;
}

export async function listAudit(ctx: Ctx, principal: Principal, opts: { limit: number; cursor?: string | undefined }): Promise<Page<AuditRecord>> {
  requireRole(principal, "admin");
  const after = decodeCursor(opts.cursor, ["number"]);
  const rows = await ctx.db.query<{
    seq: string;
    actor_type: string;
    actor_id: string | null;
    action: string;
    resource_type: string;
    resource_id: string;
    created_at: Date;
    redacted_metadata: unknown;
  }>(
    `SELECT seq::text AS seq, actor_type, actor_id, action, resource_type, resource_id, created_at, redacted_metadata
       FROM audit_events WHERE workspace_id = $1 AND seq > $2::bigint ORDER BY seq LIMIT $3`,
    [principal.workspaceId, after ? after[0] : 0, opts.limit + 1],
  );
  const page = rows.rows.slice(0, opts.limit);
  const items = page.map((r) => ({
    seq: Number(r.seq),
    actor_type: r.actor_type,
    actor_id: r.actor_id,
    action: r.action,
    resource_type: r.resource_type,
    resource_id: r.resource_id,
    created_at: r.created_at.toISOString(),
    // Redacted again when served: a row written by an earlier build was redacted by the rules of that build.
    metadata: redactDeep(r.redacted_metadata),
  }));
  const last = items[items.length - 1];
  return { items, next_cursor: rows.rows.length > opts.limit && last ? encodeCursor([last.seq]) : null };
}
