/** Public surface of the deterministic, database-free domain layer (frozen for stage B; see docs/DOMAIN.md). */
export * from "./domain/canonical.js";
export * from "./domain/clock.js";
export * from "./domain/contract-checks.js";
export * from "./domain/errors.js";
export * from "./domain/limits.js";
export * from "./domain/manifest.js";
// A named list, not `export *`: the test hooks of redaction.ts (`setWorkBudget`, `scanStateHoldsText`, `looksRandomAt`, `NextMark`) are not part of the surface
// (pinned by tests/unit/review-round7-barrel.test.ts).
export { containsSecret, detectSecretKinds, escapeHtml, OVERSIZE_REDACTED, REDACTED, redactDeep, redactIdentifier, redactIdentifiers, redactSecrets, safeReportText } from "./domain/redaction.js";
export * from "./domain/run-state.js";
export * from "./domain/semver.js";
export * from "./domain/types.js";
export * from "./services/assess.js";
export * from "./services/diff.js";
export * from "./services/graph.js";
