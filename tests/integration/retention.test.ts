import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli, type Io } from "../../src/commands/run.js";
import { applyRetention, planRetention } from "../../src/services/retention.js";
import { count, createHarness, type Harness, type TestWorkspace } from "../helpers/harness.js";
import { addOptionalFieldDoc, baselineDoc, removeAmountDoc } from "../helpers/scenario.js";

describe("retention is operator approved, never automatic", () => {
  let h: Harness;
  let a: TestWorkspace;
  let b: TestWorkspace;
  let oldSnapshot: string;
  let keptSnapshot: string;

  beforeAll(async () => {
    h = await createHarness({ settings: { sessionTtlSeconds: 10 * 365 * 86_400 } });
    a = await h.workspace("RetentionA");
    b = await h.workspace("RetentionB");
    // Old evidence: a snapshot and a finished run, 100 days before the clock moves on.
    const old = await h.importSnapshot(a.operator, baselineDoc(), { revision: "old" });
    oldSnapshot = old.body.id;
    await h.requestRun(a.operator, { snapshot_id: old.body.id, proposed_manifest: removeAmountDoc(), expected_hash: old.body.hash });
    await h.drain();
    await h.importSnapshot(b.operator, baselineDoc(), { revision: "other-workspace-old" });
    h.advance(100 * 86_400);
    // Recent evidence: the current baseline and a fresh run against it.
    const recent = await h.importSnapshot(a.operator, addOptionalFieldDoc(), { revision: "recent" });
    keptSnapshot = recent.body.id;
    await h.requestRun(a.operator, { snapshot_id: recent.body.id, proposed_manifest: removeAmountDoc(), expected_hash: recent.body.hash });
    await h.drain();
  });
  afterAll(async () => h.close());

  it("plans without deleting anything, honouring the window and the workspace filter", async () => {
    const before = { runs: await count(h.db, "impact_runs"), snaps: await count(h.db, "snapshots"), findings: await count(h.db, "findings") };
    const plan = await planRetention(h.ctx, 90);
    expect(plan).toMatchObject({ older_than_days: 90, impact_runs: 1, snapshots: 1 }); // A's old run and snapshot; B's old snapshot is its baseline and stays
    expect(plan.findings).toBe(3);
    expect(plan.cutoff).toBe(new Date(h.now().getTime() - 90 * 86_400_000).toISOString());
    expect((await planRetention(h.ctx, 90, a.id)).snapshots).toBe(1);
    expect(await planRetention(h.ctx, 90, b.id)).toMatchObject({ impact_runs: 0, snapshots: 0 });
    expect(await planRetention(h.ctx, 365)).toMatchObject({ impact_runs: 0, snapshots: 0 });
    expect({ runs: await count(h.db, "impact_runs"), snaps: await count(h.db, "snapshots"), findings: await count(h.db, "findings") }).toEqual(before);
    await expect(planRetention(h.ctx, 0)).rejects.toThrow(/at least 1/);
    await expect(planRetention(h.ctx, 1.5)).rejects.toThrow(/whole number/);
  });

  it("the CLI refuses to apply without --approve", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const io: Io = { out: (m) => out.push(m), err: (m) => err.push(m), stdin: async () => "" };
    const code = await runCli(["retention", "apply"], { CHANGERADAR_DATABASE_URL: "pglite:memory", CHANGERADAR_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64") }, io);
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("needs --approve");
  });

  it("applies atomically: old runs, findings and unreferenced snapshots go; the baseline, kept runs and their snapshots stay", async () => {
    const applied = await applyRetention(h.ctx, 90);
    expect(applied).toMatchObject({ impact_runs: 1, findings: 3, snapshots: 1 });
    const remaining = await h.db.query<{ id: string }>("SELECT id FROM snapshots ORDER BY imported_at");
    expect(remaining.rows.map((r) => r.id)).toContain(keptSnapshot);
    expect(remaining.rows.map((r) => r.id)).not.toContain(oldSnapshot);
    expect(await count(h.db, "impact_runs")).toBe(1);
    expect(await count(h.db, "findings")).toBe(3);
    // Graph rows of deleted snapshots are gone; kept ones remain; the other workspace keeps its baseline.
    expect(await count(h.db, "nodes", "snapshot_id = $1", [oldSnapshot])).toBe(0);
    expect(await count(h.db, "edges", "snapshot_id = $1", [oldSnapshot])).toBe(0);
    expect(await count(h.db, "nodes", "snapshot_id = $1", [keptSnapshot])).toBeGreaterThan(0);
    const bBaseline = await h.api(b.viewer, "GET", "/api/v1/baseline");
    expect(bBaseline.body.snapshot.revision).toBe("other-workspace-old");
    // The kept run is still fully readable.
    const runs = await h.api(a.viewer, "GET", "/api/v1/impact-runs");
    expect(runs.body.items).toHaveLength(1);
    // The audit trail survives and records the purge.
    const audit = await h.api(a.admin, "GET", "/api/v1/audit?limit=100");
    expect(audit.body.items.some((x: any) => x.action === "retention.applied" && x.metadata.impact_runs === 1)).toBe(true);
    // Idempotent: a second application finds nothing.
    expect(await applyRetention(h.ctx, 90)).toMatchObject({ impact_runs: 0, snapshots: 0 });
  });

  it("unfinished runs are never purged, and neither is a snapshot they reference", async () => {
    const w = await h.workspace("RetentionC");
    const snap = await h.importSnapshot(w.operator, baselineDoc(), { revision: "queued-old" });
    await h.requestRun(w.operator, { snapshot_id: snap.body.id, proposed_manifest: removeAmountDoc(), expected_hash: snap.body.hash });
    await h.importSnapshot(w.operator, addOptionalFieldDoc(), { revision: "newer-baseline" });
    h.advance(200 * 86_400);
    const plan = await planRetention(h.ctx, 90, w.id);
    expect(plan.impact_runs).toBe(0); // still queued
    expect(plan.snapshots).toBe(0); // the first snapshot is referenced by the queued run and the second is the baseline
  });
});
