import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultSettings } from "../../src/platform/context.js";
import { pruneIdempotencyKeys } from "../../src/services/idempotency.js";
import { count, createHarness, type Harness, type TestWorkspace } from "../helpers/harness.js";
import { addOptionalFieldDoc, baselineDoc, removeAmountDoc } from "../helpers/scenario.js";

describe("Idempotency-Key on mutations (scope: workspace + actor + route)", () => {
  let h: Harness;
  let ws: TestWorkspace;
  let other: TestWorkspace;
  beforeAll(async () => {
    // The retention test moves the clock by days, so sessions must outlive that.
    h = await createHarness({ settings: { sessionTtlSeconds: 10 * 365 * 86_400, checks: { ...defaultSettings.checks, allowedHosts: ["checks.example.test"] } } });
    ws = await h.workspace("Idem");
    other = await h.workspace("IdemOther");
  });
  afterAll(async () => h.close());

  it("same key and same body returns the same receipt without executing again", async () => {
    const first = await h.importSnapshot(ws.operator, baselineDoc(), { key: "import-1" });
    expect(first.status).toBe(201);
    const before = { s: await count(h.db, "snapshots"), e: await count(h.db, "outbox_events"), a: await count(h.db, "audit_events") };
    const again = await h.importSnapshot(ws.operator, baselineDoc(), { key: "import-1" });
    expect(again.status).toBe(201);
    expect(again.body).toEqual(first.body);
    expect(again.headers["idempotent-replayed"]).toBe("true");
    expect(first.headers["idempotent-replayed"]).toBeUndefined();
    expect({ s: await count(h.db, "snapshots"), e: await count(h.db, "outbox_events"), a: await count(h.db, "audit_events") }).toEqual(before);
    // The baseline did not move either, so a replayed import cannot invalidate a later run request.
    const baseline = await h.api(ws.viewer, "GET", "/api/v1/baseline");
    expect(baseline.body.snapshot.id).toBe(first.body.id);
  });

  it("the same key with a changed body is 409 IDEMPOTENCY_CONFLICT and executes nothing", async () => {
    const first = await h.importSnapshot(ws.operator, baselineDoc(), { key: "import-2" });
    const before = await count(h.db, "snapshots");
    const changed = await h.importSnapshot(ws.operator, addOptionalFieldDoc(), { key: "import-2" });
    expect(changed.status).toBe(409);
    expect(changed.body.error.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(await count(h.db, "snapshots")).toBe(before);
    // Even a whitespace-only difference is a different body: comparison is byte exact.
    const reformatted = await h.api(ws.operator, "POST", "/api/v1/snapshots", undefined, {
      raw: JSON.stringify({ schema_version: 1, revision: "rev-1", manifest: baselineDoc() }, null, 2),
      headers: { "idempotency-key": "import-2" },
    });
    expect(reformatted.status).toBe(409);
    expect(first.status).toBe(201);
  });

  it("applies to impact runs: a retry returns the same run id and creates one job", async () => {
    const snap = await h.importSnapshot(ws.operator, baselineDoc());
    const body = { snapshot_id: snap.body.id, proposed_manifest: removeAmountDoc(), expected_hash: snap.body.hash };
    const jobsBefore = await count(h.db, "jobs");
    const a = await h.requestRun(ws.operator, body, { key: "run-1" });
    const b = await h.requestRun(ws.operator, body, { key: "run-1" });
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    expect(b.body).toEqual(a.body);
    expect(await count(h.db, "jobs")).toBe(jobsBefore + 1);
    const c = await h.requestRun(ws.operator, { ...body, expected_hash: "sha256:" + "1".repeat(64) }, { key: "run-1" });
    expect(c.status).toBe(409);
    expect(c.body.error.code).toBe("IDEMPOTENCY_CONFLICT");
    // Without a key every request is independent.
    const d = await h.requestRun(ws.operator, body);
    const e = await h.requestRun(ws.operator, body);
    expect(d.body.id).not.toBe(e.body.id);
  });

  it("a retry of an accepted request gets the original receipt even though the baseline has since moved (lost-response retry)", async () => {
    const snap = await h.importSnapshot(ws.operator, baselineDoc(), { revision: "lost-response" });
    const body = { snapshot_id: snap.body.id, proposed_manifest: removeAmountDoc(), expected_hash: snap.body.hash };
    const accepted = await h.requestRun(ws.operator, body, { key: "lost-response-1" });
    expect(accepted.status).toBe(202);
    await h.importSnapshot(ws.operator, addOptionalFieldDoc(), { revision: "moved-on" });
    const fresh = await h.requestRun(ws.operator, body);
    expect(fresh.status).toBe(409); // a NEW request is stale now
    const retry = await h.requestRun(ws.operator, body, { key: "lost-response-1" });
    expect(retry.status).toBe(202); // the retry of the accepted one is not
    expect(retry.body).toEqual(accepted.body);
    expect(retry.headers["idempotent-replayed"]).toBe("true");
  });

  it("applies to contract check creation", async () => {
    const body = { key: "chk.idem", node_id: "contract.invoice", url: "https://checks.example.test/x" };
    const first = await h.api(ws.admin, "POST", "/api/v1/contract-checks", body, { headers: { "idempotency-key": "check-1" } });
    const again = await h.api(ws.admin, "POST", "/api/v1/contract-checks", body, { headers: { "idempotency-key": "check-1" } });
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.body.id).toBe(first.body.id);
    const plain = await h.api(ws.admin, "POST", "/api/v1/contract-checks", body);
    expect(plain.status).toBe(409); // no key: the natural uniqueness rule answers instead
    expect(plain.body.error.code).toBe("CHECK_EXISTS");
  });

  it("is scoped by workspace, actor and route", async () => {
    const k = "shared-key";
    const mine = await h.importSnapshot(ws.operator, baselineDoc(), { key: k });
    const theirs = await h.importSnapshot(other.operator, baselineDoc(), { key: k });
    expect(theirs.status).toBe(201);
    expect(theirs.body.id).not.toBe(mine.body.id); // another workspace's key is not a replay
    const admin = await h.importSnapshot(ws.admin, baselineDoc(), { key: k });
    expect(admin.status).toBe(201);
    expect(admin.body.id).not.toBe(mine.body.id); // another actor in the same workspace is not a replay
    const runBody = { snapshot_id: admin.body.id, proposed_manifest: removeAmountDoc(), expected_hash: admin.body.hash };
    const run = await h.requestRun(ws.admin, runBody, { key: k });
    expect(run.status).toBe(202); // the same key on another route is independent
  });

  it("concurrent requests with one key execute exactly once", async () => {
    const before = await count(h.db, "snapshots");
    const results = await Promise.all(Array.from({ length: 5 }, () => h.importSnapshot(ws.operator, baselineDoc(), { key: "parallel-1" })));
    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(await count(h.db, "snapshots")).toBe(before + 1);
    expect(results.filter((r) => r.headers["idempotent-replayed"] === "true")).toHaveLength(4);
  });

  it("a failed request leaves no receipt: the corrected retry with the same key executes", async () => {
    const bad = await h.importSnapshot(ws.operator, { nope: true }, { key: "retry-after-422" });
    expect(bad.status).toBe(422);
    expect(await count(h.db, "idempotency_keys", "key = 'retry-after-422'")).toBe(0);
    const good = await h.importSnapshot(ws.operator, baselineDoc(), { key: "retry-after-422" });
    expect(good.status).toBe(201);
  });

  it("validates the key format with 400", async () => {
    for (const key of ["", "has space", "a".repeat(129), "semi;colon"]) {
      const res = await h.api(ws.operator, "POST", "/api/v1/snapshots", { schema_version: 1, revision: "r", manifest: baselineDoc() }, { headers: { "idempotency-key": key } });
      expect(res.status, JSON.stringify(key)).toBe(400);
      expect(res.body.error.code).toBe("INVALID_IDEMPOTENCY_KEY");
    }
    const ok = await h.importSnapshot(ws.operator, baselineDoc(), { key: "A-z_0.9:x" });
    expect(ok.status).toBe(201);
  });

  it("retains keys at least seven days: a replay at six days works, and pruning refuses anything shorter", async () => {
    const first = await h.importSnapshot(ws.operator, baselineDoc(), { key: "retention-1" });
    h.advance(6 * 86_400);
    const replay = await h.api(ws.operator, "POST", "/api/v1/snapshots", { schema_version: 1, revision: "rev-1", manifest: baselineDoc() }, { headers: { "idempotency-key": "retention-1" } });
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(first.body);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    await expect(pruneIdempotencyKeys(h.ctx, 6)).rejects.toThrow(/at least 7 days/);
    await expect(pruneIdempotencyKeys(h.ctx, 0)).rejects.toThrow(/at least 7 days/);
    await expect(pruneIdempotencyKeys(h.ctx, Number.NaN)).rejects.toThrow(/at least 7 days/);
    const keep = await count(h.db, "idempotency_keys", "key = 'retention-1'");
    expect(keep).toBe(1);
    expect(await pruneIdempotencyKeys(h.ctx, 7)).toBeGreaterThanOrEqual(0);
    expect(await count(h.db, "idempotency_keys", "key = 'retention-1'")).toBe(1); // only six days old
    h.advance(2 * 86_400);
    expect(await pruneIdempotencyKeys(h.ctx, 7)).toBeGreaterThan(0);
    expect(await count(h.db, "idempotency_keys", "key = 'retention-1'")).toBe(0);
  });
});
