import { randomUUID } from "node:crypto";
import type { Queryable } from "../db/index.js";
import { canonicalJson } from "../domain/canonical.js";
import { DEFAULT_LIMITS } from "../domain/limits.js";
import { containsSecret, redactDeep } from "../domain/redaction.js";
import { type Ctx } from "../platform/context.js";
import { type Page, decodeCursor, encodeCursor } from "../platform/cursor.js";
import { AppError, badRequest, notFound, unprocessable } from "../platform/errors.js";
import { hasControlChars, isUuid } from "../platform/ids.js";
import { type DependencyGraph, buildGraph, buildGraphFromJson, exportManifest, type GraphWarning } from "./graph.js";
import { audit } from "./audit.js";
import { type Principal, requireRole } from "./auth.js";
import { idempotent, type IdempotentOutcome, replayOf } from "./idempotency.js";
import { appendEvent } from "./outbox.js";

/** Stored data no longer matches its recorded hash: corruption, never a stale request. */
export class IntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrityError";
  }
}

export interface SnapshotSummary {
  id: string;
  revision: string;
  hash: string;
  document_hash: string;
  schema_version: 1;
  node_count: number;
  edge_count: number;
  baseline_version: number;
  is_baseline: boolean;
  imported_at: string;
  warnings: unknown;
}

export interface ImportReceipt extends SnapshotSummary {
  warnings: readonly GraphWarning[];
}

const CHUNK = 2000;

/** Validate the request envelope. Returns the pieces; throws 422 with the same codes the domain uses. */
export function parseSnapshotBody(body: unknown): { revision: string; manifest: Record<string, unknown> } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw unprocessable("SCHEMA_INVALID", "request body must be a JSON object");
  }
  const doc = body as Record<string, unknown>;
  for (const key of Object.keys(doc)) {
    if (!["schema_version", "revision", "manifest"].includes(key)) {
      throw unprocessable("SCHEMA_INVALID", "request body has an unknown property");
    }
  }
  const version = doc.schema_version;
  if (typeof version !== "number" || !Number.isInteger(version)) {
    throw unprocessable("SCHEMA_INVALID", "schema_version must be an integer");
  }
  if (version !== 1) throw unprocessable("UNSUPPORTED_SCHEMA_VERSION", "only schema_version 1 is supported");
  const revision = doc.revision;
  if (typeof revision !== "string" || revision.length < 1 || revision.length > 200 || hasControlChars(revision)) {
    throw unprocessable("SCHEMA_INVALID", "revision must be a string of 1 to 200 printable characters");
  }
  if (containsSecret(revision)) throw unprocessable("SECRET_VALUE_REJECTED", "revision looks like a secret");
  const manifest = doc.manifest;
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    throw unprocessable("SCHEMA_INVALID", "manifest must be a JSON object");
  }
  return { revision, manifest: manifest as Record<string, unknown> };
}

/** Build a graph from a request manifest, mapping a domain failure onto the API envelope. */
export function buildGraphOrThrow(ctx: Ctx, manifest: unknown): { graph: DependencyGraph; warnings: readonly GraphWarning[] } {
  const built = buildGraph(manifest, { limits: { max_nodes: ctx.settings.maxNodes, max_edges: ctx.settings.maxEdges, max_manifest_bytes: ctx.settings.maxManifestBytes } });
  if (!built.ok) {
    const { failure } = built;
    throw new AppError(failure.status, failure.code, failure.message, {}, { issues: failure.issues, total_issues: failure.total_issues });
  }
  return { graph: built.graph, warnings: built.warnings };
}

