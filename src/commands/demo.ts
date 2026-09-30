import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { prepareSchema, startServer } from "../api/bootstrap.js";
import { contextFromConfig, loadConfig } from "../platform/config.js";
import { randomToken } from "../platform/crypto.js";
import { createWorkspace, grantUser } from "../services/auth.js";
import { loadDemoFixture } from "./demo-fixture.js";

export const DEMO_MARKER = ".changeradar-demo";
const DEMO_ADMIN = "demo-admin@example.test";
const DEMO_VIEWER = "demo-viewer@example.test";

export interface DemoOptions {
  dir: string;
  port: number;
  reset: boolean;
  /** Directory of the built web UI, or null to serve the API only. */
  webRoot: string | null;
  /** How often a run is polled while the worker finishes it (tests shorten it; 300 polls are made). */
  pollMs?: number;
}

export interface DemoIo {
  out(message: string): void;
  err(message: string): void;
}

interface Session {
  cookie: string;
  csrf: string;
}

/**
 * The synthetic, account-free demo. It builds its own configuration from scratch (never the caller's environment),
 * so it can only use a private embedded database inside `dir`, a one-off encryption key, a loopback bind address and
 * an empty egress allowlist: it makes no outbound request and needs no account. It creates an administrator and a
 * viewer with generated one-time passwords, imports a synthetic multi-service manifest, and requests three impact
 * runs (a seeded breaking removal, an isolated change, and a removal against a baseline with an unverified edge). It
 * refuses to continue if a run does not end with the verdict the fixture documents.
 */
