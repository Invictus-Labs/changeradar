import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { buildApp } from "../../src/api/server.js";
import { type Database, openDatabase } from "../../src/db/index.js";
import { migrate } from "../../src/db/migrate.js";
import type { Clock } from "../../src/domain/clock.js";
import { type Ctx, defaultSettings, type Settings } from "../../src/platform/context.js";
import { SecretBox } from "../../src/platform/crypto.js";
import { silentDiagnostics, type DiagnosticSink } from "../../src/platform/diagnostics.js";
import { createWorkspace, grantUser, type Role } from "../../src/services/auth.js";
import { runWorkerOnce } from "../../src/workers/worker.js";
import type { HostResolver } from "../../src/workers/ssrf.js";
import { NOW_ISO } from "./builders.js";

export const T0 = new Date(NOW_ISO);
/** Synthetic test credential, generated per process so no literal secret-shaped string sits in the source. */
export const PASSWORD = `synthetic-${randomBytes(9).toString("hex")}`;

/** True when the suite runs against a real PostgreSQL server instead of the embedded engine. */
export const usingRealPostgres = Boolean(process.env.CHANGERADAR_TEST_DATABASE_URL);

/**
 * Fresh database per suite: embedded PostgreSQL by default, or a throwaway database on a real server when
 * CHANGERADAR_TEST_DATABASE_URL points at one. The same tests run unchanged against both.
 */