export async function insertGraphRows(tx: Queryable, workspaceId: string, snapshotId: string, graph: DependencyGraph): Promise<void> {
  for (let i = 0; i < graph.nodes.length; i += CHUNK) {
    const rows = graph.nodes.slice(i, i + CHUNK).map((n) => ({
      id: n.id,
      kind: n.kind,
      owner: n.owner,
      version: n.version,
      placeholder: n.placeholder,
      contract: n.contract,
    }));
    await tx.query(
      `INSERT INTO nodes (workspace_id, snapshot_id, id, kind, owner, version, placeholder, contract)
       SELECT $1::uuid, $2::uuid, x.id, x.kind, x.owner, x.version, x.placeholder, NULLIF(x.contract, 'null'::jsonb)
         FROM jsonb_to_recordset($3::jsonb) AS x(id text, kind text, owner text, version text, placeholder boolean, contract jsonb)`,
      [workspaceId, snapshotId, JSON.stringify(rows)],
    );
  }
  for (let i = 0; i < graph.edges.length; i += CHUNK) {
    const rows = graph.edges.slice(i, i + CHUNK).map((e) => ({
      source_id: e.source_id,
      target_id: e.target_id,
      relation: e.relation,
      source_file: e.source_file,
      source_line: e.source_line,
      verified_at: e.verified_at,
      fields: e.fields,
    }));
    await tx.query(
      `INSERT INTO edges (workspace_id, snapshot_id, source_id, target_id, relation, source_file, source_line, verified_at, fields)
       SELECT $1::uuid, $2::uuid, x.source_id, x.target_id, x.relation, x.source_file, x.source_line, x.verified_at::timestamptz, NULLIF(x.fields, 'null'::jsonb)
         FROM jsonb_to_recordset($3::jsonb)
           AS x(source_id text, target_id text, relation text, source_file text, source_line integer, verified_at text, fields jsonb)`,
      [workspaceId, snapshotId, JSON.stringify(rows)],
    );
  }
}

/**
 * POST /api/v1/snapshots. Everything that can fail on input (size limits, schema, secrets, dangling edges)
 * is decided before the transaction opens, so a rejected manifest leaves no rows at all. The import then
 * runs in one transaction that also moves the workspace baseline pointer under a row lock.
 */
export async function importSnapshot(
  ctx: Ctx,
  principal: Principal,
  input: { body: unknown; idempotencyKey: string | undefined; requestHash: string },
): Promise<IdempotentOutcome<ImportReceipt>> {
  requireRole(principal, "operator");
  const route = { route: "POST /snapshots", key: input.idempotencyKey, requestHash: input.requestHash };
  const replay = await replayOf<ImportReceipt>(ctx, principal, route);
  if (replay) return replay;
  const { revision, manifest } = parseSnapshotBody(input.body);
  const { graph, warnings } = buildGraphOrThrow(ctx, manifest);
  const canonical = canonicalJson(exportManifest(graph));
  const now = ctx.clock.now();

  return idempotent(ctx, principal, route, async (tx) => {
    const workspace = await tx.query<{ baseline_version: number }>("SELECT baseline_version FROM workspaces WHERE id = $1 FOR UPDATE", [principal.workspaceId]);
    const version = (workspace.rows[0]?.baseline_version ?? 0) + 1;
    const id = randomUUID();
    await tx.query(
      `INSERT INTO snapshots (id, workspace_id, schema_version, revision, manifest_hash, document_hash, manifest, node_count, edge_count, warnings, baseline_version, imported_by, imported_at)
       VALUES ($1,$2,1,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12)`,
      [id, principal.workspaceId, revision, graph.hash, graph.manifest_hash, canonical, graph.nodes.length, graph.edges.length, JSON.stringify(warnings), version, principal.userId, now],
    );
    await insertGraphRows(tx, principal.workspaceId, id, graph);
    await tx.query("UPDATE workspaces SET baseline_snapshot_id = $2, baseline_version = $3 WHERE id = $1", [principal.workspaceId, id, version]);
    await appendEvent(tx, {
      workspaceId: principal.workspaceId,
      eventType: "snapshot.imported",
      resourceId: id,
      revision,
      evidenceRef: `/api/v1/snapshots/${id}`,
      occurredAt: now,
    });
    await audit(tx, {
      workspaceId: principal.workspaceId,
      actorType: "user",
      actorId: principal.userId,
      action: "snapshot.imported",
      resourceType: "snapshot",
      resourceId: id,
      at: now,
      metadata: { hash: graph.hash, revision, nodes: graph.nodes.length, edges: graph.edges.length },
    });
    const receipt: ImportReceipt = {
      id,
      revision,
      hash: graph.hash,
      document_hash: graph.manifest_hash,
      schema_version: 1,
      node_count: graph.nodes.length,
      edge_count: graph.edges.length,
      baseline_version: version,
      is_baseline: true,
      imported_at: now.toISOString(),
      warnings,
    };
    return { status: 201, body: receipt };
  });
}

interface SnapshotRow {
  id: string;
  revision: string;
  manifest_hash: string;
  document_hash: string;
  node_count: number;
  edge_count: number;
  baseline_version: number;
  imported_at: Date;
  warnings: unknown;
  baseline_snapshot_id: string | null;
}

