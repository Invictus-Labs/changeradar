import type { Clock } from "./clock.js";
import { redactSecrets } from "./redaction.js";

/**
 * Read-only contract check model (AC-06). The pure part lives here: definitions, result states and a
 * timeout wrapper. The network implementation of ContractCheckRunner belongs to stage B.
 *
 * Invariant: only a runner that explicitly reports PASSED yields PASSED. Timeouts, thrown errors,
 * malformed outcomes and invalid definitions can never become PASSED.
 */

export const CHECK_STATES = ["PASSED", "FAILED", "TIMED_OUT", "ERROR", "UNKNOWN"] as const;
export type CheckState = (typeof CHECK_STATES)[number];

export interface ContractCheckDefinition {
  /** Stable check id (same character set as node ids). */
  readonly id: string;
  /** The contract node under check. */
  readonly node_id: string;
  readonly description: string;
  /** Per-attempt time limit in milliseconds. */
  readonly timeout_ms: number;
  /** Total attempts including the first (1..4). Only ERROR and TIMED_OUT are retried. Default 1. */
  readonly max_attempts?: number;
  /** First retry delay; doubles on every further retry (exponential backoff). Default 100 ms. */
  readonly backoff_base_ms?: number;
}

/** What a runner may report. Anything else is treated as UNKNOWN. */
export interface CheckOutcome {
  readonly state: "PASSED" | "FAILED";
  readonly detail?: string;
}

export interface CheckRunContext {
  /** Aborted when the attempt times out. Runners should stop work and release sockets. */
  readonly signal: AbortSignal;
  readonly attempt: number;
}

/**
 * Implemented by stage B (network) and by test doubles. A runner must be read-only: it may fetch
 * but never write to the system under check. `read_only` makes that promise explicit and checked.
 */
export interface ContractCheckRunner {
  readonly read_only: true;
  run(definition: ContractCheckDefinition, context: CheckRunContext): Promise<CheckOutcome>;
}

/** Timer facade so tests can drive time deterministically. */
export interface Timers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Resolves the global timer functions at call time, so fake timers installed later are honoured. */
export const realTimers: Timers = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface CheckAttempt {
  readonly attempt: number;
  readonly state: CheckState;
  readonly detail: string | null;
  readonly error_code: string | null;
}

export interface ContractCheckResult {
  readonly check_id: string;
  readonly node_id: string;
  readonly state: CheckState;
  /** Attempts actually made (0 when the definition was rejected before running). */
  readonly attempts: number;
  readonly started_at: string;
  readonly finished_at: string;
  readonly duration_ms: number;
  /** Redacted, truncated detail from the final attempt. */
  readonly detail: string | null;
  readonly error_code: "TIMEOUT" | "RUNNER_ERROR" | "UNRECOGNIZED_OUTCOME" | "INVALID_DEFINITION" | "RUNNER_NOT_READ_ONLY" | null;
  /** Append-only attempt evidence; failures are never overwritten by a later success attempt. */
  readonly attempt_log: readonly CheckAttempt[];
}

export interface RunCheckDeps {
  readonly clock: Clock;
  readonly timers?: Timers;
  /** Upper bound accepted for timeout_ms. Default 120000. */
  readonly max_timeout_ms?: number;
}

const DEFAULT_MAX_TIMEOUT_MS = 120_000;
const MAX_DETAIL_LENGTH = 500;
const CHECK_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,254}$/;

/** Returns human readable problems with a definition; empty means valid. */
export function validateCheckDefinition(
  definition: ContractCheckDefinition,
  maxTimeoutMs: number = DEFAULT_MAX_TIMEOUT_MS,
): string[] {
  const problems: string[] = [];
  if (typeof definition.id !== "string" || !CHECK_ID.test(definition.id)) problems.push("id is invalid");
  if (typeof definition.node_id !== "string" || !CHECK_ID.test(definition.node_id)) problems.push("node_id is invalid");
  if (!Number.isInteger(definition.timeout_ms) || definition.timeout_ms < 1 || definition.timeout_ms > maxTimeoutMs) {
    problems.push(`timeout_ms must be an integer between 1 and ${maxTimeoutMs}`);
  }
  const attempts = definition.max_attempts ?? 1;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 4) {
    problems.push("max_attempts must be an integer between 1 and 4");
  }
  const backoff = definition.backoff_base_ms ?? 100;
  if (!Number.isInteger(backoff) || backoff < 0 || backoff > 60_000) {
    problems.push("backoff_base_ms must be an integer between 0 and 60000");
  }
  return problems;
}

function sanitizeDetail(detail: unknown): string | null {
  if (typeof detail !== "string" || detail.length === 0) return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = redactSecrets(detail).replace(/[\u0000-\u001f\u007f]/g, " ");
  return cleaned.length > MAX_DETAIL_LENGTH ? `${cleaned.slice(0, MAX_DETAIL_LENGTH)}...` : cleaned;
}

type AttemptOutcome = { state: CheckState; detail: string | null; error_code: ContractCheckResult["error_code"] };

