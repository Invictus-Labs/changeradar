import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { runCli, USAGE, type Io } from "../../src/commands/run.js";
import { UUID_ONES } from "../helpers/ids.js";

/**
 * Review round 1 regressions for the CLI: interrupted one-shot commands (P1), repeated or value-less flags (P2),
 * EPIPE and unexpected errors never using the documented codes, write and read failures, and a taken port.
 */

const CLI = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const KEY = Buffer.alloc(32, 7).toString("base64");
const scratch: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "changeradar-r1cli-"));
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

const envFor = (dir: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ CHANGERADAR_DATABASE_URL: `pglite:${join(dir, "db")}`, CHANGERADAR_ENCRYPTION_KEY: KEY, ...extra });

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

describe("R1 P2: repeated, value-less, unknown and malformed flags are usage errors (run.ts:48-63)", () => {
  const env = envFor(tempDir());

  it.each([
    [["verify-bundle", "--in", "a.json", "--in", "b.json"], "more than once"],
    [["export", "--workspace-id", "X", "--workspace-id", "W", "--out", "f.json"], "more than once"],
    [["export", "--workspace-id", "W", "--run", "--out", "f.json"], "--run needs a value"],
    [["export", "--workspace-id", "W", "--out", "f.json", "--run"], "--run needs a value"],
    [["export", "--workspace-id", "W", "--out", "f.json", "--run", ""], "must not be empty"],
    [["export", "--workspace-id", "W", "--out", "f.json", "--run", "  "], "must not be empty"],
    [["export", "--wokrspace-id", "W", "--out", "f.json"], "not a flag of `changeradar export`"],
    [["migrate", "now"], "unexpected argument"],
    [["retention", "report", "--days", "abc"], "whole number"],
    [["retention", "report", "--days", "-5"], "whole number"],
    [["idempotency", "prune", "--older-than-days", "1.5"], "whole number"],
    [["admin", "create", "--email", "a@b.test", "--workspace", "W", "--role", "root", "--generate-password"], "--role must be"],
    [["serve", "--port", "1"], "not a flag of `changeradar serve`"],
    [["export", "--workspace-id=W", "--out", "f.json"], "unrecognised argument"],
    [["export", "--", "x"], "unrecognised argument"],
  ] as const)("%j exits 64 with the reason", async (args, reason) => {
    const res = await cli(env, [...args]);
    expect(res.code, res.err).toBe(64);
    expect(res.err).toContain(reason);
    expect(res.err).toContain(USAGE.split("\n")[0]!);
  });

  it("control: the same commands with correct flags still work", async () => {
    const dir = tempDir();
    const good = envFor(dir);
    expect((await cli(good, ["migrate"])).code).toBe(0);
    expect((await cli(good, ["retention", "report", "--days", "30"])).code).toBe(0);
    expect((await cli(good, ["sample-manifests", "--out", join(dir, "samples")])).code).toBe(0);
    expect((await cli(good, ["verify-bundle", "--in", join(dir, "missing.json")])).code).toBe(66);
  });

  it("a value-less --run no longer silently exports the whole workspace", async () => {
    const dir = tempDir();
    const good = envFor(dir);
    const out = join(dir, "whole.json");
    const res = await cli(good, ["export", "--workspace-id", UUID_ONES, "--run", "--out", out]);
    expect(res.code).toBe(64);
    expect(existsSync(out)).toBe(false);
  });
});

