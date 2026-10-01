import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Review round 7 (a cross-check by the tests review of the sibling product): the validator entry points (`detectSecretKinds`, `containsSecret`)
 * were quadratic on `-p=` repeated (64 KiB 47 ms, 256 KiB 1.1 s, 1 MiB 14 s) while `redactSecrets` and `redactDeep` stayed linear, and the work budget
 * never fired because the validator's check of a low-confidence span (a slice and a search of every span) was not counted. Every command-line
 * shape that opens a value is timed through all four entry points in a child process, as CPU time (a loaded host stretches the wall clock, not the
 * work): the text 16 times as long may cost at most 32 times as much (a linear scan costs 16 times, a quadratic one 256 times), best of three,
 * with a floor for the noise of tiny timings and an absolute cap. A second part forces the work budget tiny: the scan must give up and hide the
 * whole text, never show the value behind the repeats.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const probe = resolve(root, "tests/helpers/flag-scaling-probe.ts");
function child(args: string[], wallMs: number): { status: number | null; out: string; err: string } {
  const run = spawnSync(process.execPath, ["--import", "tsx", probe, ...args], { encoding: "utf8", timeout: wallMs, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024, cwd: root });
  return { status: run.status, out: run.stdout, err: run.stderr };
}
const lastJson = (text: string): Record<string, any> => JSON.parse(text.trim().split("\n").filter((l) => l.startsWith("{") || l.startsWith("[")).pop() as string);

const units = lastJson(child(["units"], 60_000).out) as unknown as string[];

describe("R7 (flag shapes): every entry point reads a repeated command-line shape in linear time", () => {
  it("the child knows the shapes (control)", () => {
    expect(units.length).toBeGreaterThanOrEqual(21);
    expect(units).toContain("-p=");
  });
  it.each(units.map((unit, index) => [unit, index] as const))("%j", (_unit, index) => {
    const run = child(["scale", String(index)], 150_000);
    expect(run.status === 0 ? "finished" : `killed or failed within the wall clock: ${run.err.slice(-200)}`, "the child").toBe("finished");
    const { rows } = lastJson(run.out) as { rows: Record<string, { small: number; large: number; refused: boolean }> };
    expect(Object.keys(rows).sort()).toEqual(["containsSecret", "detectSecretKinds", "redactDeep", "redactSecrets"]);
    for (const [name, { small, large, refused }] of Object.entries(rows)) {
      expect(large, `${name}: 16,384 characters ${small.toFixed(1)} ms CPU, 262,144 characters ${large.toFixed(1)} ms`).toBeLessThan(Math.max(small, 10) * 16 * 2);
      expect(large, `${name} at 262,144 characters in absolute terms`).toBeLessThan(5_000);
      expect(refused ? "the work budget gave up and hid the whole text" : "scanned", `${name}: the shape is read, not given up on`).toBe("scanned");
    }
  }, 400_000);
});

describe("R7 (flag shapes): with the work budget forced tiny a repeated flag is refused whole and the value behind it is never shown", () => {
  it.each([
    ["plain", 1000],
    ["env", 1000],
    ["secret", 1000],
  ])("%s flags, %i repeats", (kind, repeats) => {
    const run = child(["budget", kind, String(repeats)], 60_000);
    expect(run.status === 0 ? "finished" : `killed or failed: ${run.err.slice(-200)}`, "the child").toBe("finished");
    const result = lastJson(run.out);
    expect(result.kinds, "the detector says oversize (a refusal)").toEqual(["oversize"]);
    expect(result.contains, "containsSecret").toBe(true);
    expect(result.hidden_whole, "redactSecrets hides the whole text").toBe(true);
    expect(result.deep_hidden_whole, "redactDeep hides the whole text").toBe(true);
    expect(result.shown, "the planted value").toBe(false);
  }, 120_000);
});
