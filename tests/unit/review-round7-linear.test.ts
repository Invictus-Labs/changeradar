import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Review round 7 (security P1-2, redaction.ts:12-14 promises linear time): five families of hostile text were quadratic (a resealed
 * bundle turned one into a stall of verify-bundle and restore of minutes to hours): the run after `!` or `&` read again for every
 * key, the value-first pair scan, the `#` comment in a gap, the block header after `=`, and the sticky scan at every backslash.
 * Every family is timed in a child process with a hard wall clock at 12,500 and at 200,000 characters (16 times the input): the large run may
 * cost at most 16 times the small one, and a factor of four on top absorbs noise and the floor of tiny timings.
 * Fake secrets are assembled at run time.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const probe = resolve(root, "tests/helpers/linear-probe.ts");
function child(args: string[], wallMs: number, env: Record<string, string> = {}): { status: number | null; out: string; err: string } {
  const run = spawnSync(process.execPath, ["--import", "tsx", probe, ...args], { encoding: "utf8", timeout: wallMs, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024, cwd: root, env: { ...process.env, ...env } });
  return { status: run.status, out: run.stdout, err: run.stderr };
}
const lastJson = (text: string): Record<string, any> => JSON.parse(text.trim().split("\n").filter((l) => l.startsWith("{") || l.startsWith("[")).pop() as string);

describe("R7 (linear time): the five families that were quadratic cost at most 16 times as much at 16 times the input", () => {
  const families = lastJson(child(["families"], 60_000).out) as unknown as string[];
  it("the child knows the families (control)", () => {
    expect(families.length).toBeGreaterThanOrEqual(8);
  });
  it.each(families)("%s", (family) => {
    // 200,000 leaves room under the 512 K characters above which a text that holds a %XX escape is refused whole (docs/MANIFEST.md): a
    // pass that replaces many values by the longer marker can grow the text past that bound for the next pass.
    const run = child(["scale", family, "12500", "200000"], 150_000);
    expect(run.status === 0 ? "finished" : `killed or failed within the wall clock: ${run.err.slice(-200)}`, "the child").toBe("finished");
    const { small_ms: small, large_ms: large, refused } = lastJson(run.out);
    expect(large, `12,500 characters: ${small} ms, 200,000: ${large} ms`).toBeLessThan(Math.max(small, 20) * 16 * 4);
    expect(large, "200,000 characters in absolute terms").toBeLessThan(20_000);
    expect(refused ? "the work budget gave up and hid the whole text" : "scanned", "the shape is read in linear time, not given up on").toBe("scanned");
  }, 400_000);
});

describe("R7 (termination): a chain of encoded line breaks behind a header value terminates and shows nothing", () => {
  it.each([15, 32, 64, 1000])("%i repeats", (repeats) => {
    const run = child(["chain", String(repeats)], 60_000);
    expect(run.status === 0 ? "finished" : `killed or failed within the wall clock: ${run.err.slice(-200)}`, "the child").toBe("finished");
    const { ms, shown } = lastJson(run.out);
    expect(shown, "the planted value").toBe(false);
    expect(ms, "milliseconds").toBeLessThan(10_000);
  }, 120_000);
});
