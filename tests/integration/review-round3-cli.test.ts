import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { runCli, type Io } from "../../src/commands/run.js";
import { UUID_ZERO } from "../helpers/ids.js";

/**
 * Review round 3 regression tests for the CLI: what verify-bundle and restore say about runs from an older engine and
 * about disabled checks, standard output is escaped like standard error, and the stdin cap is exact at its boundary.
 */

const here = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(here, "../../src/cli.ts");
const KEY = Buffer.alloc(32, 7).toString("base64");
const scratch: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "changeradar-r3cli-"));
  scratch.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of scratch) {
    try {
      chmodSync(dir, 0o700);
    } catch {
      /* already gone */
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
const envFor = (dir: string): NodeJS.ProcessEnv => ({ CHANGERADAR_DATABASE_URL: `pglite:${join(dir, "db")}`, CHANGERADAR_ENCRYPTION_KEY: KEY });
function capture(): { io: Io; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (m) => out.push(m), err: (m) => err.push(m), stdin: async () => "" }, out, err };
}
async function cli(env: NodeJS.ProcessEnv, args: string[]) {
  const c = capture();
  const code = await runCli(args, env, c.io);
  return { code, out: c.out.join("\n"), err: c.err.join("\n") };
}
/** The genuine bundle written by the 2cc918e build; UUIDs are stored without dashes in the fixture. */
const ENGINE1 = readFileSync(resolve(here, "../fixtures/upgrade/engine1-bundle.json"), "utf8").replace(/\b([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12})\b/g, "$1-$2-$3-$4-$5");
// eslint-disable-next-line no-control-regex
const RAW_CONTROL = new RegExp("[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f]");

describe("R3 P1 (evidence.ts:268): verify-bundle and restore say what they did with a run from an older engine", () => {
  it("verify-bundle accepts the 2cc918e bundle and reports the two stale runs; restore restores them and says how to re-run", async () => {
    const dir = tempDir();
    const file = join(dir, "engine1.json");
    writeFileSync(file, ENGINE1);
    const verified = await cli(envFor(dir), ["verify-bundle", "--in", file]);
    expect(verified.code, verified.err).toBe(0);
    expect(verified.out).toContain("bundle ok: 2 snapshot(s), 2 run(s)");
    expect(verified.out).toContain("2 finished run(s) were assessed by an older decision engine");
    const restored = await cli(envFor(dir), ["restore", "--in", file]);
    expect(restored.code, restored.err).toBe(0);
    expect(restored.out).toContain("2 finished run(s) were assessed by an older decision engine");
    expect(restored.out).toContain("request new runs");
  }, 120_000);
});

describe("R3 P1 (checks.ts:132): the restore message tells the operator the way that works", () => {
  it("names re-creating with the SAME key, not a new key", async () => {
    const dir = tempDir();
    const file = join(dir, "engine1.json");
    const bundle = JSON.parse(ENGINE1) as Record<string, any>;
    expect(bundle.contract_checks).toEqual([]);
    const text = readFileSync(resolve(here, "../../src/commands/run.ts"), "utf8");
    expect(text).toContain("with the SAME key");
    expect(text).not.toContain("re-create the ones you still want with the API");
    writeFileSync(file, ENGINE1);
  });
});

describe("R3 P3 (cli.ts): standard output is escaped like standard error", () => {
  it("a directory name with an escape character never reaches stdout raw", async () => {
    const dir = tempDir();
    const hostile = join(dir, "a\u001b[31mb");
    const res = await cli(envFor(dir), ["sample-manifests", "--out", hostile]);
    expect(res.code, res.err).toBe(0);
    expect(res.out).toContain("wrote");
    expect(RAW_CONTROL.test(res.out)).toBe(false);
    expect(res.out).toContain("\\u{1b}");
  });
});

describe("R3 P3 (cli.ts:65): the stdin cap is exactly 65,536 bytes", () => {
  function runStdin(bytes: number): Promise<{ code: number | null; stderr: string }> {
    const dir = tempDir();
    const child = spawn(process.execPath, ["--import", "tsx", CLI, "credential", "set", "--workspace-id", UUID_ZERO, "--alias", "a1"], {
      env: { ...process.env, ...envFor(dir), NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.stdin.on("error", () => undefined);
    child.stdin.end("x".repeat(bytes));
    return new Promise((resolveRun) => child.on("close", (code) => resolveRun({ code, stderr })));
  }
  it("65,536 bytes pass the cap (and are then refused as a credential value); 65,537 stop at the cap", async () => {
    const atLimit = await runStdin(65_536);
    expect(atLimit.stderr).not.toContain("standard input is larger");
    const over = await runStdin(65_537);
    expect(over.stderr).toContain("standard input is larger than 65536 bytes");
    expect(over.code).toBe(1);
  }, 180_000);
});
