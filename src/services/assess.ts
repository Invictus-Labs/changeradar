import type { Clock } from "../domain/clock.js";
import { compareStrings, isHashString, sha256Hex, stableId } from "../domain/canonical.js";
import type { ContractCheckResult } from "../domain/contract-checks.js";
import { capDerived } from "../domain/derived-text.js";
import { InvalidExpectedHashError, StaleBaselineError } from "../domain/errors.js";
import { DEFAULT_ASSESS_CONFIG, outputBoundsOf, type AssessConfig, type OutputBounds } from "../domain/limits.js";
import {
  edgeKeyString,
  type Cycle,
  type EdgeKey,
  type GraphEdge,
  type OverallAssessment,
  type Severity,
} from "../domain/types.js";
import { affectsLink, diffGraphs, traverseDependents, type Change, type PathHop } from "./diff.js";
import type { DependencyGraph } from "./graph.js";

export const ASSESSMENT_SCHEMA_VERSION = 1;

/**
 * Version of the DECISION rules (what counts as a change, who a change reaches, what is an unknown). Stamped into every
 * assessment. Bump it whenever a change to the decision code can give a run a different verdict, findings or unknowns:
 * a stored run or a bundle from an older engine is then reported as such (re-run required) instead of failing
 * verification like a tampered file, and its old verdict is never presented as current. 1 is the engine before round 2
 * (no stamp); round 2 (version 2) changed produces edge and unusable field declarations, prerelease targets and 0.0.x
 * versions; round 3 (version 3) made a new requirement (a required field added, an optional field made required) reach
 * every consumer of the contract, whatever fields it declares.
 */
export const ENGINE_VERSION = 3;

/**
 * THE predicate for "this run's verdict comes from an out-of-date engine": a FINISHED run whose stamp is not the current
 * version (a run stored before the stamp existed is version 1; a stamp that is not a number is never current). The run view,
 * the run list, both exports and the bundle checks all use it (through `engineOf` and `staleEngineRuns`), so no surface can
 * disagree about which runs are stale.
 */
export function isStaleEngineRun(finished: boolean, stamp: unknown): boolean {
  const version = stamp === undefined || stamp === null ? 1 : stamp;
  return finished && version !== ENGINE_VERSION;
}

export type UnknownCode =
  | "MISSING_OWNER"
  | "PLACEHOLDER_NODE"
  | "STALE_CONTRACT"
  | "UNVERIFIED_CONTRACT"
  | "FUTURE_VERIFIED_AT"
  | "UNDECLARED_CONTRACT"
  | "CHECK_FAILED"
  | "CHECK_TIMED_OUT"
  | "CHECK_ERROR"
  | "CHECK_UNKNOWN"
  | "FINDINGS_TRUNCATED"
  | "UNKNOWNS_TRUNCATED"
  | "CHECK_NOT_RUN"
  | "EDGE_FIELD_NOT_IN_CONTRACT";

/** Something the assessment could not establish. Any unknown forces INCOMPLETE. */
export interface AssessmentUnknown {
  /** Stable, content derived id (`unk_` + 20 hex). Independent of the evaluation time. */
  readonly id: string;
  readonly code: UnknownCode;
  readonly node_id: string | null;
  readonly edge: EdgeKey | null;
  readonly message: string;
}

/** A consumer that a proposed change can break. */
export interface Finding {
  /** Stable, content derived id (`fnd_` + 20 hex); identical in JSON and HTML exports. */
  readonly id: string;
  /** The changed node whose dependents were traversed. */
  readonly origin_id: string;
  readonly consumer_id: string;
  readonly consumer_kind: string;
  readonly consumer_owner: string | null;
  readonly severity: Severity;
  /** true when the consumer is one hop from the origin. */
  readonly direct: boolean;
  readonly depth: number;
  /** Ordered node ids, changed node first, consumer last. */
  readonly path: readonly string[];
  /**
   * Ordered hops with edge provenance. `hops.length === depth` unless `path_omitted_hops` is present, in which
   * case only the first and last hops are kept and that many hops sit between `hops[PATH_HEAD_HOPS - 1]` and
   * `hops[PATH_HEAD_HOPS]` (and `path` is the origin followed by the `to` of every kept hop).
   */
  readonly hops: readonly PathHop[];
  /** Hops left out of a very long path. Absent when the whole path is kept. */
  readonly path_omitted_hops?: number;
  /** Ids of the changes that reach this consumer through the first hop. Sorted; capped (see change_ids_omitted). */
  readonly change_ids: readonly string[];
  /** Change ids left out of `change_ids`. Absent when the list is complete. */
  readonly change_ids_omitted?: number;
  readonly reason: string;
}

