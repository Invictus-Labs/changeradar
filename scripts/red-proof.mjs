#!/usr/bin/env node
// Red-before evidence, reproducibly (the regression-evidence rule of the remediation rounds).
//
//   node scripts/red-proof.mjs [--round 2|3|4|5|6|7] [--base SHA] [--json OUT] [--plan] [test files...]
//
// For the immutable pre-fix commit (default: a37dd69ddc0348be1c4c72011fc48e7947e56c36 for round 2, 5ebd5ba0b424de1794a16c88f4b2849777e13739
// for `--round 3`) it extracts a pristine tree with
// `git archive`, copies ONLY the new test files of that round (and the few new test helpers) into it, adds the smallest shims
// for the exports the old tree lacks (an identity `neutralize`, a pass-through `redactIdentifier`, `ENGINE_VERSION = 1`
// and so on, each modelling "the old behaviour") so that a test can fail BY ASSERTION instead of by an import error,
// runs vitest with the JSON reporter and classifies every failing test:
//   assertion  the test failed on an AssertionError: this IS red evidence
//   other      a TypeError, timeout, crash or import error: NOT red evidence
// Suites that cannot load are reported as such. Tests that hang the old tree (a FIFO read blocks the whole process) are
// excluded and listed as not available. The fixed tree is then run the same way for GREEN. Scratch is created under
// the OS temp dir and removed.
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
// --round 2 (default): the round-2 tests against a37dd69. --round 3: the round-3 tests against 5ebd5ba, the revision the
// third review read (its own shims and fixture, see ROUND3 below).
const ROUND = flag("--round") ?? "2";
if (!["2", "3", "4", "5", "6", "7"].includes(ROUND)) {
  console.error("usage: node scripts/red-proof.mjs [--round 2|3|4|5|6|7] [--base SHA] [--json OUT] [--plan] [test files...]");
  process.exit(64);
}
const BASE =
  flag("--base") ??
  (ROUND === "7"
    ? "08e28a63c399baa9e0de9cdb97b3a4df7ee5d974"
    : ROUND === "6"
    ? "201e61474149b8e9d9957e1cea3cfb6d8b5fd515"
    : ROUND === "5"
    ? "435731edb27cc8ba6dc94752f2a573185452ebe7"
    : ROUND === "4"
      ? "a6c91dbfe937a257ee42410e0a21c70f44fd3fd6"
      : ROUND === "3"
        ? "5ebd5ba0b424de1794a16c88f4b2849777e13739"
        : "a37dd69ddc0348be1c4c72011fc48e7947e56c36");

// --round 4: the round-4 tests against a6c91db, the revision the fourth review read.
const ROUND4_TESTS = [
  "tests/unit/review-round4-redaction.test.ts",
  "tests/unit/review-round4-pins.test.ts",
  "tests/unit/review-round4-rate-limit.test.ts",
  "tests/unit/review-round4-logic.test.ts",
  "tests/unit/review-round3-crosscheck.test.ts",
  "tests/unit/mutation-classify.test.ts",
  "tests/unit/mutation-instruments.test.ts",
  "tests/integration/review-round4-export-cap.test.ts",
  "tests/integration/review-round4-stale.test.ts",
  "tests/integration/review-round4-cursors.test.ts",
  "tests/integration/review-round4-evidence.test.ts",
  "tests/integration/review-round4-restore-caps.test.ts",
  "tests/integration/review-round4-audit.test.ts",
  "tests/integration/review-round4-cli.test.ts",
  "tests/integration/review-round4-pins.test.ts",
  "tests/integration/review-round4-sweep.test.ts",
  "tests/integration/review-round4-runview.test.ts",
];

