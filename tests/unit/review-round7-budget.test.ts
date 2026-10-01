import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Review round 7 (security P1-2, the structural ruling): a per-call WORK BUDGET makes the scanner fail closed. When the counted
 * steps of one call exceed 64 per input character (plus a floor), the text is hidden WHOLE (the fixed marker replaces it) and
 * never shown in part, so no future quadratic shape can stall a caller. The budget is forced tiny here (in a child process, so the
 * setting cannot leak into another test); at the default a text of about 1 MiB of ordinary words is scanned in full.
 * Fake secrets are assembled at run time.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const probe = resolve(root, "tests/helpers/linear-probe.ts");
function child(args: string[]): { status: number | null; out: string; err: string } {
  const run = spawnSync(process.execPath, ["--import", "tsx", probe, ...args], { encoding: "utf8", timeout: 120_000, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024, cwd: root });
  return { status: run.status, out: run.stdout, err: run.stderr };
}
const lastJson = (text: string): Record<string, any> => JSON.parse(text.trim().split("\n").filter((l) => l.startsWith("{") || l.startsWith("[")).pop() as string);

describe("R7 (work budget): a call that exceeds its budget hides the whole text and shows none of it", () => {
  it.each([
    [200, 0, 50],
    [2000, 0, 100],
    [20000, 0, 1000],
  ])("%i hostile units with %i steps per character and a floor of %i", (units, perChar, floor) => {
    const run = child(["budget", String(units), String(perChar), String(floor)]);
    expect(run.status, `the child finished: ${run.err.slice(-200)}`).toBe(0);
    const result = lastJson(run.out);
    expect(result.shown, "the planted value").toBe(false);
    expect(result.hidden_whole, "the whole text is replaced by the marker").toBe(true);
    expect(result.stable, "redacting the hidden text again (tiny and default budget) changes nothing").toBe(true);
    expect(result.kinds, "the import validator's detector refuses the text (it never says 'nothing found')").toEqual(["oversize"]);
    expect(result.contains, "containsSecret").toBe(true);
    expect(result.deep, "redactDeep hides the whole text").toBe(true);
    expect(result.identifier, "redactIdentifier hides the whole text").toBe(true);
  }, 200_000);

  it("the memoised reads keep no state between calls: the result of a text does not depend on the texts scanned before it", () => {
    const run = child(["consecutive"]);
    expect(run.status === 0 ? "finished" : `failed: ${run.err.slice(-200)}`, "the child").toBe("finished");
    const result = lastJson(run.out);
    expect(result.same, "the same texts in another order give the same outputs").toBe(true);
    expect(result.none_shown, "the planted value").toBe(true);
    expect(result.interleaved_none_shown, "texts scanned one behind the other (one text is the previous one plus its own)").toBe(true);
  }, 200_000);

  it("at the default budget an ordinary text of about 1 MiB is scanned in full: its secret is hidden and the rest is kept", () => {
    const run = child(["budget-default", "1048576"]);
    expect(run.status, `the child finished: ${run.err.slice(-200)}`).toBe(0);
    const result = lastJson(run.out);
    expect(result.shown).toBe(false);
    expect(result.hidden_whole, "not refused").toBe(false);
    expect(result.kept, "the ordinary words are still there").toBe(true);
  }, 200_000);
});
