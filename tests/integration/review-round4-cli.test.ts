import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runCli, type Io } from "../../src/commands/run.js";
import { UUID_ZERO } from "../helpers/ids.js";

/**
 * Review round 4 (security P3, run.ts:351): a flag that names a UUID is validated before the database sees it. The database's
 * own message echoed the argument (`invalid input syntax for type uuid: "..."`); now it is a usage error (exit 64) with a fixed
 * text and nothing is created.
 */

const KEY = Buffer.alloc(32, 7).toString("base64");
const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) {
    try {
      chmodSync(dir, 0o700);
    } catch {
      /* gone */
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
async function cli(env: NodeJS.ProcessEnv, args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (m) => out.push(m), err: (m) => err.push(m), stdin: async () => "" };
  const code = await runCli(args, env, io);
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("R4 P3 (run.ts): a non-UUID id flag is a usage error, not the database's message", () => {
  it.each([
    (dir: string) => ["export", "--workspace-id", "not a uuid with \u001b[31m escape", "--out", join(dir, "b.json")],
    (dir: string) => ["export", "--workspace-id", UUID_ZERO, "--run", "nonsense-run-id", "--out", join(dir, "b.json")],
    () => ["admin", "revoke", "--email", "someone@example.test", "--workspace-id", "1; DROP TABLE users"],
    () => ["credential", "list", "--workspace-id", "abc"],
  ])("case %#", async (make) => {
    const dir = mkdtempSync(join(tmpdir(), "changeradar-r4uuid-"));
    scratch.push(dir);
    const env: NodeJS.ProcessEnv = { CHANGERADAR_DATABASE_URL: `pglite:${join(dir, "db")}`, CHANGERADAR_ENCRYPTION_KEY: KEY };
    const run = await cli(env, make(dir));
    expect(run.code).toBe(64);
    expect(run.err).toContain("must be a UUID");
    expect(run.err).not.toContain("invalid input syntax");
    expect(run.err).not.toContain("DROP TABLE");
    expect(existsSync(join(dir, "b.json"))).toBe(false);
  }, 60_000);
});