// --round 5: the round-5 tests against 435731e, the revision the fifth review read. The web suite (a separate vitest configuration)
// and the real single-mutant harness runs are not part of this profile, and no test that starts a mutation harness is listed.
const ROUND5_TESTS = [
  "tests/unit/review-round5-redaction.test.ts",
  "tests/unit/review-round5-pins.test.ts",
  "tests/unit/review-round5-rate-limit.test.ts",
  "tests/unit/mutation-classify.test.ts",
  "tests/unit/ac-matrix-ids.test.ts",
  "tests/integration/review-round5-derived-text.test.ts",
  "tests/integration/review-round5-stale-bundle.test.ts",
  "tests/integration/review-round5-restore.test.ts",
  "tests/integration/review-round5-pins.test.ts",
  "tests/integration/review-round5-sweep.test.ts",
  "tests/integration/review-round4-runview.test.ts",
];
// --round 6: the round-6 tests against 201e614, the revision the sixth review read. The KNOWN LIMIT pins pass on the old tree by design
// (authored-only: they pin what stays unredacted), and the tests that import the classifier's new names run against a shim.
const ROUND6_TESTS = [
  "tests/unit/review-round6-no-leak.test.ts",
  "tests/unit/review-round6-security.test.ts",
  "tests/unit/review-round6-known-limits.test.ts",
  "tests/unit/review-round6-rate-limit.test.ts",
  "tests/unit/mutation-classify-context.test.ts",
  "tests/unit/ac-matrix-ids.test.ts",
  "tests/integration/review-round6-bundle-bounds.test.ts",
  "tests/integration/review-round6-cap-after-redaction.test.ts",
  "tests/integration/review-round6-legacy-manifests.test.ts",
  "tests/integration/review-round5-derived-text.test.ts",
  // (round 7, test review P3: three files whose red tests the profile had left out)
  "tests/unit/review-round6-rules.test.ts",
  "tests/unit/review-round5-robustness.test.ts",
  "tests/integration/review-round4-stale.test.ts",
];
// --round 7: the round-7 tests against 08e28a6, the revision the seventh review read. The KNOWN LIMIT pins of review-round7-pins pass on the
// old tree by design, and the tests that import the comparison bound of verification run against a shim (the old tree has no such bound).
const ROUND7_TESTS = [
  "tests/unit/review-round7-pins.test.ts",
  "tests/unit/review-round7-shapes.test.ts",
  "tests/unit/review-round7-security.test.ts",
  "tests/unit/review-round7-linear.test.ts",
  "tests/unit/review-round7-budget.test.ts",
  "tests/unit/review-round6-known-limits.test.ts",
  "tests/unit/review-round5-redaction.test.ts",
  "tests/unit/ssrf.test.ts",
  "tests/integration/review-round7-logic.test.ts",
  "tests/integration/review-round7-bounds.test.ts",
  "tests/integration/review-round7-outbox.test.ts",
  "tests/integration/review-round7-stale-findings.test.ts",
];
const jsonOut = flag("--json");
const positional = args.filter((a, i) => !a.startsWith("--") && !["--base", "--json", "--round"].includes(args[i - 1] ?? ""));

const ROUND3_TESTS = [
  "tests/unit/review-round3-redaction.test.ts",
  "tests/unit/review-round3-logic.test.ts",
  "tests/unit/review-round3-unknowns-view.test.ts",
  "tests/unit/review-round3-crosscheck.test.ts",
  "tests/unit/mutation-classify.test.ts",
  "tests/integration/review-round3-evidence.test.ts",
  "tests/integration/review-round3-api.test.ts",
  "tests/integration/review-round3-cli.test.ts",
  "tests/integration/export-restore.test.ts",
];

const DEFAULT_TESTS = [
  "tests/unit/review-round2-logic.test.ts",
  "tests/unit/review-round2-redaction.test.ts",
  "tests/unit/review-round2-platform.test.ts",
  "tests/unit/review-round2-truncation.test.ts",
  "tests/integration/review-round2-evidence.test.ts",
  "tests/integration/review-round2-cli.test.ts",
  "tests/integration/review-round2-server.test.ts",
  "tests/integration/review-round2-contract.test.ts",
  "tests/unit/api-responses.test.ts",
];
const tests = positional.length > 0 ? positional : ROUND === "7" ? ROUND7_TESTS : ROUND === "6" ? ROUND6_TESTS : ROUND === "5" ? ROUND5_TESTS : ROUND === "4" ? ROUND4_TESTS : ROUND === "3" ? ROUND3_TESTS : DEFAULT_TESTS;

/** Files copied from the fixed tree into the old tree unchanged (test helpers, schema definitions and fixtures, not behaviour). */
const COPIED = ROUND === "7" ? ["tests/helpers/linear-probe.ts", "tests/helpers/verify-probe.ts", "tests/fixtures/redaction-no-leak/seed-6151.json", "tests/fixtures/redaction-no-leak/seed-7207.json", "tests/fixtures/redaction-no-leak/seed-9931.json", "tests/fixtures/redaction-no-leak/seed-4242.json", "tests/fixtures/redaction-no-leak/reported.json", "tests/fixtures/upgrade/engine1-bundle.json", "src/domain/api-responses.ts", "schemas/api-responses.json"] : ROUND === "6" ? ["tests/fixtures/redaction-no-leak/seed-6151.json", "tests/fixtures/redaction-no-leak/seed-7207.json", "tests/fixtures/redaction-no-leak/seed-9931.json", "tests/fixtures/redaction-no-leak/seed-4242.json", "tests/fixtures/redaction-no-leak/reported.json"] : ROUND === "5" ? ["tests/fixtures/classifier/real-messages.json"] : ROUND === "4" ? [] : ROUND === "3" ? ["tests/fixtures/upgrade/engine1-bundle.json", "tests/helpers/redact-probe.ts"] : ["tests/helpers/redact-probe.ts", "src/domain/api-responses.ts", "schemas/api-responses.json"];

