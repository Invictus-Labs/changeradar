import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { billingManifest, clone, e, f, manifest, n, STALE } from "../helpers/builders.js";
import { count, createHarness, getRun, type Harness, type TestWorkspace } from "../helpers/harness.js";
import { addOptionalFieldDoc, baselineDoc, fanOutManifest, removeAmountDoc, unverifiedEdgeDoc } from "../helpers/scenario.js";
import { UUID_ZERO } from "../helpers/ids.js";

async function assessed(h: Harness, ws: TestWorkspace, baseline: unknown, proposed: unknown, extra: Record<string, unknown> = {}) {
  const snap = await h.importSnapshot(ws.operator, baseline);
  expect(snap.status, snap.text).toBe(201);
  const run = await h.requestRun(ws.operator, { snapshot_id: snap.body.id, proposed_manifest: proposed, expected_hash: snap.body.hash, ...extra });
  expect(run.status, run.text).toBe(202);
  await h.drain();
  return { snap: snap.body, run: run.body, view: await getRun(h, ws.viewer, run.body.id) };
}

describe("AC-02 direct and transitive consumers with ordered paths and owners (through the API)", () => {
  let h: Harness;
  let ws: TestWorkspace;
  beforeAll(async () => {
    h = await createHarness();
    ws = await h.workspace("Propagation");
  });
  afterAll(async () => h.close());

  it("POST returns 202 {id,status:'queued'}; GET shows queued before the worker runs, then complete", async () => {
    const snap = await h.importSnapshot(ws.operator, baselineDoc());
    const run = await h.requestRun(ws.operator, { snapshot_id: snap.body.id, proposed_manifest: removeAmountDoc(), expected_hash: snap.body.hash });
    expect(run.status).toBe(202);
    expect(run.body).toMatchObject({ id: expect.any(String), status: "queued" });
    expect(run.headers.location).toBe(`/api/v1/impact-runs/${run.body.id}`);
    const queued = await getRun(h, ws.viewer, run.body.id);
    expect(queued).toMatchObject({ status: "queued", assessment: null, affected: [], paths: [], unknowns: [], totals: { findings: 0, unknowns: 0 }, started_at: null, finished_at: null });
    await h.drain();
    const done = await getRun(h, ws.viewer, run.body.id);
    expect(done.status).toBe("complete");
    expect(done.started_at).toBe("2026-09-29T00:00:00.000Z");
    expect(done.assessment).toBe("AFFECTED");
  });

  it("removing a required field lists direct and transitive consumers, ordered source to consumer, with owners", async () => {
    const { view } = await assessed(h, ws, baselineDoc(), removeAmountDoc());
    expect(view.affected.map((a: { consumer_id: string }) => a.consumer_id)).toEqual(["job.export", "artifact.report", "svc.dashboard"]);
    const byConsumer = new Map<string, { id: string; direct: boolean; depth: number; consumer_owner: string; severity: string }>(view.affected.map((a: any) => [a.consumer_id, a]));
    expect(byConsumer.get("job.export")).toMatchObject({ direct: true, depth: 1, consumer_owner: "team-data", severity: "high" });
    expect(byConsumer.get("svc.dashboard")).toMatchObject({ direct: false, depth: 3, consumer_owner: "team-web", severity: "medium" });
    const pathOf = (consumer: string) => view.paths.find((p: any) => p.finding_id === byConsumer.get(consumer)?.id);
    expect(pathOf("svc.dashboard").path).toEqual(["contract.invoice", "job.export", "artifact.report", "svc.dashboard"]);
    expect(pathOf("svc.dashboard").hops.map((x: any) => `${x.from}>${x.to}`)).toEqual(["contract.invoice>job.export", "job.export>artifact.report", "artifact.report>svc.dashboard"]);
    expect(pathOf("job.export").hops[0]).toMatchObject({ source_file: "manifests/job.export.yaml", source_line: 10 });
    // svc.mailer declared it only relies on invoice_id, so it is precisely NOT affected.
    expect(view.affected.some((a: any) => a.consumer_id === "svc.mailer")).toBe(false);
    expect(view.summary).toMatchObject({ findings: 3, direct_findings: 1, transitive_findings: 2, known_impact: true });
    expect(view.changes.some((c: any) => c.kind === "contract_field_removed")).toBe(true);
  });

  it("finding ids are content derived: identical assessments produce identical ids and order (AC-03)", async () => {
    const first = await assessed(h, ws, baselineDoc(), removeAmountDoc());
    const second = await assessed(h, ws, clone(baselineDoc()), clone(removeAmountDoc()));
    expect(second.run.id).not.toBe(first.run.id);
    expect(second.view.affected.map((a: any) => a.id)).toEqual(first.view.affected.map((a: any) => a.id));
    expect(second.view.baseline_hash).toBe(first.view.baseline_hash);
    expect(second.view.proposed_hash).toBe(first.view.proposed_hash);
  });

  it("AC-03 cycles terminate deterministically and are reported", async () => {
    const cyc = () =>
      manifest(
        [n("contract.c", "contract", { fields: [f("id"), f("total", "number")] }), n("svc.a", "service"), n("svc.b", "service")],
        [e("svc.a", "contract.c", "consumes"), e("svc.b", "svc.a", "consumes"), e("svc.a", "svc.b", "consumes")],
      );
    const proposed = clone(cyc()) as { nodes: { contract?: { fields: { name: string }[] } }[] };
    proposed.nodes[0]!.contract!.fields = proposed.nodes[0]!.contract!.fields.filter((x) => x.name !== "total");
    const a = await assessed(h, ws, cyc(), proposed);
    const b = await assessed(h, ws, cyc(), proposed);
    expect(a.view.status).toBe("complete");
    expect(a.view.affected.map((x: any) => x.consumer_id)).toEqual(["svc.a", "svc.b"]);
    expect(a.view.cycles).toEqual([expect.objectContaining({ members: ["svc.a", "svc.b"] })]);
    expect(b.view.affected.map((x: any) => x.id)).toEqual(a.view.affected.map((x: any) => x.id));
  });
});

