import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error a plain .mjs script without type declarations
import { classifyMutantRun, crashShaped, isExpectFailure, playwrightToReport, startsProcesses } from "../../scripts/mutation-classify.mjs";

/**
 * Review round 6 (logic P2): `expected 1 to be +0` is a crashed child in a test that spawns a process and asserts its exit status,
 * and a genuine failed expectation in a test that counts something (a list of length 1 expected to be 0). The kill rule reads the
 * status shape as a crash only in a test file that starts processes.
 */

const here = dirname(fileURLToPath(import.meta.url));
const PLAIN = resolve(here, "../integration/review-round5-derived-text.test.ts");
const SPAWNS = resolve(here, "review-round5-robustness.test.ts");
const report = (file: string, message: string) => ({ testResults: [{ name: file, assertionResults: [{ status: "failed", failureMessages: [message] }] }] });
const COUNT = "AssertionError: existing edge: leaves over 2000: expected 1 to be +0 // Object.is equality";

const real = JSON.parse(readFileSync(resolve(here, "../fixtures/classifier/real-messages.json"), "utf8")) as { playwright: Record<string, string> };
const playwrightVerdict = (message: string): string => {
  const json = { suites: [{ specs: [{ tests: [{ status: "unexpected", results: [{ status: "failed", error: { message } }] }] }], suites: [] }] };
  return classifyMutantRun(1, "", playwrightToReport(json)).result;
};

describe("R6 (real Playwright text): an expect with no label and no Expected/Received pair is an assertion, a thrown line that looks like one is not", () => {
  it("toBeNull, toEqual (a diff), toBeTruthy and toThrow, unlabelled, are KILLED", () => {
    for (const name of ["unlabelled-tobenull", "unlabelled-toequal", "unlabelled-tobetruthy", "unlabelled-tothrow"]) {
      expect(playwrightVerdict(real.playwright[name] as string), name).toBe("KILLED");
    }
  });
  it("an error thrown by a helper whose message has a line starting `expect(` is SUSPECT", () => {
    expect(playwrightVerdict(real.playwright["helper-threw-expect-line"] as string)).toBe("SUSPECT");
    expect(isExpectFailure("Error: expect(received).toBeNull()\n\nReceived: 1")).toBe(true);
    expect(isExpectFailure("Error: helper failed\nexpect(page).toHaveTitle(x) was never reached")).toBe(false);
  });
});

describe("R6: the exit-status shape counts as a crash only in a file that starts processes", () => {
  it("control: the two files are what the test says they are", () => {
    expect(startsProcesses(PLAIN)).toBe(false);
    expect(startsProcesses(SPAWNS)).toBe(true);
    expect(startsProcesses(resolve(here, "no-such-file.test.ts"))).toBe(false);
    expect(startsProcesses("")).toBe(false);
    expect(startsProcesses(undefined)).toBe(false);
  });

  it("a report with no file name and a count assertion (`expected 1 to be +0`, also null and 70) is KILLED", () => {
    for (const shape of ["expected 1 to be +0", "expected null to be +0", "expected 70 to be +0"]) {
      expect(classifyMutantRun(1, "", { testResults: [{ assertionResults: [{ status: "failed", failureMessages: [`AssertionError: x: ${shape} // Object.is equality`] }] }] }).result, shape).toBe("KILLED");
    }
  });

  it("a count assertion `expected 1 to be +0` in a test file that spawns nothing KILLS", () => {
    expect(classifyMutantRun(1, "", report(PLAIN, COUNT)).result).toBe("KILLED");
  });

  it("the same message in a test file that spawns a process is a crashed child: SUSPECT", () => {
    expect(classifyMutantRun(1, "", report(SPAWNS, COUNT)).result).toBe("SUSPECT");
  });

  it("a report that says its tests start processes (the browser suite) reads the status shape as a crash", () => {
    const flagged = { testResults: [{ startsProcesses: true, assertionResults: [{ status: "failed", failureMessages: [COUNT] }] }] };
    expect(classifyMutantRun(1, "", flagged).result).toBe("SUSPECT");
  });

  it("a spawned CLI that died while loading (the failing comparison received a source path) is SUSPECT in a file that spawns", () => {
    const load = "AssertionError: expected '/private/var/folders/x/T/changeradar-cli/src/cli.ts:12:9' to contain 'standard input is larger'";
    expect(classifyMutantRun(1, "", report(SPAWNS, load)).result).toBe("SUSPECT");
  });

  it("a decision status (2) in a file that spawns processes still kills, and a crash phrase never does, in either kind of file", () => {
    expect(classifyMutantRun(1, "", report(SPAWNS, "AssertionError: the CLI: expected 2 to be +0 // Object.is equality")).result).toBe("KILLED");
    expect(classifyMutantRun(1, "", report(PLAIN, "AssertionError: ReferenceError: x is not defined")).result).toBe("SUSPECT");
    expect(crashShaped("expected null to be +0", false)).toBe(false);
    expect(crashShaped("expected null to be +0", true)).toBe(true);
    expect(crashShaped("heap out of memory", false)).toBe(true);
  });
});
