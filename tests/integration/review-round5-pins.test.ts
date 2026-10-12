import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { runCli, type Io } from "../../src/commands/run.js";
import { htmlReportRenderer } from "../../src/report/html-report.js";
import { restoreBundle } from "../../src/services/restore.js";
import { createHarness, getRun } from "../helpers/harness.js";
import { UUID_ONES, UUID_ZERO } from "../helpers/ids.js";
import { baselineDoc, removeAmountDoc } from "../helpers/scenario.js";

/**
 * Review round 5 (tests P3): pins for the parts of the stale view and the CLI guards that a review's hand mutations left alive:
 * the engine version of an unstamped run, the default renderer's wording, the recorded verdict and the history notice in the
 * HTML block, the run list and the run view agreeing on what a stamp means, the UUID flag guard (anchored, on every command
 * that takes one), and the error codes of a value the database refuses.
 */

const here = dirname(fileURLToPath(import.meta.url));
const ENGINE1 = readFileSync(resolve(here, "../fixtures/upgrade/engine1-bundle.json"), "utf8").replace(/\b([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12})\b/g, "$1-$2-$3-$4-$5");
const runsOf = (): { id: string; verdict: string; findings: number }[] =>
  (JSON.parse(ENGINE1) as { impact_runs: { id: string; verdict: string; findings: unknown[]; status: string }[] }).impact_runs.filter((r) => r.status === "COMPLETE").map((r) => ({ id: r.id, verdict: r.verdict, findings: r.findings.length }));
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

describe("R5 (impact.ts, report.ts, html-report.ts): what the stale views say", () => {
  it("an unstamped run is engine version 1 of this build's 3 (not 'version 3, this build is 3'), and the note says so", async () => {
    const h = await createHarness();
    try {
      const summary = await restoreBundle(h.ctx, ENGINE1);
      const viewer = await h.userIn(summary.workspace_id, "viewer");
      for (const run of runsOf()) {
        const view = await getRun(h, viewer, run.id);
        expect(view.engine).toMatchObject({ version: 1, current: 3, rerun_required: true });
        expect(view.engine.note).toContain("version 1, this build is 3");
      }
    } finally {
      await h.close();
    }
  }, 120_000);

  it("the DEFAULT renderer (no HTML renderer installed) withholds the verdict of a stale run in words", async () => {
    const h = await createHarness();
    try {
      const summary = await restoreBundle(h.ctx, ENGINE1);
      const viewer = await h.userIn(summary.workspace_id, "viewer");
      const run = runsOf()[0] as { id: string };
      const res = await h.api(viewer, "GET", `/api/v1/impact-runs/${run.id}/export?format=html`);
      expect(res.status).toBe(200);
      expect(res.text).toContain("withheld (older decision engine, re-run required)");
      for (const verdict of ["AFFECTED", "NO_KNOWN_IMPACT", "INCOMPLETE"]) expect(res.text, verdict).not.toContain(`Assessment: ${verdict}`);
    } finally {
      await h.close();
    }
  }, 120_000);

  it("the HTML stale block names the recorded verdict of each run as history, and a stale run that lists findings says the list is history", async () => {
    const h = await createHarness();
    h.ctx.reportRenderer = htmlReportRenderer;
    try {
      const summary = await restoreBundle(h.ctx, ENGINE1);
      const viewer = await h.userIn(summary.workspace_id, "viewer");
      const runs = runsOf();
      expect(runs.some((r) => r.findings > 0), "the fixture holds a stale run with findings").toBe(true);
      for (const run of runs) {
        const html = (await h.api(viewer, "GET", `/api/v1/impact-runs/${run.id}/export?format=html`)).text;
        expect(html, run.verdict).toContain(`Recorded verdict, do not rely on it: <code>${run.verdict}</code>`);
        if (run.findings > 0) expect(html).toContain("the list below is history; re-run before relying on it.");
        else expect(html).not.toContain("the list below is history");
      }
    } finally {
      await h.close();
    }
  }, 120_000);

  it("the HTML unknowns heading and its empty line say whose they are for a stale run, and stay plain for a current one", async () => {
    const h = await createHarness();
    h.ctx.reportRenderer = htmlReportRenderer;
    try {
      const summary = await restoreBundle(h.ctx, ENGINE1);
      const viewer = await h.userIn(summary.workspace_id, "viewer");
      const clean = runsOf().find((r) => r.verdict === "NO_KNOWN_IMPACT") as { id: string };
      const html = (await h.api(viewer, "GET", `/api/v1/impact-runs/${clean.id}/export?format=html`)).text;
      expect(html).toContain("Unknowns as recorded by the older engine (0)");
      expect(html).toContain("As assessed by the older engine: no unknowns were recorded for this run.");
      expect(html).not.toContain(">Unknowns (0)<");
      expect(html).not.toContain("No unknowns were recorded for this run.");
      const w = await h.workspace("PlainUnknowns5");
      const snap = await h.importSnapshot(w.operator, baselineDoc(), { revision: "release-1" });
      const run = await h.requestRun(w.operator, { snapshot_id: snap.body.id, proposed_manifest: removeAmountDoc(), expected_hash: snap.body.hash, run_checks: false });
      await h.drain();
      const current = (await h.api(w.viewer, "GET", `/api/v1/impact-runs/${run.body.id}/export?format=html`)).text;
      expect(current).not.toContain("older engine");
    } finally {
      await h.close();
    }
  }, 120_000);

  it("the run list and the run view agree on a stamp that is not a number: a numeric string is stale in both", async () => {
    const h = await createHarness();
    try {
      const w = await h.workspace("Stamp5");
      const snap = await h.importSnapshot(w.operator, baselineDoc(), { revision: "release-1" });
      const run = await h.requestRun(w.operator, { snapshot_id: snap.body.id, proposed_manifest: removeAmountDoc(), expected_hash: snap.body.hash, run_checks: false });
      await h.drain();
      const before = await getRun(h, w.viewer, run.body.id);
      expect(before.engine.rerun_required, "control: the run is current").toBe(false);
      // A finished run cannot be modified through the application (a trigger forbids it): the row is written directly, with the
      // trigger off for this one statement, to reach a state no API path can create.
      await h.db.query("ALTER TABLE impact_runs DISABLE TRIGGER USER");
      await h.db.query(`UPDATE impact_runs SET assessment = jsonb_set(assessment, '{engine_version}', '"3"'::jsonb) WHERE id = $1`, [run.body.id]);
      await h.db.query("ALTER TABLE impact_runs ENABLE TRIGGER USER");
      const view = await getRun(h, w.viewer, run.body.id);
      const list = await h.api(w.viewer, "GET", "/api/v1/impact-runs");
      const item = list.body.items.find((i: any) => i.id === run.body.id);
      expect(view.engine.rerun_required, "view").toBe(true);
      expect(item.rerun_required, "list").toBe(true);
      expect(view.assessment).toBeNull();
      expect(item.assessment).toBeNull();
    } finally {
      await h.close();
    }
  }, 120_000);
});

