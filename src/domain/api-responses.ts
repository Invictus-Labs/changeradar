import { z } from "zod";

/**
 * Response body schemas of the HTTP API, the counterpart of `api-schemas.ts` (requests). They are written once here
 * as zod schemas, the shipped JSON Schema (schemas/api-responses.json) is generated from them, and the contract tests
 * (tests/integration/review-round2-contract.test.ts) validate REAL responses of a live server against both, so a
 * renamed, removed or added field fails a test. Top level objects are strict (an unexpected member is a drift);
 * free-form parts that the domain defines elsewhere (coverage, changes, unknowns, hops) are described by the members a
 * client relies on and left open otherwise.
 */

const Text = z.string();
const Iso = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/);
const Hash = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const Uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const Role = z.enum(["viewer", "operator", "admin"]);
const Verdict = z.enum(["AFFECTED", "NO_KNOWN_IMPACT", "INCOMPLETE"]);
const RunStatus = z.enum(["queued", "running", "complete", "failed"]);

/** `{error:{code,message,request_id}}` plus optional structured `details` (never a submitted value). */
export const ErrorEnvelope = z.strictObject({
  error: z.strictObject({ code: Text.min(1), message: Text, request_id: Text.min(1), details: z.unknown().optional() }),
});

export const HealthLive = z.strictObject({ status: z.literal("ok"), version: Text });
export const HealthReady = z.strictObject({ status: z.literal("ready"), version: Text });

const PublicUser = z.strictObject({ id: Uuid, email: Text, workspace_id: Uuid, workspace_name: Text, role: Role });
/** POST /auth/login (200) and GET /auth/session (200). */
export const SessionResponse = z.strictObject({ user: PublicUser, csrf_token: Text.min(1) });
export const LogoutResponse = z.strictObject({ ok: z.literal(true) });

const SnapshotSummary = z.strictObject({
  id: Uuid,
  revision: Text,
  hash: Hash,
  document_hash: Hash,
  schema_version: z.literal(1),
  node_count: z.number().int().min(0),
  edge_count: z.number().int().min(0),
  baseline_version: z.number().int().min(0),
  is_baseline: z.boolean(),
  imported_at: Iso,
  warnings: z.array(z.looseObject({ code: Text })),
});
/** POST /snapshots (201): the summary of the new baseline. */
export const SnapshotReceipt = SnapshotSummary.extend({ is_baseline: z.literal(true) });
export { SnapshotSummary };

/** POST /impact-runs (202). */
export const ImpactRunReceipt = z.strictObject({
  id: Uuid,
  status: z.literal("queued"),
  snapshot_id: Uuid,
  baseline_hash: Hash,
  proposed_hash: Hash,
  baseline_version: z.number().int().min(0),
});

const FindingId = z.string().regex(/^fnd_[0-9a-f]{20}$/);
const Hop = z.looseObject({ from: Text, to: Text, relation: z.enum(["consumes", "requires", "produces"]), source_id: Text, target_id: Text });
const findingMembers = {
  id: FindingId,
  origin_id: Text,
  consumer_id: Text,
  consumer_kind: Text,
  consumer_owner: Text.nullable(),
  severity: z.enum(["high", "medium"]),
  direct: z.boolean(),
  depth: z.number().int().min(1),
  path: z.array(Text),
  hops: z.array(Hop),
  path_omitted_hops: z.number().int().min(1).optional(),
  change_ids: z.array(Text),
  change_ids_omitted: z.number().int().min(1).optional(),
  reason: Text,
};
/** One finding as listed by GET /impact-runs/{id}/findings and in the report. */
export const FindingView = z.strictObject(findingMembers);
const { path: _p, hops: _h, ...withoutPath } = findingMembers;
const AffectedView = z.strictObject(withoutPath);

const Unknown = z.looseObject({ id: Text, code: Text, message: Text });
const Change = z.looseObject({ id: Text, kind: Text });
const Coverage = z.looseObject({ scope: z.literal("declared_manifests_only"), limits: z.array(z.looseObject({ code: Text, message: Text })), known: z.array(Text) });
const Summary = z.strictObject({
  changes: z.number().int().min(0),
  findings: z.number().int().min(0),
  direct_findings: z.number().int().min(0),
  transitive_findings: z.number().int().min(0),
  unknowns: z.number().int().min(0),
  known_impact: z.boolean(),
  findings_omitted: z.number().int().min(1).optional(),
  changes_omitted: z.number().int().min(1).optional(),
});
const Engine = z.strictObject({ version: z.number().int().min(1), current: z.number().int().min(1), rerun_required: z.boolean(), note: Text.optional() });
const RunError = z.strictObject({ code: Text, detail: Text }).nullable();
const CheckResult = z.strictObject({
  check_key: Text,
  node_id: Text,
  state: z.enum(["STARTED", "PASSED", "FAILED", "TIMED_OUT", "ERROR", "UNKNOWN"]),
  attempts: z.number().int().min(0).nullable(),
  detail: Text.nullable(),
  error_code: Text.nullable(),
  attempt_log: z.array(z.unknown()),
  started_at: Iso,
  finished_at: Iso.nullable(),
});

