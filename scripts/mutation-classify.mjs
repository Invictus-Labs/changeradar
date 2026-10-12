// The one place that decides what a mutant run means, shared by scripts/mutation-controls.mjs and
// scripts/web-mutation-controls.mjs and unit tested (tests/unit/mutation-classify.test.ts).
//
// KILLED            at least one FAILING TEST that failed on an assertion. This is the only result that counts.
// INSTRUMENT_ERROR  the mutated code did not build or import (syntax error, missing module).
// SUSPECT           non-zero exit without a failing assertion: an import-time ReferenceError with no failing test,
//                   an unhandled error while every test passed, or a test that failed only by a thrown error.
//                   It proves nothing about the property, so it fails the run like a survivor.
// SURVIVED          the tests passed with the mutation applied.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

/**
 * An assertion that only reports a CRASHED child process (a probe that spawns `node`, whose exit status is asserted to be
 * 0): the code under test died, no property was shown to fail. Not evidence that a test noticed the mutation.
 */
// vitest prints the zero of `expect(status).toBe(0)` as `+0` (Object.is equality): `expected 1 to be +0`.
//
// The exit statuses that say "the process died" are the ones a crash produces: null (killed by a signal), 1 (node's uncaught
// exception), 70 (the CLI's own "unexpected internal error", docs/OPERATIONS.md) and 134 to 143 (128 + a fatal signal). Every
// other status is a DECISION of the program (2 bundle rejected, 64 usage, 66, 73, ...): a test that expects 0 and sees 2 has
// noticed a mutation, it is not a crash. The pattern is applied to the MATCHER part of a message only (see matcherPart).
const CRASH_STATUS = "(?:null|1|70|13[4-9]|14[0-3])";
/** Messages that say a process or the runtime died, whatever the test does. */
const CRASH_ALWAYS = new RegExp(
  [
    "heap out of memory",
    "Reached heap limit",
    "ReferenceError",
    "SIGABRT",
    "SIGSEGV",
    // The spawned CLI's entry point caught a throw: `changeradar: unexpected internal error ... this is a defect`, which vitest
    // shortens inside an expected-string: `'changeradar: unexpected internal erro…'`.
    "unexpected internal erro",
  ].join("|"),
  "m",
);
/**
 * Messages of the SHAPE of an exit status that is not a decision (`expected 1 to be +0`). They mean a crash only in a test that
 * spawns a process and asserts its status; the same words come from a count (a list length of 1 expected to be 0), which is a
 * genuine failed expectation.
 */
const CRASH_STATUS_SHAPED = new RegExp(
  [
    `expected ${CRASH_STATUS} to (?:be|equal|deeply equal) \\+?0(?![\\d.])`,
    "expected (?:70|13[4-9]|14[0-3]) to (?:be|equal|deeply equal)",
    `^Expected: \\+?0\\s+Received: ${CRASH_STATUS}\\s*$`,
    // A spawned CLI that died while loading printed a stack whose first source path is what the test received (vitest shortens it).
    "expected '(?:file://)?/[\\w.@ /-]*(?:/src/|/dist/|/scripts/|/node_modules/)[\\w.@/-]+\\.(?:ts|mjs|cjs|js)",
  ].join("|"),
  "m",
);

/**
 * True when the test file starts processes (spawnSync, execFileSync, spawn, fork, execFile, runCli), so a status-shaped message of
 * one of its tests may be a crashed child. Only a file that is read and does so counts: a report without a file name (or a file
 * that cannot be read) shows no process, and a count that happens to read `expected 1 to be +0` is a genuine failed expectation.
 */
export function startsProcesses(path) {
  if (typeof path !== "string" || path === "") return false;
  try {
    return /\b(?:spawnSync|execFileSync|execSync|execFile|spawn|fork|runCli)\s*\(/.test(readFileSync(path, "utf8"));
  } catch {
    return false;
  }
}

/** Whether a failure message of a test in a file that does (`processes`) or does not start processes is shaped like a crash. */
export const crashShaped = (matcher, processes) => CRASH_ALWAYS.test(matcher) || (processes && CRASH_STATUS_SHAPED.test(matcher));

/**
 * The part of a failure message that states the failed comparison: what follows the LAST `: expected ` (vitest prints
 * `AssertionError: <label>: expected X to be Y`), so a custom label, which is free text, can never make a genuine kill look
 * like a crash (or the reverse). A message without a label is taken whole.
 */
export function matcherPart(message) {
  const at = message.lastIndexOf(": expected ");
  return at >= 0 ? message.slice(at + 2) : message;
}

/**
 * The test runners are started detached (their own process group) so that what a run leaves behind can be ended with it: a
 * mutant that makes the code spin forever leaves a forked test worker alive after the wall-clock cap ended its parent
 * (it ran on, at full CPU, with the harness gone). Called after every run, on success too.
 * @param {number | undefined} pid the runner's process id (also its process group id)
 */
export function killProcessGroup(pid) {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    /* the group is already gone */
  }
}

