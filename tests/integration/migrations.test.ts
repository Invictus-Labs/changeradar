import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareSchema } from "../../src/api/bootstrap.js";
import { buildApp } from "../../src/api/server.js";
import { isSchemaCurrent, migrate, MigrationError, migrationsDir } from "../../src/db/migrate.js";
import { defaultSettings, type Ctx } from "../../src/platform/context.js";
import { SecretBox } from "../../src/platform/crypto.js";
import { silentDiagnostics } from "../../src/platform/diagnostics.js";
import { count, createHarness, freshDatabase, type Harness } from "../helpers/harness.js";
import { baselineDoc, removeAmountDoc } from "../helpers/scenario.js";
import { UUID_ONES } from "../helpers/ids.js";

const scratch: string[] = [];
function migrationsCopy(extra: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "changeradar-migrations-"));
  scratch.push(dir);
  cpSync(migrationsDir(), dir, { recursive: true });
  for (const [name, sql] of Object.entries(extra)) writeFileSync(join(dir, name), sql);
  return dir;
}
afterEach(() => {
  while (scratch.length > 0) rmSync(scratch.pop() as string, { recursive: true, force: true });
});

describe("AC-13 migrations", () => {
  it("applies every migration once and is idempotent", async () => {
    const { db, drop } = await freshDatabase();
    try {
      const first = await migrate(db);
      expect(first.applied).toEqual(readdirSync(migrationsDir()).filter((f) => f.endsWith(".sql")).sort());
      expect((await migrate(db)).applied).toEqual([]);
      expect(await isSchemaCurrent(db)).toBe(true);
    } finally {
      await db.close();
      await drop();
    }
  });

  it("a failing migration rolls back completely and leaves the applied schema untouched", async () => {
    const { db, drop } = await freshDatabase();
    try {
      await migrate(db);
      const before = await count(db, "schema_migrations");
      const bad = migrationsCopy({ "005_broken.sql": "CREATE TABLE half_applied (id int); SELECT 1/0;" });
      await expect(migrate(db, bad)).rejects.toThrow(MigrationError);
      await expect(migrate(db, bad)).rejects.toThrow(/005_broken\.sql failed/);
      expect(await count(db, "schema_migrations")).toBe(before);
      const tables = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'half_applied'");
      expect(tables.rows[0]?.n).toBe(0);
      expect(await isSchemaCurrent(db, bad)).toBe(false);
    } finally {
      await db.close();
      await drop();
    }
  });

  it("a failure on a fresh database applies nothing at all", async () => {
    const { db, drop } = await freshDatabase();
    try {
      const bad = migrationsCopy({ "002_evidence.sql": "SELECT 1/0;" });
      await expect(migrate(db, bad)).rejects.toThrow(MigrationError);
      const tables = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'");
      expect(tables.rows[0]?.n).toBe(0);
    } finally {
      await db.close();
      await drop();
    }
  });

  it("refuses a modified applied migration and a database that is ahead of this build", async () => {
    const { db, drop } = await freshDatabase();
    try {
      await migrate(db);
      const modified = migrationsCopy({ "001_identity.sql": "-- tampered\nSELECT 1;" });
      await expect(migrate(db, modified)).rejects.toThrow(/was modified/);
      await db.query("INSERT INTO schema_migrations (version, checksum, applied_at) VALUES ('099_from_the_future.sql', 'x', now())");
      await expect(migrate(db)).rejects.toThrow(/unknown to this build/);
      expect(await isSchemaCurrent(db)).toBe(true);
    } finally {
      await db.close();
      await drop();
    }
  });

  it("concurrent migrators serialize and apply each migration exactly once", async () => {
    const { db, drop } = await freshDatabase();
    try {
      const results = await Promise.all([migrate(db), migrate(db), migrate(db)]);
      expect(results.flatMap((r) => r.applied).length).toBe(readdirSync(migrationsDir()).filter((f) => f.endsWith(".sql")).length);
      expect(await isSchemaCurrent(db)).toBe(true);
    } finally {
      await db.close();
      await drop();
    }
  });

  it("isSchemaCurrent is false before migration and when the table is missing", async () => {
    const { db, drop } = await freshDatabase();
    try {
      expect(await isSchemaCurrent(db)).toBe(false);
    } finally {
      await db.close();
      await drop();
    }
  });
});