/** GET /impact-runs/{id}. */
export const ImpactRunView = z.strictObject({
  id: Uuid,
  snapshot_id: Uuid,
  status: RunStatus,
  // Null for a finished run assessed by an older engine: its old verdict is `recorded_assessment`, never a current answer.
  assessment: Verdict.nullable(),
  recorded_assessment: Verdict.nullable(),
  baseline_hash: Hash,
  proposed_hash: Hash,
  baseline_version: z.number().int().min(0),
  allow_superseded: z.boolean(),
  created_at: Iso,
  started_at: Iso.nullable(),
  finished_at: Iso.nullable(),
  error: RunError,
  engine: Engine,
  summary: Summary.nullable(),
  coverage: Coverage.nullable(),
  cycles: z.array(z.unknown()),
  changes: z.array(Change),
  affected: z.array(AffectedView),
  paths: z.array(z.strictObject({ finding_id: FindingId, path: z.array(Text), hops: z.array(Hop), path_omitted_hops: z.number().int().min(1).optional() })),
  unknowns: z.array(Unknown),
  checks: z.array(CheckResult),
  totals: z.strictObject({ findings: z.number().int().min(0), unknowns: z.number().int().min(0) }),
  truncated: z.strictObject({ findings: z.boolean(), unknowns: z.boolean() }),
});

const Page = <T extends z.ZodType>(item: T) => z.strictObject({ items: z.array(item), next_cursor: Text.nullable() });
/** GET /impact-runs/{id}/findings. */
export const FindingsPage = Page(FindingView).extend({ rerun_required: z.boolean() });
/** GET /snapshots (the list envelope every list endpoint uses: `{items, next_cursor}`). */
export const SnapshotListPage = Page(SnapshotSummary);
/** GET /impact-runs. */
export const RunListPage = Page(
  z.strictObject({ id: Uuid, snapshot_id: Uuid, status: RunStatus, assessment: Verdict.nullable(), recorded_assessment: Verdict.nullable(), proposed_hash: Hash, created_at: Iso, finished_at: Iso.nullable(), rerun_required: z.boolean() }),
);

/** GET /impact-runs/{id}/export?format=json. */
export const RunReport = z.strictObject({
  schema_version: z.literal(1),
  format: z.literal("changeradar-run-report"),
  run: z.strictObject({
    id: Uuid,
    snapshot_id: Uuid,
    status: RunStatus,
    assessment: Verdict.nullable(),
    recorded_assessment: Verdict.nullable(),
    baseline_hash: Hash,
    proposed_hash: Hash,
    baseline_version: z.number().int().min(0),
    allow_superseded: z.boolean(),
    created_at: Iso,
    started_at: Iso.nullable(),
    finished_at: Iso.nullable(),
    error: RunError,
    engine: Engine,
  }),
  snapshot: z.strictObject({ id: Uuid, revision: Text, hash: Hash, imported_at: Iso }),
  summary: Summary.nullable(),
  coverage: Coverage.nullable(),
  cycles: z.array(z.unknown()),
  changes: z.array(Change),
  findings: z.array(FindingView),
  unknowns: z.array(Unknown),
  checks: z.array(CheckResult),
  report_hash: Hash,
});

/** The named response schemas, in the order they appear in schemas/api-responses.json. */
export const RESPONSE_SCHEMAS = {
  error_envelope: ErrorEnvelope,
  health_live: HealthLive,
  health_ready: HealthReady,
  session_response: SessionResponse,
  logout_response: LogoutResponse,
  snapshot_receipt: SnapshotReceipt,
  snapshot_summary: SnapshotSummary,
  snapshot_list_page: SnapshotListPage,
  impact_run_receipt: ImpactRunReceipt,
  impact_run_view: ImpactRunView,
  impact_run_list_page: RunListPage,
  findings_page: FindingsPage,
  run_report: RunReport,
} as const;

export function buildResponseJsonSchemas(): Record<string, unknown> {
  const defs: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(RESPONSE_SCHEMAS)) {
    const generated = z.toJSONSchema(schema, { target: "draft-2020-12", io: "output", unrepresentable: "any" }) as Record<string, unknown>;
    const { $schema: _drop, ...rest } = generated;
    defs[name] = rest;
  }
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "api-responses.json",
    title: "ChangeRadar API response bodies (v1)",
    description:
      "Response bodies of the HTTP API: the error envelope, health, login and session, snapshot receipt and list, impact run receipt, view and list, findings page and the JSON run report. Written once as zod schemas (src/domain/api-responses.ts); tests validate real server responses against them, so a renamed, removed or added member fails a test. Free-form parts defined by the domain (coverage, changes, unknowns, hops) list the members clients rely on and stay open otherwise.",
    $defs: defs,
  };
}