const SNAPSHOT_COLUMNS = `s.id, s.revision, s.manifest_hash, s.document_hash, s.node_count, s.edge_count, s.baseline_version, s.imported_at, s.warnings, w.baseline_snapshot_id`;

const summarize = (r: SnapshotRow): SnapshotSummary => ({
  id: r.id,
  // Free text in a view goes through the redactor like node and edge views do (the import validator already
  // refused secrets; this is the second layer). The manifest download stays verbatim on purpose: it is the hashed document.
  revision: redactDeep(r.revision) as string,
  hash: r.manifest_hash,
  document_hash: r.document_hash,
  schema_version: 1,
  node_count: r.node_count,
  edge_count: r.edge_count,
  baseline_version: r.baseline_version,
  is_baseline: r.baseline_snapshot_id === r.id,
  imported_at: r.imported_at.toISOString(),
  warnings: redactDeep(r.warnings),
});

export async function listSnapshots(ctx: Ctx, principal: Principal, opts: { limit: number; cursor?: string | undefined }): Promise<Page<SnapshotSummary>> {
  requireRole(principal, "viewer");
  const after = decodeCursor(opts.cursor, ["iso", "uuid"]);
  const rows = await ctx.db.query<SnapshotRow>(
    `SELECT ${SNAPSHOT_COLUMNS} FROM snapshots s JOIN workspaces w ON w.id = s.workspace_id
      WHERE s.workspace_id = $1 AND ($2::timestamptz IS NULL OR (s.imported_at, s.id) < ($2::timestamptz, $3::uuid))
      ORDER BY s.imported_at DESC, s.id DESC LIMIT $4`,
    [principal.workspaceId, after ? after[0] : null, after ? after[1] : null, opts.limit + 1],
  );
  const page = rows.rows.slice(0, opts.limit);
  const last = page[page.length - 1];
  return {
    items: page.map(summarize),
    next_cursor: rows.rows.length > opts.limit && last ? encodeCursor([last.imported_at.toISOString(), last.id]) : null,
  };
}

export async function getSnapshot(ctx: Ctx, principal: Principal, id: string): Promise<SnapshotSummary> {
  requireRole(principal, "viewer");
  if (!isUuid(id)) throw notFound();
  const rows = await ctx.db.query<SnapshotRow>(
    `SELECT ${SNAPSHOT_COLUMNS} FROM snapshots s JOIN workspaces w ON w.id = s.workspace_id WHERE s.workspace_id = $1 AND s.id = $2`,
    [principal.workspaceId, id],
  );
  const row = rows.rows[0];
  if (!row) throw notFound();
  return summarize(row);
}

/** The workspace baseline: the snapshot new impact runs are assessed against. */
export async function getBaseline(ctx: Ctx, principal: Principal): Promise<{ snapshot: SnapshotSummary | null; baseline_version: number }> {
  requireRole(principal, "viewer");
  const ws = await ctx.db.query<{ baseline_snapshot_id: string | null; baseline_version: number }>(
    "SELECT baseline_snapshot_id, baseline_version FROM workspaces WHERE id = $1",
    [principal.workspaceId],
  );
  const row = ws.rows[0];
  if (!row?.baseline_snapshot_id) return { snapshot: null, baseline_version: row?.baseline_version ?? 0 };
  return { snapshot: await getSnapshot(ctx, principal, row.baseline_snapshot_id), baseline_version: row.baseline_version };
}

/** The stored normalized manifest. Operator and admin only: the viewer role reads redacted reports. */
export async function getSnapshotManifest(ctx: Ctx, principal: Principal, id: string): Promise<unknown> {
  return (await getSnapshotManifestChecked(ctx, principal, id)).manifest;
}

/**
 * The stored manifest as it may be served. A manifest that the CURRENT validator no longer accepts (an earlier build stored it
 * before a secret shape was recognised) is never served verbatim: it goes through the redactor at log strength, and `redactedFrom`
 * names the hash of the stored document so a reader knows what was served is not it. The stored row is never rewritten.
 */
