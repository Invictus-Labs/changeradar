/**
 * Plain-language wording shared by the static HTML report and the web UI, so both say exactly the same thing
 * about a verdict. No imports: this module is used by the server build and by the browser bundle.
 *
 * Uncertainty is never phrased as success: INCOMPLETE says it is not a safe result, and NO_KNOWN_IMPACT says
 * what it does not cover. There is deliberately no "safe", "ok" or "passed" wording for a verdict.
 */

export type Verdict = "AFFECTED" | "NO_KNOWN_IMPACT" | "INCOMPLETE";

export const VERDICTS: readonly Verdict[] = ["AFFECTED", "INCOMPLETE", "NO_KNOWN_IMPACT"];

export interface VerdictText {
  label: string;
  headline: string;
  explanation: string;
}

export const VERDICT_TEXT: Record<Verdict, VerdictText> = {
  AFFECTED: {
    label: "AFFECTED",
    headline: "Known consumers can break",
    explanation: "Declared consumers depend on what this change alters. Review each path and owner below before rolling out.",
  },
  INCOMPLETE: {
    label: "INCOMPLETE",
    headline: "Impact cannot be ruled out",
    explanation:
      "Some inputs are unknown, stale or unverified, so this is not a safe result. Resolve every unknown listed below, then assess again.",
  },
  NO_KNOWN_IMPACT: {
    label: "NO KNOWN IMPACT",
    headline: "No declared consumer is affected",
    explanation:
      "This covers only dependencies declared in the imported manifests. It does not prove that nothing else depends on the changed items; read the coverage limits below.",
  },
};

export const PENDING_TEXT = {
  label: "PENDING",
  headline: "No verdict yet",
  explanation: "The run has not finished. Complete describes computation only and is never a safety statement.",
};

export const FAILED_TEXT = {
  label: "RUN FAILED",
  headline: "No verdict was produced",
  explanation: "The run ended without an assessment. Nothing can be concluded about impact from a failed run.",
};

/** Explanations of the run error codes documented in docs/API.md. Unknown codes fall back to the raw code. */
export const RUN_ERROR_HELP: Record<string, string> = {
  WORKER_EXHAUSTED: "The job kept failing or crashing and was given up after its attempts ran out.",
  INTEGRITY_FAILURE: "Stored data no longer matches its recorded hash, so the run was refused instead of guessed at.",
  TOO_MANY_CHECKS: "More contract checks were selected than one run allows.",
  OUTPUT_TOO_LARGE: "The assessment was larger than the service allows to store, so no verdict was recorded. Narrow the change.",
  RESTORED_UNFINISHED: "The run was unfinished when a backup was restored. Request it again.",
};

/** What each contract check state means for the verdict (anything except PASSED becomes an unknown). */
export const CHECK_STATE_NOTE: Record<string, string> = {
  PASSED: "The endpoint answered as declared.",
  FAILED: "The endpoint answered wrongly. Counted as an unknown.",
  TIMED_OUT: "No answer within the limit. Counted as an unknown.",
  ERROR: "Transport failure, policy refusal or missing credential. Counted as an unknown.",
  UNKNOWN: "Interrupted by a worker restart; the outcome cannot be known and the check was not re-run. Counted as an unknown.",
  STARTED: "Still in flight.",
};

/** Explanations of assessment unknown codes (docs/DOMAIN.md, section 8). */
export const UNKNOWN_CODE_HELP: Record<string, string> = {
  MISSING_OWNER: "A node on the affected path has no owner.",
  PLACEHOLDER_NODE: "A node is a placeholder for a manifest that was never imported.",
  UNVERIFIED_CONTRACT: "A dependency edge has never been verified.",
  STALE_CONTRACT: "A dependency edge was last verified too long ago.",
  FUTURE_VERIFIED_AT: "A verification time lies in the future.",
  UNDECLARED_CONTRACT: "A contract changed but its fields are not declared in both manifests.",
  CHECK_FAILED: "A live contract check answered wrongly.",
  CHECK_TIMED_OUT: "A live contract check timed out.",
  CHECK_ERROR: "A live contract check could not run.",
  CHECK_UNKNOWN: "A live contract check was interrupted; its outcome is unknown.",
  CHECK_NOT_RUN: "A live contract check the request named was disabled or removed before it ran, so the live contract was not confirmed.",
  FINDINGS_TRUNCATED: "An output limit was reached, so the list of affected consumers is incomplete. Narrow the change to see the rest.",
  UNKNOWNS_TRUNCATED: "More unknowns exist than the list limit allows. Resolve the listed ones and assess again.",
  EDGE_FIELD_NOT_IN_CONTRACT: "A consumer edge (in the proposal or in the baseline) names a field the contract does not have: a typo or a name left over from a rename. The consumer is treated as relying on every required field.",
};

export const REDACTION_NOTE = "Text in this report is redacted for secret-like values and escaped; nothing here is executed or fetched.";

export const isVerdict = (value: unknown): value is Verdict => value === "AFFECTED" || value === "NO_KNOWN_IMPACT" || value === "INCOMPLETE";
