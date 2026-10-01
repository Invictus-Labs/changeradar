/**
 * End-to-end performance experiment through the real HTTP API (docs/BENCHMARK.md, section "Through the API").
 * Usage: npm run bench:api -- [--runs 3] [--sizes 1000:5000,10000:50000]
 * Database target: CHANGERADAR_BENCH_DATABASE_URL (a PostgreSQL server; a throwaway database is created and
 * dropped) or, when unset, the embedded engine. Output is one JSON document on stdout.
 */
import { randomBytes } from "node:crypto";
import os from "node:os";
import pg from "pg";
import { buildApp } from "../src/api/server.js";
import { type Database, openDatabase } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";
import { systemClock } from "../src/domain/clock.js";
import { type Ctx, defaultSettings } from "../src/platform/context.js";
import { SecretBox } from "../src/platform/crypto.js";
import { silentDiagnostics } from "../src/platform/diagnostics.js";
import { createWorkspace, grantUser } from "../src/services/auth.js";
import { restoreBundle } from "../src/services/restore.js";
import { runWorkerOnce } from "../src/workers/worker.js";

const args = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? (args[i + 1] as string) : fallback;
};
const RUNS = Number(flag("runs", "3"));
const SIZES = flag("sizes", "1000:5000,10000:50000")
  .split(",")
  .map((s) => s.split(":").map(Number) as [number, number]);
const PASSWORD = `bench-${randomBytes(9).toString("hex")}`;

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Doc = { schema_version: 1; revision: string; provenance: { source: string }; nodes: any[]; edges: any[] };

/** Same shape as scripts/benchmark.ts: a layered DAG (node i consumes lower numbered nodes) with a few back edges. */
function generate(nodeCount: number, edgeCount: number, seed: number): Doc {
  const random = prng(seed);
  const kinds = ["service", "job", "contract", "credential_alias", "artifact"] as const;
  const nodes: any[] = [];
  for (let i = 0; i < nodeCount; i += 1) {
    const kind = i === 0 ? "contract" : kinds[i % kinds.length]!;
    const node: any = { id: `n${i}`, kind, owner: `team-${i % 40}`, version: "1.0.0" };
    if (kind === "contract") node.contract = { fields: Array.from({ length: 12 }, (_, j) => ({ name: `field_${j}`, type: "string", required: j < 8 })) };
    nodes.push(node);
  }
  const edges: any[] = [];
  const seen = new Set<string>();
  const relations = ["consumes", "consumes", "consumes", "consumes", "requires"] as const;
  // Every node depends on something lower so the root contract reaches nearly everything.
  for (let i = 1; i < nodeCount && edges.length < edgeCount; i += 1) {
    const j = Math.floor(random() * i);
    seen.add(`${i}>${j}`);
    edges.push({ source_id: `n${i}`, target_id: `n${j}`, relation: "consumes", source_file: `m/${i % 200}.yaml`, source_line: (i % 900) + 1, verified_at: "2026-09-28T00:00:00Z" });
  }
  while (edges.length < edgeCount) {
    const i = 1 + Math.floor(random() * (nodeCount - 1));
    const back = random() < 0.002;
    const j = back ? Math.floor(random() * nodeCount) : Math.floor(random() * i);
    const key = `${i}>${j}`;
    if (i === j || seen.has(key)) continue;
    seen.add(key);
    edges.push({ source_id: `n${i}`, target_id: `n${j}`, relation: relations[Math.floor(random() * relations.length)], source_file: `m/${i % 200}.yaml`, source_line: (i % 900) + 1, verified_at: "2026-09-28T00:00:00Z" });
  }
  return { schema_version: 1, revision: "bench", provenance: { source: "benchmark" }, nodes, edges };
}

/** Removes a required field from the root contract: nearly every node becomes a finding (worst case fan-out). */
function proposal(doc: Doc): Doc {
  const clone = JSON.parse(JSON.stringify(doc)) as Doc;
  clone.nodes[0].contract.fields = clone.nodes[0].contract.fields.filter((f: { name: string }) => f.name !== "field_0");
  return clone;
}

