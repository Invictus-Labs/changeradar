import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/api/server.js";
import { prepareSchema, startServer } from "../../src/api/bootstrap.js";
import { KEEP_RUNNING, runCli, USAGE, type Io } from "../../src/commands/run.js";
import { contextFromConfig, loadConfig } from "../../src/platform/config.js";
import { cpSync } from "node:fs";
import { migrationsDir } from "../../src/db/migrate.js";
import { baselineDoc, removeAmountDoc } from "../helpers/scenario.js";
import { UUID_ONES } from "../helpers/ids.js";

const KEY = Buffer.alloc(32, 5).toString("base64");
const scratch: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "changeradar-cli-"));
  scratch.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

const envFor = (dir: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ CHANGERADAR_DATABASE_URL: `pglite:${join(dir, "db")}`, CHANGERADAR_ENCRYPTION_KEY: KEY, ...extra });

function capture(stdin = ""): { io: Io; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (m) => out.push(m), err: (m) => err.push(m), stdin: async () => stdin }, out, err };
}
async function cli(env: NodeJS.ProcessEnv, args: string[], stdin = "") {
  const c = capture(stdin);
  const code = await runCli(args, env, c.io);
  return { code, out: c.out.join("\n"), err: c.err.join("\n") };
}

/** Log in through a real app instance on the database the CLI wrote to. */
async function loginVia(env: NodeJS.ProcessEnv, email: string, password: string, workspaceId?: string) {
  const ctx = await contextFromConfig(loadConfig({ ...env, CHANGERADAR_PUBLIC_URL: "http://localhost:1" }));
  await prepareSchema(ctx);
  const app = await buildApp(ctx);
  try {
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", headers: { "content-type": "application/json" }, payload: JSON.stringify({ email, password, ...(workspaceId ? { workspace_id: workspaceId } : {}) }) });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  } finally {
    await app.close();
    await ctx.db.close();
  }
}

describe("CLI: help, usage and migrate", () => {
  it("prints usage with exit 0 for help and no arguments, and 64 for an unknown command", async () => {
    const env = envFor(tempDir());
    expect((await cli(env, [])).code).toBe(0);
    expect((await cli(env, ["help"])).code).toBe(0);
    expect((await cli(env, ["--help"])).code).toBe(0);
    const unknown = await cli(env, ["frobnicate"]);
    expect(unknown.code).toBe(64);
    expect(unknown.err).toBe(USAGE);
    expect((await cli(env, ["admin"])).code).toBe(64);
    expect((await cli(env, ["admin", "delete"])).code).toBe(64);
    expect((await cli(env, ["idempotency"])).code).toBe(64);
    expect((await cli(env, ["credential", "explode", "--workspace-id", "x"])).code).toBe(64);
  });

  it("migrate applies once and then reports the schema up to date; missing configuration is a clear error", async () => {
    const env = envFor(tempDir());
    const first = await cli(env, ["migrate"]);
    expect(first).toMatchObject({ code: 0 });
    expect(first.out).toMatch(/applied: 001_identity\.sql, 002_evidence\.sql, 003_jobs_outbox\.sql/);
    expect((await cli(env, ["migrate"])).out).toBe("schema up to date");
    const missing = await cli({}, ["migrate"]);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("missing required configuration");
  });
});

