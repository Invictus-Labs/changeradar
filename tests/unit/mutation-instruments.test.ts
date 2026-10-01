import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/**
 * Review round 4 (tests P1 x3, conformance P1): edits of the product code silently broke three seeded-mutation instruments
 * (`r3-html-stale-block`, `report-escape`, `e2e-unsupported-bundle-version-accepted`), so the mutation gate steps could not pass
 * and the guards they stood for were inert. Every mutant of ALL THREE harnesses must match its file exactly once, always.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HARNESSES = ["scripts/mutation-controls.mjs", "scripts/web-mutation-controls.mjs", "scripts/e2e-mutation-controls.mjs"];
const node = (cwd: string, args: string[]) => spawnSync(process.execPath, args, { cwd, encoding: "utf8" });

describe("every seeded mutant of every harness matches the code exactly once (gate pre-step `mutation-instruments`)", () => {
  it("scripts/check-mutant-instruments.mjs: 0 broken over all three harnesses, and each harness reports every id it declares", () => {
    const run = node(root, ["scripts/check-mutant-instruments.mjs"]);
    expect(run.status, run.stdout + run.stderr).toBe(0);
    const lines = run.stdout.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    const rows = lines.slice(0, -1);
    expect(rows.map((r) => r.harness)).toEqual(HARNESSES);
    for (const row of rows) {
      expect(row.broken, String(row.harness)).toBe(0);
      expect(row.mutants, String(row.harness)).toBe(row.declared);
      expect(row.mutants as number).toBeGreaterThan(0);
    }
    expect(lines.at(-1)).toMatchObject({ harnesses: 3, broken: 0 });
  });

  it("the gate runs it before any mutation step, and an npm script exists", () => {
    const gate = readFileSync(join(root, "scripts/verify-quality.sh"), "utf8");
    const instruments = gate.indexOf("run_step mutation-instruments");
    expect(instruments).toBeGreaterThan(0);
    expect(instruments).toBeLessThan(gate.indexOf("run_step mutation-server"));
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["mutation:check"]).toBe("node scripts/check-mutant-instruments.mjs");
  });
});

describe("the check bites: an edit of the code that one instrument matches is reported by its own harness", () => {
  const temps: string[] = [];
  afterAll(() => {
    for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  });
  /** A copy of the sources and the scripts, with one text of the code changed. */
  function drifted(file: string, from: string, to: string): string {
    const dir = mkdtempSync(join(tmpdir(), "changeradar-instruments-"));
    temps.push(dir);
    cpSync(join(root, "src"), join(dir, "src"), { recursive: true });
    cpSync(join(root, "scripts"), join(dir, "scripts"), { recursive: true });
    const path = join(dir, file);
    const text = readFileSync(path, "utf8");
    expect(text.includes(from), `${file} contains the text to drift`).toBe(true);
    writeFileSync(path, text.split(from).join(to));
    return dir;
  }

  it.each([
    ["scripts/mutation-controls.mjs", "r3-html-stale-block", "src/report/html-report.ts", "run.engine?.rerun_required", "run.engine.rerunRequired"],
    ["scripts/web-mutation-controls.mjs", "report-escape", "src/report/html-report.ts", "logText(value)", "escapeThenLog(value)"],
    ["scripts/e2e-mutation-controls.mjs", "e2e-unsupported-bundle-version-accepted", "src/services/evidence.ts", "if (version !== BUNDLE_SCHEMA_VERSION) {", "if (version != BUNDLE_SCHEMA_VERSION) {"],
  ])("%s notices the drift of %s", (harness, id, file, from, to) => {
    const dir = drifted(file, from, to);
    const run = node(dir, [harness, "--check"]);
    expect(run.status, run.stdout).toBe(1);
    expect(run.stdout).toContain(`"id":"${id}"`);
    expect(run.stdout).toContain('"occurrences":0');
    const summary = JSON.parse(run.stdout.trim().split("\n").at(-1) as string) as { broken: number };
    expect(summary.broken).toBeGreaterThanOrEqual(1);
    // The same tree, undrifted, is clean (the control).
    expect(node(root, [harness, "--check"]).status).toBe(0);
  });
});
