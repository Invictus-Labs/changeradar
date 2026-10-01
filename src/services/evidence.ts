import { z } from "zod";
import type { Queryable } from "../db/index.js";
import { canonicalJson, hashCanonical, isHashString } from "../domain/canonical.js";
import { fixedClock } from "../domain/clock.js";
import type { ContractCheckResult } from "../domain/contract-checks.js";
import { recordedBounds } from "../domain/limits.js";
import { JsonRejectedError, parseStrictJson } from "../domain/strict-json.js";
import { redactDeep, redactIdentifier, redactIdentifiers } from "../domain/redaction.js";
import type { Ctx } from "../platform/context.js";
import { notFound } from "../platform/errors.js";
import { isUuid } from "../platform/ids.js";
import { APP_VERSION } from "../platform/version.js";
import { boundLeaves, capLeaves, capText, exceedsBound, maskedEqualDeep } from "../domain/derived-text.js";
import { boundsProblem } from "./bundle-bounds.js";
import { assess, ENGINE_VERSION, isStaleEngineRun, type Finding } from "./assess.js";
import { type Principal, requireRole } from "./auth.js";
import { diffGraphs } from "./diff.js";
import { buildGraph } from "./graph.js";

export const BUNDLE_FORMAT = "changeradar-evidence-bundle";
export const BUNDLE_SCHEMA_VERSION = 1;

const Hash = z.string().refine(isHashString, "must be sha256:<64 hex>");
const Iso = z.string().max(40);
const Obj = z.record(z.string(), z.unknown());

const CheckResultRow = z.strictObject({
  check_key: z.string(),
  node_id: z.string(),
  state: z.enum(["STARTED", "PASSED", "FAILED", "TIMED_OUT", "ERROR", "UNKNOWN"]),
  definition: z.unknown(),
  result: z.unknown().nullable(),
  started_at: Iso,
  finished_at: Iso.nullable(),
});

const FindingRow = z.strictObject({
  finding_key: z.string(),
  position: z.number().int().min(0),
  origin_id: z.string(),
  consumer_id: z.string(),
  consumer_kind: z.string(),
  consumer_owner: z.string().nullable(),
  severity: z.enum(["high", "medium"]),
  direct: z.boolean(),
  depth: z.number().int().min(1),
  path: z.array(z.string()),
  hops: z.array(z.unknown()),
  /** Hops and change ids left out of a bounded finding; absent in bundles written before findings were bounded. */
  path_omitted_hops: z.number().int().min(0).optional(),
  change_ids: z.array(z.string()),
  change_ids_omitted: z.number().int().min(0).optional(),
  reason: z.string(),
});

const RunRow = z.strictObject({
  id: z.string(),
  snapshot_id: z.string(),
  status: z.enum(["QUEUED", "RUNNING", "COMPLETE", "FAILED"]),
  verdict: z.enum(["AFFECTED", "NO_KNOWN_IMPACT", "INCOMPLETE"]).nullable(),
  proposed_hash: Hash,
  expected_hash: z.string(),
  baseline_hash: Hash,
  baseline_version: z.number().int().min(0),
  proposed_manifest: Obj,
  run_checks: z.boolean(),
  check_keys: z.array(z.string()),
  allow_superseded: z.boolean(),
  assessment_detail: Obj.nullable(),
  unknowns: z.array(z.unknown()),
  findings: z.array(FindingRow),
  checks: z.array(CheckResultRow),
  events: z.array(z.strictObject({ from_status: z.string().nullable(), to_status: z.string(), note: z.string().nullable(), at: Iso })),
  error_code: z.string().nullable(),
  error_detail: z.string().nullable(),
  created_at: Iso,
  started_at: Iso.nullable(),
  finished_at: Iso.nullable(),
});

const SnapshotRow = z.strictObject({
  id: z.string(),
  revision: z.string(),
  imported_at: Iso,
  baseline_version: z.number().int().min(0),
  graph_hash: Hash,
  document_hash: Hash,
  node_count: z.number().int().min(0),
  edge_count: z.number().int().min(0),
  warnings: z.array(z.unknown()),
  manifest: Obj,
});

const CheckDefRow = z.strictObject({
  key: z.string(),
  node_id: z.string(),
  url: z.string(),
  method: z.enum(["GET", "HEAD"]),
  timeout_ms: z.number().int(),
  retries: z.number().int(),
  expect_status: z.number().int(),
  required_fields: z.array(z.unknown()),
  credential_alias: z.string().nullable(),
  enabled: z.boolean(),
  created_at: Iso,
  disabled_at: Iso.nullable(),
});

