#!/usr/bin/env node
// Seeded mutation controls for the web UI and the static report (the same method as scripts/mutation-controls.mjs):
// for each mutant, run the named tests on an unmodified copy (must pass), apply ONE semantic mutation to a disposable
// copy (never to the checkout), rerun (must FAIL on assertions, not on a build error), restore, rerun (must pass).
// A surviving mutant means the tests would not notice that property being removed, and the script exits non-zero.
//
//   node scripts/web-mutation-controls.mjs             run every mutant
//   node scripts/web-mutation-controls.mjs verdict     run the mutants whose id contains the argument
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { classifyMutantRun, killProcessGroup } from "./mutation-classify.mjs";

const repo = resolve(import.meta.dirname, "..");
const only = process.argv.slice(2).find((a) => !a.startsWith("--"));
const WEB = "vitest.web.config.ts";

/** id, property removed, file, exact text (must occur exactly once), replacement, tests, vitest config (default: the server config). */
const MUTANTS = [
  {
    id: "report-escape",
    property: "AC-09: report free text is escaped and redacted (hostile strings render as text)",
    file: "src/report/html-report.ts",
    find: 'value === "" ? fallback : logText(value));',
    replace: 'value === "" ? fallback : String(value));',
    tests: ["tests/web/report-render.test.tsx"],
    config: WEB,
  },
  {
    id: "report-finding-id",
    property: "AC-07: the HTML report prints the same finding ids as the JSON export",
    file: "src/report/html-report.ts",
    find: 'data-finding-id="${escapeHtml(f.id)}"',
    replace: 'data-finding-id="${escapeHtml(f.id).toUpperCase()}"',
    tests: ["tests/web/report-render.test.tsx", "tests/web/report-service.test.ts"],
    config: WEB,
  },
  {
    id: "report-csp",
    property: "AC-09: the report carries a strict CSP (no unsafe-inline styles)",
    file: "src/report/html-report.ts",
    find: "style-src '${CSS_HASH}'; base-uri",
    replace: "style-src 'unsafe-inline'; base-uri",
    tests: ["tests/web/report-render.test.tsx"],
    config: WEB,
  },
  {
    id: "verdict-incomplete-as-noknown",
    property: "AC-04: INCOMPLETE is visibly distinct from NO_KNOWN_IMPACT",
    file: "src/web/components.tsx",
    find: 'INCOMPLETE: "incomplete", NO_KNOWN_IMPACT: "noknown" };',
    replace: 'INCOMPLETE: "noknown", NO_KNOWN_IMPACT: "noknown" };',
    tests: ["tests/web/read-pages.test.tsx"],
    config: WEB,
  },
  {
    id: "coverage-limits-hidden",
    property: "AC-04: coverage limits are always shown on a finished run",
    file: "src/web/pages/runs.tsx",
    find: "const coverage = complete ? <CoverageLimits coverage={run.coverage} stale={stale} /> : null;",
    replace: "const coverage = null;",
    tests: ["tests/web/read-pages.test.tsx"],
    config: WEB,
  },
  {
    id: "unknowns-hidden",
    property: "AC-04: every unknown is listed on an INCOMPLETE run",
    file: "src/web/pages/runs.tsx",
    find: "const unknowns = complete ? <UnknownsTable unknowns={run.unknowns} total={run.totals.unknowns} stale={stale} /> : null;",
    replace: "const unknowns = null;",
    tests: ["tests/web/read-pages.test.tsx"],
    config: WEB,
  },
  {
    id: "check-failure-looks-fine",
    property: "AC-06: a non-PASSED contract check is never styled like a pass",
    file: "src/web/pages/runs.tsx",
    find: 'c.state === "PASSED" ? "badge-neutral" : "badge-warn"',
    replace: '"badge-neutral"',
    tests: ["tests/web/states.test.tsx"],
    config: WEB,
  },
  {
    id: "csrf-header",
    property: "AC-12: every mutation from the UI carries the CSRF token",
    file: "src/web/api.ts",
    find: 'if (method !== "GET" && csrfToken) headers["x-csrf-token"] = csrfToken;',
    replace: "void csrfToken;",
    tests: ["tests/web/write-pages.test.tsx", "tests/web/units.test.tsx"],
    config: WEB,
  },
  {
    id: "viewer-mutation-controls",
    property: "AC-12: viewers get no mutation controls",
    file: "src/web/api.ts",
    find: 'export const canImport = (role: Role): boolean => role === "operator" || role === "admin";',
    replace: "export const canImport = (role: Role): boolean => Boolean(role);",
    tests: ["tests/web/read-pages.test.tsx", "tests/web/write-pages.test.tsx"],
    config: WEB,
  },
  {
    id: "not-found-leak",
    property: "AC-12: a 404 never says whether the object exists elsewhere (fixed wording)",
    file: "src/web/components.tsx",
    find: 'body: "This item does not exist, or you do not have access to it.", retry: false };',
    replace: "body: error.message, retry: false };",
    tests: ["tests/web/states.test.tsx"],
    config: WEB,
  },
  {
    id: "superseded-without-opt-in",
    property: "AC-05: a superseded snapshot is only assessed after an explicit opt-in",
    file: "src/web/pages/runs.tsx",
    find: "allow_superseded: superseded && allowSuperseded };",
    replace: "allow_superseded: superseded };",
    tests: ["tests/web/write-pages.test.tsx"],
    config: WEB,
  },
  {
    id: "idempotency-key-reuse",
    property: "a changed request body never reuses the previous Idempotency-Key",
    file: "src/web/api.ts",
    find: "if (key === null || body !== lastBody) {",
    replace: "if (key === null) {",
    tests: ["tests/web/units.test.tsx"],
    config: WEB,
  },
  {
    id: "double-click-double-append",
    property: "two clicks on 'Load more' append a page once",
    file: "src/web/hooks.ts",
    find: "if (path === null || cursor === null || fetchingMore.current) return;",
    replace: "if (path === null || cursor === null || loadingMore) return;",
    tests: ["tests/web/units.test.tsx"],
    config: WEB,
  },
  {
    id: "run-list-rerun-badge",
    property: "an older-engine run is marked 'Re-run required' in the run list, never shown as its recorded verdict",
    file: "src/web/pages/runs.tsx",
    find: "{r.rerun_required ? (",
    replace: "{false ? (",
    tests: ["tests/web/states.test.tsx"],
    config: WEB,
  },
  {
    id: "stale-banner-off",
    property: "an older-engine run gets the RE-RUN REQUIRED banner, not a verdict banner",
    file: "src/web/components.tsx",
    find: 'if (run.status === "complete" && run.engine?.rerun_required) {',
    replace: "if (false) {",
    tests: ["tests/web/states.test.tsx"],
    config: WEB,
  },
  {
    id: "stale-empty-findings-text",
    property: "the empty findings line of an older-engine run does not say that no declared consumer is affected",
    file: "src/web/pages/runs.tsx",
    find: 'if (run.engine?.rerun_required) return "As assessed by the older engine, no consumer was listed.',
    replace: 'if (false) return "As assessed by the older engine, no consumer was listed.',
    tests: ["tests/web/states.test.tsx"],
    config: WEB,
  },
  {
    id: "stale-coverage-qualified",
    property: "an older-engine run's coverage limits, known lines and examined counts are labelled as the older engine's",
    file: "src/web/components.tsx",
    find: 'const old = stale ? OLDER_ENGINE : "";',
    replace: 'const old = "";',
    tests: ["tests/web/review-round5-stale.test.tsx"],
    config: WEB,
  },
  {
    id: "stale-run-facts-labels",
    property: "an older-engine run's counts in the run facts are labelled as the older engine's",
    file: "src/web/pages/runs.tsx",
    find: '<dt>Findings{stale ? " (older engine)" : ""}</dt>',
    replace: "<dt>Findings</dt>",
    tests: ["tests/web/review-round5-stale.test.tsx"],
    config: WEB,
  },
  {
    id: "stale-unknowns-heading",
    property: "an older-engine run's unknowns heading says whose unknowns they are",
    file: "src/web/components.tsx",
    find: 'Unknowns{stale ? " as recorded by the older engine" : ""} ({total})',
    replace: "Unknowns ({total})",
    tests: ["tests/web/review-round5-stale.test.tsx"],
    config: WEB,
  },
  {
    id: "stale-findings-heading",
    property: "an older-engine run's findings heading says whose findings they are",
    file: "src/web/pages/runs.tsx",
    find: 'Affected consumers{run.engine?.rerun_required ? " as listed by the older engine" : ""} ({run.totals.findings})',
    replace: "Affected consumers ({run.totals.findings})",
    tests: ["tests/web/review-round5-stale.test.tsx"],
    config: WEB,
  },
  {
    id: "static-traversal",
    property: "the static file server never serves a file whose real path is outside the web root",
    file: "src/api/static.ts",
    find: "if (real !== realRoot && !real.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep)) return null;",
    replace: "void realRoot;",
    tests: ["tests/integration/static.test.ts"],
  },
];

