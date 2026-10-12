import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error a plain .mjs script without type declarations
import { classifyLoad, classifyMutantRun, crashShaped, isExpectFailure, loadProbe, matcherPart, playwrightToReport } from "../../scripts/mutation-classify.mjs";

/**
 * Review round 7 (test review P2-c and P3): the exact boundaries of the kill rule that hand mutations of it went through, and the
 * stricter reading of a Playwright expect failure (the call line counts only when Playwright's own block follows it).
 */

describe("R7: exit statuses that mean a crashed process, exactly (a spawned probe asserting status 0)", () => {
  const shaped = (status: string): boolean => crashShaped(matcherPart(`AssertionError: the child: expected ${status} to be +0 // Object.is equality`), true);
  it.each(["null", "1", "70", "134", "135", "139", "143"])("status %s is a crash", (status) => {
    expect(shaped(status)).toBe(true);
  });
  it.each(["2", "3", "64", "66", "73", "129", "130", "133", "144", "255"])("status %s is a decision of the program, not a crash", (status) => {
    expect(shaped(status)).toBe(false);
  });
  it("the same words in a file that starts no process are a count, not a crash", () => {
    expect(crashShaped("expected 143 to be +0", false)).toBe(false);
    expect(crashShaped("expected 1 to be +0", false)).toBe(false);
  });
  it("a count above the crash range in a spawning file is still not a crash", () => {
    expect(crashShaped("expected 144 to be 1", true)).toBe(false);
    expect(crashShaped("expected 143 to be 1", true)).toBe(true);
  });
});

describe("R7: a Playwright expect failure is a call line followed by Playwright's own block", () => {
  it("the real shapes are expect failures: unlabelled, labelled, poll, locator with a call log", () => {
    expect(isExpectFailure("Error: expect(received).toBe(expected) // Object.is equality\n\nExpected: 2\nReceived: 1")).toBe(true);
    expect(isExpectFailure("Error: label\n\nexpect(received).toBe(expected) // Object.is equality\n\nExpected: 2\nReceived: 1")).toBe(true);
    expect(isExpectFailure("Error: polled value\n\npolled value\n\nexpect(received).toBe(expected) // Object.is equality\n\nExpected: 2\nReceived: 1")).toBe(true);
    expect(isExpectFailure("Error: expect(locator).toBeVisible() failed\n\nLocator: getByRole('alert')\nExpected: visible\nReceived: <element(s) not found>\nTimeout: 5000ms\n\nCall log:\n  - waiting")).toBe(true);
  });
  it("an Expected/Received pair with no expect call line is NOT an expect failure (an error that a helper threw can carry one)", () => {
    expect(isExpectFailure("Some helper: mismatch\nExpected: 1\nReceived: 2")).toBe(false);
    expect(isExpectFailure("Expected substring: a\nReceived string: b")).toBe(false);
    expect(isExpectFailure("Error: bad\n\nExpected: 1\nReceived: 2")).toBe(false);
    expect(isExpectFailure("Expected: 1")).toBe(false);
    expect(isExpectFailure("Received: 2")).toBe(false);
  });
  it("an error that a helper threw, with a blank line and an expect line of its own text, is not", () => {
    expect(isExpectFailure("Error: helper failed\n\nexpect(page).toHaveURL() was never called")).toBe(false);
    expect(isExpectFailure("Error: boom\n\nexpect(x).y()\nsee the log")).toBe(false);
    expect(isExpectFailure("Error: my label")).toBe(false);
  });
});

/** The messages below are REAL captures (Playwright 1.63 JSON reporter and vitest 5.0.2 JSON reporter, see tests/fixtures/classifier/real-messages.json). */
const here = dirname(fileURLToPath(import.meta.url));
const real = JSON.parse(readFileSync(resolve(here, "../fixtures/classifier/real-messages.json"), "utf8")) as { vitest: Record<string, string>; playwright: Record<string, string> };
const playwrightVerdict = (message: string): string => {
  const json = { suites: [{ specs: [{ tests: [{ status: "unexpected", results: [{ status: "failed", error: { message } }] }] }], suites: [] }] };
  return classifyMutantRun(1, "", playwrightToReport(json)).result;
};
const vitestVerdict = (message: string, file = ""): string => classifyMutantRun(1, "", { testResults: [{ name: file, assertionResults: [{ status: "failed", failureMessages: [message] }] }] }).result;

