import type { RunReport } from "../../src/services/report.js";
import { UUID_ONES, UUID_TWOS } from "../helpers/ids.js";
import { HOSTILE } from "./hostile.js";

/** Deterministic report fixtures (fixed ids, hashes and timestamps; synthetic names). */

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const HASH_R = `sha256:${"c".repeat(64)}`;

export const FINDING_DIRECT = "fnd_0123456789abcdef0123";
export const FINDING_TRANSITIVE = "fnd_fedcba9876543210fedc";

export function baseReport(): RunReport {
  return {
    schema_version: 1,
    format: "changeradar-run-report",
    run: {
      id: UUID_ONES,
      snapshot_id: UUID_TWOS,
      status: "complete",
      assessment: "AFFECTED",
      baseline_hash: HASH_A,
      proposed_hash: HASH_B,
      baseline_version: 3,
      allow_superseded: false,
      created_at: "2026-09-29T00:00:00.000Z",
      started_at: "2026-09-29T00:00:01.000Z",
      finished_at: "2026-09-29T00:00:02.000Z",
      error: null,
    },
    snapshot: { id: UUID_TWOS, revision: "2026-09-28.1", hash: HASH_A, imported_at: "2026-09-28T00:00:00.000Z" },
    summary: { changes: 1, findings: 2, direct_findings: 1, transitive_findings: 1, unknowns: 0, known_impact: true },
    coverage: {
      scope: "declared_manifests_only",
      baseline: { nodes: 7, edges: 6 },
      proposed: { nodes: 7, edges: 6 },
      changed_node_ids: ["contract.invoice"],
      origin_node_ids: ["contract.invoice"],
      nodes_examined: 4,
      edges_examined: 3,
      consumers_found: 2,
      known: ["2 consumers of contract.invoice were found in the declared manifests"],
      limits: [
        { code: "MANIFEST_DECLARED_ONLY", message: "Only dependencies declared in the imported manifests are considered." },
        { code: "CONTRACT_SUBSET_ONLY", message: "Only required-field and type changes are compared." },
        { code: "RUNTIME_NOT_OBSERVED", message: "Runtime behavior is not observed." },
      ],
    },
    cycles: [],
    changes: [
      {
        id: "chg_00112233445566778899",
        kind: "contract_field_removed",
        node_id: "contract.invoice",
        origin_id: "contract.invoice",
        field: "amount",
        propagation: "field",
        description: "Field amount was removed from contract.invoice",
      },
    ],
    findings: [
      {
        id: FINDING_DIRECT,
        origin_id: "contract.invoice",
        consumer_id: "job.export",
        consumer_kind: "job",
        consumer_owner: "team-data",
        severity: "high",
        direct: true,
        depth: 1,
        path: ["contract.invoice", "job.export"],
        hops: [{ from: "contract.invoice", to: "job.export", relation: "consumes", source_id: "job.export", target_id: "contract.invoice", source_file: "manifests/job.export.yaml", source_line: 10 }],
        change_ids: ["chg_00112233445566778899"],
        reason: "job.export consumes contract.invoice, which lost required field amount",
      },
      {
        id: FINDING_TRANSITIVE,
        origin_id: "contract.invoice",
        consumer_id: "svc.dashboard",
        consumer_kind: "service",
        consumer_owner: null,
        severity: "medium",
        direct: false,
        depth: 2,
        path: ["contract.invoice", "job.export", "svc.dashboard"],
        hops: [
          { from: "contract.invoice", to: "job.export", relation: "consumes", source_id: "job.export", target_id: "contract.invoice", source_file: "manifests/job.export.yaml", source_line: 10 },
          { from: "job.export", to: "svc.dashboard", relation: "produces", source_id: "job.export", target_id: "artifact.report", source_file: "manifests/job.export.yaml", source_line: 11 },
        ],
        change_ids: ["chg_00112233445566778899"],
        reason: "svc.dashboard depends on job.export output",
      },
    ],
    unknowns: [],
    checks: [],
    report_hash: HASH_R,
  } as unknown as RunReport;
}