export async function getSnapshotManifestChecked(ctx: Ctx, principal: Principal, id: string): Promise<{ manifest: unknown; redactedFrom: string | null }> {
  requireRole(principal, "operator");
  if (!isUuid(id)) throw notFound();
  const rows = await ctx.db.query<{ manifest: string; document_hash: string }>("SELECT manifest, document_hash FROM snapshots WHERE workspace_id = $1 AND id = $2", [principal.workspaceId, id]);
  const row = rows.rows[0];
  if (!row) throw notFound();
  const stored = JSON.parse(row.manifest) as unknown;
  if (buildGraph(stored).ok) return { manifest: stored, redactedFrom: null };
  return { manifest: redactDeep(stored), redactedFrom: row.document_hash };
}

/**
 * Rebuild an immutable graph from its stored canonical text and require the recorded hashes to match. A mismatch
 * is corruption (IntegrityError), never a stale request. Used for snapshots and proposed manifests.
 */
export function rebuildVerified(manifestText: string, graphHash: string, documentHash: string | null, label: string): DependencyGraph {
  const built = buildGraphFromJson(manifestText, {
    limits: { max_nodes: DEFAULT_LIMITS.max_nodes, max_edges: DEFAULT_LIMITS.max_edges, max_manifest_bytes: DEFAULT_LIMITS.max_manifest_bytes },
  });
  if (!built.ok) throw new IntegrityError(`stored ${label} manifest no longer validates (${built.failure.code})`);
  if (built.graph.hash !== graphHash || (documentHash !== null && built.graph.manifest_hash !== documentHash)) {
    throw new IntegrityError(`stored ${label} manifest does not match its recorded hash`);
  }
  return built.graph;
}

export interface NodeView {
  id: string;
  kind: string;
  owner: string | null;
  version: string;
  placeholder: boolean;
  contract: unknown;
}

export async function listNodes(ctx: Ctx, principal: Principal, snapshotId: string, opts: { limit: number; cursor?: string | undefined }): Promise<Page<NodeView>> {
  requireRole(principal, "viewer");
  await getSnapshot(ctx, principal, snapshotId);
  const after = decodeCursor(opts.cursor, ["string"]);
  const rows = await ctx.db.query<NodeView>(
    `SELECT id, kind, owner, version, placeholder, contract FROM nodes
      WHERE workspace_id = $1 AND snapshot_id = $2 AND ($3::text IS NULL OR id COLLATE "C" > $3::text COLLATE "C")
      ORDER BY id COLLATE "C" LIMIT $4`,
    [principal.workspaceId, snapshotId, after ? after[0] : null, opts.limit + 1],
  );
  const stored = rows.rows.slice(0, opts.limit);
  const last = stored[stored.length - 1];
  // Stored rows are validated secret-free at import, but nothing that leaves the process is trusted to stay that way.
  const items = stored.map((row) => redactDeep(row) as NodeView);
  return { items, next_cursor: rows.rows.length > opts.limit && last ? encodeCursor([last.id]) : null };
}

export interface EdgeView {
  source_id: string;
  target_id: string;
  relation: string;
  source_file: string;
  source_line: number;
  verified_at: string | null;
  fields: unknown;
}

export async function listEdges(ctx: Ctx, principal: Principal, snapshotId: string, opts: { limit: number; cursor?: string | undefined }): Promise<Page<EdgeView>> {
  requireRole(principal, "viewer");
  await getSnapshot(ctx, principal, snapshotId);
  const after = decodeCursor(opts.cursor, ["string", "string", "string"]);
  const rows = await ctx.db.query<Omit<EdgeView, "verified_at"> & { verified_at: Date | null }>(
    `SELECT source_id, target_id, relation, source_file, source_line, verified_at, fields FROM edges
      WHERE workspace_id = $1 AND snapshot_id = $2
        AND ($3::text IS NULL OR (source_id COLLATE "C", target_id COLLATE "C", relation COLLATE "C") > ($3::text COLLATE "C", $4::text COLLATE "C", $5::text COLLATE "C"))
      ORDER BY source_id COLLATE "C", target_id COLLATE "C", relation COLLATE "C" LIMIT $6`,
    [principal.workspaceId, snapshotId, after ? after[0] : null, after ? after[1] : null, after ? after[2] : null, opts.limit + 1],
  );
  const items = rows.rows.slice(0, opts.limit).map((r) => redactDeep({ ...r, verified_at: r.verified_at ? r.verified_at.toISOString() : null }) as EdgeView);
  const last = items[items.length - 1];
  return {
    items,
    next_cursor: rows.rows.length > opts.limit && last ? encodeCursor([last.source_id, last.target_id, last.relation]) : null,
  };
}