export interface CoverageLimit {
  readonly code: string;
  readonly message: string;
  readonly node_ids?: readonly string[];
}

export interface Coverage {
  readonly scope: "declared_manifests_only";
  readonly baseline: { readonly nodes: number; readonly edges: number };
  readonly proposed: { readonly nodes: number; readonly edges: number };
  readonly changed_node_ids: readonly string[];
  readonly origin_node_ids: readonly string[];
  readonly nodes_examined: number;
  readonly edges_examined: number;
  readonly consumers_found: number;
  /** What the assessment did know. */
  readonly known: readonly string[];
  /** What the assessment did not or could not know. */
  readonly limits: readonly CoverageLimit[];
  /** The output bounds this assessment was produced under (a bundle re-derives it with the same bounds). */
  readonly bounds: OutputBounds;
}

export interface Assessment {
  readonly schema_version: 1;
  /** Version of the decision rules that produced this assessment (see ENGINE_VERSION). */
  readonly engine_version: number;
  /** COMPLETE (run status) describes computation only; this field is the verdict. */
  readonly assessment: OverallAssessment;
  readonly baseline_hash: string;
  readonly proposed_hash: string;
  /** From the injected clock. The only time-dependent field; it is not part of any id. */
  readonly evaluated_at: string;
  readonly changes: readonly Change[];
  readonly findings: readonly Finding[];
  readonly unknowns: readonly AssessmentUnknown[];
  /** Cycles reached by the traversals. Reported, never traversed twice. */
  readonly cycles: readonly Cycle[];
  readonly coverage: Coverage;
  readonly summary: {
    readonly changes: number;
    readonly findings: number;
    readonly direct_findings: number;
    readonly transitive_findings: number;
    readonly unknowns: number;
    /** Findings are real even when the verdict is INCOMPLETE; this makes that visible. */
    readonly known_impact: boolean;
    /** Consumers found but not recorded because an output bound was reached. Absent when nothing was omitted. */
    readonly findings_omitted?: number;
    /** Changes evaluated but not listed because of the list bound. Absent when the list is complete. */
    readonly changes_omitted?: number;
  };
}

export interface AssessInput {
  /** The stored baseline snapshot graph. Its `hash` is the actual snapshot hash. */
  readonly baseline: DependencyGraph;
  readonly proposed: DependencyGraph;
  /** The hash the caller believes the baseline has (POST /impact-runs expected_hash). */
  readonly expected_hash: string;
  readonly clock: Clock;
  readonly config?: Partial<AssessConfig>;
  /** Results of read-only contract checks. Anything other than PASSED is an unknown. */
  readonly check_results?: readonly ContractCheckResult[];
  /**
   * Checks the run asked for by key that could not be run (disabled or removed before the worker ran). Each is a
   * CHECK_NOT_RUN unknown: a requested verification that did not happen is never treated as none needed.
   */
  readonly missing_check_keys?: readonly string[];
  /**
   * Whether live contract checks contributed to this assessment: "disabled" (run_checks was false) or
   * "none_selected" (no enabled check matched) add a LIVE_CHECKS_NOT_RUN coverage limit. Omitted: no statement.
   */
  readonly live_checks?: "ran" | "disabled" | "none_selected";
  /**
   * Derive unknown messages and finding reasons WITHOUT the 2,000-character cut. Only verification sets it: a run written before the
   * cut existed holds text derived uncut (then redacted, then cut by a restore), and the cut of THIS derivation would fall at another
   * character than the cut of the redacted record (see evidence.ts, `sameReading`).
   */
  readonly uncapped_text?: boolean;
}

export type AssessResult =
  | { readonly ok: true; readonly assessment: Assessment }
  | { readonly ok: false; readonly error: StaleBaselineError | InvalidExpectedHashError };

/**
 * AC-05 baseline semantics: null when `expected` equals `actual`, otherwise the typed error the API
 * maps to HTTP 409 (stale) or 422 (malformed hash). Pure.
 */
