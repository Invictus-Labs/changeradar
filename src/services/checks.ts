import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Queryable } from "../db/index.js";
import { FIELD_TYPES } from "../domain/types.js";
import { containsSecret, redactIdentifiers } from "../domain/redaction.js";
import type { Ctx } from "../platform/context.js";
import { type Page, decodeCursor, encodeCursor } from "../platform/cursor.js";
import { conflict, notFound, requestIssues, unprocessable } from "../platform/errors.js";
import { IDENTIFIER, hasControlChars, isUuid } from "../platform/ids.js";
import { EgressDeniedError, checkUrlAgainstAllowlist } from "../workers/ssrf.js";
import { audit } from "./audit.js";
import { type Principal, requireRole } from "./auth.js";
import { idempotent, type IdempotentOutcome, replayOf } from "./idempotency.js";
import type { HttpCheckSpec } from "../workers/checks.js";

const ALIAS = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface CheckView {
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

interface CheckRow {
  id: string;
  check_key: string;
  node_id: string;
  url: string;
  method: "GET" | "HEAD";
  timeout_ms: number;
  retries: number;
  expect_status: number;
  required_fields: { name: string; type: string }[];
  credential_alias: string | null;
  enabled: boolean;
  created_at: Date;
  disabled_at: Date | null;
  configured?: boolean;
}

const COLUMNS = `c.id, c.check_key, c.node_id, c.url, c.method, c.timeout_ms, c.retries, c.expect_status, c.required_fields, c.credential_alias, c.enabled, c.created_at, c.disabled_at,
  (c.credential_alias IS NOT NULL AND EXISTS (SELECT 1 FROM credential_secrets s WHERE s.workspace_id = c.workspace_id AND s.alias = c.credential_alias)) AS configured`;

/** Every string of a check view is shown at the strength the validator applied when it was stored (rows written before a rule existed are covered too). */
const toView = (r: CheckRow): CheckView => redactIdentifiers(rawView(r)) as CheckView;
const rawView = (r: CheckRow): CheckView => ({
  id: r.id,
  key: r.check_key,
  node_id: r.node_id,
  url: r.url,
  method: r.method,
  timeout_ms: r.timeout_ms,
  retries: r.retries,
  expect_status: r.expect_status,
  required_fields: r.required_fields,
  credential_alias: r.credential_alias,
  credential_configured: r.configured === true,
  enabled: r.enabled,
  created_at: r.created_at.toISOString(),
  disabled_at: r.disabled_at ? r.disabled_at.toISOString() : null,
});

export const toSpec = (r: CheckRow): HttpCheckSpec => ({
  key: r.check_key,
  node_id: r.node_id,
  url: r.url,
  method: r.method,
  expect_status: r.expect_status,
  required_fields: r.required_fields.map((f) => ({ name: f.name, type: f.type as (typeof FIELD_TYPES)[number] })),
  credential_alias: r.credential_alias,
  timeout_ms: r.timeout_ms,
  retries: r.retries,
});

export function bodySchema(maxTimeoutMs: number) {
  return z.strictObject({
    key: z.string().regex(IDENTIFIER),
    node_id: z.string().regex(IDENTIFIER),
    url: z.string().min(1).max(2048),
    method: z.enum(["GET", "HEAD"]).default("GET"),
    timeout_ms: z.number().int().min(1).max(maxTimeoutMs).default(Math.min(5000, maxTimeoutMs)),
    retries: z.number().int().min(0).max(3).default(2),
    expect_status: z.number().int().min(100).max(599).default(200),
    required_fields: z
      .array(z.strictObject({ name: z.string().min(1).max(255), type: z.enum(FIELD_TYPES) }))
      .max(100)
      .default([]),
    credential_alias: z.string().regex(ALIAS).nullable().default(null),
  });
}

/** Admin creates a read-only contract check. The URL must already be on the operator egress allowlist. */
export async function createCheck(
  ctx: Ctx,
  principal: Principal,
  input: { body: unknown; idempotencyKey: string | undefined; requestHash: string },
): Promise<IdempotentOutcome<CheckView>> {
  requireRole(principal, "admin");
  const route = { route: "POST /contract-checks", key: input.idempotencyKey, requestHash: input.requestHash };
  const replay = await replayOf<CheckView>(ctx, principal, route);
  if (replay) return replay;
  const parsed = bodySchema(ctx.settings.checks.maxTimeoutMs).safeParse(input.body);
  if (!parsed.success) {
    throw unprocessable("SCHEMA_INVALID", "check definition is not valid", { issues: requestIssues(parsed.error.issues) });
  }
  const b = parsed.data;
  if (b.method === "HEAD" && b.required_fields.length > 0) throw unprocessable("SCHEMA_INVALID", "required_fields need GET, HEAD has no body");
  const names = new Set(b.required_fields.map((f) => f.name));
  if (names.size !== b.required_fields.length) throw unprocessable("SCHEMA_INVALID", "required_fields names must be unique");
  if (containsSecret(b.url) || hasControlChars(b.url)) throw unprocessable("SECRET_VALUE_REJECTED", "url must not contain credentials or control characters");
  // The key and node id are stored, listed, exported and quoted in unknowns: a secret-shaped one is refused like any other identifier.
  if (containsSecret(b.key) || containsSecret(b.node_id)) throw unprocessable("SECRET_VALUE_REJECTED", "key and node_id must not look like secrets");
  if (b.required_fields.some((field) => containsSecret(field.name)) || (b.credential_alias !== null && containsSecret(b.credential_alias))) {
    throw unprocessable("SECRET_VALUE_REJECTED", "required_fields names and credential_alias must not look like secrets");
  }
  try {
    checkUrlAgainstAllowlist(b.url, ctx.settings.checks.allowedHosts);
  } catch (error) {
    if (error instanceof EgressDeniedError) throw unprocessable("URL_NOT_ALLOWED", error.message, { reason: error.code });
    throw error;
  }
  const now = ctx.clock.now();
  return idempotent(ctx, principal, route, async (tx) => {
    const existing = await tx.query<{ id: string; enabled: boolean }>("SELECT id, enabled FROM contract_checks WHERE workspace_id = $1 AND check_key = $2", [principal.workspaceId, b.key]);
    const previous = existing.rows[0];
    if (previous?.enabled) throw conflict("CHECK_EXISTS", "a contract check with this key already exists");
    if (previous) {
      // A DISABLED check with this key (disabled by an administrator, or restored from a bundle, which never re-arms a
      // check) is replaced by the definition just vetted above: the allowlist and secret rules have already run.
      // Same id and key, so runs and callers that name the key keep working.
      await tx.query(
        `UPDATE contract_checks SET node_id = $3, url = $4, method = $5, timeout_ms = $6, retries = $7, expect_status = $8, required_fields = $9::jsonb,
                credential_alias = $10, enabled = true, disabled_at = NULL WHERE workspace_id = $1 AND id = $2`,
        [principal.workspaceId, previous.id, b.node_id, b.url, b.method, b.timeout_ms, b.retries, b.expect_status, JSON.stringify(b.required_fields), b.credential_alias],
      );
      await audit(tx, { workspaceId: principal.workspaceId, actorType: "user", actorId: principal.userId, action: "contract_check.reenabled", resourceType: "contract_check", resourceId: previous.id, at: now, metadata: { key: b.key, node_id: b.node_id, credential_alias: b.credential_alias } });
      const back = await tx.query<CheckRow>(`SELECT ${COLUMNS} FROM contract_checks c WHERE c.workspace_id = $1 AND c.id = $2`, [principal.workspaceId, previous.id]);
      return { status: 201, body: toView(back.rows[0] as CheckRow) };
    }
    const id = randomUUID();
    await tx.query(
      `INSERT INTO contract_checks (id, workspace_id, check_key, node_id, url, method, timeout_ms, retries, expect_status, required_fields, credential_alias, enabled, created_by, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,true,$12,$13)`,
      [id, principal.workspaceId, b.key, b.node_id, b.url, b.method, b.timeout_ms, b.retries, b.expect_status, JSON.stringify(b.required_fields), b.credential_alias, principal.userId, now],
    );
    await audit(tx, { workspaceId: principal.workspaceId, actorType: "user", actorId: principal.userId, action: "contract_check.created", resourceType: "contract_check", resourceId: id, at: now, metadata: { key: b.key, node_id: b.node_id, credential_alias: b.credential_alias } });
    const row = await tx.query<CheckRow>(`SELECT ${COLUMNS} FROM contract_checks c WHERE c.workspace_id = $1 AND c.id = $2`, [principal.workspaceId, id]);
    return { status: 201, body: toView(row.rows[0] as CheckRow) };
  });
}

export async function listChecks(ctx: Ctx, principal: Principal, opts: { limit: number; cursor?: string | undefined }): Promise<Page<CheckView>> {
  requireRole(principal, "operator");
  const after = decodeCursor(opts.cursor, ["string"]);
  const rows = await ctx.db.query<CheckRow>(
    `SELECT ${COLUMNS} FROM contract_checks c
      WHERE c.workspace_id = $1 AND ($2::text IS NULL OR c.check_key COLLATE "C" > $2::text COLLATE "C")
      ORDER BY c.check_key COLLATE "C" LIMIT $3`,
    [principal.workspaceId, after ? after[0] : null, opts.limit + 1],
  );
  const items = rows.rows.slice(0, opts.limit).map(toView);
  const last = items[items.length - 1];
  return { items, next_cursor: rows.rows.length > opts.limit && last ? encodeCursor([last.key]) : null };
}

export async function disableCheck(ctx: Ctx, principal: Principal, id: string): Promise<CheckView> {
  requireRole(principal, "admin");
  if (!isUuid(id)) throw notFound();
  const now = ctx.clock.now();
  return ctx.db.transaction(async (tx) => {
    const found = await tx.query<CheckRow>(`SELECT ${COLUMNS} FROM contract_checks c WHERE c.workspace_id = $1 AND c.id = $2 FOR UPDATE OF c`, [principal.workspaceId, id]);
    const row = found.rows[0];
    if (!row) throw notFound();
    if (row.enabled) {
      await tx.query("UPDATE contract_checks SET enabled = false, disabled_at = $3 WHERE workspace_id = $1 AND id = $2", [principal.workspaceId, id, now]);
      await audit(tx, { workspaceId: principal.workspaceId, actorType: "user", actorId: principal.userId, action: "contract_check.disabled", resourceType: "contract_check", resourceId: id, at: now });
    }
    const after = await tx.query<CheckRow>(`SELECT ${COLUMNS} FROM contract_checks c WHERE c.workspace_id = $1 AND c.id = $2`, [principal.workspaceId, id]);
    return toView(after.rows[0] as CheckRow);
  });
}

/** Enabled check definitions selected for a run: explicit keys, or those on the changed nodes. */
export async function selectChecks(tx: Queryable, workspaceId: string, opts: { keys: readonly string[] | null; changedNodeIds: readonly string[]; limit: number }): Promise<CheckRow[]> {
  const rows =
    opts.keys !== null
      ? await tx.query<CheckRow>(`SELECT ${COLUMNS} FROM contract_checks c WHERE c.workspace_id = $1 AND c.enabled AND c.check_key = ANY($2::text[]) ORDER BY c.check_key COLLATE "C" LIMIT $3`, [workspaceId, [...opts.keys], opts.limit + 1])
      : await tx.query<CheckRow>(`SELECT ${COLUMNS} FROM contract_checks c WHERE c.workspace_id = $1 AND c.enabled AND c.node_id = ANY($2::text[]) ORDER BY c.check_key COLLATE "C" LIMIT $3`, [workspaceId, [...opts.changedNodeIds], opts.limit + 1]);
  return rows.rows;
}

export async function existingCheckKeys(tx: Queryable, workspaceId: string, keys: readonly string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const rows = await tx.query<{ check_key: string }>("SELECT check_key FROM contract_checks WHERE workspace_id = $1 AND enabled AND check_key = ANY($2::text[])", [workspaceId, [...keys]]);
  return new Set(rows.rows.map((r) => r.check_key));
}

// ---- credential values (CLI only; sealed with the operator-managed key) ----

export function validateAlias(alias: string): void {
  if (!ALIAS.test(alias)) throw new Error("alias must be 1 to 128 characters of letters, digits, . _ : - and start with a letter or digit");
}

export async function setCredential(ctx: Ctx, workspaceId: string, alias: string, value: string): Promise<void> {
  validateAlias(alias);
  if (value.length === 0 || value.length > 4096 || hasControlChars(value)) throw new Error("credential value must be 1 to 4096 printable characters");
  const now = ctx.clock.now();
  const sealed = ctx.box.encrypt(value);
  await ctx.db.query(
    `INSERT INTO credential_secrets (workspace_id, alias, secret_enc, created_at, updated_at) VALUES ($1,$2,$3,$4,$4)
     ON CONFLICT (workspace_id, alias) DO UPDATE SET secret_enc = EXCLUDED.secret_enc, updated_at = EXCLUDED.updated_at`,
    [workspaceId, alias, sealed, now],
  );
}

export async function deleteCredential(ctx: Ctx, workspaceId: string, alias: string): Promise<boolean> {
  const result = await ctx.db.query("DELETE FROM credential_secrets WHERE workspace_id = $1 AND alias = $2 RETURNING alias", [workspaceId, alias]);
  return result.rows.length > 0;
}

export async function listCredentialAliases(ctx: Ctx, workspaceId: string): Promise<string[]> {
  const rows = await ctx.db.query<{ alias: string }>("SELECT alias FROM credential_secrets WHERE workspace_id = $1 ORDER BY alias", [workspaceId]);
  return rows.rows.map((r) => r.alias);
}

export async function loadCredential(ctx: Ctx, workspaceId: string, alias: string): Promise<string | null> {
  const rows = await ctx.db.query<{ secret_enc: string }>("SELECT secret_enc FROM credential_secrets WHERE workspace_id = $1 AND alias = $2", [workspaceId, alias]);
  const row = rows.rows[0];
  return row ? ctx.box.decrypt(row.secret_enc) : null;
}
