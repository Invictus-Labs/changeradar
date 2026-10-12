#!/usr/bin/env node
// Verifies that every seeded mutant of ALL THREE harnesses still matches the code: its `find` text must occur exactly
// once in its file. An instrument that no longer matches would abort a whole mutation run after the earlier mutants, and
// silently turn its guard into nothing, so this is a gate pre-step (step `mutation-instruments`) and a unit test.
//
//   node scripts/check-mutant-instruments.mjs        prints one JSON line per harness and a total; exit 0 only if 0 are broken
//   npm run mutation:check
//
// The count each harness reports is also compared with the number of `id:` entries in its source, so a mutant that the
// harness itself did not enumerate cannot go unchecked.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "..");
const HARNESSES = ["scripts/mutation-controls.mjs", "scripts/web-mutation-controls.mjs", "scripts/e2e-mutation-controls.mjs"];

let totalMutants = 0;
let totalBroken = 0;
let failed = false;
const rows = [];
for (const harness of HARNESSES) {
  const run = spawnSync(process.execPath, [join(repo, harness), "--check"], { cwd: repo, encoding: "utf8" });
  const lines = run.stdout.trim().split("\n").filter(Boolean);
  let summary = null;
  try {
    summary = JSON.parse(lines.at(-1) ?? "");
  } catch {
    /* handled below */
  }
  const declared = (readFileSync(join(repo, harness), "utf8").match(/^\s*(?:\{\s*)?id: "[^"]+"/gm) ?? []).length;
  const ok = run.status === 0 && summary !== null && summary.broken === 0 && summary.mutants === declared;
  if (!ok) {
    failed = true;
    for (const line of lines.slice(0, -1)) console.error(`  ${harness}: ${line}`);
    if (run.stderr) console.error(run.stderr.slice(0, 400));
  }
  totalMutants += summary?.mutants ?? 0;
  totalBroken += summary?.broken ?? 0;
  rows.push({ harness, mutants: summary?.mutants ?? null, declared, broken: summary?.broken ?? null, ok });
}
for (const row of rows) console.log(JSON.stringify(row));
console.log(JSON.stringify({ harnesses: HARNESSES.length, mutants: totalMutants, broken: totalBroken }));
process.exit(failed ? 1 : 0);
