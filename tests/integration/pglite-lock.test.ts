import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db/index.js";
import { REPO_CLI } from "../e2e/support/stack.js";

const scratch: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "changeradar-lock-"));
  scratch.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

describe("the embedded database is single process: a second opener is refused instead of silently diverging", () => {
  it("refuses a second open of the same directory (same process), then allows it once the first is closed; the lock file follows", async () => {
    const dir = join(tempDir(), "data", "db");
    const first = await openDatabase(`pglite:${dir}`);
    expect(existsSync(`${dir}.lock`)).toBe(true);
    expect(readFileSync(`${dir}.lock`, "utf8").trim()).toBe(String(process.pid));
    await expect(openDatabase(`pglite:${dir}`)).rejects.toThrow(/already open in this process/);
    await first.query("SELECT 1");
    await first.close();
    expect(existsSync(`${dir}.lock`)).toBe(false);
    const again = await openDatabase(`pglite:${dir}`);
    await again.close();
  });

  it("refuses a directory held by another live process, naming the process, and takes over a lock whose owner is dead", async () => {
    const dir = join(tempDir(), "db");
    const holder = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    try {
      writeFileSync(`${dir}.lock`, `${holder.pid}\n`);
      await expect(openDatabase(`pglite:${dir}`)).rejects.toThrow(new RegExp(`in use by process ${holder.pid}`));
      expect(readFileSync(`${dir}.lock`, "utf8").trim()).toBe(String(holder.pid)); // a refused opener never disturbs the owner's lock
    } finally {
      holder.kill("SIGKILL");
    }
    await new Promise((resolve) => holder.once("close", resolve));
    const db = await openDatabase(`pglite:${dir}`); // stale lock (owner killed): taken over
    expect(readFileSync(`${dir}.lock`, "utf8").trim()).toBe(String(process.pid));
    await db.close();

    writeFileSync(`${dir}.lock`, "garbage\n"); // unreadable owner: stale
    const third = await openDatabase(`pglite:${dir}`);
    await third.close();
  });

  it("SEEDED NEGATIVE CONTROL: a second real process on the same data directory (serve, then worker) is refused, and the first keeps working", async () => {
    expect(existsSync(REPO_CLI), "run `npm run build` first: this test drives the compiled CLI").toBe(true);
    const dir = tempDir();
    const env = { PATH: process.env.PATH ?? "", CHANGERADAR_DATABASE_URL: `pglite:${join(dir, "db")}`, CHANGERADAR_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"), CHANGERADAR_PORT: "8797" };
    expect(spawnSync(process.execPath, [REPO_CLI, "migrate"], { env, encoding: "utf8" }).status).toBe(0);
    const running = spawn(process.execPath, [REPO_CLI, "worker"], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    running.stdout.on("data", (c: Buffer) => (output += c.toString()));
    const deadline = Date.now() + 60_000;
    while (!output.includes("worker started") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    try {
      expect(output).toContain("worker started");
      const second = spawnSync(process.execPath, [REPO_CLI, "admin", "create", "--email", "a@example.test", "--workspace", "W", "--generate-password"], { env, encoding: "utf8" });
      expect(second.status).toBe(1);
      expect(second.stderr).toMatch(/in use by process \d+/);
      expect(running.exitCode).toBeNull(); // the first process is still up
    } finally {
      running.kill("SIGTERM");
      await new Promise((resolve) => running.once("close", resolve));
    }
    expect(existsSync(join(dir, "db.lock"))).toBe(false); // a clean shutdown releases the lock
  }, 120_000);
});