/**
 * Run one read-only contract check under a time limit. Never rejects and never throws: every failure
 * mode is reported as a visible non-PASSED state. A late answer after the deadline is ignored.
 */
export async function runContractCheck(
  definition: ContractCheckDefinition,
  runner: ContractCheckRunner,
  deps: RunCheckDeps,
): Promise<ContractCheckResult> {
  const timers = deps.timers ?? realTimers;
  const started = deps.clock.now();
  const finish = (
    state: CheckState,
    attempts: number,
    detail: string | null,
    errorCode: ContractCheckResult["error_code"],
    log: CheckAttempt[],
  ): ContractCheckResult => {
    const finished = deps.clock.now();
    return Object.freeze({
      check_id: String(definition.id),
      node_id: String(definition.node_id),
      state,
      attempts,
      started_at: started.toISOString(),
      finished_at: finished.toISOString(),
      duration_ms: Math.max(0, finished.getTime() - started.getTime()),
      detail,
      error_code: errorCode,
      attempt_log: Object.freeze(log),
    });
  };

  const problems = validateCheckDefinition(definition, deps.max_timeout_ms);
  if (problems.length > 0) {
    return finish("ERROR", 0, sanitizeDetail(problems.join("; ")), "INVALID_DEFINITION", []);
  }
  if (runner.read_only !== true) {
    return finish("ERROR", 0, "runner does not declare read_only", "RUNNER_NOT_READ_ONLY", []);
  }

  const maxAttempts = definition.max_attempts ?? 1;
  const backoffBase = definition.backoff_base_ms ?? 100;
  const log: CheckAttempt[] = [];
  let last: AttemptOutcome = { state: "UNKNOWN", detail: null, error_code: null };

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    last = await runAttempt(definition, runner, timers, attempt);
    log.push({ attempt, state: last.state, detail: last.detail, error_code: last.error_code });
    const retryable = last.state === "ERROR" || last.state === "TIMED_OUT";
    if (!retryable || attempt === maxAttempts) break;
    await sleep(timers, backoffBase * 2 ** (attempt - 1));
  }
  return finish(last.state, log.length, last.detail, last.error_code, log);
}

function sleep(timers: Timers, ms: number): Promise<void> {
  return new Promise((resolve) => {
    timers.setTimeout(resolve, ms);
  });
}

async function runAttempt(
  definition: ContractCheckDefinition,
  runner: ContractCheckRunner,
  timers: Timers,
  attempt: number,
): Promise<AttemptOutcome> {
  const controller = new AbortController();
  let handle: unknown;
  const deadline = new Promise<"deadline">((resolve) => {
    handle = timers.setTimeout(() => resolve("deadline"), definition.timeout_ms);
  });

  let run: Promise<{ kind: "outcome"; value: unknown } | { kind: "threw"; error: unknown }>;
  try {
    // Attach handlers immediately so a rejection after the deadline is never an unhandled rejection.
    run = Promise.resolve(runner.run(definition, { signal: controller.signal, attempt })).then(
      (value) => ({ kind: "outcome" as const, value }),
      (error: unknown) => ({ kind: "threw" as const, error }),
    );
  } catch (error) {
    timers.clearTimeout(handle);
    return runnerError(error);
  }

  const winner = await Promise.race([run, deadline]);
  timers.clearTimeout(handle);
  if (winner === "deadline") {
    controller.abort();
    return { state: "TIMED_OUT", detail: `no result within ${definition.timeout_ms} ms`, error_code: "TIMEOUT" };
  }
  if (winner.kind === "threw") return runnerError(winner.error);

  const value = winner.value as { state?: unknown; detail?: unknown } | null;
  try {
    // Reading the outcome can itself throw (a getter on a hostile runner's result): that is a runner error, and
    // runContractCheck never rejects.
    if (value !== null && typeof value === "object") {
      if (value.state === "PASSED") return { state: "PASSED", detail: sanitizeDetail(value.detail), error_code: null };
      if (value.state === "FAILED") return { state: "FAILED", detail: sanitizeDetail(value.detail), error_code: null };
    }
  } catch (error) {
    return runnerError(error);
  }
  return { state: "UNKNOWN", detail: "runner returned an unrecognized outcome", error_code: "UNRECOGNIZED_OUTCOME" };
}

function runnerError(error: unknown): AttemptOutcome {
  const message = error instanceof Error ? error.message : "runner failed";
  return { state: "ERROR", detail: sanitizeDetail(message) ?? "runner failed", error_code: "RUNNER_ERROR" };
}

export interface CheckSummary {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly timed_out: number;
  readonly error: number;
  readonly unknown: number;
  /** True only when at least one check ran and every one PASSED. */
  readonly all_passed: boolean;
}

export function summarizeChecks(results: readonly ContractCheckResult[]): CheckSummary {
  const count = (state: CheckState): number => results.filter((r) => r.state === state).length;
  const passed = count("PASSED");
  return {
    total: results.length,
    passed,
    failed: count("FAILED"),
    timed_out: count("TIMED_OUT"),
    error: count("ERROR"),
    unknown: count("UNKNOWN"),
    all_passed: results.length > 0 && passed === results.length,
  };
}
