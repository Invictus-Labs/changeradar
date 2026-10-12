import { InvalidRunTransitionError } from "./errors.js";
import type { RunStatus } from "./types.js";

/**
 * Impact run state machine. COMPLETE describes computation, not safety: the assessment inside a
 * COMPLETE run may still be AFFECTED or INCOMPLETE.
 *
 * QUEUED -> RUNNING -> COMPLETE | FAILED, plus two operational edges:
 * - RUNNING -> QUEUED: a worker lease expired and the job is reclaimed (assessment is pure, so re-running is safe).
 * - QUEUED -> FAILED: rejected before it started (for example the baseline went stale).
 * COMPLETE and FAILED are terminal.
 */
const TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  QUEUED: ["RUNNING", "FAILED"],
  RUNNING: ["COMPLETE", "FAILED", "QUEUED"],
  COMPLETE: [],
  FAILED: [],
};

export const RUN_STATUSES: readonly RunStatus[] = ["QUEUED", "RUNNING", "COMPLETE", "FAILED"];

export function isTerminal(status: RunStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

export function canTransition(from: RunStatus, to: RunStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Returns `to` when the transition is legal, otherwise throws InvalidRunTransitionError (HTTP 409). */
export function transition(from: RunStatus, to: RunStatus): RunStatus {
  if (!canTransition(from, to)) throw new InvalidRunTransitionError(from, to);
  return to;
}