const vitest = join(repo, "node_modules", "vitest", "vitest.mjs");
function runTests(cwd, tests, config) {
  // The JSON report makes the kill rule structural (per failing test); the text output is kept for build errors.
  const reportFile = join(cwd, ".mutation-report.json");
  rmSync(reportFile, { force: true });
  const result = spawnSync(process.execPath, [vitest, "run", ...(config ? ["-c", config] : []), ...tests, "--reporter=default", "--reporter=json", `--outputFile.json=${reportFile}`], {
    cwd,
    encoding: "utf8",
    timeout: 600_000,
    maxBuffer: 64 * 1024 * 1024,
    detached: true,
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
  });
  killProcessGroup(result.pid);
  let report = null;
  try {
    report = JSON.parse(readFileSync(reportFile, "utf8"));
  } catch {
    /* no report: the run crashed before vitest could write one */
  }
  return { status: result.status, output: `${result.stdout}\n${result.stderr}`, report };
}

const selected = MUTANTS.filter((m) => !only || m.id.includes(only));
// --check: run no tests, only verify that every mutant's `find` text occurs exactly once in its file and that no id repeats.
if (process.argv.includes("--check")) {
  let broken = 0;
  const seen = new Set();
  for (const mutant of selected) {
    const occurrences = readFileSync(join(repo, mutant.file), "utf8").split(mutant.find).length - 1;
    const duplicate = seen.has(mutant.id);
    seen.add(mutant.id);
    if (occurrences !== 1 || duplicate) {
      broken += 1;
      console.log(JSON.stringify({ id: mutant.id, file: mutant.file, occurrences, duplicate }));
    }
  }
  console.log(JSON.stringify({ mutants: selected.length, broken }));
  process.exit(broken === 0 ? 0 : 1);
}
const temp = mkdtempSync(join(tmpdir(), "changeradar-web-mutation-"));
const report = [];
try {
  cpSync(repo, temp, {
    recursive: true,
    filter: (src) => {
      const rel = src.slice(repo.length + 1);
      return !["node_modules", ".git", ".claude", "coverage", "dist", ".changeradar"].some((skip) => rel === skip || rel.startsWith(`${skip}${sep}`));
    },
  });
  symlinkSync(join(repo, "node_modules"), join(temp, "node_modules"), "dir");

  const baselineCache = new Map();
  for (const mutant of selected) {
    const key = `${mutant.config ?? ""}|${mutant.tests.join(",")}`;
    if (!baselineCache.has(key)) {
      const baseline = runTests(temp, mutant.tests, mutant.config);
      baselineCache.set(key, baseline.status);
      if (baseline.status !== 0) throw new Error(`baseline for ${key} must pass before mutating:\n${baseline.output.slice(-3000)}`);
    }
    const path = join(temp, mutant.file);
    const original = readFileSync(path, "utf8");
    const occurrences = original.split(mutant.find).length - 1;
    if (occurrences !== 1) throw new Error(`INSTRUMENT_BROKEN ${mutant.id}: expected exactly one occurrence in ${mutant.file}, found ${occurrences}`);
    writeFileSync(path, original.replace(mutant.find, () => mutant.replace));
    const mutated = runTests(temp, mutant.tests, mutant.config);
    writeFileSync(path, original);
    // KILLED only by a FAILING TEST that failed on an assertion; a crash with no failing test is SUSPECT (see mutation-classify.mjs).
    const { result, failedTests } = classifyMutantRun(mutated.status, mutated.output, mutated.report);
    // The first failing assertion's text is recorded for EVERY result: a kill is evidence only with its message.
    const firstFailure = mutated.report?.testResults?.flatMap((f) => f.assertionResults ?? []).find((t) => t.status === "failed")?.failureMessages?.[0]?.replace(/\u001b\[[0-9;]*m/g, "").slice(0, 300);
    report.push({ id: mutant.id, property: mutant.property, file: mutant.file, tests: mutant.tests, result, failed_tests: failedTests, ...(firstFailure ? { first_failure: firstFailure } : {}) });
    const restored = runTests(temp, mutant.tests, mutant.config);
    if (restored.status !== 0) throw new Error(`restored ${mutant.id} must pass again:\n${restored.output.slice(-3000)}`);
    console.log(JSON.stringify(report.at(-1)));
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
const survivors = report.filter((r) => r.result !== "KILLED");
console.log(JSON.stringify({ mutants: report.length, killed: report.length - survivors.length, survivors: survivors.map((s) => s.id) }));
if (survivors.length > 0 || report.length === 0) process.exit(1);