/** Shims appended to old-tree files: each models the OLD behaviour so the new tests fail by assertion. */
const SHIMS =
  ROUND === "7"
    ? {
        // 08e28a6: a text is compared uncut and unbounded, and a cut may split a surrogate pair. (Evidence class: SHIM-DEPENDENT for the
        // tests that import these names; the others fail by assertion on the old code.)
        // The old redactor has no work budget: the setter exists only so that the probe can call it (and then the budget tests fail by assertion).
        "src/domain/redaction.ts": "export const setWorkBudget = (_perChar: number, _floor: number): void => {};\n",
        "src/domain/derived-text.ts": "export const COMPARE_BOUND = 8000;\nexport const boundText = (text: string): string => text;\nexport const boundLeaves = (value: unknown): unknown => value;\nexport const exceedsBound = (): boolean => false;\n",
      }
    : ROUND === "6"
    ? {
        // 201e614: the classifier reads an exit-status-shaped message as a crash in every file. (Evidence class: SHIM-DEPENDENT for the
        // tests that import these names; the shim states the old rule.)
        "scripts/mutation-classify.mjs": "export const startsProcesses = () => true;\nexport const crashShaped = () => false;\n",
      }
    : ROUND === "5"
    ? {
        // 435731e: the classifier reads the whole message (labels included) and recognises a Playwright expect by its prefix, and its
        // runners are not detached. (Evidence class: SHIM-DEPENDENT for the tests that import these names; every other test
        // fails by assertion on the old code.)
        "scripts/mutation-classify.mjs":
          "export const matcherPart = (message) => message;\nexport const isExpectFailure = (message) => /^(?:Error: )?expect\\(/.test(message.trimStart());\nexport const killProcessGroup = () => {};\n",
      }
    : ROUND === "4"
    ? {
        // a6c91db: a database data exception is not recognised, an address is its own key, and the classifier has no Playwright reader.
        // (Evidence class: SHIM-DEPENDENT for the tests that import these names; every other test fails by assertion on the old code.)
        "src/platform/errors.ts": "export const isDataException = (_error: unknown): boolean => false;\n",
        "src/platform/rate-limit.ts": "export const addressKey = (ip: string): string => ip;\n",
        "scripts/mutation-classify.mjs": "export const playwrightToReport = () => ({ testResults: [] });\n",
        // The single predicate is a refactor: the old code decided the same thing in two places, so this shim states that rule and the
        // tests that pin the predicate PASS on the old tree (guarded by the r4-stale-predicate mutants, not by a red proof).
        "src/services/assess.ts": "export const isStaleEngineRun = (finished: boolean, stamp: unknown): boolean => finished && (typeof stamp === \"number\" ? stamp : 1) !== ENGINE_VERSION;\n",
      }
    : ROUND === "3"
    ? {
        // 5ebd5ba: identifier objects are not redacted, no run is reported stale, the unknowns view is the first 100 as sorted.
        "src/domain/redaction.ts": "export const redactIdentifiers = (value: unknown): unknown => value;\n",
        "src/services/evidence.ts": "export const staleEngineRuns = (_bundle: unknown): string[] => [];\n",
        "src/services/impact.ts": "export const visibleUnknowns = (all: unknown[]): unknown[] => all.slice(0, 100);\n",
      }
    : {
        "src/domain/redaction.ts": 'export const OVERSIZE_REDACTED = "[REDACTED: value too large to scan]";\nexport const redactIdentifier = (text: string): string => redactSecrets(text);\n',
        "src/services/assess.ts": "export const ENGINE_VERSION = 1;\n",
        "src/services/diff.ts": "export const usableDeclaredFields = (edge: { fields: readonly string[] | null }): readonly string[] | null => edge.fields;\n",
        "src/services/impact.ts": "export const engineOf = () => ({ version: 1, current: 1, rerun_required: false });\n",
      };
const NEW_FILES =
  ROUND === "5"
    ? // The old tree has no shared derivation cap: the constant exists only so that the tests can import it.
      { "src/domain/derived-text.ts": "export const TEXT_CAP = 2000;\n" }
    : ROUND === "3" || ROUND === "4" || ROUND === "6" || ROUND === "7"
      ? {}
      : { "src/platform/terminal-text.ts": "export const neutralize = (text: string): string => text;\n" };

/** Tests that HANG the old tree (a blocked synchronous read cannot be timed out): excluded, listed as not available. */
const EXCLUDED_NAMES = ["FIFO", "named pipe", "trickl", "stop\\(\\) closes an incomplete request"];
// [\s\S] so that a test name that contains a line break (a title built from a multi-line sample) is matched like any other.
const EXCLUDE = `^(?![\\s\\S]*(?:${EXCLUDED_NAMES.join("|")}))[\\s\\S]*$`;