describe("AC-04 unknown or stale contracts are INCOMPLETE, never a safe verdict", () => {
  let h: Harness;
  let ws: TestWorkspace;
  beforeAll(async () => {
    h = await createHarness();
    ws = await h.workspace("Unknowns");
  });
  afterAll(async () => h.close());

  it("an unverified edge on an examined path gives INCOMPLETE with the unknown listed and findings still visible", async () => {
    const { view } = await assessed(h, ws, unverifiedEdgeDoc(), removeAmountDoc());
    expect(view.assessment).toBe("INCOMPLETE");
    expect(view.unknowns.map((u: any) => u.code)).toContain("UNVERIFIED_CONTRACT");
    expect(view.summary.known_impact).toBe(true);
    expect(view.affected.length).toBeGreaterThan(0);
    expect(view.status).toBe("complete"); // computation finished; the verdict is what says "not safe to conclude"
  });

  it("a stale contract (verified 60 days ago) gives INCOMPLETE", async () => {
    const stale = billingManifest((_nodes, edges) => {
      for (const edge of edges) if (edge.source_id === "job.export" && edge.target_id === "contract.invoice") edge.verified_at = STALE;
    });
    const { view } = await assessed(h, ws, stale, removeAmountDoc());
    expect(view.assessment).toBe("INCOMPLETE");
    expect(view.unknowns.map((u: any) => u.code)).toContain("STALE_CONTRACT");
  });

  it("a missing owner and an undeclared contract both force INCOMPLETE", async () => {
    const noOwner = billingManifest((nodes) => {
      (nodes[2] as { owner: string | null }).owner = null;
    });
    const { view } = await assessed(h, ws, noOwner, removeAmountDoc());
    expect(view.assessment).toBe("INCOMPLETE");
    expect(view.unknowns.map((u: any) => u.code)).toContain("MISSING_OWNER");

    const undeclared = manifest([n("contract.u", "contract"), n("svc.x", "service")], [e("svc.x", "contract.u", "consumes")]);
    const changed = manifest([{ ...n("contract.u", "contract"), version: "2.0.0" }, n("svc.x", "service")], [e("svc.x", "contract.u", "consumes")]);
    const u = await assessed(h, ws, undeclared, changed);
    expect(u.view.assessment).not.toBe("NO_KNOWN_IMPACT");
  });

  it("an isolated change says NO_KNOWN_IMPACT together with explicit coverage limits", async () => {
    const island = billingManifest((nodes) => nodes.push(n("svc.island", "service")));
    const { view } = await assessed(h, ws, baselineDoc(), island);
    expect(view.assessment).toBe("NO_KNOWN_IMPACT");
    expect(view.affected).toEqual([]);
    const limits = view.coverage.limits.map((l: any) => l.code);
    expect(limits).toEqual(expect.arrayContaining(["MANIFEST_DECLARED_ONLY", "CONTRACT_SUBSET_ONLY", "RUNTIME_NOT_OBSERVED", "INFORMATIONAL_CHANGES_ONLY"]));
    expect(view.coverage.scope).toBe("declared_manifests_only");
    const optional = await assessed(h, ws, baselineDoc(), addOptionalFieldDoc());
    expect(optional.view.assessment).toBe("NO_KNOWN_IMPACT");
    const same = await assessed(h, ws, baselineDoc(), baselineDoc());
    expect(same.view.assessment).toBe("NO_KNOWN_IMPACT");
    expect(same.view.coverage.limits.map((l: any) => l.code)).toContain("NO_CHANGES_DETECTED");
  });

  it("unknowns are capped at 100 in the run view, with the total and a truncation flag", async () => {
    const wide = manifest(
      [n("contract.wide", "contract", { fields: [f("id"), f("total", "number")] }), ...Array.from({ length: 120 }, (_, i) => n(`svc.w${String(i).padStart(3, "0")}`, "service"))],
      Array.from({ length: 120 }, (_, i) => e(`svc.w${String(i).padStart(3, "0")}`, "contract.wide", "consumes", { verified_at: null })),
    );
    const proposed = clone(wide) as { nodes: { contract?: { fields: { name: string }[] } }[] };
    proposed.nodes[0]!.contract!.fields = proposed.nodes[0]!.contract!.fields.filter((x) => x.name !== "total");
    const { view } = await assessed(h, ws, wide, proposed);
    expect(view.assessment).toBe("INCOMPLETE");
    expect(view.totals.unknowns).toBe(120);
    expect(view.unknowns).toHaveLength(100);
    expect(view.truncated.unknowns).toBe(true);
  });
});

