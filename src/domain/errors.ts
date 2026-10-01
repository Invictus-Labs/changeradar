/**
 * Stable error codes shared with the API layer. `status` is the HTTP status the API layer
 * maps the code to (PRD section 6, interface contract).
 */
export const ERROR_STATUS = {
  MALFORMED_JSON: 400,
  /** The same object key appears twice in one JSON object (last-wins parsing would hide one of the values). */
  DUPLICATE_JSON_KEY: 400,
  /** Nesting depth or container count beyond what any valid document needs. */
  JSON_TOO_COMPLEX: 400,
  PAYLOAD_TOO_LARGE: 413,
  TOO_MANY_NODES: 413,
  TOO_MANY_EDGES: 413,
  UNSUPPORTED_SCHEMA_VERSION: 422,
  SCHEMA_INVALID: 422,
  SECRET_VALUE_REJECTED: 422,
  DUPLICATE_NODE_ID: 422,
  DUPLICATE_EDGE: 422,
  DUPLICATE_CONTRACT_FIELD: 422,
  DANGLING_EDGE: 422,
  CONTRACT_ON_NON_CONTRACT_NODE: 422,
  EDGE_FIELDS_ON_NON_CONTRACT_TARGET: 422,
  STALE_BASELINE: 409,
  INVALID_EXPECTED_HASH: 422,
  INVALID_RUN_TRANSITION: 409,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

/** Codes that describe a rejected manifest (the subset of ErrorCode graph building can emit). */
export type ManifestErrorCode = Exclude<
  ErrorCode,
  "STALE_BASELINE" | "INVALID_EXPECTED_HASH" | "INVALID_RUN_TRANSITION"
>;

export function statusForCode(code: ErrorCode): number {
  return ERROR_STATUS[code];
}

/** Base class for typed domain errors. Never carries secret values. */
export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly status: number;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.status = ERROR_STATUS[code];
  }
}

/** AC-05: the caller's expected_hash does not equal the hash of the stored snapshot. Maps to HTTP 409. */
export class StaleBaselineError extends DomainError {
  readonly expected_hash: string;
  readonly actual_hash: string;

  constructor(expectedHash: string, actualHash: string) {
    super(
      "STALE_BASELINE",
      "expected_hash does not match the baseline snapshot hash; re-read the snapshot and retry",
    );
    this.expected_hash = expectedHash;
    this.actual_hash = actualHash;
  }
}

/** expected_hash is not a well formed `sha256:<64 hex>` value. Maps to HTTP 422. */
export class InvalidExpectedHashError extends DomainError {
  constructor() {
    super("INVALID_EXPECTED_HASH", "expected_hash must have the form sha256:<64 lowercase hex characters>");
  }
}

/** A run state transition that the state machine forbids. Maps to HTTP 409. */
export class InvalidRunTransitionError extends DomainError {
  readonly from: string;
  readonly to: string;

  constructor(from: string, to: string) {
    super("INVALID_RUN_TRANSITION", `run cannot move from ${from} to ${to}`);
    this.from = from;
    this.to = to;
  }
}