describe("R1: write failures and missing input use documented codes, not raw errno text", () => {
  it("an output path that cannot be created is 73 with a readable message and no path leak", async () => {
    const dir = tempDir();
    const file = join(dir, "a-file");
    writeFileSync(file, "x");
    const res = await cli(envFor(dir), ["sample-manifests", "--out", join(file, "child")]); // a file where a directory is needed
    expect(res.code).toBe(73);
    expect(res.err).toContain("cannot write");
    expect(res.err).not.toContain(dir);
  });

  it.skipIf(typeof process.getuid === "function" && process.getuid() === 0)("a read-only directory is 73 (EACCES)", async () => {
    const dir = tempDir();
    const locked = join(dir, "locked");
    mkdirSync(locked, { mode: 0o500 });
    const res = await cli(envFor(dir), ["sample-manifests", "--out", join(locked, "samples")]);
    expect(res.code).toBe(73);
    expect(res.err).toMatch(/EACCES|EPERM|EROFS/);
  });

  it("a missing or unreadable input file is 66, a corrupt one stays 2", async () => {
    const dir = tempDir();
    const env = envFor(dir);
    expect((await cli(env, ["restore", "--in", join(dir, "nope.json")])).code).toBe(66);
    const corrupt = join(dir, "corrupt.json");
    writeFileSync(corrupt, "{ not a bundle");
    const res = await cli(env, ["verify-bundle", "--in", corrupt]);
    expect(res.code).toBe(2);
    expect(res.err).toContain("BUNDLE_MALFORMED");
  });

  it("a bundle with a repeated key is refused with BUNDLE_DUPLICATE_KEY (exit 2)", async () => {
    const dir = tempDir();
    const file = join(dir, "dup.json");
    writeFileSync(file, '{"format":"changeradar-evidence-bundle","format":"changeradar-evidence-bundle"}');
    const res = await cli(envFor(dir), ["verify-bundle", "--in", file]);
    expect(res.code).toBe(2);
    expect(res.err).toContain("BUNDLE_DUPLICATE_KEY");
  });
});

interface Spawned {
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}
function launch(args: string[], env: NodeJS.ProcessEnv, extraNodeArgs: string[] = [], stdio: ("pipe" | "ignore")[] = ["pipe", "pipe", "pipe"]): Spawned {
  const child = spawn(process.execPath, [...extraNodeArgs, "--import", "tsx", CLI, ...args], { env: { ...process.env, ...env }, stdio });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (d) => (stdout += String(d)));
  child.stderr?.on("data", (d) => (stderr += String(d)));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  return { child, stdout: () => stdout, stderr: () => stderr, exited };
}
async function until(check: () => boolean, ms = 60_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return check();
}

describe("R1 P1: an interrupted one-shot command never exits 0 (cli.ts:11)", () => {
  for (const [signal, expected] of [
    ["SIGTERM", 143],
    ["SIGINT", 130],
  ] as const) {
    it(`admin create waiting on stdin, ${signal}: exit ${expected}, says it did not finish`, async () => {
      const dir = tempDir();
      const run = launch(["admin", "create", "--email", "a@b.test", "--workspace", "W", "--password-stdin"], envFor(dir));
      // The database directory appears once the command is running (it then blocks reading stdin).
      expect(await until(() => existsSync(join(dir, "db")))).toBe(true);
      await new Promise((r) => setTimeout(r, 2500));
      run.child.kill(signal);
      const { code } = await run.exited;
      expect(code, run.stderr()).toBe(expected);
      expect(run.stderr()).toContain("did not finish");
      expect(run.stdout()).toBe("");
    }, 120_000);
  }

  it("control: a long-running command (serve) still ends 0 on SIGTERM", async () => {
    const dir = tempDir();
    const port = await new Promise<number>((resolve) => {
      const probe = net.createServer();
      probe.listen(0, "127.0.0.1", () => {
        const p = (probe.address() as net.AddressInfo).port;
        probe.close(() => resolve(p));
      });
    });
    const run = launch(["serve", "--no-worker"], envFor(dir, { CHANGERADAR_PORT: String(port), CHANGERADAR_PUBLIC_URL: `http://localhost:${port}` }));
    expect(await until(() => run.stdout().includes("listening on"))).toBe(true);
    run.child.kill("SIGTERM");
    expect((await run.exited).code).toBe(0);
  }, 120_000);
});