export const BundleSchema = z.strictObject({
  format: z.literal(BUNDLE_FORMAT),
  schema_version: z.number().int(),
  scope: z.enum(["workspace", "run"]),
  created_at: Iso,
  producer: z.strictObject({ name: z.string(), version: z.string() }),
  workspace: z.strictObject({ id: z.string(), name: z.string(), created_at: Iso }),
  baseline: z.strictObject({ snapshot_id: z.string().nullable(), version: z.number().int().min(0) }),
  snapshots: z.array(SnapshotRow),
  impact_runs: z.array(RunRow),
  contract_checks: z.array(CheckDefRow),
  hashes: z.strictObject({ snapshots: Hash, impact_runs: Hash, contract_checks: Hash }),
  bundle_hash: Hash,
  /**
   * Ids of the finished runs assessed by an older decision engine. NOT part of any hash: a hint written next to the evidence,
   * because the recorded `verdict` of such a run is history (it may be a wrong NO_KNOWN_IMPACT) yet stays hashed evidence. A
   * script that gates on `verdict` must first look here. Absent in bundles written by earlier builds; when present it must name
   * exactly the runs verification finds stale.
   */
  stale_runs: z.array(z.string()).optional(),
});

export type EvidenceBundle = z.infer<typeof BundleSchema>;

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

function sealBundle(body: Omit<EvidenceBundle, "hashes" | "bundle_hash">): EvidenceBundle {
  const hashes = {
    snapshots: hashCanonical(body.snapshots),
    impact_runs: hashCanonical(body.impact_runs),
    contract_checks: hashCanonical(body.contract_checks),
  };
  const withHashes = { ...body, hashes };
  return { ...withHashes, bundle_hash: hashCanonical(withHashes) };
}

/**
 * Collect the evidence of one workspace (or one run with its baseline snapshot) into a versioned, hashed
 * bundle. No credential values, sessions, password hashes or idempotency keys are ever included, and every
 * value passes through the redactor. Runs that were not finished are exported as they are; restore records
 * them as FAILED (interrupted) so nothing looks finished that was not.
 */