describe("CLI: admin bootstrap (no default password)", () => {
  it("refuses to create a user without an explicit password choice", async () => {
    const env = envFor(tempDir());
    const res = await cli(env, ["admin", "create", "--email", "boss@example.test", "--workspace", "Main"]);
    expect(res.code).toBe(1);
    expect(res.err).toContain("there is no default password");
  });

  it("creates a workspace admin from a password on stdin and that user can log in; a wrong password cannot", async () => {
    const env = envFor(tempDir());
    const res = await cli(env, ["admin", "create", "--email", "Boss@Example.test", "--workspace", "Main", "--password-stdin"], "a-strong-passphrase-1\n");
    expect(res.code).toBe(0);
    const workspaceId = /workspace ([0-9a-f-]{36})/.exec(res.out)?.[1] as string;
    expect(res.out).toContain("created admin boss@example.test");
    expect(res.out).not.toContain("a-strong-passphrase-1");
    const ok = await loginVia(env, "boss@example.test", "a-strong-passphrase-1", workspaceId);
    expect(ok.status).toBe(200);
    expect(ok.body.user).toMatchObject({ role: "admin", workspace_name: "Main" });
    expect((await loginVia(env, "boss@example.test", "another-passphrase-2")).status).toBe(401);
    expect((await loginVia(env, "boss@example.test", "password")).status).toBe(401);
  });

  it("--generate-password prints a strong password exactly once and it works", async () => {
    const env = envFor(tempDir());
    const res = await cli(env, ["admin", "create", "--email", "gen@example.test", "--workspace", "Gen", "--generate-password"]);
    expect(res.code).toBe(0);
    const password = /password \(shown once\): (\S+)/.exec(res.out)?.[1] as string;
    expect(password.length).toBeGreaterThanOrEqual(20);
    expect((await loginVia(env, "gen@example.test", password)).status).toBe(200);
    const again = await cli(env, ["admin", "create", "--email", "gen2@example.test", "--workspace", "Gen2", "--generate-password"]);
    expect(/password \(shown once\): (\S+)/.exec(again.out)?.[1]).not.toBe(password);
  });

  it("validates password strength, email, role, workspace and duplicate membership", async () => {
    const env = envFor(tempDir());
    const created = await cli(env, ["admin", "create", "--email", "first@example.test", "--workspace", "One", "--password-stdin"], "long-enough-passphrase");
    const workspaceId = /workspace ([0-9a-f-]{36})/.exec(created.out)?.[1] as string;
    expect((await cli(env, ["admin", "create", "--email", "weak@example.test", "--workspace", "W", "--password-stdin"], "short")).err).toContain("at least 12 characters");
    expect((await cli(env, ["admin", "create", "--email", "not-an-email", "--workspace", "W", "--password-stdin"], "long-enough-passphrase")).err).toContain("valid email");
    expect((await cli(env, ["admin", "create", "--email", "x@example.test", "--workspace", "W", "--role", "root", "--password-stdin"], "long-enough-passphrase")).err).toContain("--role must be");
    expect((await cli(env, ["admin", "create", "--email", "x@example.test", "--password-stdin"], "long-enough-passphrase")).err).toContain("--workspace is required");
    expect((await cli(env, ["admin", "create", "--email", "x@example.test", "--workspace-id", UUID_ONES, "--password-stdin"], "long-enough-passphrase")).err).toContain("Workspace does not exist");
    expect((await cli(env, ["admin", "create", "--email", "first@example.test", "--workspace-id", workspaceId, "--password-stdin"], "long-enough-passphrase")).err).toContain("already a member");
    const viewer = await cli(env, ["admin", "create", "--email", "reader@example.test", "--workspace-id", workspaceId, "--role", "viewer", "--password-stdin"], "long-enough-passphrase");
    expect(viewer.code).toBe(0);
    expect(viewer.out).toContain("created viewer reader@example.test");
    expect((await cli(env, ["admin", "create", "--email", "x@example.test", "--workspace", "W"])).code).toBe(1);
  });
});