describe("R5 (run.ts): the UUID flag guard is anchored at both ends and covers every command that takes one", () => {
  async function cli(env: NodeJS.ProcessEnv, args: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const io: Io = { out: (m) => out.push(m), err: (m) => err.push(m), stdin: async () => "" };
    const code = await runCli(args, env, io);
    return { code, out: out.join("\n"), err: err.join("\n") };
  }
  const envIn = (dir: string): NodeJS.ProcessEnv => ({ CHANGERADAR_DATABASE_URL: `pglite:${join(dir, "db")}`, CHANGERADAR_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString("base64") });

  it.each([
    ["a UUID followed by text", `${UUID_ZERO};junk`],
    ["text in front of a UUID", `junk${UUID_ONES}`],
    ["a UUID with a line break behind it", `${UUID_ZERO}\n`],
    ["not a UUID at all", "not-a-uuid-SECRET"],
  ])("retention report, admin create and credential list refuse %s (exit 64, the text is not echoed)", async (_label, bad) => {
    const dir = mkdtempSync(join(tmpdir(), "changeradar-r5uuid-"));
    scratch.push(dir);
    const env = envIn(dir);
    const commands: string[][] = [
      ["retention", "report", "--workspace-id", bad],
      ["admin", "create", "--email", "someone@example.test", "--workspace-id", bad, "--generate-password"],
      ["credential", "list", "--workspace-id", bad],
    ];
    for (const args of commands) {
      const run = await cli(env, args);
      expect(run.code, args.join(" ")).toBe(64);
      expect(run.err, args.join(" ")).toContain("must be a UUID");
      expect(run.err + run.out).not.toContain("SECRET");
      expect(run.err).not.toContain("invalid input syntax");
    }
  }, 120_000);

  it("a well-formed UUID passes the guard (control): retention report on an empty installation answers, exit 0", async () => {
    const dir = mkdtempSync(join(tmpdir(), "changeradar-r5uuid-"));
    scratch.push(dir);
    const run = await cli(envIn(dir), ["retention", "report", "--workspace-id", UUID_ZERO]);
    expect(run.code, run.err).toBe(0);
  }, 120_000);
});

describe("R5 (server.ts:132): a value the database refuses is a 400 with the right code", () => {
  it("without a cursor it is INVALID_REQUEST, with a cursor it is INVALID_CURSOR", async () => {
    const h = await createHarness();
    try {
      const w = await h.workspace("Data5");
      const real = h.ctx.db.query.bind(h.ctx.db) as (sql: string, params?: unknown[]) => Promise<unknown>;
      let armed = false;
      (h.ctx.db as unknown as { query: unknown }).query = async (sql: string, params?: unknown[]) => {
        if (armed && /FROM impact_runs/.test(sql)) throw Object.assign(new Error("out of range for type integer"), { code: "22003" });
        return real(sql, params);
      };
      armed = true;
      const plain = await h.api(w.viewer, "GET", "/api/v1/impact-runs");
      expect(plain.status).toBe(400);
      expect(plain.body.error.code).toBe("INVALID_REQUEST");
      const cursor = Buffer.from(JSON.stringify(["2026-01-01T00:00:00.000Z", UUID_ZERO]), "utf8").toString("base64url");
      const withCursor = await h.api(w.viewer, "GET", `/api/v1/impact-runs?cursor=${cursor}`);
      expect(withCursor.status).toBe(400);
      expect(withCursor.body.error.code).toBe("INVALID_CURSOR");
      expect(JSON.stringify([plain.body, withCursor.body])).not.toContain("out of range");
    } finally {
      await h.close();
    }
  }, 120_000);
});