export async function buildBundle(
  db: Queryable,
  scope: { workspaceId: string; runId?: string },
  now: Date,
  opts: { maxBytes?: number } = {},
): Promise<EvidenceBundle | null> {
  const ws = await db.query<{ id: string; name: string; created_at: Date; baseline_snapshot_id: string | null; baseline_version: number }>(
    "SELECT id, name, created_at, baseline_snapshot_id, baseline_version FROM workspaces WHERE id = $1",
    [scope.workspaceId],
  );
  const workspace = ws.rows[0];
  if (!workspace) return null;

  const runFilter = scope.runId ? "AND id = $2" : "";
  const runParams = scope.runId ? [scope.workspaceId, scope.runId] : [scope.workspaceId];
  const runs = await db.query<{
    id: string; snapshot_id: string; status: "QUEUED" | "RUNNING" | "COMPLETE" | "FAILED"; verdict: EvidenceBundle["impact_runs"][number]["verdict"];
    proposed_hash: string; expected_hash: string; baseline_hash: string; baseline_version: number; proposed_manifest: string; run_checks: boolean;
    check_keys: string[]; allow_superseded: boolean; assessment: Record<string, unknown> | null; unknowns: unknown[]; error_code: string | null; error_detail: string | null;
    created_at: Date; started_at: Date | null; finished_at: Date | null;
  }>(
    `SELECT id, snapshot_id, status, verdict, proposed_hash, expected_hash, baseline_hash, baseline_version, proposed_manifest, run_checks, check_keys, allow_superseded,
            assessment, unknowns, error_code, error_detail, created_at, started_at, finished_at
       FROM impact_runs WHERE workspace_id = $1 ${runFilter} ORDER BY created_at, id`,
    runParams,
  );
  if (scope.runId && runs.rows.length === 0) return null;

  const snapshotIds = [...new Set(runs.rows.map((r) => r.snapshot_id))];
  const snaps = await db.query<{
    id: string; revision: string; imported_at: Date; baseline_version: number; manifest_hash: string; document_hash: string;
    node_count: number; edge_count: number; warnings: unknown[]; manifest: string;
  }>(
    scope.runId
      ? `SELECT id, revision, imported_at, baseline_version, manifest_hash, document_hash, node_count, edge_count, warnings, manifest
           FROM snapshots WHERE workspace_id = $1 AND id = ANY($2::uuid[]) ORDER BY imported_at, id`
      : `SELECT id, revision, imported_at, baseline_version, manifest_hash, document_hash, node_count, edge_count, warnings, manifest
           FROM snapshots WHERE workspace_id = $1 ORDER BY imported_at, id`,
    scope.runId ? [scope.workspaceId, snapshotIds] : [scope.workspaceId],
  );

  const bundleRuns: EvidenceBundle["impact_runs"] = [];
  for (const run of runs.rows) {
    const findings = await db.query<EvidenceBundle["impact_runs"][number]["findings"][number]>(
      `SELECT finding_key, position, origin_id, consumer_id, consumer_kind, consumer_owner, severity, direct, depth, path, hops, path_omitted_hops, change_ids, change_ids_omitted, reason
         FROM findings WHERE workspace_id = $1 AND run_id = $2 ORDER BY position`,
      [scope.workspaceId, run.id],
    );
    const checks = await db.query<{ check_key: string; node_id: string; state: EvidenceBundle["impact_runs"][number]["checks"][number]["state"]; definition: unknown; result: unknown; started_at: Date; finished_at: Date | null }>(
      "SELECT check_key, node_id, state, definition, result, started_at, finished_at FROM check_results WHERE workspace_id = $1 AND run_id = $2 ORDER BY check_key COLLATE \"C\"",
      [scope.workspaceId, run.id],
    );
    const events = await db.query<{ from_status: string | null; to_status: string; note: string | null; at: Date }>(
      "SELECT from_status, to_status, note, at FROM run_events WHERE workspace_id = $1 AND run_id = $2 ORDER BY id",
      [scope.workspaceId, run.id],
    );
    bundleRuns.push({
      id: run.id,
      snapshot_id: run.snapshot_id,
      status: run.status,
      verdict: run.verdict,
      proposed_hash: run.proposed_hash,
      expected_hash: run.expected_hash,
      baseline_hash: run.baseline_hash,
      baseline_version: run.baseline_version,
      proposed_manifest: JSON.parse(run.proposed_manifest) as Record<string, unknown>,
      run_checks: run.run_checks,
      check_keys: run.check_keys,
      allow_superseded: run.allow_superseded,
      assessment_detail: run.assessment,
      unknowns: run.unknowns,
      findings: findings.rows,
      checks: checks.rows.map((c) => ({ ...c, started_at: c.started_at.toISOString(), finished_at: iso(c.finished_at) })),
      events: events.rows.map((e) => ({ ...e, at: e.at.toISOString() })),
      error_code: run.error_code,
      error_detail: run.error_detail,
      created_at: run.created_at.toISOString(),
      started_at: iso(run.started_at),
      finished_at: iso(run.finished_at),
    });
  }

  // A run bundle carries the definitions its runs recorded AND the ones they asked for by key that have since been
  // disabled or never ran, so a reader sees what a CHECK_NOT_RUN unknown refers to.
  const referenced = new Set(bundleRuns.flatMap((r) => [...r.checks.map((c) => c.check_key), ...r.check_keys]));
  const defs = await db.query<{
    check_key: string; node_id: string; url: string; method: "GET" | "HEAD"; timeout_ms: number; retries: number; expect_status: number;
    required_fields: unknown[]; credential_alias: string | null; enabled: boolean; created_at: Date; disabled_at: Date | null;
  }>(
    "SELECT check_key, node_id, url, method, timeout_ms, retries, expect_status, required_fields, credential_alias, enabled, created_at, disabled_at FROM contract_checks WHERE workspace_id = $1 ORDER BY check_key COLLATE \"C\"",
    [scope.workspaceId],
  );

  const body = {
    format: BUNDLE_FORMAT as typeof BUNDLE_FORMAT,
    schema_version: BUNDLE_SCHEMA_VERSION,
    scope: scope.runId ? ("run" as const) : ("workspace" as const),
    created_at: now.toISOString(),
    producer: { name: "changeradar", version: APP_VERSION },
    workspace: { id: workspace.id, name: workspace.name, created_at: workspace.created_at.toISOString() },
    baseline: scope.runId
      ? { snapshot_id: null, version: 0 }
      : { snapshot_id: workspace.baseline_snapshot_id, version: workspace.baseline_version },
    snapshots: snaps.rows.map((s) => ({
      id: s.id,
      revision: s.revision,
      imported_at: s.imported_at.toISOString(),
      baseline_version: s.baseline_version,
      graph_hash: s.manifest_hash,
      document_hash: s.document_hash,
      node_count: s.node_count,
      edge_count: s.edge_count,
      warnings: s.warnings,
      manifest: JSON.parse(s.manifest) as Record<string, unknown>,
    })),
    impact_runs: bundleRuns,
    contract_checks: defs.rows
      .filter((d) => !scope.runId || referenced.has(d.check_key))
      .map((d) => ({
        key: d.check_key, node_id: d.node_id, url: d.url, method: d.method, timeout_ms: d.timeout_ms, retries: d.retries, expect_status: d.expect_status,
        required_fields: d.required_fields, credential_alias: d.credential_alias, enabled: d.enabled, created_at: d.created_at.toISOString(), disabled_at: iso(d.disabled_at),
      })),
  };
  // Manifest and hash fields must survive verbatim; redaction only touches free text such as reasons and details.
  const hashed = sealBundle(redactBundleText(body));
  const sealed: EvidenceBundle = { ...hashed, stale_runs: staleEngineRuns(hashed) };
  const serialized = serializeBundle(sealed);
  // A bundle larger than the limit this installation restores is refused at export, before the expensive verification.
  // The limit is in BYTES, as verify-bundle and restore measure the file; string length counts UTF-16 units.
  const byteLength = Buffer.byteLength(serialized, "utf8");
  if (opts.maxBytes !== undefined && byteLength > opts.maxBytes) {
    throw new BundleError("BUNDLE_TOO_LARGE", `the bundle is ${byteLength} bytes; the limit is ${opts.maxBytes} (narrow the export to one run, or raise CHANGERADAR_MAX_BUNDLE_BYTES if the host can restore it)`);
  }
  // An export the same build could not verify and restore is never reported as success: verify the exact bytes
  // that would be written, and let the BundleError propagate (fail closed).
  verifyBundle(serialized, { maxBytes: Number.MAX_SAFE_INTEGER });
  return sealed;
}

