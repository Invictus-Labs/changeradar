import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { defaultSettings } from "../../src/platform/context.js";
import { assertLease, claimJob, completeWith, extendLease, LeaseLostError } from "../../src/services/jobs.js";
import { relayOutboxOnce, runWorkerOnce, SimulatedCrash, startWorker } from "../../src/workers/worker.js";
import { startFixture, type Fixture } from "../helpers/fixture-server.js";
import { count, createHarness, getRun, type Harness, type TestWorkspace } from "../helpers/harness.js";
import { baselineDoc, removeAmountDoc } from "../helpers/scenario.js";

async function queueRun(h: Harness, ws: TestWorkspace, extra: Record<string, unknown> = {}) {
  const snap = await h.importSnapshot(ws.operator, baselineDoc());
  const run = await h.requestRun(ws.operator, { snapshot_id: snap.body.id, proposed_manifest: removeAmountDoc(), expected_hash: snap.body.hash, ...extra });
  expect(run.status, run.text).toBe(202);
  return { snap: snap.body, runId: run.body.id as string };
}

describe("AC-13 leases: bounded claims, restart reclaim, fencing", () => {
  let h: Harness;
  let ws: TestWorkspace;
  beforeAll(async () => {
    // These tests move the clock by hours; sessions must outlive that.
    h = await createHarness({ settings: { sessionTtlSeconds: 10 * 365 * 86_400 } });
    ws = await h.workspace("Leases");
  });
  afterAll(async () => h.close());

  it("a claim takes a bounded lease; a second worker cannot claim a live lease; an expired lease is reclaimable", async () => {
    const { runId } = await queueRun(h, ws);
    const a = await claimJob(h.db, "worker-a", h.ctx.clock, 60);
    expect(a).toMatchObject({ object_id: runId, state: "running", locked_by: "worker-a", attempt: 1 });
    expect(new Date(a!.lease_until!).toISOString()).toBe("2026-09-29T00:01:00.000Z");
    expect(await claimJob(h.db, "worker-b", h.ctx.clock, 60)).toBeNull();
    h.advance(59);
    expect(await claimJob(h.db, "worker-b", h.ctx.clock, 60)).toBeNull();
    h.advance(2);
    const b = await claimJob(h.db, "worker-b", h.ctx.clock, 60);
    expect(b).toMatchObject({ id: a!.id, locked_by: "worker-b", attempt: 2 });
    // The old owner is fenced out in every way: it cannot extend, assert or complete.
    expect(await extendLease(h.db, a!, h.ctx.clock, 60)).toBe(false);
    await expect(h.db.transaction((tx) => assertLease(tx, a!))).rejects.toBeInstanceOf(LeaseLostError);
    const auditBefore = await count(h.db, "audit_events");
    await expect(
      completeWith(
        h.db,
        a!,
        async (tx) => {
          await tx.query("INSERT INTO audit_events (id, workspace_id, actor_type, action, resource_type, resource_id, created_at) VALUES (gen_random_uuid(), $1, 'worker', 'stale.write', 'x', 'y', now())", [ws.id]);
        },
        h.ctx.clock,
      ),
    ).rejects.toBeInstanceOf(LeaseLostError);
    expect(await count(h.db, "audit_events")).toBe(auditBefore); // the stale worker's effect was rolled back
    // The new owner can extend and complete; job ends done.
    expect(await extendLease(h.db, b!, h.ctx.clock, 60)).toBe(true);
    await completeWith(h.db, b!, async () => undefined, h.ctx.clock);
    const done = await h.db.query<{ state: string }>("SELECT state FROM jobs WHERE id = $1", [a!.id]);
    expect(done.rows[0]?.state).toBe("done");
  });

  it("restart after a crash right after claim: the lease expires, the job is reclaimed and the run completes", async () => {
    const { runId } = await queueRun(h, ws);
    const crashed = await runWorkerOnce(h.ctx, { hooks: { afterClaim: () => { throw new SimulatedCrash(); } } });
    expect(crashed.result).toBe("crashed");
    expect(await runWorkerOnce(h.ctx)).toMatchObject({ job: null, result: "idle" }); // lease still live
    h.advance(61);
    const recovered = await runWorkerOnce(h.ctx);
    expect(recovered).toMatchObject({ result: "done", job: { attempt: 2 } });
    const view = await getRun(h, ws.viewer, runId);
    expect(view.status).toBe("complete");
    expect(view.assessment).toBe("AFFECTED");
  });

  it("a run left RUNNING by a dead worker goes RUNNING to QUEUED to RUNNING again, and the history says so", async () => {
    const { runId } = await queueRun(h, ws);
    // Crash after the run reached RUNNING: the first check hook is unreachable without checks, so use the
    // claim hook after making the run RUNNING by hand through the state machine's own path.
    await h.db.query("UPDATE impact_runs SET status = 'RUNNING', started_at = now() WHERE id = $1", [runId]);
    await runWorkerOnce(h.ctx, { hooks: { afterClaim: () => { throw new SimulatedCrash(); } } });
    h.advance(61);
    await runWorkerOnce(h.ctx);
    const events = await h.db.query<{ from_status: string | null; to_status: string; note: string | null }>("SELECT from_status, to_status, note FROM run_events WHERE run_id = $1 ORDER BY id", [runId]);
    expect(events.rows.map((e) => `${e.from_status ?? "-"}>${e.to_status}`)).toEqual(["->QUEUED", "RUNNING>QUEUED", "QUEUED>RUNNING", "RUNNING>COMPLETE"]);
    expect(events.rows[1]?.note).toContain("reclaimed");
    expect((await getRun(h, ws.viewer, runId)).status).toBe("complete");
  });

  it("a job that keeps crashing its worker ends FAILED with a visible reason, never queued forever and never a verdict", async () => {
    const { runId } = await queueRun(h, ws);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const r = await runWorkerOnce(h.ctx, { hooks: { afterClaim: () => { throw new SimulatedCrash(); } } });
      expect(r).toMatchObject({ result: "crashed", job: { attempt } });
      h.advance(61);
    }
    const reaped = await runWorkerOnce(h.ctx);
    expect(reaped.job).toBeNull();
    const view = await getRun(h, ws.viewer, runId);
    expect(view).toMatchObject({ status: "failed", assessment: null, error: { code: "WORKER_EXHAUSTED" } });
    const job = await h.db.query<{ state: string; attempt: number }>("SELECT state, attempt FROM jobs WHERE object_id = $1", [runId]);
    expect(job.rows[0]).toEqual({ state: "dead", attempt: 3 });
    const events = await h.api(ws.operator, "GET", "/api/v1/events?limit=100");
    expect(events.body.items.some((e: any) => e.envelope.event_type === "impact_run.failed" && e.envelope.resource_id === runId)).toBe(true);
    const report = await h.api(ws.viewer, "GET", `/api/v1/impact-runs/${runId}/export?format=html`);
    expect(report.text).toContain("status failed");
    expect(report.text).toContain("not yet available");
  });

  it("a worker that loses its lease mid-job commits nothing and reports lease_lost, also when its failure handling is fenced out", async () => {
    const steal = async () => {
      h.advance(61);
      const thief = await claimJob(h.db, "thief", h.ctx.clock, 60);
      expect(thief).not.toBeNull();
    };
    const first = await queueRun(h, ws);
    const lost = await runWorkerOnce(h.ctx, { hooks: { afterClaim: steal } });
    expect(lost.result).toBe("lease_lost");
    expect((await getRun(h, ws.viewer, first.runId)).status).toBe("queued"); // the loser wrote nothing
    h.advance(61);
    await h.drain(); // the thief died too; its lease expires and the job is reclaimed and completed
    expect((await getRun(h, ws.viewer, first.runId)).status).toBe("complete");

    const second = await queueRun(h, ws);
    const alsoLost = await runWorkerOnce(h.ctx, {
      hooks: {
        afterClaim: async () => {
          await steal();
          throw new Error("failure after the lease was lost");
        },
      },
    });
    expect(alsoLost.result).toBe("lease_lost"); // failJob is fenced too: it cannot record a failure for a job it no longer owns
    const job = await h.db.query<{ state: string; last_error: string | null }>("SELECT state, last_error FROM jobs WHERE object_id = $1", [second.runId]);
    expect(job.rows[0]).toEqual({ state: "running", last_error: null });
    h.advance(61);
    await h.drain();
    expect((await getRun(h, ws.viewer, second.runId)).status).toBe("complete");
  });

  it("a healthy long-running job keeps extending its lease with a heartbeat", async () => {
    const { runId } = await queueRun(h, ws);
    const lease = async () => (await h.db.query<{ lease_until: Date }>("SELECT lease_until FROM jobs WHERE object_id = $1", [runId])).rows[0]!.lease_until.getTime();
    let initial = 0;
    let extended = 0;
    const result = await runWorkerOnce(h.ctx, {
      heartbeatMs: 15,
      hooks: {
        afterClaim: async () => {
          initial = await lease();
          h.advance(30);
          await new Promise((r) => setTimeout(r, 120));
          extended = await lease();
        },
      },
    });
    expect(result.result).toBe("done");
    expect(extended - initial).toBe(30_000); // the lease now ends 60 s after the advanced clock
  });

  it("a failing handler is retried with exponential backoff and ends dead after the attempt budget", async () => {
    const { runId } = await queueRun(h, ws);
    const boom = { afterClaim: () => { throw new Error("transient failure"); } };
    const first = await runWorkerOnce(h.ctx, { hooks: boom });
    expect(first.result).toBe("retry");
    let job = (await h.db.query<{ next_attempt_at: Date; last_error: string; state: string }>("SELECT next_attempt_at, last_error, state FROM jobs WHERE object_id = $1", [runId])).rows[0]!;
    expect(job).toMatchObject({ state: "queued", last_error: "transient failure" });
    expect(job.next_attempt_at.getTime() - h.now().getTime()).toBe(2000);
    expect((await runWorkerOnce(h.ctx)).job).toBeNull(); // not due yet
    h.advance(2);
    expect((await runWorkerOnce(h.ctx, { hooks: boom })).result).toBe("retry");
    job = (await h.db.query<{ next_attempt_at: Date; last_error: string; state: string }>("SELECT next_attempt_at, last_error, state FROM jobs WHERE object_id = $1", [runId])).rows[0]!;
    expect(job.next_attempt_at.getTime() - h.now().getTime()).toBe(4000);
    h.advance(4);
    expect((await runWorkerOnce(h.ctx, { hooks: boom })).result).toBe("dead");
    expect((await getRun(h, ws.viewer, runId))).toMatchObject({ status: "failed", error: { code: "WORKER_EXHAUSTED" } });
    h.advance(3600); // drain leftovers of earlier tests so later tests start clean
    await h.drain();
  });

  it("concurrent workers process each run exactly once", async () => {
    const snap = await h.importSnapshot(ws.operator, baselineDoc());
    const ids: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const run = await h.requestRun(ws.operator, { snapshot_id: snap.body.id, proposed_manifest: removeAmountDoc(), expected_hash: snap.body.hash });
      ids.push(run.body.id);
    }
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => runWorkerOnce(h.ctx, { workerId: `w${i}` })));
    for (const r of results) expect(["done", "idle"]).toContain(r.result);
    await h.drain();
    for (const id of ids) {
      expect((await getRun(h, ws.viewer, id)).status).toBe("complete");
      const completes = await h.db.query<{ n: number }>("SELECT count(*)::int AS n FROM run_events WHERE run_id = $1 AND to_status = 'COMPLETE'", [id]);
      expect(completes.rows[0]?.n).toBe(1);
      const findings = await h.db.query<{ n: number; d: number }>("SELECT count(*)::int AS n, count(DISTINCT finding_key)::int AS d FROM findings WHERE run_id = $1", [id]);
      expect(findings.rows[0]).toEqual({ n: 3, d: 3 });
    }
  });

  it("stored data that no longer matches its recorded hash fails the run as INTEGRITY_FAILURE, not as a stale request", async () => {
    const { runId, snap } = await queueRun(h, ws);
    await h.db.query("ALTER TABLE snapshots DISABLE TRIGGER snapshots_append_only");
    await h.db.query("UPDATE snapshots SET manifest = replace(manifest, 'team-billing', 'team-tampered') WHERE id = $1", [snap.id]);
    await h.db.query("ALTER TABLE snapshots ENABLE TRIGGER snapshots_append_only");
    await h.drain();
    const view = await getRun(h, ws.viewer, runId);
    expect(view).toMatchObject({ status: "failed", assessment: null, error: { code: "INTEGRITY_FAILURE" } });
    expect(view.error.detail).toContain("does not match its recorded hash");
    expect(await count(h.db, "findings", "run_id = $1", [runId])).toBe(0);
  });

  it("a run whose proposed manifest was tampered with fails the same way", async () => {
    const { runId } = await queueRun(h, ws);
    await h.db.query("ALTER TABLE impact_runs DISABLE TRIGGER impact_runs_protect");
    await h.db.query("UPDATE impact_runs SET proposed_manifest = replace(proposed_manifest, 'contract.invoice', 'contract.other') WHERE id = $1", [runId]);
    await h.db.query("ALTER TABLE impact_runs ENABLE TRIGGER impact_runs_protect");
    await h.drain();
    expect((await getRun(h, ws.viewer, runId)).error.code).toBe("INTEGRITY_FAILURE");
  });

  it("a job for a run that vanished, or is already terminal, completes without effect", async () => {
    const { runId } = await queueRun(h, ws);
    await h.drain();
    const before = await count(h.db, "findings", "run_id = $1", [runId]);
    await h.db.query("INSERT INTO jobs (id, workspace_id, type, object_id, state, next_attempt_at, deduplication_key, created_at, updated_at) VALUES (gen_random_uuid(), $1, 'assess_run', $2, 'queued', now() - interval '1 day', 'dup-terminal', now(), now())", [ws.id, runId]);
    await h.db.query("INSERT INTO jobs (id, workspace_id, type, object_id, state, next_attempt_at, deduplication_key, created_at, updated_at) VALUES (gen_random_uuid(), $1, 'assess_run', gen_random_uuid(), 'queued', now() - interval '1 day', 'dup-missing', now(), now())", [ws.id]);
    h.advance(86_400 * 2);
    expect(await h.drain()).toBe(2);
    expect(await count(h.db, "findings", "run_id = $1", [runId])).toBe(before);
    expect(await count(h.db, "jobs", "state = 'done'")).toBeGreaterThan(2);
  });

  it("the poll loop drains queued runs and stops cleanly", async () => {
    const { runId } = await queueRun(h, ws);
    const stop = startWorker(h.ctx, { intervalMs: 20 });
    try {
      const deadline = Date.now() + 5000;
      let status = "queued";
      while (status !== "complete" && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
        status = (await getRun(h, ws.viewer, runId)).status;
      }
      expect(status).toBe("complete");
    } finally {
      await stop();
    }
  });
});

