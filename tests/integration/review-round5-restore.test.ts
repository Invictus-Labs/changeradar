import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { runCli, type Io } from "../../src/commands/run.js";
import { hashCanonical } from "../../src/domain/canonical.js";
import { BundleError, verifyBundle } from "../../src/services/evidence.js";
import { restoreBundle } from "../../src/services/restore.js";
import { createHarness } from "../helpers/harness.js";

/**
 * Review round 5 (logic P2 evidence.ts:22, P3 restore.ts:112, tests P2 restore.ts:89): a bundle whose hashes are consistent but
 * whose values the database refuses (an invalid timestamp, a NUL character, an integer past its column, a check the table
 * rejects, a malformed finding id) is REJECTED by verification (BUNDLE_SCHEMA_INVALID, exit 2), and whatever verification
 * misses is still reported under that code by the restore (SQLSTATE class 22 and 23), never as a database message with exit 1.
 * The run events and the credential alias of a check are cut like every other stored text.
 */

const here = dirname(fileURLToPath(import.meta.url));
const ENGINE1 = readFileSync(resolve(here, "../fixtures/upgrade/engine1-bundle.json"), "utf8").replace(/\b([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12})\b/g, "$1-$2-$3-$4-$5");
const LIMIT = 64 * 1024 * 1024;
const scratch: string[] = [];
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

function reseal(bundle: Record<string, any>): string {
  const { bundle_hash: _drop, hashes: _h, stale_runs: _s, ...body } = bundle;
  const hashes = { snapshots: hashCanonical(body.snapshots), impact_runs: hashCanonical(body.impact_runs), contract_checks: hashCanonical(body.contract_checks) };
  const withHashes = { ...body, hashes };
  return JSON.stringify({ ...withHashes, bundle_hash: hashCanonical(withHashes) });
}
const fresh = (): Record<string, any> => JSON.parse(ENGINE1) as Record<string, any>;
const check = (over: Record<string, unknown> = {}) => ({
  key: "chk.r5", node_id: "contract.invoice", url: "http://localhost:9/ok", method: "GET", timeout_ms: 1000, retries: 0, expect_status: 200, required_fields: [], credential_alias: null, enabled: false,
  created_at: "2026-09-29T00:00:00.000Z", disabled_at: "2026-09-29T00:00:00.000Z", ...over,
});
const codeOf = (text: string): string => {
  try {
    verifyBundle(text, { maxBytes: LIMIT });
    return "ACCEPTED";
  } catch (error) {
    return error instanceof BundleError ? error.code : String(error);
  }
};
function capture(): { io: Io; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (m) => out.push(m), err: (m) => err.push(m), stdin: async () => "" }, out, err };
}