/**
 * Redact every text that is not a hashed document. Manifests were validated secret-free at import and are re-verified
 * against their hashes on restore, so they stay verbatim; findings are the re-derived, compared records and also stay
 * verbatim. Identifiers, names and URLs (workspace, revisions, check definitions, ids in run records) keep the strength
 * the validator applied when they were stored, so an accepted value is never rewritten; explanations, notes and
 * details are redacted at log strength. Verification compares derived and stored unknowns and detail through the same
 * redactor, so redacting them here does not disturb it.
 */
function redactBundleText(body: Omit<EvidenceBundle, "hashes" | "bundle_hash">): Omit<EvidenceBundle, "hashes" | "bundle_hash"> {
  return {
    ...body,
    workspace: { ...body.workspace, name: redactIdentifier(body.workspace.name) },
    // Free text is cut to the text cap AFTER it is redacted (redaction can lengthen a text, and a restore cuts every stored text to the
    // cap: a text longer than the cap in the bundle would not survive a restore and would then fail verification).
    snapshots: body.snapshots.map((s) => ({ ...s, revision: redactIdentifier(s.revision), warnings: capLeaves(redactDeep(s.warnings)) as unknown[] })),
    impact_runs: body.impact_runs.map((r) => ({
      ...r,
      error_code: r.error_code === null ? null : redactIdentifier(r.error_code),
      error_detail: r.error_detail === null ? null : (capText(redactDeep(r.error_detail) as string) as string),
      check_keys: r.check_keys.map((key) => redactIdentifier(key)),
      unknowns: capLeaves(redactDeep(r.unknowns)) as unknown[],
      assessment_detail: r.assessment_detail === null ? null : (capLeaves(redactDeep(r.assessment_detail)) as Record<string, unknown>),
      events: r.events.map((ev) => ({ ...ev, note: ev.note === null ? null : (capText(redactDeep(ev.note) as string) as string) })),
      checks: r.checks.map((c) => ({
        ...c,
        check_key: redactIdentifier(c.check_key),
        node_id: redactIdentifier(c.node_id),
        definition: capLeaves(redactDeep(c.definition)),
        result: c.result === null ? null : capLeaves(redactDeep(c.result)),
      })),
    })),
    contract_checks: body.contract_checks.map((c) => redactIdentifiers(c) as typeof c),
  };
}

/** The ids of the finished runs of `bundle` that were assessed by an older decision engine (their re-derivation is skipped). */
export function staleEngineRuns(bundle: EvidenceBundle): string[] {
  return bundle.impact_runs.filter((r) => isStaleEngineRun(r.status === "COMPLETE", (r.assessment_detail as Record<string, unknown> | null)?.engine_version)).map((r) => r.id);
}

/** API wrapper: operator and admin export the evidence bundle of one run in their workspace. */
export async function exportRunBundle(ctx: Ctx, principal: Principal, runId: string): Promise<EvidenceBundle> {
  requireRole(principal, "operator");
  if (!isUuid(runId)) throw notFound();
  const bundle = await buildBundle(ctx.db, { workspaceId: principal.workspaceId, runId }, ctx.clock.now(), { maxBytes: ctx.settings.maxBundleBytes });
  if (!bundle) throw notFound();
  return bundle;
}

