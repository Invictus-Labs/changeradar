import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { runCli, USAGE, type Io } from "../../src/commands/run.js";
import { BUNDLE_FORMAT, buildBundle, serializeBundle, type EvidenceBundle } from "../../src/services/evidence.js";
import { restoreBundle } from "../../src/services/restore.js";
import { createHarness } from "../helpers/harness.js";
import { UUID_ZERO } from "../helpers/ids.js";
import { baselineDoc, removeAmountDoc } from "../helpers/scenario.js";

/**
 * Review round 2 regressions for the CLI and restore (security P1 run.ts:250, P2 cli.ts:19, P2 restore.ts:42,
 * conformance P3s run.ts:470 and help output, security stdin). Each block names its finding.
 */

const CLI = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const KEY = Buffer.alloc(32, 7).toString("base64");
const scratch: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "changeradar-r2cli-"));
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
// eslint-disable-next-line no-control-regex
const RAW_CONTROL = new RegExp("[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u202a-\\u202e\\u2066-\\u2069\\u2028\\u2029]");

describe("R2 P1 (run.ts:250): text from a hostile file never reaches the terminal raw", () => {
  const hostile = "\u001b[31mRED\u001b]0;pwned-title\u0007\u009b2J‮evil";
  const file = (): string => {
    const path = join(tempDir(), "hostile.json");
    writeFileSync(path, JSON.stringify({ format: BUNDLE_FORMAT, schema_version: hostile }));
    return path;
  };
  const env = envFor(tempDir());

  it("verify-bundle: exit 2, the rejection is readable, and stdout and stderr hold no raw control or bidi character", async () => {
    const res = await cli(env, ["verify-bundle", "--in", file()]);
    expect(res.code).toBe(2);
    expect(res.err).toContain("BUNDLE_UNSUPPORTED_VERSION");
    // Round 3 (security P2, evidence.ts:342): an untrusted schema_version is now shown as a bounded, one-line JSON
    // rendering, whose escape for ESC is the JSON one (\u001b); the sanitiser still escapes anything else.
    expect(res.err).toContain("\\u001b[31mRED");
    expect(RAW_CONTROL.test(res.err)).toBe(false);
    expect(RAW_CONTROL.test(res.out)).toBe(false);
  });

  it("restore: the same", async () => {
    const res = await cli(env, ["restore", "--in", file()]);
    expect(res.code).toBe(2);
    expect(RAW_CONTROL.test(res.err)).toBe(false);
    expect(res.err).toContain("\\u{202e}");
  });

  it("operator typed arguments are escaped too (unknown flag, stray argument, bad number)", async () => {
    for (const args of [["export", "--bad\u001b[2J", "x"], ["migrate", "\u001b]0;x\u0007"], ["retention", "report", "--days", "‮5"]]) {
      const res = await cli(env, args);
      expect(res.code, res.err).toBe(64);
      expect(RAW_CONTROL.test(res.err), JSON.stringify(res.err)).toBe(false);
    }
  });

  it("--__proto__ is an unknown flag, not a silently ignored one (security P3)", async () => {
    for (const name of ["__proto__", "constructor", "toString"]) {
      const res = await cli(env, ["migrate", `--${name}`, "x"]);
      expect(res.code, name).toBe(64);
      expect(res.err, name).toContain(`--${name} is not a flag of \`changeradar migrate\``);
    }
  });

  it("the usage text itself is unchanged by the sanitiser (newlines and tabs survive)", async () => {
    const res = await cli(env, ["nonsense"]);
    expect(res.code).toBe(64);
    expect(res.err).toBe(USAGE);
  });
});

describe("R2 P3 (run.ts:470): a FIFO, device or directory is refused as bundle input, without waiting on it", () => {
  it("verify-bundle of a named pipe exits with a bundle rejection immediately", async () => {
    const dir = tempDir();
    const fifo = join(dir, "pipe.json");
    const made = spawnSync("mkfifo", [fifo]);
    expect(made.status).toBe(0);
    const started = Date.now();
    const res = await cli(envFor(dir), ["verify-bundle", "--in", fifo]);
    expect(res.code, res.err).toBe(2);
    expect(res.err).toContain("not a regular file");
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("a directory is refused the same way", async () => {
    const dir = tempDir();
    const res = await cli(envFor(dir), ["verify-bundle", "--in", dir]);
    expect(res.code, res.err).toBe(2);
    expect(res.err).toContain("not a regular file");
  });
});

describe("R2 P3 (run.ts help): asked-for help is output on stdout with exit 0; an unknown command is an error on stderr", () => {
  const env = envFor(tempDir());
  for (const args of [[], ["help"], ["--help"]]) {
    it(`changeradar ${args.join(" ")}`.trim(), async () => {
      const res = await cli(env, args);
      expect(res.code).toBe(0);
      expect(res.out).toBe(USAGE);
      expect(res.err).toBe("");
    });
  }
  it("an unknown command is 64 on stderr, stdout empty", async () => {
    const res = await cli(env, ["frobnicate"]);
    expect(res.code).toBe(64);
    expect(res.err).toBe(USAGE);
    expect(res.out).toBe("");
  });
});

describe("R2 P2 (cli.ts): standard input is capped at 64 KiB", () => {
  it("credential set with a 200 KiB stdin fails without storing anything (exit 1, says why)", async () => {
    const dir = tempDir();
    const child = spawn(process.execPath, ["--import", "tsx", CLI, "credential", "set", "--workspace-id", UUID_ZERO, "--alias", "a1"], {
      env: { ...process.env, ...envFor(dir), NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.stdin.on("error", () => undefined);
    child.stdin.end("x".repeat(200 * 1024));
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    expect(code, stderr).toBe(1);
    expect(stderr).toContain("standard input is larger than 65536 bytes");
  }, 120_000);
});

describe("R2 P2 (restore.ts, cli.ts:19): restore gives the event loop a turn between steps, so a signal is seen during it", () => {
  it("timers and immediates run while a multi-snapshot, multi-run restore is in progress", async () => {
    const src = await createHarness();
    try {
      const ws = await src.workspace("Yield source");
      const snapshots: { id: string; hash: string }[] = [];
      for (let i = 0; i < 4; i += 1) {
        const doc = baselineDoc() as { revision: string };
        doc.revision = `release-${i}`;
        const snap = await src.importSnapshot(ws.operator, doc, { revision: `release-${i}` });
        snapshots.push({ id: snap.body.id, hash: snap.body.hash });
        await src.requestRun(ws.operator, { snapshot_id: snap.body.id, proposed_manifest: removeAmountDoc(), expected_hash: snap.body.hash, run_checks: false, allow_superseded: true });
      }
      await src.drain();
      const bundle = (await buildBundle(src.db, { workspaceId: ws.id }, src.now())) as EvidenceBundle;
      const text = serializeBundle(bundle);
      const dst = await createHarness();
      try {
        let ticks = 0;
        let done = false;
        const spinner = (async () => {
          while (!done) {
            await new Promise<void>((resolve) => setImmediate(resolve));
            ticks += 1;
          }
        })();
        await restoreBundle(dst.ctx, text);
        done = true;
        await spinner;
        // One turn per snapshot and per run at least (4 + 4); the database's own asynchrony adds more.
        expect(ticks).toBeGreaterThanOrEqual(bundle.snapshots.length + bundle.impact_runs.length);
      } finally {
        await dst.close();
      }
    } finally {
      await src.close();
    }
  }, 120_000);
});