export function checkBaselineHash(actual: string, expected: string): StaleBaselineError | InvalidExpectedHashError | null {
  if (!isHashString(expected)) return new InvalidExpectedHashError();
  if (expected !== actual) return new StaleBaselineError(expected, actual);
  return null;
}


/**
 * Assess a proposed graph against an immutable baseline snapshot.
 *
 * Verdict precedence: any unknown => INCOMPLETE; else any finding => AFFECTED; else NO_KNOWN_IMPACT.
 * Unknowns never become a safe verdict. Findings stay visible even when the verdict is INCOMPLETE.
 *
 * Output is bounded (see AssessConfig): a valid manifest can imply a quadratic number of (origin, consumer)
 * pairs, so findings, stored paths, change lists and unknowns are capped and reaching a cap records an unknown.
 */
export function assess(input: AssessInput): AssessResult {
  const stale = checkBaselineHash(input.baseline.hash, input.expected_hash);
  if (stale) return { ok: false, error: stale };

  const config: AssessConfig = { ...DEFAULT_ASSESS_CONFIG, ...(input.config ?? {}) };
  const { baseline, proposed } = input;
  const now = input.clock.now();

  const allChanges = diffGraphs(baseline, proposed);
  const propagating = allChanges.filter((c) => c.propagation !== "none");

  const changesByOrigin = new Map<string, Change[]>();
  for (const change of propagating) {
    const list = changesByOrigin.get(change.origin_id);
    if (list) list.push(change);
    else changesByOrigin.set(change.origin_id, [change]);
  }
  const originIds = [...changesByOrigin.keys()].sort(compareStrings);
  const findings: Finding[] = [];
  const unknownMap = new Map<string, AssessmentUnknown>();
  const cycleMap = new Map<string, Cycle>();
  const examinedNodes = new Set<string>();
  const examinedEdges = new Set<string>();
  const originsWithoutAffected: string[] = [];

  let unknownsOmitted = 0;
  const addUnknown = (
    code: UnknownCode,
    message: string,
    nodeId: string | null,
    edge: EdgeKey | null,
    extra: unknown = null,
    force = false,
  ): void => {
    const id = stableId("unk", { code, node_id: nodeId, edge, extra });
    if (unknownMap.has(id)) return;
    if (!force && unknownMap.size >= config.max_unknowns) {
      unknownsOmitted += 1;
      return;
    }
    // Every unknown message passes through here, so none can exceed what a restore keeps (see derived-text.ts): a message
    // that lists names (EDGE_FIELD_NOT_IN_CONTRACT) grows with the manifest.
    unknownMap.set(id, { id, code, node_id: nodeId, edge, message: input.uncapped_text === true ? message : capDerived(message) });
  };

  const checkNode = (nodeId: string): void => {
    if (examinedNodes.has(nodeId)) return;
    examinedNodes.add(nodeId);
    // Traversal only yields nodes of the baseline graph, so the node always exists.
    const node = baseline.getNode(nodeId)!;
    if (node.owner === null) {
      addUnknown("MISSING_OWNER", `node ${nodeId} has no declared owner, so who is affected is unknown`, nodeId, null);
    }
    if (node.placeholder) {
      addUnknown(
        "PLACEHOLDER_NODE",
        `node ${nodeId} is a placeholder for an unimported manifest; its owner and contract are unknown`,
        nodeId,
        null,
      );
    }
  };

  const nowMs = now.getTime();
  const checkEdge = (edge: GraphEdge): void => {
    const key = edgeKeyString(edge);
    if (examinedEdges.has(key)) return;
    examinedEdges.add(key);
    const edgeKey: EdgeKey = { source_id: edge.source_id, target_id: edge.target_id, relation: edge.relation };
    if (edge.verified_at === null) {
      addUnknown("UNVERIFIED_CONTRACT", `edge ${key} was never verified`, null, edgeKey);
      return;
    }
    const verifiedMs = Date.parse(edge.verified_at);
    if (verifiedMs > nowMs + config.future_skew_ms) {
      addUnknown("FUTURE_VERIFIED_AT", `edge ${key} has a verified_at in the future, so it cannot be trusted`, null, edgeKey);
    } else if (nowMs - verifiedMs > config.max_contract_age_ms) {
      addUnknown("STALE_CONTRACT", `edge ${key} was last verified at ${edge.verified_at}, older than the allowed age`, null, edgeKey);
    }
  };

  const budget = { remaining: config.max_traversal_links };
  let findingBytes = 0;
  let findingsOmitted = 0;
  const originsNotAnalyzed: string[] = [];
  let originsTruncated = 0;

  for (const originId of originIds) {
    if (budget.remaining <= 0) {
      originsNotAnalyzed.push(originId);
      continue;
    }
    const originChanges = changesByOrigin.get(originId)!;
    const causing = new Map<string, Change[]>();
    const originContract = baseline.getNode(originId)?.contract ?? null;
    const originFields = originContract ? new Set(originContract.map((field) => field.name)) : null;
    const traversal = traverseDependents(baseline, originId, {
      budget,
      acceptFirstHop: (link) => {
        const hits = originChanges.filter((c) => affectsLink(c, link, originFields));
        if (hits.length === 0) return false;
        causing.set(edgeKeyString(link.edge), hits);
        return true;
      },
    });
    if (traversal.truncated) originsTruncated += 1;

    checkNode(originId);
    // Includes first-hop edges that EXCLUDED a consumer (it declares other fields): the exclusion is only as
    // trustworthy as the evidence on that edge.
    for (const edge of traversal.examined_edges) checkEdge(edge);
    // A consumer edge into the origin whose declared fields the origin contract does not have is an unusable
    // declaration: the consumer is treated as relying on every required field (see usableDeclaredFields) and the
    // typo or stale name is reported, for edges of the BASELINE too (not only those a proposal introduces).
    if (originFields !== null) {
      for (const edge of traversal.examined_edges) {
        if (edge.relation === "produces" || edge.target_id !== originId || edge.fields === null) continue;
        const unknownFields = edge.fields.filter((name) => !originFields.has(name));
        if (unknownFields.length === 0) continue;
        addUnknown(
          "EDGE_FIELD_NOT_IN_CONTRACT",
          `edge ${edgeKeyString(edge)} declares field(s) ${unknownFields.join(", ")} that contract ${originId} does not have (a typo or a name left over from a rename), so what this consumer relies on is unknown; it is treated as relying on every required field`,
          null,
          { source_id: edge.source_id, target_id: edge.target_id, relation: edge.relation },
        );
      }
    }
    for (const cycle of traversal.cycles) cycleMap.set(cycle.id, cycle);
    if (traversal.reached.length === 0 && !traversal.truncated) originsWithoutAffected.push(originId);

    // Cause text is computed once per first hop: every consumer behind the same first hop shares it.
    const causeCache = new Map<string, CauseInfo>();
    const causeOf = (edge: GraphEdge): CauseInfo => {
      const key = edgeKeyString(edge);
      let info = causeCache.get(key);
      if (!info) {
        info = describeCauses(causing.get(key)!, config);
        causeCache.set(key, info);
      }
      return info;
    };

    let recordedForOrigin = 0;
    for (const reached of traversal.reached) {
      checkNode(reached.node_id);
      if (
        recordedForOrigin >= config.max_findings_per_origin ||
        findings.length >= config.max_findings ||
        findingBytes >= config.max_finding_bytes
      ) {
        findingsOmitted += 1;
        continue;
      }
      const consumer = baseline.getNode(reached.node_id)!;
      const cause = causeOf(reached.first.edge);
      const bounded = reached.boundedPath();
      const path = [originId, ...bounded.hops.map((h) => h.to)];
      const direct = reached.depth === 1;
      const finding: Finding = {
        id: stableId("fnd", {
          baseline_hash: baseline.hash,
          proposed_hash: proposed.hash,
          origin_id: originId,
          consumer_id: reached.node_id,
          path,
          change_ids: cause.ids,
          // Present only when something was left out, so ids of complete findings are unchanged.
          ...(bounded.omitted > 0 ? { path_omitted_hops: bounded.omitted, depth: reached.depth } : {}),
          ...(cause.omitted > 0 ? { change_ids_omitted: cause.omitted, change_digest: cause.digest } : {}),
        }),
        origin_id: originId,
        consumer_id: reached.node_id,
        consumer_kind: consumer.kind,
        consumer_owner: consumer.owner,
        severity: direct ? "high" : "medium",
        direct,
        depth: reached.depth,
        path,
        hops: bounded.hops,
        ...(bounded.omitted > 0 ? { path_omitted_hops: bounded.omitted } : {}),
        change_ids: cause.ids,
        ...(cause.omitted > 0 ? { change_ids_omitted: cause.omitted } : {}),
        reason: ((text: string): string => (input.uncapped_text === true ? text : capDerived(text)))(`${direct ? "Direct" : "Transitive"} dependent of ${originId} (${reached.depth} hop${reached.depth === 1 ? "" : "s"}): ${cause.text}`),
      };
      const size = JSON.stringify(finding).length;
      if (findingBytes + size > config.max_finding_bytes) {
        findingsOmitted += 1;
        findingBytes = config.max_finding_bytes;
        continue;
      }
      findingBytes += size;
      findings.push(finding);
      recordedForOrigin += 1;
    }
  }

  const truncated = findingsOmitted > 0 || originsNotAnalyzed.length > 0 || originsTruncated > 0;
  if (truncated) {
    const parts = [`${findings.length} affected consumer(s) are recorded`];
    if (findingsOmitted > 0) parts.push(`${findingsOmitted} more were found but not recorded because an output limit was reached`);
    if (originsTruncated > 0) parts.push(`${originsTruncated} changed node(s) were only partly analysed because the traversal limit was reached`);
    if (originsNotAnalyzed.length > 0) parts.push(`${originsNotAnalyzed.length} changed node(s) were not analysed at all`);
    addUnknown("FINDINGS_TRUNCATED", `${parts.join("; ")}. The list of affected consumers is incomplete.`, null, null, null, true);
  }

  // A contract whose field list is unknown on either side cannot be compared field by field.
  for (const change of allChanges) {
    if (change.kind === "node_added" || change.kind === "node_removed" || change.edge !== null) continue;
    // Added and removed nodes were skipped above, so the node exists in both graphs.
    const before = baseline.getNode(change.node_id)!;
    const after = proposed.getNode(change.node_id)!;
    if ((before.kind === "contract" || after.kind === "contract") && (before.contract === null || after.contract === null)) {
      addUnknown(
        "UNDECLARED_CONTRACT",
        `contract ${change.node_id} changed but its required fields are not declared in both manifests, so field level impact is unknown`,
        change.node_id,
        null,
      );
    }
  }

  // A consumer edge that the proposal introduces or rewrites and that names a field the contract does not have
  // cannot be judged: the graph warns about it, and the verdict must not stay silent.
  for (const edge of proposed.edges) {
    if (edge.fields === null) continue;
    const contract = proposed.getNode(edge.target_id)?.contract;
    if (!contract) continue;
    const names = new Set(contract.map((field) => field.name));
    const unknownFields = edge.fields.filter((name) => !names.has(name));
    if (unknownFields.length === 0) continue;
    const previous = baseline.getEdge(edge);
    if (previous && previous.fields !== null && previous.fields.join("\u0000") === edge.fields.join("\u0000")) continue;
    addUnknown(
      "EDGE_FIELD_NOT_IN_CONTRACT",
      `edge ${edgeKeyString(edge)} declares field(s) ${unknownFields.join(", ")} that the contract does not have, so what this consumer relies on is unknown`,
      null,
      { source_id: edge.source_id, target_id: edge.target_id, relation: edge.relation },
    );
  }

  for (const key of [...(input.missing_check_keys ?? [])].sort(compareStrings)) {
    addUnknown(
      "CHECK_NOT_RUN",
      `contract check ${key} was requested for this run but was not run (it is disabled or no longer exists), so the live contract is not confirmed`,
      null,
      null,
      key,
    );
  }

  for (const result of input.check_results ?? []) {
    if (result.state === "PASSED") continue;
    const code = (
      { FAILED: "CHECK_FAILED", TIMED_OUT: "CHECK_TIMED_OUT", ERROR: "CHECK_ERROR", UNKNOWN: "CHECK_UNKNOWN" } as const
    )[result.state];
    addUnknown(
      code,
      `contract check ${result.check_id} on ${result.node_id} finished ${result.state}; the live contract is not confirmed`,
      result.node_id,
      null,
      result.check_id,
    );
  }

  if (unknownsOmitted > 0) {
    addUnknown(
      "UNKNOWNS_TRUNCATED",
      `${unknownsOmitted} further unknown(s) were not listed because the list limit of ${config.max_unknowns} was reached`,
      null,
      null,
      null,
      true,
    );
  }

  findings.sort(
    (a, b) =>
      severityRank(a.severity) - severityRank(b.severity) ||
      a.depth - b.depth ||
      compareStrings(a.consumer_id, b.consumer_id) ||
      compareStrings(a.origin_id, b.origin_id) ||
      compareStrings(a.id, b.id),
  );
  const unknowns = [...unknownMap.values()].sort(
    (a, b) =>
      compareStrings(a.code, b.code) ||
      compareStrings(a.node_id ?? "", b.node_id ?? "") ||
      compareStrings(a.edge ? edgeKeyString(a.edge) : "", b.edge ? edgeKeyString(b.edge) : "") ||
      compareStrings(a.id, b.id),
  );
  const cycles = [...cycleMap.values()].sort((a, b) => compareStrings(a.members[0]!, b.members[0]!));

  const verdict: OverallAssessment =
    unknowns.length > 0 ? "INCOMPLETE" : findings.length > 0 ? "AFFECTED" : "NO_KNOWN_IMPACT";

  const direct = findings.filter((f) => f.direct).length;
  const consumers = new Set(findings.map((f) => f.consumer_id));

  const changes = limitChanges(allChanges, config.max_changes_listed);
  const changesOmitted = allChanges.length - changes.length;

  const coverage = buildCoverage({
    baseline,
    proposed,
    changes: allChanges,
    propagating,
    originIds,
    originsWithoutAffected,
    nodesExamined: examinedNodes.size,
    edgesExamined: examinedEdges.size,
    consumersFound: consumers.size,
    findings: findings.length,
    truncated,
    findingsOmitted,
    originsNotAnalyzed: originsNotAnalyzed.length,
    changesOmitted,
    listedChanges: changes.length,
    bounds: outputBoundsOf(config),
    ...(input.live_checks ? { liveChecks: input.live_checks } : {}),
  });

  return {
    ok: true,
    assessment: {
      schema_version: ASSESSMENT_SCHEMA_VERSION,
      engine_version: ENGINE_VERSION,
      assessment: verdict,
      baseline_hash: baseline.hash,
      proposed_hash: proposed.hash,
      evaluated_at: now.toISOString(),
      changes,
      findings,
      unknowns,
      cycles,
      coverage,
      summary: {
        changes: allChanges.length,
        findings: findings.length,
        direct_findings: direct,
        transitive_findings: findings.length - direct,
        unknowns: unknowns.length,
        known_impact: findings.length > 0,
        ...(findingsOmitted > 0 ? { findings_omitted: findingsOmitted } : {}),
        ...(changesOmitted > 0 ? { changes_omitted: changesOmitted } : {}),
      },
    },
  };
}