describe("AC-05 immutable baseline hash and 409 on a changed baseline", () => {
  let h: Harness;
  let ws: TestWorkspace;
  beforeAll(async () => {
    h = await createHarness();
    ws = await h.workspace("Race");
  });
  afterAll(async () => h.close());

  const runCounts = async () => ({ runs: await count(h.db, "impact_runs"), jobs: await count(h.db, "jobs"), events: await count(h.db, "run_events") });

  it("a stale expected_hash is 409 STALE_BASELINE and creates nothing", async () => {
    const snap = await h.importSnapshot(ws.operator, baselineDoc());
    const before = await runCounts();
    const res = await h.requestRun(ws.operator, { snapshot_id: snap.body.id, proposed_manifest: removeAmountDoc(), expected_hash: "sha256:" + "a".repeat(64) });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: "STALE_BASELINE", request_id: expect.any(String) });
    expect(await runCounts()).toEqual(before);
  });

  it("a malformed expected_hash is 422 INVALID_EXPECTED_HASH", async () => {
    const snap = await h.importSnapshot(ws.operator, baselineDoc());
    for (const bad of ["abc", "sha256:XYZ", "SHA256:" + "a".repeat(64), "sha256:" + "A".repeat(64)]) {
      const res = await h.requestRun(ws.operator, { snapshot_id: snap.body.id, proposed_manifest: removeAmountDoc(), expected_hash: bad });
      expect(res.status, bad).toBe(422);
      expect(res.body.error.code).toBe("INVALID_EXPECTED_HASH");
    }
  });

  it("a snapshot that is no longer the workspace baseline is 409 (sequential concurrent-change case)", async () => {
    const s1 = await h.importSnapshot(ws.operator, baselineDoc(), { revision: "v1" });
    const body = { snapshot_id: s1.body.id, proposed_manifest: removeAmountDoc(), expected_hash: s1.body.hash };
    expect((await h.requestRun(ws.operator, body)).status).toBe(202);
    const s2 = await h.importSnapshot(ws.operator, addOptionalFieldDoc(), { revision: "v2" });
    const before = await runCounts();
    const stale = await h.requestRun(ws.operator, body);
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("STALE_BASELINE");
    expect(stale.body.error.details).toMatchObject({ current_baseline_snapshot_id: s2.body.id, baseline_version: s2.body.baseline_version });
    expect(await runCounts()).toEqual(before);
    // Explicitly opting in to a historical baseline still checks that expected_hash matches THAT snapshot.
    const historical = await h.requestRun(ws.operator, { ...body, allow_superseded: true });
    expect(historical.status).toBe(202);
    const wrongHash = await h.requestRun(ws.operator, { ...body, expected_hash: s2.body.hash, allow_superseded: true });
    expect(wrongHash.status).toBe(409);
    // The current baseline is accepted with its own hash.
    const current = await h.requestRun(ws.operator, { snapshot_id: s2.body.id, proposed_manifest: removeAmountDoc(), expected_hash: s2.body.hash });
    expect(current.status).toBe(202);
  });

  it("REAL CONCURRENCY: a run request racing a baseline change is either accepted against the baseline that was current, or refused", async () => {
    const outcomes = { accepted: 0, refused: 0 };
    for (let i = 0; i < 12; i += 1) {
      const s = await h.importSnapshot(ws.operator, baselineDoc(), { revision: `race-${i}` });
      const run = () => h.requestRun(ws.operator, { snapshot_id: s.body.id, proposed_manifest: removeAmountDoc(), expected_hash: s.body.hash });
      const change = () => h.importSnapshot(ws.operator, addOptionalFieldDoc(), { revision: `race-${i}-next` });
      const [a, b] = i % 2 === 0 ? await Promise.all([run(), change()]) : (await Promise.all([change(), run()])).reverse();
      const runRes = a as Awaited<ReturnType<typeof run>>;
      const importRes = b as Awaited<ReturnType<typeof change>>;
      expect(importRes.status, importRes.text).toBe(201);
      expect([202, 409]).toContain(runRes.status);
      if (runRes.status === 202) {
        outcomes.accepted += 1;
        const row = await h.db.query<{ baseline_version: number }>("SELECT baseline_version FROM impact_runs WHERE id = $1", [runRes.body.id]);
        // Accepted while its snapshot was still the baseline: same counter value, and the import came after.
        expect(row.rows[0]?.baseline_version).toBe(s.body.baseline_version);
        expect(importRes.body.baseline_version).toBeGreaterThan(s.body.baseline_version);
      } else {
        outcomes.refused += 1;
        expect(runRes.body.error.code).toBe("STALE_BASELINE");
      }
    }
    expect(outcomes.accepted + outcomes.refused).toBe(12);
    // Global invariant: no run was ever accepted against a snapshot that was not the baseline at acceptance.
    const bad = await h.db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM impact_runs r JOIN snapshots s ON s.id = r.snapshot_id WHERE r.baseline_version <> s.baseline_version AND NOT r.allow_superseded",
    );
    expect(bad.rows[0]?.n).toBe(0);
  });

  it("many parallel run requests against the same baseline are all accepted, each with its own id", async () => {
    const s = await h.importSnapshot(ws.operator, baselineDoc(), { revision: "parallel" });
    const results = await Promise.all(Array.from({ length: 6 }, () => h.requestRun(ws.operator, { snapshot_id: s.body.id, proposed_manifest: removeAmountDoc(), expected_hash: s.body.hash })));
    expect(results.map((r) => r.status)).toEqual([202, 202, 202, 202, 202, 202]);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(6);
  });
});