export async function freshDatabase(): Promise<{ db: Database; url: string; drop: () => Promise<void> }> {
  const adminUrl = process.env.CHANGERADAR_TEST_DATABASE_URL;
  if (!adminUrl) {
    const db = await openDatabase("pglite:memory");
    return { db, url: "pglite:memory", drop: async () => undefined };
  }
  const name = `changeradar_test_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const db = await openDatabase(url.toString());
  return {
    db,
    url: url.toString(),
    drop: async () => {
      const client = new pg.Client({ connectionString: adminUrl });
      await client.connect();
      await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await client.end();
    },
  };
}

export interface TestUser {
  userId: string;
  email: string;
  cookie: string;
  csrf: string;
  role: Role;
}

export interface TestWorkspace {
  id: string;
  name: string;
  admin: TestUser;
  operator: TestUser;
  viewer: TestUser;
}

export interface ApiOptions {
  csrf?: string | null;
  headers?: Record<string, string>;
  /** Send this exact text as the body instead of JSON.stringify(body). */
  raw?: string;
}

export interface ApiResult {
  status: number;
  body: any;
  headers: Record<string, string | string[] | number | undefined>;
  text: string;
}

export interface HarnessOptions {
  settings?: Partial<Settings>;
  resolver?: HostResolver;
  diagnostics?: DiagnosticSink;
}

export interface Harness {
  ctx: Ctx;
  app: FastifyInstance;
  db: Database;
  now(): Date;
  advance(seconds: number): void;
  workspace(name: string): Promise<TestWorkspace>;
  /** Create a user with `role` in an existing workspace (for example one created by a restore) and log in. */
  userIn(workspaceId: string, role: Role): Promise<TestUser>;
  api(user: TestUser | null, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, body?: unknown, opts?: ApiOptions): Promise<ApiResult>;
  importSnapshot(user: TestUser, manifest: unknown, opts?: { revision?: string; key?: string }): Promise<ApiResult>;
  requestRun(user: TestUser, body: Record<string, unknown>, opts?: { key?: string }): Promise<ApiResult>;
  /** Run the worker until no job is claimable. Returns the number of jobs processed. */
  drain(): Promise<number>;
  rebuildApp(): Promise<void>;
  close(): Promise<void>;
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const { db, drop } = await freshDatabase();
  await migrate(db);
  let current = T0.getTime();
  const clock: Clock = { now: () => new Date(current) };
  const settings: Settings = {
    ...defaultSettings,
    secureCookies: false,
    // The suites make many requests under a frozen clock, so the per-principal limiter is opened wide by
    // default; the rate limit tests override it.
    rateLimit: { ...defaultSettings.rateLimit, apiPerPrincipal: 1_000_000, loginPerAccount: 1000, loginPerAddress: 10_000 },
    ...options.settings,
    checks: { ...defaultSettings.checks, backoffBaseMs: 5, ...(options.settings?.checks ?? {}) },
  };
  const ctx: Ctx = {
    db,
    clock,
    box: new SecretBox(randomBytes(32)),
    settings,
    readiness: { ok: true, reason: "ready" },
    diagnostics: options.diagnostics ?? silentDiagnostics,
    ...(options.resolver ? { resolver: options.resolver } : {}),
  };
  let app = await buildApp(ctx);

  const api: Harness["api"] = async (user, method, url, body, opts = {}) => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (user) headers.cookie = user.cookie;
    const csrf = opts.csrf === undefined ? user?.csrf : opts.csrf;
    if (csrf) headers["x-csrf-token"] = csrf;
    const payload = opts.raw !== undefined ? opts.raw : body === undefined ? undefined : JSON.stringify(body);
    if (payload !== undefined) headers["content-type"] = "application/json";
    const res = await app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });
    let parsed: unknown = null;
    try {
      parsed = res.body ? JSON.parse(res.body) : null;
    } catch {
      parsed = null;
    }
    return { status: res.statusCode, body: parsed, headers: res.headers, text: res.body };
  };

  const loginAs = async (email: string, role: Role): Promise<TestUser> => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ email, password: PASSWORD }),
    });
    if (res.statusCode !== 200) throw new Error(`login failed ${res.statusCode} ${res.body}`);
    const cookie = String(res.headers["set-cookie"]).split(";")[0] as string;
    const body = JSON.parse(res.body);
    return { userId: body.user.id, email, cookie, csrf: body.csrf_token, role };
  };

  const harness: Harness = {
    ctx,
    get app() {
      return app;
    },
    db,
    api,
    now: () => clock.now(),
    advance(seconds) {
      current += seconds * 1000;
    },
    async workspace(name) {
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      const at = clock.now();
      const id = await db.transaction(async (tx) => {
        const ws = await createWorkspace(tx, name, at);
        for (const role of ["admin", "operator", "viewer"] as Role[]) {
          await grantUser(tx, { workspaceId: ws, email: `${role}@${slug}.test`, password: PASSWORD, role, at });
        }
        return ws;
      });
      return {
        id,
        name,
        admin: await loginAs(`admin@${slug}.test`, "admin"),
        operator: await loginAs(`operator@${slug}.test`, "operator"),
        viewer: await loginAs(`viewer@${slug}.test`, "viewer"),
      };
    },
    async userIn(workspaceId, role) {
      const email = `${role}-${workspaceId.slice(0, 8)}@restored.test`;
      await db.transaction((tx) => grantUser(tx, { workspaceId, email, password: PASSWORD, role, at: clock.now() }));
      return loginAs(email, role);
    },
    importSnapshot(user, manifest, opts = {}) {
      return api(
        user,
        "POST",
        "/api/v1/snapshots",
        { schema_version: 1, revision: opts.revision ?? "rev-1", manifest },
        opts.key ? { headers: { "idempotency-key": opts.key } } : {},
      );
    },
    requestRun(user, body, opts = {}) {
      return api(user, "POST", "/api/v1/impact-runs", body, opts.key ? { headers: { "idempotency-key": opts.key } } : {});
    },
    async drain() {
      let count = 0;
      for (;;) {
        const { job } = await runWorkerOnce(ctx);
        if (!job) return count;
        count += 1;
      }
    },
    async rebuildApp() {
      await app.close();
      app = await buildApp(ctx);
    },
    async close() {
      await app.close();
      await db.close();
      await drop();
    },
  };
  return harness;
}

/** Fetch a run through the API and return the body, failing loudly on a non-200. */
export async function getRun(h: Harness, user: TestUser, id: string): Promise<any> {
  const res = await h.api(user, "GET", `/api/v1/impact-runs/${id}`);
  if (res.status !== 200) throw new Error(`GET run ${id} -> ${res.status} ${res.text}`);
  return res.body;
}

export async function count(db: Database, table: string, where = "true", params: unknown[] = []): Promise<number> {
  const r = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, params);
  return r.rows[0]?.n ?? 0;
}