/** FIXTURE server plus real network checks: what happens to uncertain external outcomes across a restart. */
describe("AC-13 a worker restart never discards or fabricates an uncertain external outcome", () => {
  let h: Harness;
  let ws: TestWorkspace;
  let fx: Fixture;
  beforeAll(async () => {
    fx = await startFixture();
    h = await createHarness({ settings: { checks: { ...defaultSettings.checks, allowedHosts: [`127.0.0.1:${fx.port}`], allowPrivateNetwork: true, backoffBaseMs: 5 } } });
    ws = await h.workspace("Uncertain");
    const created = await h.api(ws.admin, "POST", "/api/v1/contract-checks", {
      key: "chk.uncertain",
      node_id: "contract.invoice",
      url: `${fx.origin}/ok`,
      retries: 0,
      timeout_ms: 1000,
      required_fields: [{ name: "invoice_id", type: "string" }],
    });
    expect(created.status, created.text).toBe(201);
  });
  afterAll(async () => {
    await h.close();
    await fx.close();
  });

  it("crash after the check was marked STARTED: on restart it is UNKNOWN (never PASSED, never silently retried) and the run is INCOMPLETE", async () => {
    const { runId } = await queueRun(h, ws);
    const before = fx.hits("/ok");
    const crashed = await runWorkerOnce(h.ctx, { hooks: { afterCheckStarted: () => { throw new SimulatedCrash(); } } });
    expect(crashed.result).toBe("crashed");
    const mid = await h.db.query<{ state: string }>("SELECT state FROM check_results WHERE run_id = $1", [runId]);
    expect(mid.rows).toEqual([{ state: "STARTED" }]);
    expect((await getRun(h, ws.viewer, runId)).status).toBe("running");
    expect(await runWorkerOnce(h.ctx)).toMatchObject({ job: null }); // live lease: nobody else touches it
    h.advance(61);
    const restarted = await runWorkerOnce(h.ctx);
    expect(restarted).toMatchObject({ result: "done", job: { attempt: 2 } });
    const view = await getRun(h, ws.viewer, runId);
    expect(view.status).toBe("complete");
    expect(view.assessment).toBe("INCOMPLETE");
    expect(view.checks).toEqual([expect.objectContaining({ check_key: "chk.uncertain", state: "UNKNOWN" })]);
    expect(view.checks[0].detail).toContain("interrupted by a worker restart");
    expect(view.unknowns.map((u: any) => u.code)).toContain("CHECK_UNKNOWN");
    expect(fx.hits("/ok")).toBe(before); // not re-executed into a pass
    const events = await h.db.query<{ note: string | null }>("SELECT note FROM run_events WHERE run_id = $1 ORDER BY id", [runId]);
    expect(events.rows.some((e) => e.note?.includes("reclaimed"))).toBe(true);
  });

  it("crash after the check concluded: the recorded outcome is kept and the endpoint is not called again", async () => {
    const { runId } = await queueRun(h, ws);
    const before = fx.hits("/ok");
    const crashed = await runWorkerOnce(h.ctx, { hooks: { afterCheckConcluded: () => { throw new SimulatedCrash(); } } });
    expect(crashed.result).toBe("crashed");
    expect(fx.hits("/ok")).toBe(before + 1);
    h.advance(61);
    expect((await runWorkerOnce(h.ctx)).result).toBe("done");
    const view = await getRun(h, ws.viewer, runId);
    expect(view.checks[0]).toMatchObject({ state: "PASSED", attempts: 1 });
    expect(fx.hits("/ok")).toBe(before + 1);
    expect(view.assessment).toBe("AFFECTED");
  });

  it("a check that was left STARTED for a definition that is no longer selected still ends UNKNOWN and forces INCOMPLETE", async () => {
    const { runId } = await queueRun(h, ws);
    await runWorkerOnce(h.ctx, { hooks: { afterCheckStarted: () => { throw new SimulatedCrash(); } } });
    const list = await h.api(ws.admin, "GET", "/api/v1/contract-checks");
    await h.api(ws.admin, "POST", `/api/v1/contract-checks/${list.body.items[0].id}/disable`);
    h.advance(61);
    await runWorkerOnce(h.ctx);
    const view = await getRun(h, ws.viewer, runId);
    expect(view.checks[0].state).toBe("UNKNOWN");
    expect(view.assessment).toBe("INCOMPLETE");
    await h.api(ws.admin, "POST", "/api/v1/contract-checks", { key: "chk.uncertain2", node_id: "contract.invoice", url: `${fx.origin}/ok`, retries: 0 });
  });

  it("a run that dies for good leaves its open check UNKNOWN in the evidence", async () => {
    const { runId } = await queueRun(h, ws);
    // Attempt 1 dies with the check STARTED; attempts 2 and 3 die right after claiming (an interrupted check is
    // concluded UNKNOWN on the first reclaim and is not run again, so only attempt 1 can crash inside a check).
    await runWorkerOnce(h.ctx, { hooks: { afterCheckStarted: () => { throw new SimulatedCrash(); } } });
    for (let i = 0; i < 2; i += 1) {
      h.advance(61);
      await runWorkerOnce(h.ctx, { hooks: { afterClaim: () => { throw new SimulatedCrash(); } } });
    }
    h.advance(61);
    await runWorkerOnce(h.ctx);
    const view = await getRun(h, ws.viewer, runId);
    expect(view).toMatchObject({ status: "failed", error: { code: "WORKER_EXHAUSTED" }, assessment: null });
    expect(view.checks[0].state).toBe("UNKNOWN");
  });
});

