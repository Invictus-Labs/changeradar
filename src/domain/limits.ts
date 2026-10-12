/** MVP resource limits (PRD section 6: security and resource limits). */
export interface ManifestLimits {
  /** Maximum nodes per snapshot. */
  readonly max_nodes: number;
  /** Maximum edges per snapshot. */
  readonly max_edges: number;
  /** Maximum serialized manifest size in bytes (25 MB metadata cap). */
  readonly max_manifest_bytes: number;
  /** Maximum number of validation issues reported for one rejected manifest. */
  readonly max_issues: number;
}

export const DEFAULT_LIMITS: ManifestLimits = Object.freeze({
  max_nodes: 10_000,
  max_edges: 50_000,
  max_manifest_bytes: 25 * 1024 * 1024,
  max_issues: 100,
});

/** Assessment defaults. All are overridable per call. */
export interface AssessConfig {
  /** An edge whose verified_at is older than this (against the injected clock) is stale. Default 30 days. */
  readonly max_contract_age_ms: number;
  /** verified_at values further in the future than this are treated as unverifiable. Default 5 minutes. */
  readonly future_skew_ms: number;
  /**
   * Output bounds. A valid manifest can imply a quadratic number of (origin, consumer) pairs, so every part of the
   * assessment that grows with that product is capped. Reaching a cap is never silent and never safe: it records a
   * FINDINGS_TRUNCATED (or UNKNOWNS_TRUNCATED) unknown, which forces INCOMPLETE.
   */
  /** Findings recorded per run. */
  readonly max_findings: number;
  /** Findings recorded per changed origin (closest consumers first). */
  readonly max_findings_per_origin: number;
  /** Dependent links the traversals may look at, summed over all origins of one run. */
  readonly max_traversal_links: number;
  /** Serialized bytes of all recorded findings. */
  readonly max_finding_bytes: number;
  /** Distinct unknowns recorded per run. */
  readonly max_unknowns: number;
  /** Changes listed in the assessment (all changes are still evaluated). */
  readonly max_changes_listed: number;
  /** Change ids listed on one finding (the count of the rest is recorded). */
  readonly max_change_ids: number;
  /** Change descriptions quoted in one finding reason. */
  readonly max_reason_changes: number;
}

export const DEFAULT_ASSESS_CONFIG: AssessConfig = Object.freeze({
  max_contract_age_ms: 30 * 24 * 60 * 60 * 1000,
  future_skew_ms: 5 * 60 * 1000,
  max_findings: 5_000,
  max_findings_per_origin: 1_000,
  max_traversal_links: 2_000_000,
  max_finding_bytes: 16 * 1024 * 1024,
  max_unknowns: 2_000,
  max_changes_listed: 10_000,
  max_change_ids: 20,
  max_reason_changes: 3,
});

export const OUTPUT_BOUND_KEYS = [
  "max_findings",
  "max_findings_per_origin",
  "max_traversal_links",
  "max_finding_bytes",
  "max_unknowns",
  "max_changes_listed",
  "max_change_ids",
  "max_reason_changes",
] as const;

/** The output bounds an assessment was produced under. Recorded in its coverage so a bundle can re-derive it. */
export type OutputBounds = Pick<AssessConfig, (typeof OUTPUT_BOUND_KEYS)[number]>;

export function outputBoundsOf(config: AssessConfig): OutputBounds {
  const out = {} as Record<string, number>;
  for (const key of OUTPUT_BOUND_KEYS) out[key] = config[key];
  return out as OutputBounds;
}

/**
 * Read recorded bounds back from stored (untrusted) data. Every value must be a positive safe integer and is
 * clamped to the default, so verifying a bundle can never be made to do more work than a normal assessment.
 */
export function recordedBounds(value: unknown): Partial<OutputBounds> {
  const out: Partial<Record<(typeof OUTPUT_BOUND_KEYS)[number], number>> = {};
  if (typeof value !== "object" || value === null) return out;
  for (const key of OUTPUT_BOUND_KEYS) {
    const raw = (value as Record<string, unknown>)[key];
    if (typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0) out[key] = Math.min(raw, DEFAULT_ASSESS_CONFIG[key]);
  }
  return out;
}

/** Serialized assessment bytes above which the worker fails the run visibly instead of persisting it. */
export const MAX_ASSESSMENT_BYTES = 40 * 1024 * 1024;