export type BundleRejection =
  | "BUNDLE_TOO_LARGE"
  | "BUNDLE_MALFORMED"
  | "BUNDLE_DUPLICATE_KEY"
  | "BUNDLE_UNSUPPORTED_VERSION"
  | "BUNDLE_ENGINE_VERSION"
  | "BUNDLE_SCHEMA_INVALID"
  | "BUNDLE_HASH_MISMATCH"
  | "BUNDLE_SNAPSHOT_MISMATCH"
  | "BUNDLE_RUN_INCONSISTENT";

export class BundleError extends Error {
  constructor(
    readonly code: BundleRejection,
    message: string,
  ) {
    super(message);
    this.name = "BundleError";
  }
}

const fail = (code: BundleRejection, message: string): never => {
  throw new BundleError(code, message);
};

/**
 * Verify a bundle completely, in memory, before any database work: size, JSON, version, strict shape, the
 * bundle hash and section hashes, every snapshot rebuilt and re-hashed, and every finished run re-derived
 * with the pure assessor (frozen at its recorded evaluation time) so its finding ids must reproduce. Anything
 * truncated, edited or from an unsupported version is refused; nothing is accepted partially.
 */
export function verifyBundle(input: string | Uint8Array, opts: { maxBytes: number }): EvidenceBundle {
  const bytes = typeof input === "string" ? Buffer.byteLength(input, "utf8") : input.byteLength;
  if (bytes > opts.maxBytes) fail("BUNDLE_TOO_LARGE", `bundle is ${bytes} bytes; the limit is ${opts.maxBytes}`);
  let parsed: unknown;
  try {
    const text = typeof input === "string" ? input : new TextDecoder("utf-8", { fatal: true }).decode(input);
    parsed = parseStrictJson(text);
  } catch (error) {
    // A repeated key would let last-wins parsing hide one value from a reviewer: refuse it under its own code.
    if (error instanceof JsonRejectedError && error.code === "DUPLICATE_JSON_KEY") return fail("BUNDLE_DUPLICATE_KEY", "bundle contains the same object key more than once");
    if (error instanceof JsonRejectedError && error.code === "JSON_TOO_COMPLEX") return fail("BUNDLE_MALFORMED", "bundle is nested or structured beyond any valid bundle");
    return fail("BUNDLE_MALFORMED", "bundle is not valid UTF-8 JSON (it may be truncated)");
  }
  if (typeof parsed === "object" && parsed !== null && (parsed as { format?: unknown }).format === BUNDLE_FORMAT) {
    const version = (parsed as { schema_version?: unknown }).schema_version;
    // An untrusted value is shown as a bounded, escaped, one-line JSON rendering: never raw, never with a newline.
    if (version !== BUNDLE_SCHEMA_VERSION) {
      const shown = JSON.stringify(typeof version === "string" ? version.slice(0, 40) : (JSON.stringify(version) ?? "undefined").slice(0, 40));
      fail("BUNDLE_UNSUPPORTED_VERSION", `bundle schema_version ${shown} is not supported (this build reads ${BUNDLE_SCHEMA_VERSION})`);
    }
  }
  const shaped = BundleSchema.safeParse(parsed);
  if (!shaped.success) return fail("BUNDLE_SCHEMA_INVALID", "bundle does not match the evidence bundle schema");
  const bundle = shaped.data;

  // `stale_runs` is a hint next to the evidence, outside every hash (see the schema); it is checked against the runs instead.
  const { bundle_hash: claimed, stale_runs: staleMarker, ...rest } = bundle;
  if (hashCanonical(rest) !== claimed) fail("BUNDLE_HASH_MISMATCH", "bundle hash does not match its content");
  if (staleMarker !== undefined && canonicalText(staleMarker) !== canonicalText(staleEngineRuns(bundle))) {
    fail("BUNDLE_SCHEMA_INVALID", "the stale_runs marker does not name the finished runs of an older decision engine");
  }
  if (
    hashCanonical(bundle.snapshots) !== bundle.hashes.snapshots ||
    hashCanonical(bundle.impact_runs) !== bundle.hashes.impact_runs ||
    hashCanonical(bundle.contract_checks) !== bundle.hashes.contract_checks
  ) {
    fail("BUNDLE_HASH_MISMATCH", "a bundle section does not match its recorded hash");
  }
  if (!isUuid(bundle.workspace.id)) fail("BUNDLE_SCHEMA_INVALID", "workspace id is not a UUID");
  // A value the database would refuse is a bundle rejection here, not a failed restore later.
  const outOfRange = boundsProblem(bundle);
  if (outOfRange !== null) fail("BUNDLE_SCHEMA_INVALID", outOfRange);

  const graphs = new Map<string, ReturnType<typeof requireGraph>>();
  for (const s of bundle.snapshots) {
    if (!isUuid(s.id) || graphs.has(s.id)) fail("BUNDLE_SNAPSHOT_MISMATCH", "snapshot ids must be unique UUIDs");
    const graph = requireGraph(s.manifest, "snapshot", s.id);
    if (graph.hash !== s.graph_hash || graph.manifest_hash !== s.document_hash || graph.nodes.length !== s.node_count || graph.edges.length !== s.edge_count) {
      fail("BUNDLE_SNAPSHOT_MISMATCH", `snapshot ${s.id} does not match its recorded hashes`);
    }
    graphs.set(s.id, graph);
  }
  if (bundle.baseline.snapshot_id !== null && !graphs.has(bundle.baseline.snapshot_id)) {
    fail("BUNDLE_SNAPSHOT_MISMATCH", "the baseline pointer references a snapshot that is not in the bundle");
  }

  const runIds = new Set<string>();
  for (const run of bundle.impact_runs) {
    if (!isUuid(run.id) || runIds.has(run.id)) fail("BUNDLE_RUN_INCONSISTENT", "run ids must be unique UUIDs");
    runIds.add(run.id);
    const baseline = graphs.get(run.snapshot_id);
    if (!baseline) return fail("BUNDLE_RUN_INCONSISTENT", `run ${run.id} references a snapshot that is not in the bundle`);
    if (baseline.hash !== run.baseline_hash) fail("BUNDLE_RUN_INCONSISTENT", `run ${run.id} baseline hash does not match its snapshot`);
    const proposed = requireGraph(run.proposed_manifest, "proposed manifest of run", run.id);
    if (proposed.hash !== run.proposed_hash) fail("BUNDLE_RUN_INCONSISTENT", `run ${run.id} proposed hash does not match its manifest`);
    if ((run.status === "COMPLETE") !== (run.verdict !== null)) fail("BUNDLE_RUN_INCONSISTENT", `run ${run.id} verdict does not match its status`);
    if (run.status !== "COMPLETE") {
      if (run.findings.length > 0) fail("BUNDLE_RUN_INCONSISTENT", `run ${run.id} is not complete but carries findings`);
      continue;
    }
    const detail = run.assessment_detail;
    const evaluatedAt = detail && typeof detail.evaluated_at === "string" ? detail.evaluated_at : null;
    if (!detail || evaluatedAt === null || Number.isNaN(Date.parse(evaluatedAt))) fail("BUNDLE_RUN_INCONSISTENT", `run ${run.id} has no assessment`);
    // Rows of one run are numbered 0, 1, 2, ... in order; the number is part of what a reader sees.
    if (run.findings.some((row, index) => row.position !== index)) fail("BUNDLE_RUN_INCONSISTENT", `run ${run.id} finding positions are not 0, 1, 2, ...`);
    // Re-derivation is only meaningful against the rules that produced the run. A run from a NEWER engine cannot be
    // re-derived by this build and is refused under its own code. A run from an OLDER engine (a missing stamp is
    // version 1) is accepted on the strength of the hashes alone: its verdict may differ today, which is exactly what
    // the "re-run required" marking says (staleEngineRuns), so an upgrade never makes a workspace impossible to export.
    const stamp: unknown = (detail as Record<string, unknown>).engine_version ?? 1;
    const recordedEngine = typeof stamp === "number" && Number.isInteger(stamp) ? stamp : Number.NaN;
    if (Number.isNaN(recordedEngine) || recordedEngine > ENGINE_VERSION) {
      fail("BUNDLE_ENGINE_VERSION", `run ${run.id} was produced by decision engine version ${(JSON.stringify(stamp) ?? "?").slice(0, 20)}; this build re-derives version ${ENGINE_VERSION} and older`);
    }
    if (recordedEngine < ENGINE_VERSION) {
      // The stamp is written by whoever wrote the bundle, so it must not switch every check off: what does not depend on the
      // engine's rules is still verified (the recorded rows against the recorded verdict and summary).
      const problem = staleRunProblem(run);
      if (problem !== null) fail("BUNDLE_RUN_INCONSISTENT", `run ${run.id} ${problem}`);
      continue;
    }
    const results = run.checks.filter((c) => c.result !== null).map((c) => c.result as ContractCheckResult);
    // The same derivation the worker used: requested check keys with no recorded row were never run.
    const recorded = new Set(run.checks.filter((c) => c.result !== null).map((c) => c.check_key));
    const rederived = assess({
      baseline,
      proposed,
      expected_hash: run.baseline_hash,
      clock: fixedClock(evaluatedAt as string),
      check_results: results,
      config: recordedBounds(((detail as Record<string, unknown>).coverage as { bounds?: unknown } | undefined)?.bounds),
      missing_check_keys: run.run_checks ? run.check_keys.filter((k) => !recorded.has(k)) : [],
      live_checks: liveChecksOf(run.run_checks, results.length),
      // Derived without the 2,000-character cut: the record of an earlier build was cut after redaction, at another character.
      uncapped_text: true,
    });
    if (!rederived.ok) return fail("BUNDLE_RUN_INCONSISTENT", `run ${run.id} cannot be re-derived`);
    const a = rederived.assessment;
    // Every stored field is compared, not just ids: a reviewer reads reasons, paths, severities and unknown text,
    // so an edit to any of them (with the hash recomputed) must not verify.
    const sameFindings = a.findings.length === run.findings.length && a.findings.every((f: Finding, i: number) => sameFinding(f, run.findings[i]));
    const { findings: _f, unknowns: _u, ...rederivedDetail } = a;
    // The recorded check results were redacted at export, so free text derived from them can differ from the stored
    // text exactly where the redactor rewrote it. Both sides go through the same redactor before they are compared.
    // The derivation above is UNCUT and both sides are bounded (COMPARE_BOUND, derived-text.ts) before they are redacted. A run
    // written by an earlier build holds a derived message that was derived uncut, redacted, and cut only by an export or a restore
    // (round 4 and before), or cut to 2,000 characters BEFORE redaction (round 5), or cut after redaction (now). Redaction can
    // lengthen a text, so these are different strings: the recorded side matches when it reproduces under any one reading applied
    // to both sides (see sameReading): uncut, redact then cut, or cut then redact.
    const sameText = sameReading;
    const sameUnknowns = sameText(a.unknowns, run.unknowns);
    const sameDetail = sameText(rederivedDetail, detail);
    if (a.assessment !== run.verdict || !sameFindings || !sameUnknowns || !sameDetail) {
      fail("BUNDLE_RUN_INCONSISTENT", `run ${run.id} findings, unknowns or verdict do not reproduce from its recorded inputs`);
    }
  }
  const keys = new Set<string>();
  for (const c of bundle.contract_checks) {
    if (keys.has(c.key)) fail("BUNDLE_SCHEMA_INVALID", "contract check keys must be unique");
    keys.add(c.key);
  }
  return bundle;
}

