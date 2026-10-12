import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { runCli, type Io } from "../../src/commands/run.js";
import { buildBundle, BundleError, serializeBundle, type EvidenceBundle } from "../../src/services/evidence.js";
import { createHarness } from "../helpers/harness.js";
import { baselineDoc } from "../helpers/scenario.js";

/**
 * Review round 4 (logic P1, run.ts:356): the CLI workspace export used to ignore the bundle size limit, so it wrote a file
 * that verify-bundle and restore of the same installation refuse. The limit is measured in BYTES (not UTF-16 units).
 */

const here = dirname(fileURLToPath(import.meta.url));
const KEY = Buffer.alloc(32, 7).toString("base64");
const scratch: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "changeradar-r4cap-"));
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
const envFor = (dir: string, cap?: number): NodeJS.ProcessEnv => ({
  CHANGERADAR_DATABASE_URL: `pglite:${join(dir, "db")}`,
  CHANGERADAR_ENCRYPTION_KEY: KEY,
  ...(cap === undefined ? {} : { CHANGERADAR_MAX_BUNDLE_BYTES: String(cap) }),
});
async function cli(env: NodeJS.ProcessEnv, args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (m) => out.push(m), err: (m) => err.push(m), stdin: async () => "" };
  const code = await runCli(args, env, io);
  return { code, out: out.join("\n"), err: err.join("\n") };
}
const ENGINE1 = readFileSync(resolve(here, "../fixtures/upgrade/engine1-bundle.json"), "utf8").replace(/\b([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12})\b/g, "$1-$2-$3-$4-$5");
const WORKSPACE_ID = (JSON.parse(ENGINE1) as { workspace: { id: string } }).workspace.id;

describe("R4 P1 (run.ts:356): `changeradar export` honours CHANGERADAR_MAX_BUNDLE_BYTES", () => {
  it("refuses with BUNDLE_TOO_LARGE (exit 2) and writes no file; a bundle at the cap exports, verifies and restores; one byte less is refused everywhere", async () => {
    const dir = tempDir();
    const setupFile = join(dir, "engine1.json");
    (await import("node:fs")).writeFileSync(setupFile, ENGINE1);
    expect((await cli(envFor(dir), ["restore", "--in", setupFile])).code).toBe(0);

    // The size of this workspace's bundle, exported without a tight limit.
    const free = join(dir, "free.json");
    const first = await cli(envFor(dir), ["export", "--workspace-id", WORKSPACE_ID, "--out", free]);
    expect(first.code, first.err).toBe(0);
    const size = readFileSync(free).length;
    expect(size).toBeGreaterThan(4096);

    // Below the size: exit 2, the specific code, no file.
    const tight = join(dir, "tight.json");
    const refused = await cli(envFor(dir, size - 1), ["export", "--workspace-id", WORKSPACE_ID, "--out", tight]);
    expect(refused.code).toBe(2);
    expect(refused.err).toContain("BUNDLE_TOO_LARGE");
    expect(existsSync(tight), "no file is written").toBe(false);
    const small = join(dir, "small.json");
    const tiny = await cli(envFor(dir, 4096), ["export", "--workspace-id", WORKSPACE_ID, "--out", small]);
    expect(tiny.code).toBe(2);
    expect(existsSync(small)).toBe(false);

    // Exactly at the size: the export works, and verify-bundle and restore of that file work under the same limit.
    const exact = join(dir, "exact.json");
    const ok = await cli(envFor(dir, size), ["export", "--workspace-id", WORKSPACE_ID, "--out", exact]);
    expect(ok.code, ok.err).toBe(0);
    expect((await cli(envFor(dir, size), ["verify-bundle", "--in", exact])).code).toBe(0);
    const other = tempDir();
    expect((await cli(envFor(other, size), ["restore", "--in", exact])).code).toBe(0);
    // One byte under the limit, verify-bundle and restore refuse the same file, as export now does.
    expect((await cli(envFor(dir, size - 1), ["verify-bundle", "--in", exact])).code).toBe(2);
  }, 180_000);
});

describe("R4 P1 (evidence.ts:269): the limit is compared in bytes, not UTF-16 units", () => {
  it("a bundle of multi-byte text is refused when its bytes exceed the limit even though its characters do not", async () => {
    const h = await createHarness();
    try {
      const w = await h.workspace("cap");
      await h.importSnapshot(w.operator, baselineDoc(), { revision: "release-1" });
      await h.db.query("UPDATE workspaces SET name = $1 WHERE id = $2", ["é".repeat(3000), w.id]);
      const free = serializeBundle((await buildBundle(h.db, { workspaceId: w.id }, h.now())) as EvidenceBundle);
      const chars = free.length;
      const bytes = Buffer.byteLength(free, "utf8");
      expect(bytes).toBeGreaterThan(chars + 2000);
      await expect(buildBundle(h.db, { workspaceId: w.id }, h.now(), { maxBytes: chars })).rejects.toBeInstanceOf(BundleError);
      await expect(buildBundle(h.db, { workspaceId: w.id }, h.now(), { maxBytes: bytes - 1 })).rejects.toMatchObject({ code: "BUNDLE_TOO_LARGE" });
      expect(await buildBundle(h.db, { workspaceId: w.id }, h.now(), { maxBytes: bytes })).not.toBeNull();
    } finally {
      await h.close();
    }
  }, 120_000);
});