export const withRun = (patch: Partial<RunReport["run"]>, rest: Partial<RunReport> = {}): RunReport => {
  const base = baseReport();
  return { ...base, ...rest, run: { ...base.run, ...patch } };
};

export function incompleteReport(): RunReport {
  return withRun(
    { assessment: "INCOMPLETE" },
    {
      summary: { changes: 1, findings: 2, direct_findings: 1, transitive_findings: 1, unknowns: 2, known_impact: true },
      unknowns: [
        { id: "unk_aaaaaaaaaaaaaaaaaaaa", code: "UNVERIFIED_CONTRACT", node_id: null, edge: { source_id: "job.export", target_id: "contract.invoice", relation: "consumes" }, message: "edge job.export -> contract.invoice was never verified" },
        { id: "unk_bbbbbbbbbbbbbbbbbbbb", code: "MISSING_OWNER", node_id: "svc.dashboard", edge: null, message: "svc.dashboard has no owner" },
      ],
      checks: [{ check_key: "invoice-live", node_id: "contract.invoice", state: "TIMED_OUT", attempts: 3, detail: "no answer within 5000 ms", error_code: null, attempt_log: [], started_at: "2026-09-29T00:00:01.000Z", finished_at: "2026-09-29T00:00:02.000Z" }],
    },
  );
}

export function noImpactReport(): RunReport {
  const base = baseReport();
  return withRun(
    { assessment: "NO_KNOWN_IMPACT" },
    {
      summary: { changes: 1, findings: 0, direct_findings: 0, transitive_findings: 0, unknowns: 0, known_impact: false },
      findings: [],
      coverage: { ...(base.coverage as object), limits: [{ code: "NO_AFFECTED_CONSUMERS_DECLARED", message: "No consumer of the changed node is declared.", node_ids: ["contract.invoice"] }, ...((base.coverage as { limits: unknown[] }).limits as object[])] },
    },
  );
}

/** Every free-text field carries a payload. */
export function hostileReport(): RunReport {
  const h = `${HOSTILE.owner}${HOSTILE.version}`;
  const base = baseReport();
  return {
    ...base,
    run: { ...base.run, error: null },
    snapshot: { ...base.snapshot, revision: HOSTILE.revision },
    findings: [
      {
        id: FINDING_DIRECT,
        origin_id: `origin-${HOSTILE.owner}`,
        consumer_id: HOSTILE.owner,
        consumer_kind: HOSTILE.version,
        consumer_owner: HOSTILE.version,
        severity: "high",
        direct: true,
        depth: 1,
        path: [`origin-${HOSTILE.owner}`, HOSTILE.owner],
        hops: [{ relation: HOSTILE.revision, source_file: HOSTILE.file, source_line: 7 }],
        change_ids: [],
        reason: h,
      },
    ],
    unknowns: [{ id: "unk_cccccccccccccccccccc", code: HOSTILE.version, node_id: HOSTILE.owner, edge: null, message: h }],
    checks: [{ check_key: HOSTILE.owner, node_id: HOSTILE.version, state: "ERROR", attempts: 1, detail: h, error_code: null, attempt_log: [], started_at: "2026-09-29T00:00:01.000Z", finished_at: null }],
    cycles: [{ id: "cyc_dddddddddddddddddddd", members: [HOSTILE.owner, HOSTILE.version] }],
    changes: [{ id: "chg_eeeeeeeeeeeeeeeeeeee", kind: HOSTILE.version, node_id: HOSTILE.owner, propagation: "field", description: h }],
    coverage: { ...(base.coverage as object), scope: HOSTILE.version, known: [h], limits: [{ code: HOSTILE.owner, message: h, node_ids: [HOSTILE.owner] }] },
  } as unknown as RunReport;
}
