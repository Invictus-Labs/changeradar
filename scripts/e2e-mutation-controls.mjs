#!/usr/bin/env node
// Seeded mutation controls for the END TO END suites. Each mutant removes one safety property from a disposable copy of
// the repository (never from the checkout), rebuilds it, and runs the real end-to-end project that must notice: the real
// Chromium suite for a UI and a server property, and the npm tarball suite for a persistence property. A surviving
// mutant (the suite still passes) or a build error is a failure of this script.
//
//   node scripts/e2e-mutation-controls.mjs             run every mutant
//   node scripts/e2e-mutation-controls.mjs csrf        only the mutants whose id contains the argument
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import { classifyMutantRun, killProcessGroup, playwrightToReport } from "./mutation-classify.mjs";

const repo = resolve(import.meta.dirname, "..");
const only = process.argv.slice(2).find((a) => !a.startsWith("--"));

const MUTANTS = [
  {
    id: "e2e-csrf-header-not-sent",
    property: "AC-12: the UI sends the CSRF token on every mutation (browser suite)",
    project: "browser",
    file: "src/web/api.ts",
    find: 'if (method !== "GET" && csrfToken) headers["x-csrf-token"] = csrfToken;',
    replace: "void csrfToken;",
  },
  {
    id: "e2e-stale-baseline-accepted",
    property: "AC-05: a run request against a superseded baseline is refused with 409 (browser suite, through the real UI)",
    project: "browser",
    file: "src/services/impact.ts",
    find: "if (!body.allow_superseded && current?.baseline_snapshot_id !== body.snapshot_id) {",
    replace: "if (false) {",
  },
  {
    id: "e2e-unsupported-bundle-version-accepted",
    property: "AC-10: a bundle with an unsupported schema version is refused by the installed binary with its own reason (packaged suite)",
    project: "packaged",
    file: "src/services/evidence.ts",
    find: "if (version !== BUNDLE_SCHEMA_VERSION) {",
    replace: 'if (version !== BUNDLE_SCHEMA_VERSION && (version as unknown) === "never") {',
  },
];

const selected = MUTANTS.filter((m) => !only || m.id.includes(only));
// --check: run nothing, only verify that every mutant's `find` text occurs exactly once in its file and that no id repeats.
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
const temp = mkdtempSync(join(tmpdir(), "changeradar-e2e-mutation-"));
const report = [];
const run = (cmd, args, options = {}) => spawnSync(cmd, args, { cwd: temp, encoding: "utf8", maxBuffer: 128 * 1024 * 1024, env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" }, ...options });
try {
  cpSync(repo, temp, {
    recursive: true,
    filter: (src) => {
      const rel = src.slice(repo.length + 1);
      return !["node_modules", ".git", ".claude", "coverage", "dist", "test-results", "playwright-report", ".changeradar"].some((skip) => rel === skip || rel.startsWith(`${skip}${sep}`));
    },
  });
  symlinkSync(join(repo, "node_modules"), join(temp, "node_modules"), "dir");
  const playwright = join(repo, "node_modules", "@playwright", "test", "cli.js");

  // The unmutated copy must pass first, like the other harnesses do: a suite that is already red kills every mutant for the wrong reason.
  for (const project of new Set(selected.map((m) => m.project))) {
    const built = run("npm", ["run", "build"]);
    if (built.status !== 0) throw new Error(`BASELINE_BROKEN ${project}: the build fails before any mutation`);
    const baseline = run(process.execPath, [playwright, "test", `--project=${project}`, "--reporter=list"], { timeout: 1_800_000, detached: true });
    killProcessGroup(baseline.pid);
    if (baseline.status !== 0) throw new Error(`BASELINE_BROKEN ${project}: the suite fails before any mutation: ${`${baseline.stdout}\n${baseline.stderr}`.slice(-600)}`);
  }

  for (const mutant of selected) {
    const path = join(temp, mutant.file);
    const original = readFileSync(path, "utf8");
    const occurrences = original.split(mutant.find).length - 1;
    if (occurrences !== 1) throw new Error(`INSTRUMENT_BROKEN ${mutant.id}: expected exactly one occurrence in ${mutant.file}, found ${occurrences}`);
    writeFileSync(path, original.replace(mutant.find, () => mutant.replace));
    let result = "SURVIVED";
    let detail = "";
    try {
      const build = run("npm", ["run", "build"]);
      if (build.status !== 0) {
        result = "INSTRUMENT_ERROR";
        detail = `build failed: ${(build.stdout + build.stderr).slice(-600)}`;
      } else {
        // The structural rule of the other harnesses: KILLED only by a failing test whose first error is an expect() failure,
        // read from Playwright's JSON report. A hang or a crash is SUSPECT, and a wall-clock cap ends a run that never finishes.
        const jsonFile = join(temp, ".e2e-report.json");
        rmSync(jsonFile, { force: true });
        const test = run(process.execPath, [playwright, "test", `--project=${mutant.project}`, "--reporter=list,json"], {
          timeout: 1_800_000,
          detached: true,
          env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", PLAYWRIGHT_JSON_OUTPUT_NAME: jsonFile },
        });
        killProcessGroup(test.pid);
        const output = `${test.stdout}\n${test.stderr}`;
        let report = null;
        try {
          report = playwrightToReport(JSON.parse(readFileSync(jsonFile, "utf8")));
        } catch {
          /* no report: the run crashed or was cut off before Playwright wrote one */
        }
        const verdict = classifyMutantRun(test.status, output, report);
        result = verdict.result;
        // a kill carries the text of its first failing expectation (evidence), the other labels the tail of the output
        detail = result === "KILLED" ? `${verdict.failedTests} failed: ${report?.testResults?.flatMap((f) => f.assertionResults ?? []).find((t) => t.status === "failed")?.failureMessages?.[0] ?? ""}` : output.slice(-600);
      }
    } finally {
      writeFileSync(path, original);
    }
    report.push({ id: mutant.id, property: mutant.property, project: mutant.project, result, detail: detail.slice(0, 300) });
    console.log(JSON.stringify(report.at(-1)));
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
const survivors = report.filter((r) => r.result !== "KILLED");
console.log(JSON.stringify({ mutants: report.length, killed: report.length - survivors.length, survivors: survivors.map((s) => `${s.id}:${s.result}`) }));
process.exit(survivors.length === 0 ? 0 : 1);