describe("transactional outbox and optional event delivery", () => {
  let h: Harness;
  let ws: TestWorkspace;
  const sinks: { close(): Promise<void> }[] = [];
  beforeAll(async () => {
    h = await createHarness();
    ws = await h.workspace("Outbox");
  });
  afterAll(async () => h.close());
  afterEach(async () => {
    while (sinks.length > 0) await sinks.pop()!.close();
  });

  async function startSink(script: (attempt: number) => number) {
    const received: any[] = [];
    let attempt = 0;
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        attempt += 1;
        const status = script(attempt);
        if (status >= 200 && status < 300) received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        res.writeHead(status);
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    sinks.push({ close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) });
    return { port, received, attempts: () => attempt };
  }

  it("state changes emit versioned envelope events in the same transaction", async () => {
    const { runId, snap } = await queueRun(h, ws);
    await h.drain();
    const res = await h.api(ws.operator, "GET", "/api/v1/events?limit=100");
    expect(res.status).toBe(200);
    const envelopes = res.body.items.map((i: any) => i.envelope);
    const imported = envelopes.find((e: any) => e.event_type === "snapshot.imported" && e.resource_id === snap.id);
    const completed = envelopes.find((e: any) => e.event_type === "impact_run.completed" && e.resource_id === runId);
    expect(Object.keys(imported).sort()).toEqual(["event_id", "evidence_ref", "event_type", "occurred_at", "resource_id", "revision", "schema_version", "source"].sort());
    expect(imported).toMatchObject({ schema_version: 1, source: "changeradar", revision: "rev-1", evidence_ref: `/api/v1/snapshots/${snap.id}`, occurred_at: "2026-09-29T00:00:00.000Z" });
    expect(imported.event_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(completed).toMatchObject({ schema_version: 1, evidence_ref: `/api/v1/impact-runs/${runId}`, revision: "rev-1" });
    expect(new Set(envelopes.map((e: any) => e.event_id)).size).toBe(envelopes.length);
    const seqs = res.body.items.map((i: any) => i.seq);
    expect([...seqs].sort((a: number, b: number) => a - b)).toEqual(seqs);
  });

  it("events page by cursor", async () => {
    await h.importSnapshot(ws.operator, baselineDoc());
    await h.importSnapshot(ws.operator, baselineDoc());
    const all = await h.api(ws.operator, "GET", "/api/v1/events?limit=100");
    const p1 = await h.api(ws.operator, "GET", "/api/v1/events?limit=2");
    expect(p1.body.items).toHaveLength(2);
    const p2 = await h.api(ws.operator, "GET", `/api/v1/events?limit=100&cursor=${p1.body.next_cursor}`);
    expect([...p1.body.items, ...p2.body.items].map((i: any) => i.envelope.event_id)).toEqual(all.body.items.map((i: any) => i.envelope.event_id));
    expect((await h.api(ws.operator, "GET", "/api/v1/events?cursor=bad")).status).toBe(400);
  });

  it("a failure while writing the event rolls the whole import back: no snapshot without its event, no event without its snapshot", async () => {
    await h.db.exec(`CREATE FUNCTION test_fail_outbox() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'outbox unavailable'; END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER test_fail_outbox BEFORE INSERT ON outbox_events FOR EACH ROW EXECUTE FUNCTION test_fail_outbox();`);
    const before = { s: await count(h.db, "snapshots"), n: await count(h.db, "nodes"), a: await count(h.db, "audit_events"), i: await count(h.db, "idempotency_keys") };
    const res = await h.importSnapshot(ws.operator, baselineDoc(), { key: "outbox-fail" });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatchObject({ code: "INTERNAL", message: "Internal error" });
    expect(res.text).not.toContain("outbox unavailable");
    expect({ s: await count(h.db, "snapshots"), n: await count(h.db, "nodes"), a: await count(h.db, "audit_events"), i: await count(h.db, "idempotency_keys") }).toEqual(before);
    await h.db.exec("DROP TRIGGER test_fail_outbox ON outbox_events; DROP FUNCTION test_fail_outbox();");
    const retry = await h.importSnapshot(ws.operator, baselineDoc(), { key: "outbox-fail" });
    expect(retry.status).toBe(201); // the failed attempt left no receipt, so the same key is a fresh attempt
  });

  it("delivery is disabled by default: no sink, no outbound request, events stay pending", async () => {
    expect(await relayOutboxOnce(h.ctx)).toEqual({ delivered: 0, failed: 0 });
    const pending = await count(h.db, "outbox_events", "state = 'pending'");
    expect(pending).toBeGreaterThan(0);
  });

  it("delivers to a configured sink at least once: failures stay pending with backoff, later attempts deliver, consumers deduplicate on event_id", async () => {
    const sink = await startSink((attempt) => (attempt === 1 ? 500 : 204));
    const h2 = await createHarness({
      settings: { eventSinkUrl: `http://127.0.0.1:${sink.port}/events`, checks: { ...defaultSettings.checks, allowedHosts: [`127.0.0.1:${sink.port}`], allowPrivateNetwork: true } },
    });
    try {
      const w = await h2.workspace("Sink");
      await h2.importSnapshot(w.operator, baselineDoc());
      const first = await relayOutboxOnce(h2.ctx);
      expect(first).toEqual({ delivered: 0, failed: 1 });
      const row = await h2.db.query<{ state: string; attempts: number; last_error: string; next_attempt_at: Date }>("SELECT state, attempts, last_error, next_attempt_at FROM outbox_events");
      expect(row.rows[0]).toMatchObject({ state: "pending", attempts: 1, last_error: "sink answered HTTP 500" });
      expect(row.rows[0]!.next_attempt_at.getTime()).toBe(h2.now().getTime() + 2000);
      expect(await relayOutboxOnce(h2.ctx)).toEqual({ delivered: 0, failed: 0 }); // not due yet
      h2.advance(3);
      expect(await relayOutboxOnce(h2.ctx)).toEqual({ delivered: 1, failed: 0 });
      expect(sink.received).toHaveLength(1);
      expect(sink.received[0]).toMatchObject({ schema_version: 1, event_type: "snapshot.imported", source: "changeradar" });
      const done = await h2.db.query<{ state: string; last_error: string | null }>("SELECT state, last_error FROM outbox_events");
      expect(done.rows[0]).toEqual({ state: "delivered", last_error: null });
      expect(await relayOutboxOnce(h2.ctx)).toEqual({ delivered: 0, failed: 0 });
    } finally {
      await h2.close();
    }
  });

  it("a crash between a successful delivery and marking it delivered causes a redelivery with the SAME event_id", async () => {
    const sink = await startSink(() => 204);
    const h2 = await createHarness({
      settings: { eventSinkUrl: `http://127.0.0.1:${sink.port}/events`, checks: { ...defaultSettings.checks, allowedHosts: [`127.0.0.1:${sink.port}`], allowPrivateNetwork: true } },
    });
    try {
      const w = await h2.workspace("Redeliver");
      await h2.importSnapshot(w.operator, baselineDoc());
      const { claimEvents } = await import("../../src/services/outbox.js");
      const [claimed] = await claimEvents(h2.db, h2.ctx.clock, 60, 5);
      // The relay POSTed successfully and then died before marking the event delivered.
      const { safePost } = await import("../../src/workers/safe-fetch.js");
      await safePost(`http://127.0.0.1:${sink.port}/events`, Buffer.from(JSON.stringify(claimed!.envelope)), { policy: { allowedHosts: [`127.0.0.1:${sink.port}`], allowPrivateNetwork: true }, timeoutMs: 2000, maxBodyBytes: 4096, maxRedirects: 0 });
      expect(await relayOutboxOnce(h2.ctx)).toEqual({ delivered: 0, failed: 0 }); // lease still live
      h2.advance(61);
      expect(await relayOutboxOnce(h2.ctx)).toEqual({ delivered: 1, failed: 0 });
      expect(sink.received).toHaveLength(2);
      expect(sink.received[0].event_id).toBe(sink.received[1].event_id);
      expect(new Set(sink.received.map((e) => e.event_id)).size).toBe(1); // a consumer keeping event_ids sees one event
    } finally {
      await h2.close();
    }
  });

  it("an unreachable or non-allowlisted sink is a recorded delivery failure, never a crash or a silent drop", async () => {
    const h2 = await createHarness({ settings: { eventSinkUrl: "http://127.0.0.1:9/events", checks: { ...defaultSettings.checks, allowedHosts: [], allowPrivateNetwork: true } } });
    try {
      const w = await h2.workspace("BadSink");
      await h2.importSnapshot(w.operator, baselineDoc());
      expect(await relayOutboxOnce(h2.ctx)).toEqual({ delivered: 0, failed: 1 });
      const row = await h2.db.query<{ state: string; last_error: string }>("SELECT state, last_error FROM outbox_events");
      expect(row.rows[0]?.state).toBe("pending");
      expect(row.rows[0]?.last_error).toContain("allowlist");
    } finally {
      await h2.close();
    }
  });
});
