import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error a plain .mjs script without type declarations
import { classifyMutantRun, isExpectFailure, killProcessGroup, matcherPart, playwrightToReport } from "../../scripts/mutation-classify.mjs";

/**
 * Review round 2, test-adequacy P2 (scripts/mutation-controls.mjs:397): the kill rule. A mutant counts as killed only by a FAILING
 * TEST that failed on an assertion. Each sample below is the shape of output the reviewer's planted mutants produced.
 */
const classify = (status: number | null, output: string): { result: string; failedTests: number } => classifyMutantRun(status, output);

describe("the mutant kill rule", () => {
  it("output text alone is never enough for KILLED (round 4): with no test report a real-looking failure is SUSPECT and still reports the count", () => {
    const out = " FAIL  tests/unit/x.test.ts > a > b\nAssertionError: expected 'AFFECTED' to be 'INCOMPLETE'\n\n Test Files  1 failed (1)\n      Tests  4 failed | 20 passed (24)\n";
    expect(classify(1, out)).toEqual({ result: "SUSPECT", failedTests: 4 });
    // A crash can print exactly such a summary, so can any text.
    expect(classify(143, "Tests  3 failed | 1 passed\nAssertionError: x").result).toBe("SUSPECT");
    expect(classify(null, "Tests  3 failed | 1 passed\nAssertionError: x").result).toBe("SUSPECT");
  });

  it("an import-time ReferenceError with no failing test is SUSPECT, never KILLED (planted-undefined-identifier-at-import)", () => {
    const out = "ReferenceError: mutantTypo is not defined\n ❯ src/x.ts:3:1\n Test Files  1 failed (1)\n      Tests  no tests\n";
    expect(classify(1, out).result).toBe("SUSPECT");
  });

  it("an unhandled error while every test passed is SUSPECT (planted-async-crash-all-tests-pass)", () => {
    const out = "Error: Unhandled error during test run\nError: boom\n Test Files  1 passed (1)\n      Tests  24 passed (24)\n";
    expect(classify(1, out)).toEqual({ result: "SUSPECT", failedTests: 0 });
  });

  it("a failing test that failed only by a thrown error (no assertion) is SUSPECT", () => {
    const out = " FAIL  tests/integration/x.test.ts > a\nFetchError: connection refused\n      Tests  1 failed | 10 passed (11)\n";
    expect(classify(1, out).result).toBe("SUSPECT");
  });

  it("a syntax error or a missing module is INSTRUMENT_ERROR", () => {
    expect(classify(1, "SyntaxError: Unexpected token }\n").result).toBe("INSTRUMENT_ERROR");
    expect(classify(1, "Error: Cannot find module './gone.js'\n      Tests  3 failed (3)\nAssertionError: x\n").result).toBe("INSTRUMENT_ERROR");
  });

  it("a passing run (a comment-only mutation) SURVIVED", () => {
    expect(classify(0, " Test Files  1 passed (1)\n      Tests  24 passed (24)\n")).toEqual({ result: "SURVIVED", failedTests: 0 });
  });

  it("colour codes do not hide the failed-test count", () => {
    const out = "\u001b[31mAssertionError\u001b[39m: nope\n      Tests  \u001b[31m2 failed\u001b[39m | 3 passed (5)\n";
    expect(classify(1, out)).toEqual({ result: "SUSPECT", failedTests: 2 });
  });
});

/**
 * Round 3 (test-adequacy P2, scripts/mutation-classify.mjs:18): the rule is STRUCTURAL. With the test report in hand, a
 * mutant is killed only if some failing test failed by an AssertionError that is not the assertion of a crashed child
 * process; the word "AssertionError" appearing anywhere else in the output proves nothing.
 */
// The failing tests are those of a file that starts processes (the exit-status shape is a crash only there: classify context tests).
const SPAWNING_FILE = resolve(dirname(fileURLToPath(import.meta.url)), "review-round5-robustness.test.ts");
const report = (...failures: string[]) => ({ testResults: [{ name: SPAWNING_FILE, assertionResults: failures.map((message) => ({ status: "failed", failureMessages: [message] })) }] });
const classifyWith = (status: number | null, output: string, r: unknown): { result: string; failedTests: number } => classifyMutantRun(status, output, r);