async function freshDatabase(): Promise<{ db: Database; kind: string; drop: () => Promise<void> }> {
  const adminUrl = process.env.CHANGERADAR_BENCH_DATABASE_URL;
  if (!adminUrl) return { db: await openDatabase("pglite:memory"), kind: "embedded (PGlite)", drop: async () => undefined };
  const name = `changeradar_bench_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const version = (await admin.query("SHOW server_version")).rows[0].server_version as string;
  await admin.end();
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return {
    db: await openDatabase(url.toString()),
    kind: `PostgreSQL ${version}`,
    drop: async () => {
      const c = new pg.Client({ connectionString: adminUrl });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.end();
    },
  };
}

async function timed<T>(fn: () => Promise<T>): Promise<[number, T]> {
  const start = performance.now();
  const value = await fn();
  return [performance.now() - start, value];
}
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number;
const round = (n: number): number => Math.round(n);

async function main(): Promise<void> {
  const { db, kind, drop } = await freshDatabase();
  const dst = await freshDatabase();
  await migrate(db);
  await migrate(dst.db);
  const ctx: Ctx = {
    db,
    clock: systemClock,
    box: new SecretBox(randomBytes(32)),
    settings: { ...defaultSettings, secureCookies: false, rateLimit: { ...defaultSettings.rateLimit, apiPerPrincipal: 1_000_000, loginPerAccount: 1000, loginPerAddress: 10_000 } },
    readiness: { ok: true, reason: "ready" },
    diagnostics: silentDiagnostics,
  };
  const dstCtx: Ctx = { ...ctx, db: dst.db };
  const workspaceId = await db.transaction(async (tx) => {
    const id = await createWorkspace(tx, "Benchmark", new Date());
    await grantUser(tx, { workspaceId: id, email: "bench@example.test", password: PASSWORD, role: "operator", at: new Date() });
    return id;
  });
  const app = await buildApp(ctx);
  const base = await app.listen({ host: "127.0.0.1", port: 0 });
  const login = await fetch(`${base}/api/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "bench@example.test", password: PASSWORD }) });
  const cookie = (login.headers.get("set-cookie") as string).split(";")[0] as string;
  const csrf = ((await login.json()) as { csrf_token: string }).csrf_token;
  const headers = { cookie, "x-csrf-token": csrf, "content-type": "application/json" };
  const get = (path: string) => fetch(`${base}${path}`, { headers: { cookie } });

  const results: unknown[] = [];
  for (const [nodes, edges] of SIZES) {
    const doc = generate(nodes, edges, 42);
    const changed = proposal(doc);
    const samples: Record<string, number[]> = { import: [], request_run: [], worker: [], get_run: [], all_findings_pages: [], export_json: [], export_html: [], bundle_export: [], restore: [] };
    let findings = 0;
    let bytes = { manifest: 0, report_json: 0, report_html: 0, bundle: 0 };
    for (let run = 0; run < RUNS; run += 1) {
      const body = JSON.stringify({ schema_version: 1, revision: `bench-${nodes}-${run}`, manifest: doc });
      bytes.manifest = body.length;
      const [tImport, imported] = await timed(async () => {
        const res = await fetch(`${base}/api/v1/snapshots`, { method: "POST", headers, body });
        if (res.status !== 201) throw new Error(`import ${res.status} ${await res.text()}`);
        return (await res.json()) as { id: string; hash: string };
      });
      samples.import!.push(tImport);
      const [tRun, queued] = await timed(async () => {
        const res = await fetch(`${base}/api/v1/impact-runs`, { method: "POST", headers, body: JSON.stringify({ snapshot_id: imported.id, proposed_manifest: changed, expected_hash: imported.hash }) });
        if (res.status !== 202) throw new Error(`run ${res.status} ${await res.text()}`);
        return (await res.json()) as { id: string };
      });
      samples.request_run!.push(tRun);
      const [tWorker] = await timed(async () => {
        for (;;) if (!(await runWorkerOnce(ctx)).job) return;
      });
      samples.worker!.push(tWorker);
      const [tGet, view] = await timed(async () => (await (await get(`/api/v1/impact-runs/${queued.id}`)).json()) as { status: string; assessment: string; totals: { findings: number } });
      if (view.status !== "complete") throw new Error(`run ended ${view.status}`);
      findings = view.totals.findings;
      samples.get_run!.push(tGet);
      const [tPages] = await timed(async () => {
        let cursor: string | null = null;
        do {
          const page: { items: unknown[]; next_cursor: string | null } = (await (await get(`/api/v1/impact-runs/${queued.id}/findings?limit=100${cursor ? `&cursor=${cursor}` : ""}`)).json()) as never;
          cursor = page.next_cursor;
        } while (cursor);
      });
      samples.all_findings_pages!.push(tPages);
      const [tJson, json] = await timed(async () => (await get(`/api/v1/impact-runs/${queued.id}/export?format=json`)).text());
      samples.export_json!.push(tJson);
      bytes.report_json = json.length;
      const [tHtml, html] = await timed(async () => (await get(`/api/v1/impact-runs/${queued.id}/export?format=html`)).text());
      samples.export_html!.push(tHtml);
      bytes.report_html = html.length;
      const [tBundle, bundleText] = await timed(async () => {
        const res = await get(`/api/v1/impact-runs/${queued.id}/bundle`);
        return res.text();
      });
      samples.bundle_export!.push(tBundle);
      bytes.bundle = bundleText.length;
      // Restore (including full verification and re-derivation) into a clean installation; the target is emptied
      // between runs so every restore starts clean.
      const [tRestore] = await timed(async () => restoreBundle(dstCtx, bundleText));
      samples.restore!.push(tRestore);
      await dst.db.transaction(async (tx) => {
        await tx.query("SET LOCAL changeradar.purge = 'on'");
        for (const table of ["check_results", "findings", "run_events", "impact_runs", "audit_events"]) await tx.query(`DELETE FROM ${table}`);
        await tx.query("UPDATE workspaces SET baseline_snapshot_id = NULL");
        for (const table of ["edges", "nodes", "snapshots", "contract_checks", "workspaces"]) await tx.query(`DELETE FROM ${table}`);
      });
    }
    results.push({
      nodes,
      edges,
      findings,
      bytes,
      runs: RUNS,
      ms: Object.fromEntries(Object.entries(samples).map(([k, v]) => [k, { median: round(median(v)), min: round(Math.min(...v)), max: round(Math.max(...v)) }])),
      total_median_ms: round(Object.values(samples).reduce((sum, v) => sum + median(v), 0)),
    });
  }
  await app.close();
  const mem = process.memoryUsage();
  console.log(
    JSON.stringify(
      {
        database: kind,
        node: process.version,
        platform: `${os.platform()} ${os.arch()}`,
        cpus: os.cpus().length,
        total_memory_gb: Math.round(os.totalmem() / 1024 ** 3),
        rss_mb_after: Math.round(mem.rss / 1024 / 1024),
        results,
      },
      null,
      2,
    ),
  );
  await db.close();
  await dst.db.close();
  await drop();
  await dst.drop();
}

await main();