if (args.includes("--plan")) {
  console.log(JSON.stringify({ base: BASE, tests, copied: COPIED, shims: Object.keys(SHIMS).concat(Object.keys(NEW_FILES)), excluded_as_hanging: EXCLUDED_NAMES }, null, 2));
  process.exit(0);
}

function run(cwd, label) {
  const out = join(cwd, `.vitest-${label}.json`);
  const res = spawnSync(process.execPath, [join(repo, "node_modules", "vitest", "vitest.mjs"), "run", ...tests, "-t", EXCLUDE, "--reporter=json", `--outputFile=${out}`], {
    cwd,
    encoding: "utf8",
    timeout: 900_000,
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", CHANGERADAR_TEST_DATABASE_URL: process.env.CHANGERADAR_TEST_DATABASE_URL ?? "" },
  });
  let json = null;
  try {
    json = JSON.parse(readFileSync(out, "utf8"));
  } catch {
    /* no report */
  }
  return { status: res.status, json, stderr: res.stderr?.slice(-600) ?? "" };
}

function classify(json) {
  const files = [];
  for (const file of json?.testResults ?? []) {
    const name = String(file.name).replace(/^.*?\/(tests\/)/, "$1");
    const failed = (file.assertionResults ?? []).filter((t) => t.status === "failed");
    const rows = failed.map((t) => {
      const message = (t.failureMessages ?? []).join("\n");
      const assertion = /AssertionError/.test(message);
      const firstLine = message.split("\n").find((l) => l.trim() !== "") ?? "";
      return { test: t.fullName, kind: assertion ? "assertion" : "other", first_line: firstLine.slice(0, 240) };
    });
    files.push({
      file: name,
      status: file.status,
      suite_error: file.status === "failed" && (file.assertionResults ?? []).length === 0 ? String(file.message ?? "").split("\n")[0].slice(0, 240) : null,
      passed: (file.assertionResults ?? []).filter((t) => t.status === "passed").length,
      failed_by_assertion: rows.filter((r) => r.kind === "assertion").length,
      failed_other: rows.filter((r) => r.kind === "other").length,
      failures: rows,
    });
  }
  return files;
}

const work = mkdtempSync(join(tmpdir(), "changeradar-redproof-"));
const summary = { base: BASE, started_utc: new Date().toISOString(), head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(), red: null, green: null, excluded_as_hanging: EXCLUDED_NAMES };
try {
  const tarball = join(work, "base.tar");
  execFileSync("git", ["archive", "--format=tar", "-o", tarball, BASE], { cwd: repo });
  const old = join(work, "old");
  mkdirSync(old);
  execFileSync("tar", ["-xf", tarball, "-C", old]);
  symlinkSync(join(repo, "node_modules"), join(old, "node_modules"), "dir");
  for (const file of [...tests, ...COPIED]) {
    if (!existsSync(join(repo, file))) continue;
    mkdirSync(dirname(join(old, file)), { recursive: true });
    copyFileSync(join(repo, file), join(old, file));
  }
  for (const [file, text] of Object.entries(SHIMS)) appendFileSync(join(old, file), `\n// red-proof shim (models the old behaviour)\n${text}`);
  for (const [file, text] of Object.entries(NEW_FILES)) {
    mkdirSync(dirname(join(old, file)), { recursive: true });
    writeFileSync(join(old, file), text);
  }
  const red = run(old, "red");
  summary.red = { status: red.status, files: classify(red.json), stderr: red.json ? "" : red.stderr };
  const green = run(repo, "green");
  summary.green = { status: green.status, files: classify(green.json), stderr: green.json ? "" : green.stderr };
  rmSync(join(repo, ".vitest-green.json"), { force: true });
} finally {
  rmSync(work, { recursive: true, force: true });
}
summary.ended_utc = new Date().toISOString();
const total = (side) => (summary[side]?.files ?? []).reduce((a, f) => ({ passed: a.passed + f.passed, assertion: a.assertion + f.failed_by_assertion, other: a.other + f.failed_other }), { passed: 0, assertion: 0, other: 0 });
summary.totals = { red: total("red"), green: total("green") };
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(summary, null, 2) + "\n");
console.log(
  JSON.stringify(
    {
      base: BASE,
      head: summary.head,
      totals: summary.totals,
      red_files: summary.red.files.map((f) => ({ file: f.file, assertion: f.failed_by_assertion, other: f.failed_other, suite_error: f.suite_error, passed: f.passed })),
      green_files: summary.green.files.map((f) => ({ file: f.file, failed: f.failed_by_assertion + f.failed_other, passed: f.passed })),
    },
    null,
    2,
  ),
);
process.exit(summary.green.status === 0 ? 0 : 1);