/**
 * What a run from an OLDER engine (not re-derivable here) must still satisfy, whatever the rules were: a NO_KNOWN_IMPACT run
 * has no finding and no unknown, an AFFECTED run has findings, and the summary counts the finding rows (except that a run
 * cut by the finding bounds records the FINDINGS_TRUNCATED unknown and may hold fewer rows than it counts).
 */
function staleRunProblem(run: EvidenceBundle["impact_runs"][number]): string | null {
  const unknowns = run.unknowns as { code?: unknown }[];
  const truncated = unknowns.some((u) => u !== null && typeof u === "object" && u.code === "FINDINGS_TRUNCATED");
  if (run.verdict === "NO_KNOWN_IMPACT" && (run.findings.length > 0 || unknowns.length > 0)) return "is recorded as NO_KNOWN_IMPACT but lists findings or unknowns";
  if (run.verdict === "AFFECTED" && run.findings.length === 0) return "is recorded as AFFECTED but lists no finding";
  const summary = (run.assessment_detail as { summary?: { findings?: unknown } } | null)?.summary;
  if (summary && typeof summary.findings === "number" && !truncated && summary.findings !== run.findings.length) return "counts a different number of findings than it lists";
  return null;
}

/** Canonical text of a value as JSON would store it (undefined members dropped), so stored and derived forms compare exactly. */
const canonicalText = (value: unknown): string => canonicalJson(JSON.parse(JSON.stringify(value)));