export async function runDemo(options: DemoOptions, io: DemoIo, onStop: (stop: () => Promise<void>) => void): Promise<void> {
  const dir = resolve(options.dir);
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    if (!existsSync(resolve(dir, DEMO_MARKER))) throw new Error(`${dir} exists and is not a ChangeRadar demo directory; choose an empty or new directory with --dir`);
    if (!options.reset) throw new Error(`${dir} holds a previous demo (its one-time passwords cannot be shown again); pass --reset to start over`);
    rmSync(dir, { recursive: true, force: true });
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(resolve(dir, DEMO_MARKER), "synthetic demo data; safe to delete\n", { mode: 0o600 });

  const env: NodeJS.ProcessEnv = {
    CHANGERADAR_DATABASE_URL: `pglite:${resolve(dir, "db")}`,
    CHANGERADAR_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    CHANGERADAR_HOST: "127.0.0.1",
    CHANGERADAR_PORT: String(options.port),
    CHANGERADAR_PUBLIC_URL: `http://localhost:${options.port}`,
    CHANGERADAR_CHECK_ALLOWED_HOSTS: "",
  };
  const config = loadConfig(env);
  const ctx = await contextFromConfig(config);
  const schema = await prepareSchema(ctx);
  if (!schema.ready) {
    await ctx.db.close();
    throw new Error(schema.error ?? "database is not ready");
  }

  const now = ctx.clock.now();
  const adminPassword = randomToken(18);
  const viewerPassword = randomToken(18);
  const workspaceId = await ctx.db.transaction(async (tx) => {
    const id = await createWorkspace(tx, "Demo", now);
    await grantUser(tx, { workspaceId: id, email: DEMO_ADMIN, password: adminPassword, role: "admin", at: now });
    await grantUser(tx, { workspaceId: id, email: DEMO_VIEWER, password: viewerPassword, role: "viewer", at: now });
    return id;
  });

  let server: Awaited<ReturnType<typeof startServer>>;
  try {
    server = await startServer(ctx, { host: config.host, port: config.port, withWorker: true, ...(options.webRoot ? { webRoot: options.webRoot } : {}) });
  } catch (error) {
    await ctx.db.close();
    throw error;
  }
  try {
    const base = server.address;
    const call = async (session: Session | null, method: string, path: string, body?: unknown): Promise<{ status: number; headers: Headers; json: any }> => {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (session) {
        headers.cookie = session.cookie;
        if (method !== "GET") headers["x-csrf-token"] = session.csrf;
      }
      const res = await fetch(`${base}/api/v1${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: res.status, headers: res.headers, json: await res.json().catch(() => null) };
    };
    const must = (res: { status: number; json: any }, expected: number, what: string) => {
      if (res.status !== expected) throw new Error(`demo seeding failed at ${what}: HTTP ${res.status} ${JSON.stringify(res.json?.error ?? null)}`);
      return res.json;
    };

    const login = await call(null, "POST", "/auth/login", { email: DEMO_ADMIN, password: adminPassword, workspace_id: workspaceId });
    const body = must(login, 200, "login");
    const cookie = (login.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "";
    const session: Session = { cookie, csrf: body.csrf_token };

    const fixture = loadDemoFixture(now);
    const importSnapshot = async (revision: string, manifest: Record<string, unknown>) =>
      must(await call(session, "POST", "/snapshots", { schema_version: 1, revision, manifest }), 201, `import ${revision}`) as { id: string; hash: string };
    const assess = async (snapshot: { id: string; hash: string }, proposed: Record<string, unknown>, expected: string) => {
      const receipt = must(await call(session, "POST", "/impact-runs", { snapshot_id: snapshot.id, proposed_manifest: proposed, expected_hash: snapshot.hash }), 202, "request run") as { id: string };
      for (let attempt = 0; attempt < 300; attempt += 1) {
        const run = must(await call(session, "GET", `/impact-runs/${receipt.id}`), 200, "read run");
        if (run.status === "complete" || run.status === "failed") {
          if (run.assessment !== expected) throw new Error(`demo seeding: run ${receipt.id} ended ${run.status}/${run.assessment}, expected ${expected}`);
          return receipt.id;
        }
        await new Promise((r) => setTimeout(r, options.pollMs ?? 100));
      }
      throw new Error(`demo seeding: run ${receipt.id} did not finish in time`);
    };

    const first = await importSnapshot(fixture.manifests.baseline.revision as string, fixture.manifests.baseline);
    const affected = await assess(first, fixture.manifests.proposal_breaking_removal, "AFFECTED");
    const isolated = await assess(first, fixture.manifests.proposal_no_known_impact, "NO_KNOWN_IMPACT");
    const second = await importSnapshot(fixture.manifests.baseline_with_unverified_edge.revision as string, fixture.manifests.baseline_with_unverified_edge);
    const incomplete = await assess(second, fixture.manifests.proposal_breaking_removal, "INCOMPLETE");

    const url = `http://localhost:${options.port}`;
    io.out("ChangeRadar demo: synthetic data, no account, no telemetry, no outbound network access.");
    io.out(`data directory  ${dir} (delete it to remove everything; --reset starts over)`);
    io.out(`open            ${url}/`);
    io.out(`administrator   ${DEMO_ADMIN}   password (shown once): ${adminPassword}`);
    io.out(`viewer          ${DEMO_VIEWER}   password (shown once): ${viewerPassword}`);
    io.out(`workspace       Demo (${workspaceId})`);
    io.out("seeded          a baseline snapshot, then three impact runs:");
    io.out(`  AFFECTED         ${url}/runs/${affected}`);
    io.out(`  NO_KNOWN_IMPACT  ${url}/runs/${isolated}`);
    io.out(`  INCOMPLETE       ${url}/runs/${incomplete}`);
    io.out(`sign in as the administrator to import a snapshot or request a run; the viewer can only read. Listening on 127.0.0.1 (this machine only). Press Ctrl+C to stop.`);
    onStop(async () => {
      await server.stop();
      await ctx.db.close();
    });
    if (!options.webRoot) io.err("web UI not found (run `npm run build`); the API is available at " + url + "/api/v1");
  } catch (error) {
    await server.stop();
    await ctx.db.close();
    throw error;
  }
}