interface CauseInfo {
  /** Sorted change ids, at most `max_change_ids`. */
  readonly ids: string[];
  /** Change ids not listed. */
  readonly omitted: number;
  /** Digest of the complete sorted id list, present only when some ids are omitted. */
  readonly digest: string | null;
  readonly text: string;
}

function describeCauses(hits: readonly Change[], config: AssessConfig): CauseInfo {
  const all = hits.map((c) => c.id).sort(compareStrings);
  const descriptions = hits.map((c) => c.description).sort(compareStrings);
  const shown = descriptions.slice(0, config.max_reason_changes);
  const more = descriptions.length - shown.length;
  return {
    ids: all.slice(0, config.max_change_ids),
    omitted: Math.max(0, all.length - config.max_change_ids),
    digest: all.length > config.max_change_ids ? sha256Hex(all.join(",")) : null,
    text: shown.join("; ") + (more > 0 ? `; and ${more} more change(s)` : ""),
  };
}

/** Keep at most `max` changes, preferring the ones that can affect consumers, in canonical order. */
function limitChanges(changes: readonly Change[], max: number): Change[] {
  if (changes.length <= max) return [...changes];
  const keep = new Set<Change>();
  for (const change of changes) if (change.propagation !== "none" && keep.size < max) keep.add(change);
  for (const change of changes) if (keep.size < max) keep.add(change);
  return changes.filter((c) => keep.has(c));
}