describe("CLI: credentials, idempotency pruning, export, verify and restore", () => {
  const dirs = { source: "", target: "" };
  let sourceEnv: NodeJS.ProcessEnv;
  let targetEnv: NodeJS.ProcessEnv;
  let workspaceId = "";
  let bundleFile = "";

  beforeAll(async () => {
    dirs.source = tempDir();
    dirs.target = tempDir();
    sourceEnv = envFor(dirs.source);
    targetEnv = envFor(dirs.target);
    const created = await cli(sourceEnv, ["admin", "create", "--email", "op@example.test", "--workspace", "Backup", "--role", "operator", "--password-stdin"], "operator-passphrase-1");
    workspaceId = /workspace ([0-9a-f-]{36})/.exec(created.out)?.[1] as string;
    // Populate through the real API, then run the worker over the same database.
    const ctx = await contextFromConfig(loadConfig({ ...sourceEnv, CHANGERADAR_PUBLIC_URL: "http://localhost:1" }));
    await prepareSchema(ctx);
    const app = await buildApp(ctx);
    try {
      const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", headers: { "content-type": "application/json" }, payload: JSON.stringify({ email: "op@example.test", password: "operator-passphrase-1" }) });
      const cookie = String(login.headers["set-cookie"]).split(";")[0] as string;
      const csrf = JSON.parse(login.body).csrf_token as string;
      const post = (url: string, payload: unknown) => app.inject({ method: "POST", url, headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" }, payload: JSON.stringify(payload) });
      const snap = JSON.parse((await post("/api/v1/snapshots", { schema_version: 1, revision: "cli", manifest: baselineDoc() })).body);
      await post("/api/v1/impact-runs", { snapshot_id: snap.id, proposed_manifest: removeAmountDoc(), expected_hash: snap.hash });
      const { runWorkerOnce } = await import("../../src/workers/worker.js");
      await runWorkerOnce(ctx);
    } finally {
      await app.close();
      await ctx.db.close();
    }
    bundleFile = join(dirs.source, "out", "backup.json");
  });

  it("credential set reads the value from stdin, list shows aliases only, delete removes it", async () => {
    const set = await cli(sourceEnv, ["credential", "set", "--workspace-id", workspaceId, "--alias", "billing-api"], "value-from-stdin-123\n");
    expect(set).toMatchObject({ code: 0, out: "credential billing-api stored (sealed)" });
    const list = await cli(sourceEnv, ["credential", "list", "--workspace-id", workspaceId]);
    expect(list.out).toBe("billing-api");
    expect(list.out).not.toContain("value-from-stdin");
    expect((await cli(sourceEnv, ["credential", "set", "--workspace-id", workspaceId, "--alias", "bad alias"], "v")).code).toBe(1);
    expect((await cli(sourceEnv, ["credential", "set", "--workspace-id", workspaceId], "v")).err).toContain("--alias is required");
    expect((await cli(sourceEnv, ["credential", "delete", "--workspace-id", workspaceId, "--alias", "billing-api"])).out).toBe("deleted");
    expect((await cli(sourceEnv, ["credential", "delete", "--workspace-id", workspaceId, "--alias", "billing-api"])).out).toBe("no such alias");
    expect((await cli(sourceEnv, ["credential", "list", "--workspace-id", workspaceId])).out).toBe("");
  });

  it("idempotency prune refuses windows shorter than seven days", async () => {
    expect((await cli(sourceEnv, ["idempotency", "prune"])).out).toMatch(/^deleted \d+ idempotency key\(s\)$/);
    const short = await cli(sourceEnv, ["idempotency", "prune", "--older-than-days", "3"]);
    expect(short.code).toBe(1);
    expect(short.err).toContain("at least 7 days");
  });

  it("retention report is read only; apply needs --approve; the default window is the documented 90 days", async () => {
    const report = await cli(sourceEnv, ["retention", "report"]);
    expect(report.code).toBe(0);
    expect(report.out).toMatch(/^would delete 0 run\(s\), 0 finding\(s\), 0 snapshot\(s\) older than 90 day\(s\)/);
    expect((await cli(sourceEnv, ["retention", "report", "--days", "1", "--workspace-id", workspaceId])).out).toContain("older than 1 day(s)");
    const refused = await cli(sourceEnv, ["retention", "apply"]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("needs --approve");
    const applied = await cli(sourceEnv, ["retention", "apply", "--approve", "--days", "90"]);
    expect(applied.out).toMatch(/^deleted 0 run\(s\)/);
    expect((await cli(sourceEnv, ["retention", "report", "--days", "0"])).err).toContain("at least 1");
    expect((await cli(sourceEnv, ["retention", "purge"])).code).toBe(64);
  });

  it("export writes an owner-only file, refuses to overwrite it, and reports a missing workspace", async () => {
    const res = await cli(sourceEnv, ["export", "--workspace-id", workspaceId, "--out", bundleFile]);
    expect(res.code, res.err).toBe(0);
    expect(res.out).toMatch(/exported 1 snapshot\(s\), 1 run\(s\) to .*backup\.json \(bundle_hash sha256:[0-9a-f]{64}\)/);
    expect(statSync(bundleFile).mode & 0o777).toBe(0o600);
    expect(statSync(join(dirs.source, "out")).mode & 0o777).toBe(0o700);
    const again = await cli(sourceEnv, ["export", "--workspace-id", workspaceId, "--out", bundleFile]);
    expect(again.code).toBe(73); // cannot write the output: documented code, and a readable message instead of a raw errno
    expect(again.err).toContain("already exists");
    expect(again.err).not.toContain("EEXIST");
    const missing = await cli(sourceEnv, ["export", "--workspace-id", UUID_ONES, "--out", join(dirs.source, "none.json")]);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("nothing to export");
    expect(existsSync(join(dirs.source, "none.json"))).toBe(false);
    expect((await cli(sourceEnv, ["export", "--workspace-id", workspaceId])).err).toContain("--out is required");
    const oneRun = await cli(sourceEnv, ["export", "--workspace-id", workspaceId, "--run", UUID_ONES, "--out", join(dirs.source, "none2.json")]);
    expect(oneRun.err).toContain("nothing to export");
  });

  it("verify-bundle needs no database and detects corruption; restore accepts only a verified bundle into a clean installation", async () => {
    const verify = await cli({}, ["verify-bundle", "--in", bundleFile]);
    expect(verify).toMatchObject({ code: 0 });
    expect(verify.out).toMatch(/^bundle ok: 1 snapshot\(s\), 1 run\(s\), bundle_hash sha256:/);

    const text = readFileSync(bundleFile, "utf8");
    const truncated = join(dirs.target, "truncated.json");
    writeFileSync(truncated, text.slice(0, Math.floor(text.length * 0.6)));
    const bad = await cli(targetEnv, ["restore", "--in", truncated]);
    expect(bad.code).toBe(2);
    expect(bad.err).toMatch(/BUNDLE_(MALFORMED|SCHEMA_INVALID|HASH_MISMATCH)/);
    expect((await cli({}, ["verify-bundle", "--in", truncated])).code).toBe(2);
    const unsupported = join(dirs.target, "v2.json");
    writeFileSync(unsupported, text.replace('"schema_version":1,"scope"', '"schema_version":2,"scope"'));
    const v2 = await cli(targetEnv, ["restore", "--in", unsupported]);
    expect(v2.code).toBe(2);
    expect(v2.err).toContain("BUNDLE_UNSUPPORTED_VERSION");
    const huge = await cli({ CHANGERADAR_MAX_BUNDLE_BYTES: "2048" }, ["verify-bundle", "--in", bundleFile]);
    expect(huge.code).toBe(2);
    expect(huge.err).toContain("BUNDLE_TOO_LARGE");
    expect((await cli({ CHANGERADAR_MAX_BUNDLE_BYTES: "12" }, ["verify-bundle", "--in", bundleFile])).err).toContain("at least 1024");
    expect((await cli({}, ["verify-bundle", "--in", join(dirs.target, "does-not-exist.json")])).code).toBe(66);
    // Nothing was accepted by any failed restore.
    const empty = await cli(targetEnv, ["migrate"]);
    expect(empty.code).toBe(0);

    const ok = await cli(targetEnv, ["restore", "--in", bundleFile]);
    expect(ok.code, ok.err).toBe(0);
    expect(ok.out).toContain(`restored workspace ${workspaceId}: 1 snapshot(s), 1 run(s)`);
    expect(ok.out).toContain("changeradar admin create --workspace-id");
    const conflict = await cli(targetEnv, ["restore", "--in", bundleFile]);
    expect(conflict.code).toBe(2);
    expect(conflict.err).toContain("RESTORE_CONFLICT");

    // The restored installation gets its own administrator; the source's users were never copied.
    expect((await loginVia(targetEnv, "op@example.test", "operator-passphrase-1")).status).toBe(401);
    const admin = await cli(targetEnv, ["admin", "create", "--email", "restored@example.test", "--workspace-id", workspaceId, "--generate-password"]);
    expect(admin.code, admin.err).toBe(0);
  });
});

describe("startServer and the serve command", () => {
  it("serves real HTTP and its worker processes queued runs; a failed migration keeps it up but not ready", async () => {
    const dir = tempDir();
    const env = envFor(dir, { CHANGERADAR_PUBLIC_URL: "http://localhost:1" });
    await cli(env, ["admin", "create", "--email", "ops@example.test", "--workspace", "Live", "--role", "operator", "--password-stdin"], "operator-passphrase-1");
    const ctx = await contextFromConfig(loadConfig(env));
    const server = await startServer(ctx, { host: "127.0.0.1", port: 0, withWorker: true });
    try {
      expect(server.ready).toBe(true);
      expect((await fetch(`${server.address}/api/v1/health/ready`)).status).toBe(200);
      const login = await fetch(`${server.address}/api/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "ops@example.test", password: "operator-passphrase-1" }) });
      const cookie = (login.headers.get("set-cookie") as string).split(";")[0] as string;
      const csrf = ((await login.json()) as { csrf_token: string }).csrf_token;
      const headers = { cookie, "x-csrf-token": csrf, "content-type": "application/json" };
      const snap = (await (await fetch(`${server.address}/api/v1/snapshots`, { method: "POST", headers, body: JSON.stringify({ schema_version: 1, revision: "live", manifest: baselineDoc() }) })).json()) as { id: string; hash: string };
      const run = (await (await fetch(`${server.address}/api/v1/impact-runs`, { method: "POST", headers, body: JSON.stringify({ snapshot_id: snap.id, proposed_manifest: removeAmountDoc(), expected_hash: snap.hash }) })).json()) as { id: string };
      let status = "queued";
      for (let i = 0; i < 100 && status !== "complete"; i += 1) {
        await new Promise((r) => setTimeout(r, 50));
        status = ((await (await fetch(`${server.address}/api/v1/impact-runs/${run.id}`, { headers })).json()) as { status: string }).status;
      }
      expect(status).toBe("complete");
    } finally {
      await server.stop();
      await ctx.db.close();
    }

    const brokenDir = mkdtempSync(join(tmpdir(), "changeradar-broken-migrations-"));
    scratch.push(brokenDir);
    cpSync(migrationsDir(), brokenDir, { recursive: true });
    writeFileSync(join(brokenDir, "004_broken.sql"), "SELECT 1/0;");
    const ctx2 = await contextFromConfig(loadConfig(envFor(tempDir())));
    const broken = await startServer(ctx2, { host: "127.0.0.1", port: 0, withWorker: true, migrationsDir: brokenDir });
    try {
      expect(broken.ready).toBe(false);
      const ready = await fetch(`${broken.address}/api/v1/health/ready`);
      expect(ready.status).toBe(503);
      expect(((await ready.json()) as { error: { code: string } }).error.code).toBe("NOT_READY");
      expect((await fetch(`${broken.address}/api/v1/health/live`)).status).toBe(200);
      expect((await fetch(`${broken.address}/api/v1/snapshots`)).status).toBe(503);
    } finally {
      await broken.stop();
      await ctx2.db.close();
    }
  });

  it("the serve command starts, reports ready over HTTP, and stops cleanly on SIGTERM (packaged entry point)", async () => {
    const dir = tempDir();
    const port = await new Promise<number>((resolve) => {
      const probe = net.createServer();
      probe.listen(0, "127.0.0.1", () => {
        const p = (probe.address() as net.AddressInfo).port;
        probe.close(() => resolve(p));
      });
    });
    const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "serve"], {
      env: { ...process.env, ...envFor(dir), CHANGERADAR_PORT: String(port), CHANGERADAR_PUBLIC_URL: `http://localhost:${port}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (d) => (output += String(d)));
    child.stderr.on("data", (d) => (output += String(d)));
    try {
      let ready = false;
      for (let i = 0; i < 150 && !ready; i += 1) {
        await new Promise((r) => setTimeout(r, 100));
        try {
          ready = (await fetch(`http://127.0.0.1:${port}/api/v1/health/ready`)).status === 200;
        } catch {
          ready = false;
        }
      }
      expect(ready, output).toBe(true);
      expect(output).toContain(`listening on http://127.0.0.1:${port}`);
    } finally {
      const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
      child.kill("SIGTERM");
      expect(await exited).toBe(0);
    }
  }, 60_000);

  it("runCli returns KEEP_RUNNING for serve and worker and hands back a stop function", async () => {
    const dir = tempDir();
    const env = envFor(dir, { CHANGERADAR_PORT: "0" });
    // Port 0 is rejected by configuration validation, so use a free port for serve.
    const port = await new Promise<number>((resolve) => {
      const probe = net.createServer();
      probe.listen(0, "127.0.0.1", () => {
        const p = (probe.address() as net.AddressInfo).port;
        probe.close(() => resolve(p));
      });
    });
    let stop: (() => Promise<void>) | undefined;
    const c = capture();
    const code = await runCli(["serve", "--no-worker"], { ...env, CHANGERADAR_PORT: String(port) }, c.io, { onServer: (s) => (stop = s) });
    expect(code).toBe(KEEP_RUNNING);
    expect(c.out.join("\n")).toContain("listening on");
    expect((await fetch(`http://127.0.0.1:${port}/api/v1/health/ready`)).status).toBe(200);
    await stop!();

    const workerIo = capture();
    let stopWorker: (() => Promise<void>) | undefined;
    const workerCode = await runCli(["worker"], envFor(tempDir()), workerIo.io, { onServer: (s) => (stopWorker = s) });
    expect(workerCode).toBe(KEEP_RUNNING);
    expect(workerIo.out.join("\n")).toContain("worker started");
    await stopWorker!();
  });
});