describe("AC-13 a failed migration stops readiness and the server refuses traffic", () => {
  async function ctxFor(db: Ctx["db"]): Promise<Ctx> {
    return {
      db,
      clock: { now: () => new Date("2026-09-29T00:00:00Z") },
      box: new SecretBox(Buffer.alloc(32, 7)),
      settings: { ...defaultSettings, secureCookies: false },
      readiness: { ok: false, reason: "starting" },
      diagnostics: silentDiagnostics,
    };
  }

  it("reports not ready, answers 503 everywhere except liveness, and recovers once the migration is fixed", async () => {
    const { db, drop } = await freshDatabase();
    try {
      const ctx = await ctxFor(db);
      const bad = migrationsCopy({ "005_broken.sql": "SELECT 1/0;" });
      const outcome = await prepareSchema(ctx, bad);
      expect(outcome.ready).toBe(false);
      expect(ctx.readiness).toEqual({ ok: false, reason: "migration_failed" });

      const app = await buildApp(ctx);
      const ready = await app.inject({ method: "GET", url: "/api/v1/health/ready" });
      expect(ready.statusCode).toBe(503);
      expect(JSON.parse(ready.body).error).toMatchObject({ code: "NOT_READY" });
      expect((await app.inject({ method: "GET", url: "/api/v1/health/live" })).statusCode).toBe(200);
      for (const [method, url] of [["GET", "/api/v1/snapshots"], ["POST", "/api/v1/auth/login"], ["GET", "/api/v1/impact-runs"]] as const) {
        const res = await app.inject({ method, url, ...(method === "POST" ? { payload: "{}", headers: { "content-type": "application/json" } } : {}) });
        expect(res.statusCode, url).toBe(503);
        expect(JSON.parse(res.body).error.code).toBe("NOT_READY");
      }

      expect((await prepareSchema(ctx)).ready).toBe(true);
      expect((await app.inject({ method: "GET", url: "/api/v1/health/ready" })).statusCode).toBe(200);
      await app.close();
    } finally {
      await db.close();
      await drop();
    }
  });

  it("readiness also fails when the database becomes unavailable or the schema is behind", async () => {
    const h = await createHarness();
    try {
      expect((await h.api(null, "GET", "/api/v1/health/ready")).status).toBe(200);
      await h.db.query("DELETE FROM schema_migrations WHERE version = '003_jobs_outbox.sql'");
      const behind = await h.api(null, "GET", "/api/v1/health/ready");
      expect(behind.status).toBe(503);
      expect(behind.body.error.message).toContain("migration_failed");
      await h.db.query("INSERT INTO schema_migrations (version, checksum, applied_at) VALUES ('003_jobs_outbox.sql', 'x', now())");
      const original = h.ctx.db.query.bind(h.ctx.db);
      h.ctx.db.query = (async () => {
        throw new Error("connection refused");
      }) as never;
      const down = await h.api(null, "GET", "/api/v1/health/ready");
      h.ctx.db.query = original as never;
      expect(down.status).toBe(503);
      expect(down.body.error.message).toContain("database_unavailable");
    } finally {
      await h.close();
    }
  });

  it("prepareSchema classifies a non-migration failure as database_unavailable", async () => {
    const { db, drop } = await freshDatabase();
    try {
      const ctx = await ctxFor(db);
      await db.close();
      const outcome = await prepareSchema(ctx);
      expect(outcome.ready).toBe(false);
      expect(ctx.readiness.reason).toBe("database_unavailable");
    } finally {
      await drop();
    }
  });
});