describe("R1: EPIPE and unexpected errors never use the documented exit codes", () => {
  it("a closed output pipe ends the process with 141, quietly", async () => {
    const dir = tempDir();
    const run = launch(["sample-manifests", "--out", join(dir, "samples")], envFor(dir), [], ["pipe", "pipe", "pipe"]);
    run.child.stdout?.destroy(); // the reader goes away before the command prints
    const { code } = await run.exited;
    expect([0, 141]).toContain(code); // 0 only if the whole output fit into the pipe buffer before it closed
    expect(code === 1 || code === 2 || code === 64).toBe(false);
    expect(run.stderr()).not.toContain("EPIPE");
  }, 120_000);

  it("an uncaught exception exits 70 with a generic message (no stack, no error text)", async () => {
    const dir = tempDir();
    const preload = join(dir, "boom.mjs");
    writeFileSync(preload, 'setTimeout(() => { throw new Error("secret-detail-that-must-not-print"); }, 4500);\n');
    const run = launch(["admin", "create", "--email", "a@b.test", "--workspace", "W", "--password-stdin"], envFor(dir), ["--import", preload]);
    const { code } = await run.exited;
    expect(code).toBe(70);
    expect(run.stderr()).toContain("unexpected internal error");
    expect(run.stderr()).not.toContain("secret-detail-that-must-not-print");
    expect([0, 1, 2, 64, 66, 73]).not.toContain(code);
  }, 120_000);

  it("an unhandled rejection exits 70 too", async () => {
    const dir = tempDir();
    const preload = join(dir, "reject.mjs");
    writeFileSync(preload, 'setTimeout(() => { Promise.reject(new Error("nope")); }, 4500);\n');
    const run = launch(["admin", "create", "--email", "a@b.test", "--workspace", "W", "--password-stdin"], envFor(dir), ["--import", preload]);
    expect((await run.exited).code).toBe(70);
  }, 120_000);
});

describe("R1 P2: `changeradar version` names the package and its source commit", () => {
  it("prints the version and either the 40 character commit or `unknown` (running from source), exit 0, and takes no arguments", async () => {
    const env = envFor(tempDir());
    for (const arg of ["version", "--version"]) {
      const res = await cli(env, [arg]);
      expect(res.code, res.err).toBe(0);
      expect(res.out).toMatch(/^changeradar 0\.1\.0 commit (unknown|[0-9a-f]{40})( dirty)?$/);
    }
    expect((await cli(env, ["version", "now"])).code).toBe(64);
    expect((await cli(env, ["version", "--verbose"])).code).toBe(64);
  });
});

describe("R1 P2: admin revoke ends a member's access from the command line", () => {
  it("revokes sessions, removes the membership, and refuses an unknown member", async () => {
    const dir = tempDir();
    const env = envFor(dir);
    const created = await cli(env, ["admin", "create", "--email", "op@revoke.test", "--workspace", "W", "--role", "operator", "--generate-password"]);
    expect(created.code, created.err).toBe(0);
    const workspaceId = /workspace ([0-9a-f-]{36})/.exec(created.out)![1]!;
    const revoked = await cli(env, ["admin", "revoke", "--email", "OP@revoke.test", "--workspace-id", workspaceId]);
    expect(revoked.code, revoked.err).toBe(0);
    expect(revoked.out).toContain("revoked 0 session(s) of op@revoke.test");
    const removed = await cli(env, ["admin", "revoke", "--email", "op@revoke.test", "--workspace-id", workspaceId, "--remove-member"]);
    expect(removed.out).toContain("removed the membership");
    const again = await cli(env, ["admin", "revoke", "--email", "op@revoke.test", "--workspace-id", workspaceId]);
    expect(again.code).toBe(1);
    expect(again.err).toContain("No such member");
    expect((await cli(env, ["admin", "revoke", "--workspace-id", workspaceId])).code).toBe(1); // --email is required
    expect((await cli(env, ["admin", "revoke", "--email", "x@y.test", "--workspace-id", workspaceId, "--remove-member", "yes"])).code).toBe(64);
  }, 120_000);
});

describe("R1 P2: serve on a taken port exits promptly (bootstrap.ts:44)", () => {
  it("prints EADDRINUSE, exits non-zero and does not linger", async () => {
    const dir = tempDir();
    const blocker = net.createServer();
    const port = await new Promise<number>((resolve) => blocker.listen(0, "127.0.0.1", () => resolve((blocker.address() as net.AddressInfo).port)));
    try {
      const started = Date.now();
      const run = launch(["serve"], envFor(dir, { CHANGERADAR_PORT: String(port), CHANGERADAR_HOST: "127.0.0.1", CHANGERADAR_PUBLIC_URL: `http://localhost:${port}` }));
      const { code } = await run.exited;
      const seconds = (Date.now() - started) / 1000;
      expect(code).toBe(1);
      expect(run.stderr()).toContain("EADDRINUSE");
      // Start-up itself (tsx, embedded database) takes a few seconds; lingering used to add 15 to 44 more.
      expect(seconds).toBeLessThan(25);
      await new Promise((r) => setTimeout(r, 0));
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  }, 120_000);
});