describe("R7 (repaired): an error THROWN with Expected/Received or expect-looking lines is not an assertion (real captures)", () => {
  it("Playwright: the four thrown shapes and the whole-test timeout are SUSPECT, the real expects are KILLED", () => {
    for (const name of ["thrown-blank-line-expect-line", "thrown-expected-received-one-newline", "thrown-expected-received-blank-line", "helper-threw-expect-line", "thrown-error", "whole-test-timeout"]) {
      expect(playwrightVerdict(real.playwright[name] as string), name).toBe("SUSPECT");
    }
    for (const name of ["unlabelled-tobe", "labelled-tobe", "poll-timeout", "unlabelled-tobenull", "unlabelled-toequal", "unlabelled-tothrow", "labelled-contain"]) {
      expect(playwrightVerdict(real.playwright[name] as string), name).toBe("KILLED");
    }
  });
  it("vitest: a failed `.rejects.toMatchObject` (a plain Error that starts `Error: expected`, with vitest's own matcher frame) is a KILL; an error a helper threw with the same words is not (real capture)", () => {
    expect(vitestVerdict(real.vitest["rejects-tomatchobject"] as string)).toBe("KILLED");
    expect(vitestVerdict(real.vitest["thrown-expected-words"] as string)).toBe("SUSPECT");
  });
  it("vitest: a message thrown by a helper (first line is not AssertionError) is SUSPECT however many Expected/Received lines it holds", () => {
    expect(vitestVerdict(real.vitest["thrown-expected-received"] as string)).toBe("SUSPECT");
    expect(vitestVerdict("Error: AssertionError: nested\nExpected: 1\nReceived: 2")).toBe("SUSPECT");
    expect(vitestVerdict("Error: bad\nAssertionError: expected 1 to be 2")).toBe("SUSPECT");
  });
  it("vitest: the exit status of a program that died while loading, read from a spawning file, is SUSPECT; the same text from a file that spawns nothing is a count (KILLED)", () => {
    expect(vitestVerdict(real.vitest["load-time-crash-status"] as string, resolve(here, "review-round7-linear.test.ts")), "a spawning file").toBe("SUSPECT");
    expect(vitestVerdict(real.vitest["load-time-crash-status"] as string, resolve(here, "review-round7-classifier.test.ts")), "a file that starts no process").toBe("KILLED");
  });
});

describe("R7 (repaired): a mutant whose module does not load is INSTRUMENT_ERROR before any test runs (the cut stderr of a crashed CLI reads as an assertion)", () => {
  it("the classifier alone reads the cut stderr of a crashed program as a KILL: the real capture (this is why the load is probed)", () => {
    expect(vitestVerdict(real.vitest["load-time-crash-stderr-cut"] as string, resolve(here, "review-round7-linear.test.ts"))).toBe("KILLED");
  });
  it("classifyLoad: only a module that loaded unmutated and does not load mutated is a broken instrument", () => {
    expect(classifyLoad(0, 1)).toBe("INSTRUMENT_ERROR");
    expect(classifyLoad(0, null)).toBe("INSTRUMENT_ERROR");
    expect(classifyLoad(0, 0)).toBeNull();
    expect(classifyLoad(1, 1)).toBeNull();
    expect(classifyLoad(null, 1)).toBeNull();
  });
  it("loadProbe on a copy: a module that throws at its top level fails, a sound one passes, and a missing one fails", () => {
    const copy = mkdtempSync(join(tmpdir(), "changeradar-loadprobe-"));
    try {
      symlinkSync(resolve(here, "..", "..", "node_modules"), join(copy, "node_modules"), "dir");
      mkdirSync(join(copy, "src"));
      writeFileSync(join(copy, "src", "sound.ts"), "export const answer: number = 42;\n");
      writeFileSync(join(copy, "src", "planted.ts"), "export const answer: number = 42;\nthrow new ReferenceError('planted is not defined');\n");
      expect(loadProbe(copy, "src/sound.ts").status).toBe(0);
      const crashed = loadProbe(copy, "src/planted.ts");
      expect(crashed.status, "a module that throws when it loads").not.toBe(0);
      expect(crashed.stderr).toContain("planted is not defined");
      expect(loadProbe(copy, "src/missing.ts").status, "a module that is not there").not.toBe(0);
      expect(classifyLoad(loadProbe(copy, "src/sound.ts").status, crashed.status)).toBe("INSTRUMENT_ERROR");
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  }, 120_000);
});