/**
 * A derived value and a recorded one hold the same text under one of three readings, applied to BOTH after each is bounded to
 * COMPARE_BOUND (so no text of any length is redacted at a cost that grows with it): redacted as they are (round 4 and before);
 * redacted and then cut to the derivation cap (a restore of those); cut and then redacted (round 5, before export redacted); or
 * cut, redacted and cut again (what a build since round 6 stores after its own cut, exported and cut again).
 */
function sameReading(derived: unknown, recorded: unknown, free = false): boolean {
  // A recorded text longer than the bound is refused, not compared on its prefix: no engine derives one, and redacting it would cost
  // more than reading it (the bundle is hostile input at this point).
  if (exceedsBound(recorded)) return false;
  const d = boundLeaves(derived);
  const r = boundLeaves(recorded);
  // The derived side is UNCUT. The recorded side was stored by an earlier build uncut (and then cut by a restore, after redaction)
  // or by a build since round 5 (cut before redaction, then again after). Two readings cover every form: redact then cut, and cut,
  // redact and cut (a cut never splits a marker, so `api_key:abcde` and `api_key:` meet at `api_key:`).
  const readings: ((value: unknown) => unknown)[] = [(value) => capLeaves(redactDeep(value)), (value) => capLeaves(redactDeep(capLeaves(value)))];
  if (readings.some((read) => canonicalText(read(d)) === canonicalText(read(r)))) return true;
  // A THIRD reading, tried only when those fail: a run written by the builds before round 7 holds text in which those redactors hid fewer pieces than this one does
  // (two ids of the form `auth:issuer` in one message: the first was hidden, the second was left), and redacting either side again does not meet the other. The recorded
  // text then matches the derived text by MASKED EQUALITY (derived-text.ts): its visible fragments stand in the derivation, literally and in order, and each marker hides a non-empty span
  // behind a credential-shaped word. Only the free text members are read this way (`free` says that the value itself is one: a finding's reason); a code, an id, an edge, a hash and the
  // assessment must match exactly, and a record that a restore cut at the cap is read as a masked prefix.
  return maskedEqualDeep(d, r, free) || maskedEqualDeep(capLeaves(d), r, free);
}