describe("impact run validation, lookups and pagination", () => {
  let h: Harness;
  let ws: TestWorkspace;
  beforeAll(async () => {
    h = await createHarness();
    ws = await h.workspace("Validation");
  });
  afterAll(async () => h.close());

  it("rejects an invalid proposed manifest with 422 and creates nothing", async () => {
    const snap = await h.importSnapshot(ws.operator, baselineDoc());
    const before = await count(h.db, "impact_runs");
    const dangling = billingManifest((_n, edges) => edges.push(e("svc.dashboard", "svc.ghost", "consumes")));
    const res = await h.requestRun(ws.operator, { snapshot_id: snap.body.id, proposed_manifest: dangling, expected_hash: snap.body.hash });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("DANGLING_EDGE");
    expect(await count(h.db, "impact_runs")).toBe(before);
  });

  it("rejects malformed request bodies with 422 and unknown snapshots with 404", async () => {
    const snap = await h.importSnapshot(ws.operator, baselineDoc());
    const good = { snapshot_id: snap.body.id, proposed_manifest: removeAmountDoc(), expected_hash: snap.body.hash };
    for (const patch of [{ snapshot_id: "nope" }, { snapshot_id: 5 }, { proposed_manifest: [] }, { proposed_manifest: "x" }, { expected_hash: "" }, { run_checks: "yes" }, { surprise: 1 }, { check_keys: "a" }, { check_keys: ["bad key!"] }]) {
      const res = await h.requestRun(ws.operator, { ...good, ...patch });
      expect(res.status, JSON.stringify(patch)).toBe(422);
      expect(res.body.error.code).toBe("SCHEMA_INVALID");
    }
    const { expected_hash: _drop, ...missing } = good;
    expect((await h.requestRun(ws.operator, missing)).status).toBe(422);
    const unknown = await h.requestRun(ws.operator, { ...good, snapshot_id: UUID_ZERO });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe("NOT_FOUND");
    const tooMany = await h.requestRun(ws.operator, { ...good, check_keys: ["never-defined"] });
    expect(tooMany.status).toBe(422);
    expect(tooMany.body.error.code).toBe("UNKNOWN_CHECK");
  });

  it("run_checks:false is accepted and skips checks", async () => {
    const { view } = await assessed(h, ws, baselineDoc(), removeAmountDoc(), { run_checks: false });
    expect(view.checks).toEqual([]);
    expect(view.assessment).toBe("AFFECTED");
  });

  it("lists runs newest first with status and snapshot filters and cursor pagination", async () => {
    const snap = await h.importSnapshot(ws.operator, baselineDoc(), { revision: "list" });
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      h.advance(1);
      const run = await h.requestRun(ws.operator, { snapshot_id: snap.body.id, proposed_manifest: removeAmountDoc(), expected_hash: snap.body.hash });
      ids.push(run.body.id);
    }
    const queued = await h.api(ws.viewer, "GET", `/api/v1/impact-runs?snapshot_id=${snap.body.id}&status=queued`);
    expect(queued.body.items.map((r: any) => r.id)).toEqual([...ids].reverse());
    const p1 = await h.api(ws.viewer, "GET", `/api/v1/impact-runs?snapshot_id=${snap.body.id}&limit=2`);
    const p2 = await h.api(ws.viewer, "GET", `/api/v1/impact-runs?snapshot_id=${snap.body.id}&limit=2&cursor=${p1.body.next_cursor}`);
    const p3 = await h.api(ws.viewer, "GET", `/api/v1/impact-runs?snapshot_id=${snap.body.id}&limit=2&cursor=${p2.body.next_cursor}`);
    expect([...p1.body.items, ...p2.body.items, ...p3.body.items].map((r: any) => r.id)).toEqual([...ids].reverse());
    expect(p3.body.next_cursor).toBeNull();
    await h.drain();
    const done = await h.api(ws.viewer, "GET", `/api/v1/impact-runs?snapshot_id=${snap.body.id}&status=COMPLETE`);
    expect(done.body.items).toHaveLength(5);
    expect(done.body.items[0]).toMatchObject({ status: "complete", assessment: "AFFECTED", proposed_hash: expect.any(String) });
    expect((await h.api(ws.viewer, "GET", "/api/v1/impact-runs?status=bogus")).status).toBe(422);
    expect((await h.api(ws.viewer, "GET", "/api/v1/impact-runs?snapshot_id=zzz")).status).toBe(422);
    expect((await h.api(ws.viewer, "GET", `/api/v1/impact-runs?cursor=${Buffer.from('["x","y"]').toString("base64url")}`)).status).toBe(400); // round 4: a malformed run cursor is a 400 INVALID_CURSOR, not a 404
  });

  it("caps the run view at 100 findings and serves the rest through cursor pagination", async () => {
    const { view, run } = await assessed(h, ws, fanOutManifest(130), fanOutManifest(130, { dropAmount: true }));
    expect(view.totals.findings).toBe(130);
    expect(view.affected).toHaveLength(100);
    expect(view.truncated.findings).toBe(true);
    const p1 = await h.api(ws.viewer, "GET", `/api/v1/impact-runs/${run.id}/findings?limit=100`);
    const p2 = await h.api(ws.viewer, "GET", `/api/v1/impact-runs/${run.id}/findings?limit=100&cursor=${p1.body.next_cursor}`);
    expect(p1.body.items).toHaveLength(100);
    expect(p2.body.items).toHaveLength(30);
    expect(p2.body.next_cursor).toBeNull();
    const all = [...p1.body.items, ...p2.body.items].map((x: any) => x.id);
    expect(new Set(all).size).toBe(130);
    expect(view.affected.map((a: any) => a.id)).toEqual(all.slice(0, 100));
    expect(p1.body.items[0]).toMatchObject({ path: expect.any(Array), hops: expect.any(Array), consumer_owner: "team-consumers" });
    expect((await h.api(ws.viewer, "GET", `/api/v1/impact-runs/${run.id}/findings?cursor=bad`)).status).toBe(400);
  });
});

