import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * AC-13 durability proof (scripts/durability-proof-pg17.mjs): the script is AUTHORED here and EXECUTED by the QA runner
 * when Docker is free. These are the dry-run checks that need no Docker: the plan, the usage error, and the rule that a
 * machine without Docker reports SKIPPED-no-docker (exit 3) and can never pass.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = join(root, "scripts", "durability-proof-pg17.mjs");
const run = (args: string[], env: NodeJS.ProcessEnv) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env, timeout: 30_000 });

describe("scripts/durability-proof-pg17.mjs (dry run, no Docker needed)", () => {
  it("--plan prints the ten steps and exits 0 without touching anything", () => {
    const res = run(["--plan"], { PATH: "" });
    expect(res.status, res.stderr).toBe(0);
    const plan = JSON.parse(res.stdout) as { image: string; steps: string[] };
    expect(plan.image).toBe("postgres:17-alpine");
    expect(plan.steps).toHaveLength(10);
    expect(plan.steps.join("\n")).toMatch(/kill -9/);
    expect(plan.steps.join("\n")).toMatch(/endpoint hit exactly once/);
    expect(plan.steps.join("\n")).toMatch(/restart PostgreSQL/);
    expect(plan.steps.join("\n")).toMatch(/pg_dump/);
  });

  it("without Docker it says SKIPPED-no-docker and exits 3, never 0", () => {
    const res = run([], { PATH: "" });
    expect(res.status).toBe(3);
    expect(res.stdout).toContain("SKIPPED-no-docker");
    expect(res.stdout).not.toMatch(/PASS/);
  });

  it("an unknown argument is a usage error (64)", () => {
    const res = run(["--everything"], { PATH: "" });
    expect(res.status).toBe(64);
  });

  it("the quality gate runs it only when Docker exists and reports the skip by name, and an npm script exists", () => {
    const gate = readFileSync(join(root, "scripts", "verify-quality.sh"), "utf8");
    expect(gate).toMatch(/durability-pg17/);
    expect(gate).toMatch(/SKIPPED-no-docker/);
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["durability:pg17"]).toBe("node scripts/durability-proof-pg17.mjs");
  });

  it("the script touches only what it created: one generated container name, removed by exact name", () => {
    const text = readFileSync(script, "utf8");
    expect(text).toMatch(/const container = `changeradar-durability-\$\{suffix\}`/);
    expect(text).toMatch(/\["rm", "-f", container\]/);
    expect(text).not.toMatch(/docker["'], \["(?:kill|stop|rm)["'],[^\]]*\$\(/);
    // Published on loopback only, on a port chosen BEFORE the container exists so it is the same after `docker restart`.
    expect(text).toMatch(/const pgPort = await freePort\(\)/);
    expect(text).toMatch(/"-p", `127\.0\.0\.1:\$\{pgPort\}:5432`/);
    expect(text).not.toMatch(/"-p", "127\.0\.0\.1::5432"/);
  });

  it("the container survives `docker restart` (no --rm, removed by exact name) and the poller stops only after five consecutive 200 samples", () => {
    const text = readFileSync(script, "utf8");
    expect(text).toMatch(/execFileSync\("docker", \["run", "-d", "--name", container,/);
    expect(text).not.toMatch(/"run", "-d", "--rm"/);
    expect(text).toMatch(/\["rm", "-f", container\]/);
    expect(text).toMatch(/seen\.slice\(-5\)\.every\(\(s\) => s === 200\)/);
    // The wait comes before the poller is stopped.
    expect(text.indexOf("five consecutive ready answers")).toBeLessThan(text.indexOf("done = true;"));
  });

  it("the password never goes on a command line: it reaches the container through a private env file", () => {
    const text = readFileSync(script, "utf8");
    expect(text).toMatch(/"--env-file", envFile/);
    expect(text).toMatch(/writeFileSync\(envFile, `POSTGRES_PASSWORD=\$\{pgPassword\}[^`]*`, \{ mode: 0o600 \}\)/);
    expect(text).not.toMatch(/"-e", `POSTGRES_PASSWORD=/);
  });

  it("an interrupted run cleans up once: SIGINT and SIGTERM handlers, idempotent cleanup, the env file removed, a paused worker resumed before it is killed", () => {
    const text = readFileSync(script, "utf8");
    expect(text).toMatch(/\[\["SIGINT", 130\], \["SIGTERM", 143\]\]/);
    expect(text).toMatch(/process\.on\(signal, \(\) => \{[\s\S]*?cleanup\(\)\.finally\(\(\) => process\.exit\(code\)\)/);
    expect(text).toMatch(/const cleanup = \(\) => \(cleanupPromise \?\?= cleanupBody\(\)\)/);
    expect(text).toMatch(/if \(workerPaused\) child\.kill\("SIGCONT"\);\s*child\.kill\("SIGKILL"\)/);
    expect(text).toMatch(/rmSync\(join\(work, "postgres\.env"\), \{ force: true \}\)/);
    expect(text).toMatch(/finally \{\s*await cleanup\(\);/);
  });

  it("the restart step proves work in flight: the worker is paused, the run is read as QUEUED before and after the restart, then the worker is resumed", () => {
    const text = readFileSync(script, "utf8");
    const before = text.indexOf('process.kill(workerA.pid, "SIGSTOP")');
    const request = text.indexOf("runQueued = requested.json.id");
    const queuedBefore = text.indexOf("beforeRestart === \"QUEUED\"");
    const restart = text.indexOf('"restart", "-t", "2", container');
    const queuedAfter = text.indexOf("afterRestart === \"QUEUED\"");
    const resume = text.indexOf('process.kill(workerA.pid, "SIGCONT")');
    expect([before, request, queuedBefore, restart, queuedAfter, resume].every((i) => i > 0)).toBe(true);
    expect([before, request, queuedBefore, restart, queuedAfter, resume]).toEqual([before, request, queuedBefore, restart, queuedAfter, resume].slice().sort((a, b) => a - b));
    expect(text).toMatch(/the worker died instead of recovering from the PostgreSQL restart/);
  });
});
