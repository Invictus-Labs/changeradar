import dns from "node:dns";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import tls from "node:tls";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prepareSchema } from "../src/api/bootstrap.js";
import { buildApp } from "../src/api/server.js";
import { loadDemoFixture } from "../src/commands/demo-fixture.js";
import { migrationsDir } from "../src/db/migrate.js";
import { type Ctx, defaultSettings } from "../src/platform/context.js";
import { SecretBox } from "../src/platform/crypto.js";
import { silentDiagnostics } from "../src/platform/diagnostics.js";
import { buildBundle, serializeBundle, verifyBundle } from "../src/services/evidence.js";
import { restoreBundle } from "../src/services/restore.js";
import { runWorkerOnce, SimulatedCrash } from "../src/workers/worker.js";
import { billingManifest, clone, e, f, manifest, n, STALE } from "./helpers/builders.js";
import { ALL_FAKE_SECRETS, FAKE_AWS_KEY, FAKE_BEARER, FAKE_GITHUB_TOKEN, SECRET_CORES } from "./helpers/fake-secrets.js";
import { startFixture, type Fixture } from "./helpers/fixture-server.js";
import { count, createHarness, freshDatabase, getRun, type Harness, T0, type TestWorkspace } from "./helpers/harness.js";
import { UUID_UNKNOWN } from "./helpers/ids.js";
import { baselineDoc, removeAmountDoc } from "./helpers/scenario.js";

/**
 * The acceptance suite, indexed by the flows of PRD section 5b (and the AC numbers of section 5). Every row of the
 * "Flow and failure coverage" table has a happy-path test and a sad-path test here that go through the real HTTP API,
 * the real persistence layer (embedded PostgreSQL, or a real PostgreSQL 17 when CHANGERADAR_TEST_DATABASE_URL is set),
 * and the real job worker; contract checks talk to a local FIXTURE HTTP server over a real socket. Time is a fixed
 * UTC clock and every id and secret is synthetic. The finer-grained tests behind each AC are named in
 * docs/qa/ac-matrix.md; this file is the readable index, and it must stay green on its own.
 */

let h: Harness;
let fx: Fixture;
let seq = 0;
const workspace = (label: string): Promise<TestWorkspace> => h.workspace(`${label} ${(seq += 1)}`);
const TABLES = ["snapshots", "nodes", "edges", "impact_runs", "findings", "audit_events", "jobs"];
const rowCounts = async (): Promise<Record<string, number>> => Object.fromEntries(await Promise.all(TABLES.map(async (t) => [t, await count(h.db, t)] as const)));

async function importBaseline(ws: TestWorkspace, doc: unknown = baselineDoc(), revision = "rev-1") {
  const res = await h.importSnapshot(ws.operator, doc, { revision });
  expect(res.status, res.text).toBe(201);
  return res.body as { id: string; hash: string; warnings: { code: string }[] };
}

async function assess(ws: TestWorkspace, snap: { id: string; hash: string }, proposed: unknown, extra: Record<string, unknown> = {}) {
  const res = await h.requestRun(ws.operator, { snapshot_id: snap.id, proposed_manifest: proposed, expected_hash: snap.hash, ...extra });
  expect(res.status, res.text).toBe(202);
  await h.drain();
  return getRun(h, ws.viewer, res.body.id);
}

beforeAll(async () => {
  fx = await startFixture();
  h = await createHarness({ settings: { checks: { ...defaultSettings.checks, allowedHosts: [`127.0.0.1:${fx.port}`], allowPrivateNetwork: true, backoffBaseMs: 5 } } });
});
afterAll(async () => {
  await h.close();
  await fx.close();
});