describe("schema guarantees (append-only history, workspace scoped foreign keys)", () => {
  let h: Harness;
  afterEach(async () => h?.close());

  async function seeded() {
    h = await createHarness();
    const a = await h.workspace("Alpha");
    const b = await h.workspace("Beta");
    const snap = await h.importSnapshot(a.operator, baselineDoc());
    const run = await h.requestRun(a.operator, { snapshot_id: snap.body.id, proposed_manifest: removeAmountDoc(), expected_hash: snap.body.hash });
    await h.drain();
    return { a, b, snap: snap.body, run: run.body };
  }

  it.each([
    ["snapshots", "UPDATE snapshots SET revision = 'x'"],
    ["snapshots", "DELETE FROM snapshots"],
    ["nodes", "UPDATE nodes SET owner = 'x'"],
    ["edges", "DELETE FROM edges"],
    ["findings", "UPDATE findings SET reason = 'x'"],
    ["findings", "DELETE FROM findings"],
    ["run_events", "DELETE FROM run_events"],
    ["audit_events", "UPDATE audit_events SET action = 'x'"],
    ["audit_events", "DELETE FROM audit_events"],
    ["impact_runs", "DELETE FROM impact_runs"],
    ["impact_runs", "UPDATE impact_runs SET status = 'QUEUED'"],
    ["impact_runs", "UPDATE impact_runs SET verdict = 'NO_KNOWN_IMPACT'"],
    ["check_results", "DELETE FROM check_results"],
  ])("%s is append-only: %s is refused", async (table, sql) => {
    await seeded();
    if (table === "check_results") {
      const runs = await h.db.query<{ id: string; workspace_id: string }>("SELECT id, workspace_id FROM impact_runs LIMIT 1");
      await h.db.query("INSERT INTO check_results (id, workspace_id, run_id, check_key, node_id, state, definition, started_at) VALUES (gen_random_uuid(), $1, $2, 'k', 'n', 'PASSED', '{}'::jsonb, now())", [runs.rows[0]?.workspace_id, runs.rows[0]?.id]);
    }
    await expect(h.db.query(sql)).rejects.toThrow(/not permitted|terminal|immutable|concluded/);
  });

  it("run inputs are immutable even before the run is terminal, and a concluded check cannot change", async () => {
    await seeded();
    const snap2 = await h.importSnapshot((await h.workspace("Gamma")).operator, baselineDoc());
    expect(snap2.status).toBe(201);
    const ws = await h.db.query<{ id: string }>("SELECT id FROM workspaces WHERE name = 'Alpha'");
    const snapshot = await h.db.query<{ id: string }>("SELECT id FROM snapshots WHERE workspace_id = $1", [ws.rows[0]?.id]);
    const runId = UUID_ONES;
    await h.db.query(
      `INSERT INTO impact_runs (id, workspace_id, snapshot_id, proposed_hash, expected_hash, baseline_hash, baseline_version, proposed_manifest, status, created_at)
       SELECT $1, $2, $3, proposed_hash, expected_hash, baseline_hash, baseline_version, proposed_manifest, 'QUEUED', now() FROM impact_runs LIMIT 1`,
      [runId, ws.rows[0]?.id, snapshot.rows[0]?.id],
    );
    await expect(h.db.query("UPDATE impact_runs SET proposed_manifest = '{}' WHERE id = $1", [runId])).rejects.toThrow(/immutable/);
    await h.db.query("UPDATE impact_runs SET status = 'RUNNING' WHERE id = $1", [runId]);
    await h.db.query("INSERT INTO check_results (id, workspace_id, run_id, check_key, node_id, state, definition, started_at) VALUES (gen_random_uuid(), $1, $2, 'k', 'n', 'STARTED', '{}'::jsonb, now())", [ws.rows[0]?.id, runId]);
    await h.db.query("UPDATE check_results SET state = 'UNKNOWN' WHERE run_id = $1", [runId]);
    await expect(h.db.query("UPDATE check_results SET state = 'PASSED' WHERE run_id = $1", [runId])).rejects.toThrow(/concluded/);
  });

  it("an explicit purge transaction can delete protected rows; nothing else can", async () => {
    await seeded();
    const before = await count(h.db, "findings");
    expect(before).toBeGreaterThan(0);
    await h.db.transaction(async (tx) => {
      await tx.query("SET LOCAL changeradar.purge = 'on'");
      await tx.query("DELETE FROM findings");
    });
    expect(await count(h.db, "findings")).toBe(0);
  });

  it("foreign keys are workspace scoped: a run cannot point at another workspace's snapshot, nodes cannot cross snapshots", async () => {
    const { a, b, snap } = await seeded();
    const otherWs = await h.db.query<{ id: string }>("SELECT id FROM workspaces WHERE name = 'Beta'");
    await expect(
      h.db.query(
        `INSERT INTO impact_runs (id, workspace_id, snapshot_id, proposed_hash, expected_hash, baseline_hash, baseline_version, proposed_manifest, status, created_at)
         SELECT gen_random_uuid(), $1, $2, proposed_hash, expected_hash, baseline_hash, baseline_version, proposed_manifest, 'QUEUED', now() FROM impact_runs LIMIT 1`,
        [otherWs.rows[0]?.id, snap.id],
      ),
    ).rejects.toThrow(/foreign key/);
    await expect(
      h.db.query("INSERT INTO nodes (workspace_id, snapshot_id, id, kind, version) VALUES ($1, $2, 'x.y', 'service', '1')", [otherWs.rows[0]?.id, snap.id]),
    ).rejects.toThrow(/foreign key/);
    await expect(
      h.db.query("INSERT INTO edges (workspace_id, snapshot_id, source_id, target_id, relation, source_file, source_line) VALUES ($1, $2, 'nope', 'nada', 'consumes', 'f', 1)", [a.id, snap.id]),
    ).rejects.toThrow(/foreign key/);
    expect(b.id).not.toBe(a.id);
  });
});