describe("R5 (evidence.ts:22): values the database refuses are a bundle rejection at verification", () => {
  it("the genuine bundle is accepted (control)", () => {
    expect(codeOf(ENGINE1)).toBe("ACCEPTED");
  });

  const forgeries: [string, (b: Record<string, any>) => void][] = [
    ["a run timestamp that is not a timestamp", (b) => { b.impact_runs[0].created_at = "garbage"; }],
    ["a timestamp with a calendar date that does not exist", (b) => { b.impact_runs[0].created_at = "2026-02-31T00:00:00.000Z"; }],
    ["an event timestamp that is not a timestamp", (b) => { b.impact_runs[0].events[0].at = "not-a-time"; }],
    ["a NUL in the workspace name", (b) => { b.workspace.name = `ws${String.fromCharCode(0)}name`; }],
    ["a NUL inside a run's check keys", (b) => { b.impact_runs[0].check_keys = [`k${String.fromCharCode(0)}`]; }],
    ["a baseline version above int4", (b) => { b.impact_runs[0].baseline_version = 2 ** 40; }],
    ["a check with a negative retry count", (b) => { b.contract_checks = [check({ retries: -5 })]; }],
    ["a check with a timeout of zero", (b) => { b.contract_checks = [check({ timeout_ms: 0 })]; }],
    ["a check with a status the table refuses", (b) => { b.contract_checks = [check({ expect_status: 99 })]; }],
    ["a finding depth above int4", (b) => { const run = b.impact_runs.find((r: any) => r.findings.length > 0); run.findings[0].depth = 2 ** 40; }],
    ["a finding depth of zero", (b) => { const run = b.impact_runs.find((r: any) => r.findings.length > 0); run.findings[0].depth = 0; }],
    ["a finding id that is not fnd_ and 20 hex digits", (b) => { const run = b.impact_runs.find((r: any) => r.findings.length > 0); run.findings[0].finding_key = "fnd_not-hex"; }],
  ];
  for (const [label, edit] of forgeries) {
    it(`${label}: BUNDLE_SCHEMA_INVALID (and restore refuses it under the same code)`, async () => {
      const bundle = fresh();
      expect(bundle.impact_runs.some((r: any) => r.findings.length > 0), "the fixture holds a run with findings").toBe(true);
      edit(bundle);
      const text = reseal(bundle);
      expect(codeOf(text)).toBe("BUNDLE_SCHEMA_INVALID");
      const h = await createHarness();
      try {
        await expect(restoreBundle(h.ctx, text)).rejects.toMatchObject({ code: "BUNDLE_SCHEMA_INVALID" });
      } finally {
        await h.close();
      }
    }, 120_000);
  }

  it("the CLI restore of such a bundle exits 2 (a rejected bundle), not 1 with a database message", async () => {
    const dir = mkdtempSync(join(tmpdir(), "changeradar-r5restore-"));
    scratch.push(dir);
    const bundle = fresh();
    bundle.impact_runs[0].created_at = "garbage";
    const file = join(dir, "forged.json");
    writeFileSync(file, reseal(bundle));
    const env = { CHANGERADAR_DATABASE_URL: `pglite:${join(dir, "db")}`, CHANGERADAR_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString("base64") } as NodeJS.ProcessEnv;
    const c = capture();
    const code = await runCli(["restore", "--in", file], env, c.io);
    expect(code, c.err.join("\n")).toBe(2);
    expect(c.err.join("\n")).toContain("BUNDLE_SCHEMA_INVALID");
    expect(c.err.join("\n")).not.toMatch(/invalid input syntax/);
  }, 120_000);
});

describe("R5 (restore.ts): a value the database refuses that verification did not catch is still a rejected bundle", () => {
  it("SQLSTATE class 22 and 23 raised inside the restore become BUNDLE_SCHEMA_INVALID; other errors pass through unchanged", async () => {
    for (const code of ["22007", "22003", "23514", "23505"]) {
      const h = await createHarness();
      try {
        const failure = await restoreBundle(h.ctx, ENGINE1, { afterStep: () => { throw Object.assign(new Error(`database said ${code}`), { code }); } }).then(
          () => null,
          (error: unknown) => error as { code?: string; message?: string },
        );
        expect(failure?.code, `${code}: ${failure?.message ?? "the restore succeeded"}`).toBe("BUNDLE_SCHEMA_INVALID");
      } finally {
        await h.close();
      }
    }
    const h = await createHarness();
    try {
      await expect(restoreBundle(h.ctx, ENGINE1, { afterStep: () => { throw Object.assign(new Error("connection lost"), { code: "08006" }); } })).rejects.toThrow("connection lost");
      await expect(restoreBundle(h.ctx, ENGINE1, { afterStep: () => { throw new Error("plain failure"); } })).rejects.toThrow("plain failure");
    } finally {
      await h.close();
    }
  }, 180_000);
});

describe("R5 (restore.ts:89, :112): the run event statuses and the credential alias of a check are cut to 2,000 characters", () => {
  it("event from_status and to_status, and a check's credential alias of 5,000 characters", async () => {
    const bundle = fresh();
    const long = "s".repeat(5000);
    bundle.impact_runs[0].events[0].from_status = long;
    bundle.impact_runs[0].events[0].to_status = long;
    bundle.contract_checks = [check({ credential_alias: long })];
    const h = await createHarness();
    try {
      await restoreBundle(h.ctx, reseal(bundle));
      const one = async (sql: string): Promise<number> => ((await h.db.query<{ v: number }>(sql)).rows[0] as { v: number }).v;
      expect(await one("SELECT length(credential_alias) AS v FROM contract_checks"), "credential alias").toBe(2000);
      expect(await one("SELECT max(length(from_status)) AS v FROM run_events"), "event from_status").toBe(2000);
      expect(await one("SELECT max(length(to_status)) AS v FROM run_events"), "event to_status").toBe(2000);
    } finally {
      await h.close();
    }
  }, 120_000);
});