describe("the mutant kill rule, structurally", () => {
  it("a failing test that failed by an assertion is KILLED", () => {
    expect(classifyWith(1, "", report("AssertionError: expected 'AFFECTED' to be 'INCOMPLETE'"))).toEqual({ result: "KILLED", failedTests: 1 });
  });

  it("a runtime ReferenceError in the code, seen only through the status assertion of a spawned probe, is SUSPECT", () => {
    const crashed = report("AssertionError: ReferenceError: mutantTypo is not defined\n at redactSecrets: expected 1 to be 0", "AssertionError: expected null to be 0 // Object.is equality");
    expect(classifyWith(1, "", crashed).result).toBe("SUSPECT");
  });

  it("the word AssertionError in the log of some other test does not make a thrown-error failure a kill", () => {
    const log = "stdout | some.test.ts > a passing test\nAssertionError: printed by a test that passed\n";
    expect(classifyWith(1, log, report("TypeError: x is not a function")).result).toBe("SUSPECT");
  });

  it("one real assertion next to a crash-shaped one is still a kill", () => {
    expect(classifyWith(1, "", report("AssertionError: expected 134 to be 0", "AssertionError: expected [] to deeply equal [ 'svc.x' ]")).result).toBe("KILLED");
  });

  it("a heap-out-of-memory report is a crash, not an assertion", () => {
    expect(classifyWith(1, "", report("AssertionError: FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory: expected null to be 0")).result).toBe("SUSPECT");
  });

  it("a .rejects or .resolves expectation that failed (reported by vitest as a plain Error) is a kill", () => {
    expect(classifyWith(1, "", report('Error: promise resolved "{ …(12) }" instead of rejecting\n    at _Assertion.__VITEST_REJECTS__')).result).toBe("KILLED");
    expect(classifyWith(1, "", report('Error: promise rejected "Error: boom" instead of resolving')).result).toBe("KILLED");
    expect(classifyWith(1, "", report("Error: something else entirely")).result).toBe("SUSPECT");
  });

  it("the exit-status assertion of a crashed spawned process is crash-shaped in the wording vitest really prints (`+0`), and a genuine non-zero expectation is not", () => {
    // Messages copied from a real vitest run: Object.is equality prints the zero as +0.
    for (const crashed of ["AssertionError: expected 1 to be +0 // Object.is equality", "AssertionError: expected null to be +0 // Object.is equality", "AssertionError: expected 134 to deeply equal +0", "AssertionError: expected 1 to be 0"]) {
      expect(classifyWith(1, "", report(crashed)).result, crashed).toBe("SUSPECT");
    }
    expect(classifyWith(1, "", report("AssertionError: expected 3 to be 4 // Object.is equality")).result).toBe("KILLED");
  });

  it("a Playwright JSON report goes through the same rule: an expect() failure kills, a page error, a server crash and a whole-test timeout do not", () => {
    const spec = (status: string, message: string) => ({ tests: [{ status, results: [{ status: status === "expected" ? "passed" : "failed", error: message === "" ? undefined : { message } }] }] });
    const pw = (...specs: unknown[]) => ({ suites: [{ specs, suites: [] }] });
    const killed = playwrightToReport(pw(spec("expected", ""), spec("unexpected", "Error: expect(locator).toBeVisible()\n\nLocator: getByText('x')\nExpected: visible\nReceived: <element(s) not found>")));
    expect(classifyWith(1, "", killed)).toEqual({ result: "KILLED", failedTests: 1 });
    const crashed = playwrightToReport(pw(spec("unexpected", "Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:1/"), spec("unexpected", "Test timeout of 30000ms exceeded.")));
    expect(classifyWith(1, "", crashed).result).toBe("SUSPECT");
    expect(classifyWith(0, "", playwrightToReport(pw(spec("expected", "")))).result).toBe("SURVIVED");
    // A flaky test that passed on retry is not a failure; nested suites are walked.
    const nested = { suites: [{ specs: [], suites: [{ specs: [{ tests: [{ status: "flaky", results: [{ status: "failed", error: { message: "Error: expect(a).toBe(b)" } }, { status: "passed" }] }] }] }] }] };
    expect(classifyWith(0, "", playwrightToReport(nested)).result).toBe("SURVIVED");
  });

  it("a passing report is SURVIVED and a suite that failed to load is not a kill", () => {
    expect(classifyWith(0, "", { testResults: [{ assertionResults: [{ status: "passed", failureMessages: [] }] }] }).result).toBe("SURVIVED");
    expect(classifyWith(1, "", { testResults: [{ status: "failed", assertionResults: [] }] }).result).toBe("SUSPECT");
  });
});

/**
 * Round 5 (tests P1 x3, P2): the rule over REAL captured messages (tests/fixtures/classifier/real-messages.json: vitest,
 * vitest with Testing Library, and Playwright with the JSON reporter, first error of each failing test), not over
 * hand-written imitations. Each case is what a genuine kill or a genuine crash looks like in the real text.
 */
const here = dirname(fileURLToPath(import.meta.url));
const real = JSON.parse(readFileSync(resolve(here, "../fixtures/classifier/real-messages.json"), "utf8")) as { vitest: Record<string, string>; "vitest-web": Record<string, string>; playwright: Record<string, string> };
const verdictOf = (message: string): string => classifyWith(1, "", report(message)).result;
const playwrightVerdict = (message: string): string => {
  const json = { suites: [{ specs: [{ tests: [{ status: "unexpected", results: [{ status: "failed", error: { message } }] }] }], suites: [] }] };
  return classifyWith(1, "", playwrightToReport(json)).result;
};