describe("AC-07 (server side) exported JSON and HTML carry the same finding ids; hostile text renders as text", () => {
  let h: Harness;
  let ws: TestWorkspace;
  beforeAll(async () => {
    h = await createHarness();
    ws = await h.workspace("Reports");
  });
  afterAll(async () => h.close());

  it("JSON report and HTML report list exactly the API's finding ids", async () => {
    const { run, view } = await assessed(h, ws, baselineDoc(), removeAmountDoc());
    const json = await h.api(ws.viewer, "GET", `/api/v1/impact-runs/${run.id}/export?format=json`);
    const html = await h.api(ws.viewer, "GET", `/api/v1/impact-runs/${run.id}/export?format=html`);
    expect(json.status).toBe(200);
    expect(String(json.headers["content-type"])).toContain("application/json");
    expect(String(html.headers["content-type"])).toContain("text/html");
    expect(String(html.headers["content-security-policy"])).toContain("default-src 'none'");
    expect(json.body).toMatchObject({ schema_version: 1, format: "changeradar-run-report", report_hash: expect.stringMatching(/^sha256:/) });
    const jsonIds = json.body.findings.map((x: any) => x.id);
    expect(jsonIds).toEqual(view.affected.map((x: any) => x.id));
    const htmlIds = [...html.text.matchAll(/data-finding-id="(fnd_[0-9a-f]{20})"/g)].map((m) => m[1]);
    expect(htmlIds).toEqual(jsonIds);
    expect(html.text).toContain(json.body.report_hash);
    const again = await h.api(ws.viewer, "GET", `/api/v1/impact-runs/${run.id}/export?format=json`);
    expect(again.body.report_hash).toBe(json.body.report_hash);
    expect(html.text.startsWith("<!doctype html>")).toBe(true);
    expect((await h.api(ws.viewer, "GET", `/api/v1/impact-runs/${run.id}/export?format=pdf`)).status).toBe(400);
    expect((await h.api(ws.viewer, "GET", `/api/v1/impact-runs/${run.id}/export?format=json&format=html`)).status).toBe(400);
  });

  it("exports of a run that has not finished (or has no owner information) say so instead of inventing a verdict", async () => {
    const snap = await h.importSnapshot(ws.operator, baselineDoc());
    const queued = await h.requestRun(ws.operator, { snapshot_id: snap.body.id, proposed_manifest: removeAmountDoc(), expected_hash: snap.body.hash });
    const json = await h.api(ws.viewer, "GET", `/api/v1/impact-runs/${queued.body.id}/export?format=json`);
    expect(json.body.run).toMatchObject({ status: "queued", assessment: null, finished_at: null, error: null });
    expect(json.body.findings).toEqual([]);
    const html = await h.api(ws.viewer, "GET", `/api/v1/impact-runs/${queued.body.id}/export?format=html`);
    expect(html.text).toContain("status queued, assessment not yet available");

    const noOwner = billingManifest((nodes) => {
      (nodes[2] as { owner: string | null }).owner = null;
    });
    const proposed = clone(noOwner) as { nodes: { id: string; contract?: { fields: { name: string }[] } }[] };
    const contract = proposed.nodes.find((x) => x.id === "contract.invoice")!;
    contract.contract!.fields = contract.contract!.fields.filter((x) => x.name !== "amount");
    const { run } = await assessed(h, ws, noOwner, proposed);
    const ownerless = await h.api(ws.viewer, "GET", `/api/v1/impact-runs/${run.id}/export?format=html`);
    expect(ownerless.text).toContain("unknown owner");
    expect(ownerless.text).toContain("MISSING_OWNER");
  });

  it("a registered report renderer receives the same report object the JSON export serves", async () => {
    const { run } = await assessed(h, ws, baselineDoc(), removeAmountDoc());
    let seen: unknown;
    h.ctx.reportRenderer = {
      render(report) {
        seen = report;
        return `<!doctype html><p>${report.findings.map((x) => x.id).join(",")}</p>`;
      },
    };
    const html = await h.api(ws.viewer, "GET", `/api/v1/impact-runs/${run.id}/export?format=html`);
    const json = await h.api(ws.viewer, "GET", `/api/v1/impact-runs/${run.id}/export?format=json`);
    expect(seen).toEqual(json.body);
    expect(html.text).toContain(json.body.findings[0].id);
    delete h.ctx.reportRenderer;
  });

  it("AC-09 malicious HTML in owner and provenance text renders as literal text", async () => {
    const hostile = '<img src=x onerror=alert(1)><script>alert("x")</script>';
    const base = billingManifest((nodes, edges) => {
      (nodes[2] as { owner: string }).owner = hostile;
      for (const edge of edges) if (edge.source_id === "job.export" && edge.target_id === "contract.invoice") edge.source_file = hostile;
    });
    const proposed = clone(base) as { nodes: { id: string; contract?: { fields: { name: string }[] } }[] };
    const contract = proposed.nodes.find((x) => x.id === "contract.invoice")!;
    contract.contract!.fields = contract.contract!.fields.filter((x) => x.name !== "amount");
    const { run } = await assessed(h, ws, base, proposed);
    const html = await h.api(ws.viewer, "GET", `/api/v1/impact-runs/${run.id}/export?format=html`);
    expect(html.text).not.toContain("<img");
    expect(html.text).not.toContain("<script>alert");
    expect(html.text).toContain("&lt;img src=x onerror=alert(1)&gt;");
    // JSON keeps the text as data (a JSON string cannot execute), which the UI must escape when rendering.
    const json = await h.api(ws.viewer, "GET", `/api/v1/impact-runs/${run.id}/export?format=json`);
    expect(json.body.findings.some((x: any) => x.consumer_owner === hostile)).toBe(true);
  });

  it("the safety net redacts secret-looking text that manifest validation accepted", async () => {
    const soft = billingManifest((nodes) => {
      (nodes[2] as { owner: string }).owner = "team password=plainword";
    });
    const proposed = clone(soft) as { nodes: { id: string; contract?: { fields: { name: string }[] } }[] };
    const contract = proposed.nodes.find((x) => x.id === "contract.invoice")!;
    contract.contract!.fields = contract.contract!.fields.filter((x) => x.name !== "amount");
    const { run, view } = await assessed(h, ws, soft, proposed);
    const owners = view.affected.map((a: any) => a.consumer_owner).join("|");
    expect(owners).not.toContain("plainword");
    const json = await h.api(ws.viewer, "GET", `/api/v1/impact-runs/${run.id}/export?format=json`);
    expect(json.text).not.toContain("plainword");
    expect(json.text).toContain("[REDACTED]");
  });
});