/**
 * Does the module that a mutant changed still LOAD? (round 7, the load-time crash of the spawned CLI that vitest reports as a cut string: `expected 'file:///...' to be ''`,
 * which no reading of the failing test's message can tell from a failed expectation). A mutant whose module throws when it is loaded is a broken instrument, not a
 * property that a test noticed: the harness runs this probe on the mutated copy, and a probe that fails where the same probe passed on the unmutated copy is
 * INSTRUMENT_ERROR before any test runs. `src/cli.ts` runs its `main` when it is imported, so it is probed as `cli.ts --help`; every other file is imported.
 * @param {string} cwd the repository copy
 * @param {string} file the path of the mutated file, relative to it
 */
export function loadProbe(cwd, file) {
  const args = file === "src/cli.ts" ? ["--import", "tsx", "src/cli.ts", "--help"] : ["--import", "tsx", "--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(join(cwd, file)).href)})`];
  const run = spawnSync(process.execPath, args, { cwd, encoding: "utf8", timeout: 90_000, killSignal: "SIGKILL", env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" } });
  // the head of stderr: node prints the uncaught error first and a long stack after it
  return { status: run.status, stderr: String(run.stderr ?? "").replace(ANSI, "").slice(0, 500) };
}

/** The label of a mutant whose module no longer loads (null when it loads, or when the unmutated copy did not load either: the probe says nothing then). */
export const classifyLoad = (baselineStatus, mutatedStatus) => (baselineStatus === 0 && mutatedStatus !== 0 ? "INSTRUMENT_ERROR" : null);

/** The `.rejects` / `.resolves` matchers report a genuine failed expectation as a plain Error with this fixed wording. */
const MATCHER_ERROR = /^Error: promise (?:resolved|rejected) /;

/**
 * `await expect(promise).rejects.toMatchObject(...)` (and `.resolves.`) fails with a plain `Error: expected <the rejection> to match object ...`, whose first line
 * gives no sign of an assertion. What tells it apart from an error a test THREW with the same words is the frame vitest's own matcher adds to the stack:
 * `at _Assertion.__VITEST_REJECTS__` (`__VITEST_RESOLVES__`). (A real capture: tests/fixtures/classifier/real-messages.json, "rejects-tomatchobject".)
 */
const REJECTS_MATCHER = /^Error: expected [^\n]*[\s\S]*\n\s+at _Assertion\.__VITEST_(?:REJECTS|RESOLVES)__ /;

/**
 * Testing Library reports a failed LOOKUP (the element a test looks for is not there, or there are several) as its own error
 * type, not an AssertionError: it is the dominant assertion style of the web suite (`findByRole("alert")` with the alert
 * removed). `findBy*` timeouts arrive as a plain `Error` with the same wording.
 */
const LOOKUP_FAILURE = /^(?:TestingLibraryElementError|Error): (?:Unable to find|Found multiple elements)/;

/**
 * @param {number | null} status exit status of the test run
 * @param {string} output combined stdout and stderr (used for build errors and, without a report, a textual fallback)
 * @param {{ testResults?: { status?: string; assertionResults?: { status?: string; failureMessages?: string[] }[] }[] } | null} [report]
 *   the parsed vitest JSON report. With it the rule is STRUCTURAL: a mutant is KILLED only if some failing TEST failed by
 *   an AssertionError that is not crash-shaped. Without it, the output text is used (weaker, kept for callers without a report).
 */
export function classifyMutantRun(status, output, report = null) {
  const plain = output.replace(ANSI, "");
  const buildError = /SyntaxError|Transform failed|Cannot find module|ERR_MODULE_NOT_FOUND/.test(plain);
  if (report) {
    const failed = (report.testResults ?? []).flatMap((file) => (file.assertionResults ?? []).filter((t) => t.status === "failed"));
    const real = (report.testResults ?? []).flatMap((file) => {
      const processes = file.startsProcesses === true || startsProcesses(file.name);
      return (file.assertionResults ?? [])
        .filter((t) => t.status === "failed")
        .filter((t) => {
          const message = (t.failureMessages?.[0] ?? "").replace(ANSI, "");
          return (message.startsWith("AssertionError") || MATCHER_ERROR.test(message) || REJECTS_MATCHER.test(message) || LOOKUP_FAILURE.test(message)) && !crashShaped(matcherPart(message), processes);
        });
    });
    const killed = status !== 0 && !buildError && real.length > 0;
    const suspect = !killed && status !== 0 && !buildError;
    return { result: killed ? "KILLED" : buildError ? "INSTRUMENT_ERROR" : suspect ? "SUSPECT" : "SURVIVED", failedTests: failed.length };
  }
  // No test report: nothing proves that a test failed by an assertion (a crash can print a summary line, and so can any
  // text), so this path can never say KILLED. A non-zero exit is SUSPECT, a zero exit SURVIVED.
  const failedTests = Number((plain.match(/Tests\s+(\d+) failed/) ?? [0, 0])[1]);
  const result = buildError ? "INSTRUMENT_ERROR" : status !== 0 ? "SUSPECT" : "SURVIVED";
  return { result, failedTests };
}

/**
 * A Playwright error message that comes from a failed `expect`, recognised by its STRUCTURE and not by how it starts: with a
 * label (`expect(x, "unsupported version")`) Playwright puts the label first (`Error: unsupported version` then a blank line),
 * without one the message starts `Error: expect(received).toBe(expected)`. Either way the body holds an `expect(...)` call line
 * or the `Expected` / `Received` pair (a poll or a locator timeout adds a call log after it).
 */
export function isExpectFailure(message) {
  const text = message.replace(ANSI, "");
  // The call line is either the first line (an unlabelled expect: `Error: expect(received).toBeNull()`) or follows a blank line
  // (a labelled one): an `expect(` line in the middle of a message that a helper THREW is not a failed expectation.
  // (round 7) The call line only counts when Playwright's own block follows it (`Locator:`, `Expected`, `Received`, `Call log:`, `Timeout:`): an error that
  // a helper THREW with a blank line and then an `expect(...)` line of its own text is not a failed expectation.
  return /(?:^|\n\n)(?:Error: )?expect\(.*\)\.[^\n]*\n\n?(?:Locator:|Expected|Received|Call log:|Timeout:|- Expected|\+ Received)/.test(text);
  // (round 7, repaired) Nothing else counts. An `Expected:` / `Received:` pair on ANY line (the earlier second alternative, with `m` anchors) also matched an
  // error that a helper THREW (`new Error("bad\nExpected: 1\nReceived: 2")`): every real Playwright expect failure (fixtures/classifier/real-messages.json) carries
  // the `expect(` call line, at the start of the message or behind a blank line, so the structure above is necessary as well as sufficient.
}

/**
 * Playwright's JSON report reshaped like the vitest one, so the e2e harness uses the same structural rule. A failed test
 * counts as an assertion failure only when its first error is an `expect(...)` failure (see isExpectFailure; a labelled expect
 * and an expect timeout on a locator or a poll count); a page or navigation error, a crashed server, a thrown error and a
 * whole-test timeout are not assertions.
 */
export function playwrightToReport(json) {
  const failures = [];
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        const results = test.results ?? [];
        const last = results[results.length - 1];
        const ok = test.status === "expected" || test.status === "skipped" || last?.status === "passed";
        const message = String(last?.error?.message ?? last?.errors?.[0]?.message ?? "").replace(ANSI, "");
        failures.push({ status: ok ? "passed" : "failed", failureMessages: ok ? [] : [isExpectFailure(message) ? `AssertionError: ${message}` : message] });
      }
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of json?.suites ?? []) walk(suite);
  // The browser suite drives a spawned server and CLI: an exit-status-shaped message there is read as a crashed child.
  return { testResults: [{ startsProcesses: true, assertionResults: failures }] };
}