describe("R5: the kill rule over real vitest text", () => {
  it("a crashed child (exit 1, a signal, the CLI's internal error, status 70) is SUSPECT, with or without a label", () => {
    for (const name of ["crash-uncaught", "crash-uncaught-labelled", "signal", "exit-70", "internal-error", "crash-type-error"]) {
      expect(verdictOf(real.vitest[name] as string), name).toBe("SUSPECT");
    }
  });

  it("a decision of the program (exit 2 where 0 was expected, with a label or without), a fraction and plain assertions are KILLED", () => {
    for (const name of ["decision-exit-2", "decision-exit-2-labelled", "fraction", "plain-assertion", "labelled-assertion", "query-null"]) {
      expect(verdictOf(real.vitest[name] as string), name).toBe("KILLED");
    }
  });

  it("a custom label that itself contains crash-shaped words does not decide the class: the matcher part does", () => {
    // The label says `expected 1 to be +0 // Object.is equality`, the failed comparison is 'KILLED' against 'SUSPECT'.
    expect(verdictOf(real.vitest["label-mentions-plus-zero"] as string)).toBe("KILLED");
    // And the reverse: an ordinary label in front of a crash-shaped comparison stays a crash.
    expect(verdictOf(real.vitest["crash-uncaught-labelled"] as string)).toBe("SUSPECT");
  });

  it("matcherPart is what follows the last `: expected `", () => {
    expect(matcherPart("AssertionError: a: expected 1 to be 2: expected 3 to be 4")).toBe("expected 3 to be 4");
    expect(matcherPart("expected 1 to be 2")).toBe("expected 1 to be 2");
  });
});

describe("R5: Testing Library lookup failures are assertion failures (real vitest text)", () => {
  it("an element that is not there, found multiple times, or never appears is a KILL", () => {
    for (const [name, message] of Object.entries(real["vitest-web"])) expect(verdictOf(message), name).toBe("KILLED");
  });

  it("a TypeError thrown by the component is still not a kill", () => {
    expect(verdictOf(real.vitest["crash-type-error"] as string)).toBe("SUSPECT");
  });
});

describe("R5 (tests P3): a runner that hangs does not leave a spinning worker behind", () => {
  it("the runner's whole process group is ended, the way the harnesses end it after the wall-clock cap", () => {
    // A parent that starts a child which would run for a minute, then hangs: the same shape as a vitest run whose forked
    // worker spins after the parent was cut off by the wall-clock cap.
    const parent = "const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});process.stdout.write(String(c.pid)+'\\n');setInterval(()=>{},1000)";
    const result = spawnSync(process.execPath, ["-e", parent], { encoding: "utf8", timeout: 3000, detached: true } as Parameters<typeof spawnSync>[2]);
    const childPid = Number(String(result.stdout).trim());
    expect(Number.isInteger(childPid) && childPid > 0, `the child reported a pid: ${result.stdout}`).toBe(true);
    const alive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      expect(alive(childPid), "before: the orphan outlives the timed-out parent").toBe(true);
      killProcessGroup(result.pid);
      // The kill is asynchronous in the kernel: allow it a moment.
      const until = Date.now() + 2000;
      while (alive(childPid) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      expect(alive(childPid), "after: the group is gone").toBe(false);
    } finally {
      try {
        process.kill(childPid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  });
});

describe("R5: Playwright expect failures are recognised by structure, labelled or not (real Playwright text)", () => {
  it("a labelled expect (the label is the first line of the message) is a KILL, like an unlabelled one, a poll and a negated one", () => {
    for (const name of ["labelled-contain", "unlabelled-tobe", "labelled-tobe", "labelled-status-3-for-0", "poll-timeout", "not-contain"]) {
      expect(playwrightVerdict(real.playwright[name] as string), name).toBe("KILLED");
    }
  });

  it("a thrown error is not an expect failure, and a labelled exit status of 1 where 0 was expected is a crashed child", () => {
    expect(playwrightVerdict(real.playwright["thrown-error"] as string)).toBe("SUSPECT");
    expect(playwrightVerdict(real.playwright["labelled-status-1-for-0"] as string)).toBe("SUSPECT");
  });

  it("isExpectFailure needs an expect(...) call line or an Expected/Received pair, not a prefix", () => {
    expect(isExpectFailure("Error: my label\n\nexpect(received).toBe(expected)\n\nExpected: 1\nReceived: 2")).toBe(true);
    expect(isExpectFailure("Error: my label")).toBe(false);
    expect(isExpectFailure("Error: expect is mentioned in prose only")).toBe(false);
  });
});