function severityRank(severity: Severity): number {
  return severity === "high" ? 0 : 1;
}

function buildCoverage(args: {
  baseline: DependencyGraph;
  proposed: DependencyGraph;
  changes: readonly Change[];
  propagating: readonly Change[];
  originIds: readonly string[];
  originsWithoutAffected: readonly string[];
  nodesExamined: number;
  edgesExamined: number;
  consumersFound: number;
  findings: number;
  truncated: boolean;
  findingsOmitted: number;
  originsNotAnalyzed: number;
  changesOmitted: number;
  listedChanges: number;
  bounds: OutputBounds;
  liveChecks?: "ran" | "disabled" | "none_selected";
}): Coverage {
  const { baseline, proposed } = args;
  const limits: CoverageLimit[] = [
    {
      code: "MANIFEST_DECLARED_ONLY",
      message:
        "Only dependencies declared in the supplied manifests were considered. A consumer that is not declared is not known, and its absence is not evidence that it does not exist.",
    },
    {
      code: "CONTRACT_SUBSET_ONLY",
      message:
        "Contracts are compared by required fields and field types only, not by arbitrary schema compatibility. A consumer that declares no fields is assumed to rely on every required field; use of optional fields is considered only where a consumer edge declares its fields.",
    },
    {
      code: "RUNTIME_NOT_OBSERVED",
      message: "No production traffic, code or runtime behavior was analyzed.",
    },
  ];
  if (args.liveChecks === "disabled" || args.liveChecks === "none_selected") {
    limits.push({
      code: "LIVE_CHECKS_NOT_RUN",
      message:
        args.liveChecks === "disabled"
          ? "Live contract checks were switched off for this run, so no live contract was confirmed."
          : "No enabled live contract check matched this change, so no live contract was confirmed.",
    });
  }
  if (args.changes.length === 0) {
    limits.push({ code: "NO_CHANGES_DETECTED", message: "The proposed manifest has no differences from the baseline." });
  } else if (args.propagating.length === 0) {
    limits.push({
      code: "INFORMATIONAL_CHANGES_ONLY",
      message: "The detected changes cannot break consumers under the MVP rules (for example additions, owner changes or non-major version changes).",
    });
  }
  if (args.originsWithoutAffected.length > 0) {
    limits.push({
      code: "NO_AFFECTED_CONSUMERS_DECLARED",
      message:
        "No declared consumer is affected by the changes to these nodes. This means none are declared, or every declared consumer names only other fields of the contract; it does not mean that none exist.",
      node_ids: args.originsWithoutAffected,
    });
  }
  if (args.truncated) {
    limits.push({
      code: "FINDINGS_TRUNCATED",
      message: `The list of affected consumers is incomplete: ${args.findings} recorded, ${args.findingsOmitted} more not recorded${args.originsNotAnalyzed > 0 ? `, ${args.originsNotAnalyzed} changed node(s) not analysed` : ""}. Output limits protect the service; narrow the change to see the rest.`,
    });
  }
  if (args.changesOmitted > 0) {
    limits.push({
      code: "CHANGES_LIST_TRUNCATED",
      message: `${args.listedChanges} of ${args.listedChanges + args.changesOmitted} changes are listed; all of them were evaluated. Changes that can affect consumers are listed first.`,
    });
  }
  const noOwner = baseline.nodes.filter((n) => n.owner === null).length;
  const placeholders = baseline.nodes.filter((n) => n.placeholder).length;
  const unverified = baseline.edges.filter((e) => e.verified_at === null).length;
  if (noOwner + placeholders + unverified > 0) {
    limits.push({
      code: "BASELINE_HAS_GAPS",
      message: `The baseline declares ${noOwner} node(s) without an owner, ${placeholders} placeholder node(s) and ${unverified} unverified edge(s). Only those on an examined path affect this verdict.`,
    });
  }

  return {
    scope: "declared_manifests_only",
    baseline: { nodes: baseline.nodes.length, edges: baseline.edges.length },
    proposed: { nodes: proposed.nodes.length, edges: proposed.edges.length },
    changed_node_ids: [...new Set(args.changes.map((c) => c.node_id))].sort(compareStrings),
    origin_node_ids: args.originIds,
    nodes_examined: args.nodesExamined,
    edges_examined: args.edgesExamined,
    consumers_found: args.consumersFound,
    known: [
      `baseline ${baseline.hash} declares ${baseline.nodes.length} node(s) and ${baseline.edges.length} edge(s)`,
      `proposed ${proposed.hash} declares ${proposed.nodes.length} node(s) and ${proposed.edges.length} edge(s)`,
      `${args.changes.length} change(s) compared, ${args.propagating.length} able to affect consumers`,
      `${args.consumersFound} consumer(s) reached through declared edges`,
    ],
    limits,
    bounds: args.bounds,
  };
}