describe("manifest validation (AC-01)", () => {
  it("happy: a schema-versioned manifest with unique node ids and source provenance is imported (201 {id, hash, warnings})", async () => {
    const ws = await workspace("AC-01 happy");
    const res = await h.importSnapshot(ws.operator, baselineDoc(), { revision: "2026-09-29.1" });
    expect(res.status, res.text).toBe(201);
    expect(res.body).toMatchObject({ revision: "2026-09-29.1", node_count: 7, edge_count: 6, is_baseline: true });
    expect(res.body.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(Array.isArray(res.body.warnings)).toBe(true);
    const edges = await h.api(ws.viewer, "GET", `/api/v1/snapshots/${res.body.id}/edges`);
    expect(edges.body.items.every((x: any) => typeof x.source_file === "string" && Number.isInteger(x.source_line))).toBe(true);
    const nodes = await h.api(ws.viewer, "GET", `/api/v1/snapshots/${res.body.id}/nodes`);
    expect(new Set(nodes.body.items.map((x: any) => x.id)).size).toBe(nodes.body.items.length);
  });

  it("sad: a dangling edge is rejected atomically (422) and leaves no row in any table and no new baseline", async () => {
    const ws = await workspace("AC-01 dangling");
    const first = await importBaseline(ws);
    const before = await rowCounts();
    const dangling = billingManifest((_nodes, edges) => edges.push(e("svc.mailer", "svc.ghost", "consumes")));
    const res = await h.importSnapshot(ws.operator, dangling, { revision: "dangling" });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("DANGLING_EDGE");
    expect(await rowCounts()).toEqual(before);
    expect((await h.api(ws.viewer, "GET", "/api/v1/baseline")).body.snapshot.id).toBe(first.id);
  });

  it("sad: an unsupported major schema version (in the manifest and in the request) is rejected before anything is stored", async () => {
    const ws = await workspace("AC-01 version");
    const before = await rowCounts();
    const future = { ...baselineDoc(), schema_version: 2 };
    const inManifest = await h.importSnapshot(ws.operator, future);
    expect(inManifest.status).toBe(422);
    expect(inManifest.body.error.code).toBe("UNSUPPORTED_SCHEMA_VERSION");
    const inEnvelope = await h.api(ws.operator, "POST", "/api/v1/snapshots", { schema_version: 2, revision: "x", manifest: baselineDoc() });
    expect(inEnvelope.status).toBe(422);
    expect(await rowCounts()).toEqual(before);
  });

  it("sad: duplicate node ids, malformed JSON and a secret-looking value are all refused with no state change", async () => {
    const ws = await workspace("AC-01 misc");
    const before = await rowCounts();
    const duplicate = billingManifest((nodes) => nodes.push(n("svc.billing", "service")));
    expect((await h.importSnapshot(ws.operator, duplicate)).body.error.code).toBe("DUPLICATE_NODE_ID");
    expect((await h.api(ws.operator, "POST", "/api/v1/snapshots", undefined, { raw: "{ not json" })).status).toBe(400);
    const secret = billingManifest((nodes) => ((nodes[0] as { owner: string }).owner = FAKE_AWS_KEY));
    const refused = await h.importSnapshot(ws.operator, secret);
    expect(refused.status).toBe(422);
    expect(refused.text).not.toContain(FAKE_AWS_KEY);
    expect(await rowCounts()).toEqual(before);
  });
});

describe("breaking contract propagation (AC-02)", () => {
  it("happy: removing a required field names direct and transitive consumers with an ordered source-to-consumer path and an owner", async () => {
    const ws = await workspace("AC-02 happy");
    const snap = await importBaseline(ws);
    const run = await assess(ws, snap, removeAmountDoc());
    expect(run).toMatchObject({ status: "complete", assessment: "AFFECTED" });
    const byConsumer = new Map<string, any>(run.affected.map((a: any) => [a.consumer_id, a]));
    expect(byConsumer.get("job.export")).toMatchObject({ direct: true, consumer_owner: "team-data" });
    expect(byConsumer.get("artifact.report")).toMatchObject({ direct: false, depth: 2 });
    expect(byConsumer.get("svc.dashboard")).toMatchObject({ direct: false, depth: 3, consumer_owner: "team-web" });
    const path = run.paths.find((p: any) => p.finding_id === byConsumer.get("svc.dashboard").id);
    expect(path.path).toEqual(["contract.invoice", "job.export", "artifact.report", "svc.dashboard"]);
    expect(path.hops.map((x: any) => [x.from, x.to])).toEqual([["contract.invoice", "job.export"], ["job.export", "artifact.report"], ["artifact.report", "svc.dashboard"]]);
    expect(path.hops.every((x: any) => x.source_file && x.source_line)).toBe(true);
  });

  it("sad: a consumer that declared only other fields is not reported, and a viewer cannot request the run at all (no run, no job)", async () => {
    const ws = await workspace("AC-02 sad");
    const snap = await importBaseline(ws);
    const run = await assess(ws, snap, removeAmountDoc());
    expect(run.affected.map((a: any) => a.consumer_id)).not.toContain("svc.mailer"); // it declared only invoice_id
    const before = await rowCounts();
    const denied = await h.requestRun(ws.viewer, { snapshot_id: snap.id, proposed_manifest: removeAmountDoc(), expected_hash: snap.hash });
    expect(denied.status).toBe(403);
    expect(await rowCounts()).toEqual(before);
  });
});

describe("cycles and determinism (AC-03)", () => {
  const cyclic = (drop: boolean) => {
    const nodes = [n("svc.a", "service", { owner: "team-a" }), n("svc.b", "service", { owner: "team-b" }), n("contract.c", "contract", { owner: "team-c", fields: drop ? [f("id")] : [f("id"), f("amount", "number")] })];
    return manifest(nodes, [e("svc.a", "svc.b", "consumes"), e("svc.b", "svc.a", "consumes"), e("svc.a", "contract.c", "consumes")]);
  };

  it("happy: a dependency cycle terminates deterministically, is reported once, and each consumer appears once", async () => {
    const ws = await workspace("AC-03 cycle");
    const snap = await importBaseline(ws, cyclic(false));
    expect(snap.warnings.map((w) => w.code)).toContain("CYCLE_DETECTED");
    const run = await assess(ws, snap, cyclic(true));
    expect(run.status).toBe("complete");
    expect(run.cycles).toHaveLength(1);
    expect(run.cycles[0].members).toEqual(["svc.a", "svc.b"]);
    const consumers = run.affected.map((a: any) => a.consumer_id);
    expect(new Set(consumers).size).toBe(consumers.length);
    expect(consumers).toEqual(expect.arrayContaining(["svc.a", "svc.b"]));
  });

  it("happy: importing identical content twice (in a different order) gives the same graph hash, and identical assessments give the same sorted finding ids", async () => {
    const ws = await workspace("AC-03 determinism");
    const one = await importBaseline(ws, baselineDoc(), "a");
    const shuffled = clone(baselineDoc()) as { nodes: unknown[]; edges: unknown[] };
    shuffled.nodes.reverse();
    shuffled.edges.reverse();
    const two = await importBaseline(ws, shuffled, "b");
    expect(two.hash).toBe(one.hash);
    const r1 = await assess(ws, two, removeAmountDoc());
    const r2 = await assess(ws, two, removeAmountDoc());
    expect(r2.affected.map((a: any) => a.id)).toEqual(r1.affected.map((a: any) => a.id));
    expect(r2.proposed_hash).toBe(r1.proposed_hash);
  });

  it("sad: a changed manifest never reuses a hash: one edited field changes the graph hash", async () => {
    const ws = await workspace("AC-03 hash");
    const one = await importBaseline(ws, baselineDoc(), "a");
    const edited = billingManifest((nodes) => ((nodes[2] as { owner: string }).owner = "team-other"));
    const two = await importBaseline(ws, edited, "b");
    expect(two.hash).not.toBe(one.hash);
  });
});

describe("unknown coverage (AC-04)", () => {
  it("happy: an isolated change says NO_KNOWN_IMPACT together with explicit coverage limits (never 'safe')", async () => {
    const ws = await workspace("AC-04 isolated");
    const snap = await importBaseline(ws);
    const isolated = billingManifest((nodes) => nodes.push(n("svc.loner", "service")));
    const run = await assess(ws, snap, isolated);
    expect(run.assessment).toBe("NO_KNOWN_IMPACT");
    expect(run.coverage.limits.length).toBeGreaterThan(0);
    expect(run.coverage.limits.map((l: any) => l.code)).toContain("MANIFEST_DECLARED_ONLY");
    expect(JSON.stringify(run)).not.toMatch(/\bsafe\b/i);
  });

  it("sad: a stale consumer contract makes the same change INCOMPLETE, and the known breaks stay visible", async () => {
    const ws = await workspace("AC-04 stale");
    const staleBaseline = billingManifest((_n, edges) => ((edges[1] as { verified_at: string }).verified_at = STALE));
    const snap = await importBaseline(ws, staleBaseline);
    const run = await assess(ws, snap, removeAmountDoc());
    expect(run.assessment).toBe("INCOMPLETE");
    expect(run.unknowns.map((u: any) => u.code)).toContain("STALE_CONTRACT");
    expect(run.affected.length).toBeGreaterThan(0);
    expect(run.status).toBe("complete"); // complete describes computation, not safety
  });

  it("sad: never verified, a missing owner, and an unimported placeholder consumer each force INCOMPLETE", async () => {
    const cases: [string, Record<string, unknown>, string][] = [
      ["never verified", billingManifest((_n, edges) => ((edges[1] as { verified_at: null }).verified_at = null)), "UNVERIFIED_CONTRACT"],
      ["missing owner", billingManifest((nodes) => delete (nodes[2] as { owner?: string }).owner), "MISSING_OWNER"],
      ["placeholder consumer", billingManifest((nodes) => ((nodes[2] as { placeholder?: boolean }).placeholder = true)), "PLACEHOLDER_NODE"],
    ];
    for (const [label, doc, code] of cases) {
      const ws = await workspace(`AC-04 ${label}`);
      const snap = await importBaseline(ws, doc);
      const run = await assess(ws, snap, removeAmountDoc());
      expect(run.assessment, label).toBe("INCOMPLETE");
      expect(run.unknowns.map((u: any) => u.code), label).toContain(code);
    }
  });
});

describe("baseline race (AC-05)", () => {
  it("happy: a run is assessed against the immutable baseline hash it named", async () => {
    const ws = await workspace("AC-05 happy");
    const snap = await importBaseline(ws);
    const run = await assess(ws, snap, removeAmountDoc());
    expect(run.baseline_hash).toBe(snap.hash);
    expect(run.snapshot_id).toBe(snap.id);
  });

  it("sad: a stale expected_hash, and a snapshot that stopped being the baseline, are 409 STALE_BASELINE and create no run", async () => {
    const ws = await workspace("AC-05 stale");
    const snap = await importBaseline(ws, baselineDoc(), "old");
    const before = await rowCounts();
    const wrongHash = await h.requestRun(ws.operator, { snapshot_id: snap.id, proposed_manifest: removeAmountDoc(), expected_hash: `sha256:${"0".repeat(64)}` });
    expect(wrongHash.status).toBe(409);
    expect(wrongHash.body.error.code).toBe("STALE_BASELINE");
    const moved = await importBaseline(ws, billingManifest((nodes) => nodes.push(n("svc.new", "service"))), "new");
    const beforeMoved = await rowCounts();
    const stale = await h.requestRun(ws.operator, { snapshot_id: snap.id, proposed_manifest: removeAmountDoc(), expected_hash: snap.hash });
    expect(stale.status).toBe(409);
    expect(stale.body.error.details).toMatchObject({ current_baseline_snapshot_id: moved.id });
    expect((await rowCounts()).impact_runs).toBe(beforeMoved.impact_runs);
    expect(before.impact_runs).toBe(beforeMoved.impact_runs);
  });

  it("sad: run requests racing a baseline change are each accepted against the baseline that was current, or refused with 409, never assessed stale", async () => {
    const ws = await workspace("AC-05 race");
    let snap = await importBaseline(ws, baselineDoc(), "r0");
    // The two ends of the race are pinned deterministically first: a request that lands before the import is accepted,
    // one that lands after it is refused.
    const early = await h.requestRun(ws.operator, { snapshot_id: snap.id, proposed_manifest: removeAmountDoc(), expected_hash: snap.hash });
    expect(early.status, early.text).toBe(202);
    snap = await importBaseline(ws, billingManifest((nodes) => nodes.push(n("svc.pinned", "service"))), "r0b");
    const rounds = 6;
    let accepted = 1;
    let refused = 0;
    for (let round = 1; round <= rounds; round += 1) {
      const next = billingManifest((nodes) => nodes.push(n(`svc.round-${round}`, "service")));
      const [imported, run] = await Promise.all([
        h.importSnapshot(ws.operator, next, { revision: `r${round}` }),
        h.requestRun(ws.operator, { snapshot_id: snap.id, proposed_manifest: removeAmountDoc(), expected_hash: snap.hash }),
      ]);
      expect(imported.status, imported.text).toBe(201);
      expect([202, 409]).toContain(run.status);
      if (run.status === 409) {
        expect(run.body.error.code).toBe("STALE_BASELINE");
        refused += 1;
      } else accepted += 1;
      snap = imported.body;
    }
    const late = await h.requestRun(ws.operator, { snapshot_id: snap.id, proposed_manifest: removeAmountDoc(), expected_hash: `sha256:${"0".repeat(64)}` });
    expect(late.status).toBe(409);
    await h.drain();
    // Every request got exactly one answer, and the database agrees with the answers.
    expect(accepted + refused).toBe(rounds + 1);
    const runs = await h.db.query<{ run_version: number; snapshot_version: number }>(
      "SELECT r.baseline_version AS run_version, s.baseline_version AS snapshot_version FROM impact_runs r JOIN snapshots s ON s.id = r.snapshot_id WHERE r.workspace_id = $1",
      [ws.id],
    );
    expect(runs.rows).toHaveLength(accepted);
    // The invariant: a run was accepted only while its snapshot WAS the workspace baseline, so the baseline version
    // recorded on the run is the version of the snapshot it points at. (An accepted run assessed stale would differ.)
    for (const run of runs.rows) expect(run.run_version).toBe(run.snapshot_version);
  });
});

describe("contract timeout (AC-06)", () => {
  async function runWith(ws: TestWorkspace, check: Record<string, unknown>) {
    const created = await h.api(ws.admin, "POST", "/api/v1/contract-checks", { key: `chk.${(seq += 1)}`, node_id: "contract.invoice", retries: 0, ...check });
    expect(created.status, created.text).toBe(201);
    const snap = await importBaseline(ws);
    return assess(ws, snap, removeAmountDoc(), { check_keys: [created.body.key] });
  }

  it("happy: a read-only check that answers as declared is PASSED and adds no unknown", async () => {
    const ws = await workspace("AC-06 pass");
    const run = await runWith(ws, { url: `${fx.origin}/ok`, timeout_ms: 2000, required_fields: [{ name: "invoice_id", type: "string" }] });
    expect(run.checks[0]).toMatchObject({ state: "PASSED" });
    expect(run.assessment).toBe("AFFECTED");
  });

  it("sad: a hung endpoint times out within the configured limit, is TIMED_OUT (never PASSED) and forces INCOMPLETE", async () => {
    const ws = await workspace("AC-06 timeout");
    const started = Date.now();
    const run = await runWith(ws, { url: `${fx.origin}/hang`, timeout_ms: 200 });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(run.checks[0]).toMatchObject({ state: "TIMED_OUT", error_code: "TIMEOUT" });
    expect(run.assessment).toBe("INCOMPLETE");
    expect(run.unknowns.map((u: any) => u.code)).toContain("CHECK_TIMED_OUT");
  });

  it("sad: a wrong answer, a server error and an unreachable endpoint are FAILED or ERROR, visible, never converted to passed", async () => {
    for (const [path, state] of [["/wrong-type", "FAILED"], ["/server-error", "FAILED"], ["/not-json", "FAILED"]] as const) {
      const ws = await workspace(`AC-06 ${path}`);
      const run = await runWith(ws, { url: `${fx.origin}${path}`, timeout_ms: 2000, required_fields: [{ name: "invoice_id", type: "string" }] });
      expect(run.checks[0].state, path).toBe(state);
      expect(run.assessment, path).toBe("INCOMPLETE");
    }
    const ws = await workspace("AC-06 unreachable");
    const refusedPort = await new Promise<number>((resolvePort) => {
      const probe = net.createServer();
      probe.listen(0, "127.0.0.1", () => {
        const port = (probe.address() as net.AddressInfo).port;
        probe.close(() => resolvePort(port));
      });
    });
    const created = await h.api(ws.admin, "POST", "/api/v1/contract-checks", { key: "chk.closed", node_id: "contract.invoice", url: `http://127.0.0.1:${refusedPort}/ok`, retries: 0 });
    // A destination that is not on the operator allowlist cannot even be configured: live operations fail explicitly.
    expect(created.status).toBe(422);
    expect(created.body.error.code).toBe("URL_NOT_ALLOWED");
  });
});

describe("report equivalence (AC-07)", () => {
  it("happy: the JSON export, the HTML export and the API list exactly the same finding ids, under the same report hash", async () => {
    const ws = await workspace("AC-07 happy");
    const snap = await importBaseline(ws);
    const run = await assess(ws, snap, removeAmountDoc());
    const json = await h.api(ws.viewer, "GET", `/api/v1/impact-runs/${run.id}/export?format=json`);
    const html = await h.api(ws.viewer, "GET", `/api/v1/impact-runs/${run.id}/export?format=html`);
    const ids = json.body.findings.map((x: any) => x.id).sort();
    expect(ids).toEqual(run.affected.map((a: any) => a.id).sort());
    expect([...new Set(html.text.match(/fnd_[0-9a-f]+/g))].sort()).toEqual(ids);
    expect(html.text).toContain(json.body.report_hash);
    expect(json.body.report_hash).toMatch(/^sha256:/);
  });

  it("sad: empty, denied and failed states are answered explicitly: an empty workspace lists nothing, no session is 401, a viewer's write is 403, an unfinished run exports no verdict", async () => {
    const ws = await workspace("AC-07 states");
    expect((await h.api(ws.viewer, "GET", "/api/v1/impact-runs")).body).toEqual({ items: [], next_cursor: null });
    expect((await h.api(ws.viewer, "GET", "/api/v1/baseline")).body.snapshot).toBeNull();
    expect((await h.api(null, "GET", "/api/v1/snapshots")).status).toBe(401);
    expect((await h.importSnapshot(ws.viewer, baselineDoc())).status).toBe(403);
    const snap = await importBaseline(ws);
    const queued = await h.requestRun(ws.operator, { snapshot_id: snap.id, proposed_manifest: removeAmountDoc(), expected_hash: snap.hash });
    const exported = await h.api(ws.viewer, "GET", `/api/v1/impact-runs/${queued.body.id}/export?format=json`);
    expect(exported.status).toBe(200);
    expect(exported.body.run.assessment ?? null).toBeNull();
    expect(exported.body.findings).toEqual([]);
    await h.drain();
  });
});

describe("offline demo (AC-08)", () => {
  afterEach(() => vi.restoreAllMocks());
  const isLocal = (host: unknown) => host === undefined || host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "";

  it("happy: the synthetic demo dataset yields its documented verdicts on a fixed clock with every outbound path denied", async () => {
    const attempts: string[] = [];
    const original = net.Socket.prototype.connect;
    vi.spyOn(net.Socket.prototype, "connect").mockImplementation(function (this: net.Socket, ...args: unknown[]) {
      const first = args[0] as { host?: string; path?: string } | undefined;
      const host = typeof first === "object" && first !== null ? first.host : typeof args[1] === "string" ? args[1] : undefined;
      if (!(typeof first === "object" && first?.path) && !isLocal(host)) {
        attempts.push(`socket ${String(host)}`);
        throw new Error("outbound denied");
      }
      return (original as (...a: unknown[]) => net.Socket).apply(this, args);
    } as never);
    const deny = (name: string) => () => {
      attempts.push(name);
      throw new Error("outbound denied");
    };
    vi.spyOn(dns, "lookup").mockImplementation(deny("dns.lookup") as never);
    vi.spyOn(dns.promises, "lookup").mockImplementation(deny("dns.promises.lookup") as never);
    vi.spyOn(http, "request").mockImplementation(deny("http.request") as never);
    vi.spyOn(https, "request").mockImplementation(deny("https.request") as never);
    vi.spyOn(tls, "connect").mockImplementation(deny("tls.connect") as never);
    vi.spyOn(globalThis, "fetch").mockImplementation((() => {
      attempts.push("fetch");
      throw new Error("outbound denied");
    }) as never);

    const fixture = loadDemoFixture(T0);
    const ws = await workspace("AC-08 demo");
    const baseline = await importBaseline(ws, fixture.manifests.baseline, "demo-baseline-1");
    const affected = await assess(ws, baseline, fixture.manifests.proposal_breaking_removal);
    const expected = fixture.expected.breaking_removal_against_baseline as unknown as { direct_consumers: string[]; transitive_consumers: string[]; not_affected: string[] };
    expect(affected.assessment).toBe("AFFECTED");
    expect(affected.affected.filter((a: any) => a.direct).map((a: any) => a.consumer_id).sort()).toEqual([...expected.direct_consumers].sort());
    expect(affected.affected.filter((a: any) => !a.direct).map((a: any) => a.consumer_id).sort()).toEqual([...expected.transitive_consumers].sort());
    expect((await assess(ws, baseline, fixture.manifests.proposal_no_known_impact)).assessment).toBe("NO_KNOWN_IMPACT");
    const unverified = await importBaseline(ws, fixture.manifests.baseline_with_unverified_edge, "demo-baseline-2");
    expect((await assess(ws, unverified, fixture.manifests.proposal_breaking_removal)).assessment).toBe("INCOMPLETE");
    expect(attempts).toEqual([]);
  });

  it("sad: a live connector that cannot be reached fails explicitly (ERROR, run INCOMPLETE), and there is no telemetry sink unless an operator configures one", async () => {
    const ws = await workspace("AC-08 disconnected");
    const snap = await importBaseline(ws);
    const port = await new Promise<number>((resolvePort) => {
      const probe = net.createServer();
      probe.listen(0, "127.0.0.1", () => {
        const p = (probe.address() as net.AddressInfo).port;
        probe.close(() => resolvePort(p));
      });
    });
    const off = await createHarness({ settings: { checks: { ...defaultSettings.checks, allowedHosts: [`127.0.0.1:${port}`], allowPrivateNetwork: true, backoffBaseMs: 5 } } });
    try {
      const w = await off.workspace("Disconnected");
      const check = await off.api(w.admin, "POST", "/api/v1/contract-checks", { key: "chk.down", node_id: "contract.invoice", url: `http://127.0.0.1:${port}/ok`, retries: 0, timeout_ms: 1000 });
      expect(check.status, check.text).toBe(201);
      const s = await off.importSnapshot(w.operator, baselineDoc());
      const r = await off.requestRun(w.operator, { snapshot_id: s.body.id, proposed_manifest: removeAmountDoc(), expected_hash: s.body.hash });
      await off.drain();
      const view = await getRun(off, w.viewer, r.body.id);
      expect(view.checks[0].state).toBe("ERROR");
      expect(view.assessment).toBe("INCOMPLETE");
    } finally {
      await off.close();
    }
    expect(snap.id).toBeTruthy();
    expect(defaultSettings.eventSinkUrl).toBeNull();
    expect(defaultSettings.checks.allowedHosts).toEqual([]);
  });
});

describe("redaction and hostile input (AC-09)", () => {
  it("happy: hostile HTML in owner, revision and source text renders as escaped text in the HTML export", async () => {
    const ws = await workspace("AC-09 html");
    const hostile = '<img src=x onerror="window.__pwned=1">';
    const doc = billingManifest((nodes, edges) => {
      (nodes[2] as { owner: string }).owner = hostile;
      (edges[1] as { source_file: string }).source_file = "<script>window.__pwned=1</script>";
    });
    const snap = await importBaseline(ws, doc);
    const run = await assess(ws, snap, billingManifest((nodes, edges) => {
      (nodes[2] as { owner: string }).owner = hostile;
      (edges[1] as { source_file: string }).source_file = "<script>window.__pwned=1</script>";
      const contract = nodes[1] as { contract: { fields: { name: string }[] } };
      contract.contract.fields = contract.contract.fields.filter((x) => x.name !== "amount");
    }));
    const html = await h.api(ws.viewer, "GET", `/api/v1/impact-runs/${run.id}/export?format=html`);
    expect(html.text).not.toContain(hostile);
    expect(html.text).not.toContain("<script>window.__pwned");
    expect(html.text).toContain("&lt;img src=x onerror=");
    expect(String(html.headers["content-security-policy"])).toContain("default-src 'none'");
  });

  it("sad: size and schema are validated before processing: oversize bodies, too many nodes and too many edges are 413 before any item is inspected", async () => {
    const small = await createHarness({ settings: { maxManifestBytes: 4096, maxNodes: 50, maxEdges: 60 } });
    try {
      const ws = await small.workspace("Limits");
      const before = await count(small.db, "snapshots");
      const big = await small.api(ws.operator, "POST", "/api/v1/snapshots", { schema_version: 1, revision: "x", manifest: { schema_version: 1, revision: "x", nodes: [], edges: [], pad: "a".repeat(8192) } });
      expect(big.status).toBe(413);
      expect(big.body.error.code).toBe("PAYLOAD_TOO_LARGE");
      const nodes = await small.api(ws.operator, "POST", "/api/v1/snapshots", { schema_version: 1, revision: "x", manifest: { schema_version: 1, revision: "x", nodes: Array.from({ length: 51 }, () => 1), edges: [] } });
      expect(nodes.status).toBe(413);
      expect(nodes.body.error.code).toBe("TOO_MANY_NODES");
      const edges = await small.api(ws.operator, "POST", "/api/v1/snapshots", { schema_version: 1, revision: "x", manifest: { schema_version: 1, revision: "x", nodes: [], edges: Array.from({ length: 61 }, () => 1) } });
      expect(edges.status).toBe(413);
      expect(edges.body.error.code).toBe("TOO_MANY_EDGES");
      expect(await count(small.db, "snapshots")).toBe(before);
    } finally {
      await small.close();
    }
  });

  it("sad: planted secrets in a manifest, a header, a query string and a cookie never appear in any response, export, bundle, audit row or the whole database", async () => {
    const lines: string[] = [];
    const capture = await createHarness({ diagnostics: (entry) => lines.push(JSON.stringify(entry)) });
    try {
      const ws = await capture.workspace("Secrets");
      const bad = await capture.importSnapshot(ws.operator, billingManifest((nodes) => ((nodes[0] as { owner: string }).owner = FAKE_GITHUB_TOKEN)));
      expect(bad.status).toBe(422);
      expect(bad.text).not.toContain(FAKE_GITHUB_TOKEN);
      const snap = await capture.importSnapshot(ws.operator, baselineDoc());
      const probe = await capture.api(ws.operator, "GET", `/api/v1/snapshots?token=${encodeURIComponent(FAKE_GITHUB_TOKEN)}`, undefined, { headers: { authorization: FAKE_BEARER, "x-api-key": FAKE_AWS_KEY } });
      expect(probe.status).toBeLessThan(500);
      const run = await capture.requestRun(ws.operator, { snapshot_id: snap.body.id, proposed_manifest: removeAmountDoc(), expected_hash: snap.body.hash });
      await capture.drain();
      const json = await capture.api(ws.viewer, "GET", `/api/v1/impact-runs/${run.body.id}/export?format=json`);
      const html = await capture.api(ws.viewer, "GET", `/api/v1/impact-runs/${run.body.id}/export?format=html`);
      const bundle = serializeBundle((await buildBundle(capture.db, { workspaceId: ws.id }, capture.now()))!);
      const dump = JSON.stringify(await Promise.all(["snapshots", "nodes", "edges", "impact_runs", "findings", "audit_events", "outbox_events", "idempotency_keys"].map((t) => capture.db.query(`SELECT * FROM ${t}`).then((r) => r.rows).catch(() => []))));
      for (const secret of [...ALL_FAKE_SECRETS, ...SECRET_CORES]) {
        for (const [name, text] of Object.entries({ bad: bad.text, probe: probe.text, json: json.text, html: html.text, bundle, dump, logs: lines.join("\n") })) expect(text, `${name} leaks a planted secret`).not.toContain(secret);
      }
    } finally {
      await capture.close();
    }
  });
});

describe("portability and corruption (AC-10)", () => {
  it("happy: an evidence bundle verifies and restores into a clean installation with identical ids, hashes and report hash", async () => {
    const ws = await workspace("AC-10 happy");
    const snap = await importBaseline(ws);
    const run = await assess(ws, snap, removeAmountDoc());
    const report = await h.api(ws.viewer, "GET", `/api/v1/impact-runs/${run.id}/export?format=json`);
    const text = serializeBundle((await buildBundle(h.db, { workspaceId: ws.id }, h.now()))!);
    expect(verifyBundle(text, { maxBytes: 250 * 1024 * 1024 }).snapshots).toHaveLength(1);
    const clean = await createHarness();
    try {
      const summary = await restoreBundle(clean.ctx, text);
      expect(summary).toMatchObject({ workspace_id: ws.id, snapshots: 1, impact_runs: 1 });
      const viewer = await clean.userIn(ws.id, "viewer");
      const restored = await clean.api(viewer, "GET", `/api/v1/impact-runs/${run.id}/export?format=json`);
      expect(restored.body.report_hash).toBe(report.body.report_hash);
      expect(restored.body.findings.map((x: any) => x.id)).toEqual(report.body.findings.map((x: any) => x.id));
      expect((await clean.api(viewer, "GET", `/api/v1/snapshots/${snap.id}`)).body.hash).toBe(snap.hash);
    } finally {
      await clean.close();
    }
  });

  it("sad: truncated, edited and unsupported bundles are rejected and the clean installation holds no partial state", async () => {
    const ws = await workspace("AC-10 corrupt");
    const snap = await importBaseline(ws);
    await assess(ws, snap, removeAmountDoc());
    const text = serializeBundle((await buildBundle(h.db, { workspaceId: ws.id }, h.now()))!);
    const clean = await createHarness();
    try {
      // Each refusal is named: `toThrow()` alone would accept ANY error, so a removed version check (which would
      // fall through to another refusal) could not be seen here (review round 1).
      const attempts: [string, string][] = [
        [text.slice(0, Math.floor(text.length / 2)), "BUNDLE_MALFORMED"],
        [text.slice(0, text.length - 5), "BUNDLE_MALFORMED"],
        [text.replace("team-data", "team-datx"), "BUNDLE_HASH_MISMATCH"],
        [JSON.stringify({ ...JSON.parse(text), schema_version: 2 }), "BUNDLE_UNSUPPORTED_VERSION"],
        ["", "BUNDLE_MALFORMED"],
        ["not json", "BUNDLE_MALFORMED"],
      ];
      for (const [bad, code] of attempts) await expect(restoreBundle(clean.ctx, bad), code).rejects.toMatchObject({ code });
      for (const table of ["workspaces", "snapshots", "nodes", "edges", "impact_runs", "findings"]) expect(await count(clean.db, table), table).toBe(0);
      await restoreBundle(clean.ctx, text); // the clean installation still accepts the good bundle
      expect(await count(clean.db, "impact_runs")).toBe(1);
    } finally {
      await clean.close();
    }
  });
});

describe("workspace isolation (AC-12)", () => {
  it("happy: each role can do what it may: viewer reads, operator imports and runs, admin also manages checks", async () => {
    const ws = await workspace("AC-12 roles");
    expect((await h.importSnapshot(ws.operator, baselineDoc())).status).toBe(201);
    expect((await h.importSnapshot(ws.admin, baselineDoc())).status).toBe(201);
    expect((await h.api(ws.viewer, "GET", "/api/v1/snapshots")).status).toBe(200);
    expect((await h.api(ws.operator, "GET", "/api/v1/contract-checks")).status).toBe(200);
    expect((await h.api(ws.viewer, "GET", "/api/v1/contract-checks")).status).toBe(403);
    expect((await h.api(ws.operator, "POST", "/api/v1/contract-checks", { key: "x", node_id: "contract.invoice", url: `${fx.origin}/ok` })).status).toBe(403);
    expect((await h.api(ws.admin, "GET", "/api/v1/audit")).status).toBe(200);
    expect((await h.api(ws.operator, "GET", "/api/v1/audit")).status).toBe(403);
  });

  it("sad: another workspace's object ids are 404 (indistinguishable from unknown ids) on reads, exports and run requests, and change nothing", async () => {
    const mine = await workspace("AC-12 mine");
    const theirs = await workspace("AC-12 theirs");
    const foreign = await importBaseline(theirs);
    const foreignRun = await assess(theirs, foreign, removeAmountDoc());
    const before = await rowCounts();
    const unknown = UUID_UNKNOWN;
    for (const path of [`/snapshots/${foreign.id}`, `/snapshots/${foreign.id}/nodes`, `/snapshots/${foreign.id}/manifest`, `/impact-runs/${foreignRun.id}`, `/impact-runs/${foreignRun.id}/findings`, `/impact-runs/${foreignRun.id}/export?format=json`, `/impact-runs/${foreignRun.id}/bundle`]) {
      const res = await h.api(mine.admin, "GET", `/api/v1${path}`);
      const missing = await h.api(mine.admin, "GET", `/api/v1${path.replace(foreign.id, unknown).replace(foreignRun.id, unknown)}`);
      expect(res.status, path).toBe(404);
      expect(res.body.error.code).toBe(missing.body.error.code);
      expect(res.body.error.message).toBe(missing.body.error.message);
    }
    const run = await h.requestRun(mine.admin, { snapshot_id: foreign.id, proposed_manifest: removeAmountDoc(), expected_hash: foreign.hash });
    expect(run.status).toBe(404);
    expect(await rowCounts()).toEqual(before);
    expect((await h.api(mine.admin, "GET", "/api/v1/snapshots")).body.items).toEqual([]);
  });
});

describe("restart and restore (AC-13)", () => {
  it("happy: a worker that dies right after claiming a job is replaced after the lease expires and the run completes", async () => {
    const ws = await workspace("AC-13 lease");
    const snap = await importBaseline(ws);
    const queued = await h.requestRun(ws.operator, { snapshot_id: snap.id, proposed_manifest: removeAmountDoc(), expected_hash: snap.hash });
    const crashed = await runWorkerOnce(h.ctx, { hooks: { afterClaim: () => { throw new SimulatedCrash(); } } });
    expect(crashed.result).toBe("crashed");
    expect((await runWorkerOnce(h.ctx)).job).toBeNull(); // the lease is still live: nobody else may touch it
    h.advance(61);
    expect(await runWorkerOnce(h.ctx)).toMatchObject({ result: "done", job: { attempt: 2 } });
    expect(await getRun(h, ws.viewer, queued.body.id)).toMatchObject({ status: "complete", assessment: "AFFECTED" });
  });

  it("sad: an external check that was in flight when the worker died is UNKNOWN after the restart (never passed, never re-run) and the run is INCOMPLETE", async () => {
    const ws = await workspace("AC-13 uncertain");
    const created = await h.api(ws.admin, "POST", "/api/v1/contract-checks", { key: "chk.inflight", node_id: "contract.invoice", url: `${fx.origin}/ok`, retries: 0, timeout_ms: 1000, required_fields: [{ name: "invoice_id", type: "string" }] });
    expect(created.status, created.text).toBe(201);
    const snap = await importBaseline(ws);
    const queued = await h.requestRun(ws.operator, { snapshot_id: snap.id, proposed_manifest: removeAmountDoc(), expected_hash: snap.hash, check_keys: ["chk.inflight"] });
    const hitsBefore = fx.hits("/ok");
    expect((await runWorkerOnce(h.ctx, { hooks: { afterCheckStarted: () => { throw new SimulatedCrash(); } } })).result).toBe("crashed");
    h.advance(61);
    expect((await runWorkerOnce(h.ctx)).result).toBe("done");
    const view = await getRun(h, ws.viewer, queued.body.id);
    expect(view.checks[0].state).toBe("UNKNOWN");
    expect(view.assessment).toBe("INCOMPLETE");
    expect(fx.hits("/ok")).toBe(hitsBefore); // the interrupted outcome was not turned into a pass by calling the endpoint again
  });

  it("sad: a failed migration stops readiness (503 everywhere but liveness), leaves nothing half applied, and readiness returns once it is fixed", async () => {
    const { db, drop } = await freshDatabase();
    const dir = mkdtempSync(join(tmpdir(), "changeradar-spec-migrations-"));
    try {
      cpSync(migrationsDir(), dir, { recursive: true });
      writeFileSync(join(dir, "004_broken.sql"), "CREATE TABLE half_applied (id int); SELECT 1/0;");
      const ctx: Ctx = { db, clock: { now: () => T0 }, box: new SecretBox(Buffer.alloc(32, 3)), settings: { ...defaultSettings, secureCookies: false }, readiness: { ok: false, reason: "starting" }, diagnostics: silentDiagnostics };
      expect((await prepareSchema(ctx, dir)).ready).toBe(false);
      const app = await buildApp(ctx);
      expect((await app.inject({ method: "GET", url: "/api/v1/health/live" })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/api/v1/health/ready" })).statusCode).toBe(503);
      expect((await app.inject({ method: "GET", url: "/api/v1/snapshots" })).statusCode).toBe(503);
      const tables = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'half_applied'");
      expect(tables.rows[0]?.n).toBe(0);
      expect((await prepareSchema(ctx)).ready).toBe(true);
      expect((await app.inject({ method: "GET", url: "/api/v1/health/ready" })).statusCode).toBe(200);
      await app.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await db.close();
      await drop();
    }
  });

  it("sad: a restored backup preserves every reference, and work that was unfinished at backup time is restored as FAILED, never as finished", async () => {
    const ws = await workspace("AC-13 restore");
    const snap = await importBaseline(ws);
    const done = await assess(ws, snap, removeAmountDoc());
    const unfinished = await h.requestRun(ws.operator, { snapshot_id: snap.id, proposed_manifest: removeAmountDoc(), expected_hash: snap.hash });
    const text = serializeBundle((await buildBundle(h.db, { workspaceId: ws.id }, h.now()))!);
    await h.drain();
    const clean = await createHarness();
    try {
      const summary = await restoreBundle(clean.ctx, text);
      expect(summary.interrupted_runs).toContain(unfinished.body.id);
      const viewer = await clean.userIn(ws.id, "viewer");
      const restoredDone = await getRun(clean, viewer, done.id);
      expect(restoredDone).toMatchObject({ status: "complete", assessment: "AFFECTED", snapshot_id: snap.id });
      const restoredUnfinished = await getRun(clean, viewer, unfinished.body.id);
      expect(restoredUnfinished.status).toBe("failed");
      expect(restoredUnfinished.assessment).toBeNull();
      expect(restoredUnfinished.error.code).toBe("RESTORED_UNFINISHED");
      expect(await count(clean.db, "jobs", "state = 'queued'")).toBe(0); // nothing is re-queued by a restore
    } finally {
      await clean.close();
    }
  });
});

describe("release documentation exists (AC-11 supporting checks only; AC-11 itself needs a human receipt)", () => {
  const read = (file: string) => readFileSync(resolve(import.meta.dirname, "..", file), "utf8");

  it("the operator guide covers install, upgrade, backup, restore and failure diagnosis, and the runbook and human drill sheet exist", () => {
    const ops = read("docs/OPERATIONS.md");
    for (const heading of [/^## .*install/im, /^## Upgrade/im, /^## Backup and restore/im, /^## Failure diagnosis/im]) expect(ops).toMatch(heading);
    for (const file of ["docs/RUNBOOK-SMOKE.md", "docs/HUMAN-DRILL.md", "README.md", "SECURITY.md", "CONTRIBUTING.md", "CHANGELOG.md"]) expect(existsSync(resolve(import.meta.dirname, "..", file)), file).toBe(true);
    expect(read("docs/HUMAN-DRILL.md")).toContain("PENDING_HUMAN_RECEIPT");
  });
});