/** Field-for-field equality of a re-derived finding and its stored row (absent omission counters are stored as 0). */
function sameFinding(f: Finding, row: EvidenceBundle["impact_runs"][number]["findings"][number] | undefined): boolean {
  if (row === undefined) return false;
  return (
    canonicalText({
      finding_key: f.id, origin_id: f.origin_id, consumer_id: f.consumer_id, consumer_kind: f.consumer_kind, consumer_owner: f.consumer_owner,
      severity: f.severity, direct: f.direct, depth: f.depth, path: f.path, hops: f.hops, path_omitted_hops: f.path_omitted_hops ?? 0,
      change_ids: f.change_ids, change_ids_omitted: f.change_ids_omitted ?? 0,
    }) ===
    canonicalText({
      finding_key: row.finding_key, origin_id: row.origin_id, consumer_id: row.consumer_id, consumer_kind: row.consumer_kind, consumer_owner: row.consumer_owner,
      severity: row.severity, direct: row.direct, depth: row.depth, path: row.path, hops: row.hops, path_omitted_hops: row.path_omitted_hops,
      change_ids: row.change_ids, change_ids_omitted: row.change_ids_omitted,
    }) && sameReading(f.reason, row.reason, true)
  );
}

/** How live contract checks contributed to a run, as recorded in its coverage limits. */
export function liveChecksOf(runChecks: boolean, recordedResults: number): "ran" | "disabled" | "none_selected" {
  if (!runChecks) return "disabled";
  return recordedResults === 0 ? "none_selected" : "ran";
}

/**
 * Where a stored manifest no longer validates and by which rule: locations (JSON pointers) and rule names only, never a value, and
 * what to do about it. A manifest that an earlier build accepted can fail here when the validator has been widened since (a secret
 * shape it did not know): the refusal is fail-closed, the source data is not rewritten, and the way out is to import the source
 * manifest again through the current importer (or to export with the previous build until then).
 */
export function manifestRefusal(failure: { readonly issues: readonly { readonly code: string; readonly path: string }[]; readonly total_issues: number }): string {
  const shown = failure.issues.slice(0, 5).map((i) => `${i.path === "" ? "(document)" : redactIdentifier(i.path)} [${i.code}]`);
  const more = failure.total_issues - shown.length;
  return `${shown.join("; ")}${more > 0 ? `; and ${more} more` : ""}. Nothing was written. Re-import the source manifest through the current importer, or keep the previous build for exports until then`;
}

function requireGraph(manifest: unknown, label: string, id?: string) {
  const built = buildGraph(manifest);
  if (!built.ok) return fail("BUNDLE_SNAPSHOT_MISMATCH", `${id === undefined ? `a ${label}` : `${label} ${id}`} in the bundle no longer validates: ${manifestRefusal(built.failure)}`);
  return built.graph;
}

export const serializeBundle = (bundle: EvidenceBundle): string => `${canonicalJson(bundle)}\n`;
