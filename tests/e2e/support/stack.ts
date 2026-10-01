import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * A real ChangeRadar installation for end-to-end tests: the compiled CLI (`node <cli.js>`), an embedded database in a
 * throwaway directory, the real API, the real job worker and the real web UI. Nothing here is a mock: tests drive it
 * over HTTP and through a browser. Every secret is generated per run.
 */
export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface Stack {
  baseUrl: string;
  port: number;
  dir: string;
  env: NodeJS.ProcessEnv;
  cli: string;
  /** Run one CLI command against this installation (the server must not hold the embedded database at the same time). */
  run(args: string[], options?: { stdin?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<CliResult>;
  /** Start `serve` (API, worker and UI) and wait until it reports it is listening. */
  serve(options?: { args?: string[]; env?: NodeJS.ProcessEnv }): Promise<ServerProcess>;
  cleanup(): void;
}

export interface ServerProcess {
  child: ChildProcess;
  output(): string;
  stop(signal?: NodeJS.Signals): Promise<number | null>;
  exited: Promise<number | null>;
}

export const REPO_ROOT = resolve(import.meta.dirname, "../../..");
export const REPO_CLI = join(REPO_ROOT, "dist/src/cli.js");

export const freePort = (): Promise<number> =>
  new Promise((resolvePort, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as net.AddressInfo).port;
      probe.close(() => resolvePort(port));
    });
  });

export const generatedPassword = (): string => `e2e-${randomBytes(12).toString("hex")}`;

function spawnCli(cli: string, cwd: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  return spawn(process.execPath, [cli, ...args], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
}

/** Create a stack around `cli` (the repository build by default, or an installed tarball's entry point). */
export async function createStack(options: { cli?: string; cwd?: string; extraEnv?: NodeJS.ProcessEnv; keep?: boolean } = {}): Promise<Stack> {
  const dir = mkdtempSync(join(tmpdir(), "changeradar-e2e-"));
  mkdirSync(join(dir, "work"), { recursive: true });
  const port = await freePort();
  const cli = options.cli ?? REPO_CLI;
  const cwd = options.cwd ?? join(dir, "work");
  // A clean environment: only what the server needs, so nothing from the caller's shell (or a stray variable such as a
  // database URL) can leak into the run.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    HOME: dir,
    CHANGERADAR_DATABASE_URL: `pglite:${join(dir, "data")}`,
    CHANGERADAR_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    CHANGERADAR_HOST: "127.0.0.1",
    CHANGERADAR_PORT: String(port),
    CHANGERADAR_PUBLIC_URL: `http://localhost:${port}`,
    ...options.extraEnv,
  };

  const run: Stack["run"] = (args, opts = {}) =>
    new Promise((resolveRun, reject) => {
      const child = spawnCli(cli, cwd, args, { ...env, ...opts.env });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (c: Buffer) => (stdout += c.toString()));
      child.stderr?.on("data", (c: Buffer) => (stderr += c.toString()));
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`changeradar ${args[0]} timed out\n${stdout}\n${stderr}`));
      }, opts.timeoutMs ?? 120_000);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolveRun({ code, stdout, stderr });
      });
      child.stdin?.end(opts.stdin ?? "");
    });

  const serve: Stack["serve"] = (opts = {}) =>
    new Promise((resolveServe, reject) => {
      const child = spawnCli(cli, cwd, ["serve", ...(opts.args ?? [])], { ...env, ...opts.env });
      let output = "";
      let settled = false;
      const exited = new Promise<number | null>((resolveExit) => child.on("close", (code) => resolveExit(code)));
      const onData = (c: Buffer) => {
        output += c.toString();
        if (!settled && /listening on/.test(output)) {
          settled = true;
          clearTimeout(timer);
          resolveServe({
            child,
            output: () => output,
            exited,
            async stop(signal = "SIGTERM") {
              child.kill(signal);
              return exited;
            },
          });
        }
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`serve did not start in 60 s\n${output}`));
      }, 60_000);
      void exited.then((code) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`serve exited early with ${code}\n${output}`));
        }
      });
    });

  return {
    baseUrl: `http://localhost:${port}`,
    port,
    dir,
    env,
    cli,
    run,
    serve,
    cleanup: () => {
      if (!options.keep) rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Create a user with `admin create`; returns the workspace id it belongs to. */
export async function createUser(stack: Stack, input: { email: string; password: string; role: "admin" | "operator" | "viewer"; workspace?: string; workspaceId?: string }): Promise<string> {
  const args = ["admin", "create", "--email", input.email, "--role", input.role, "--password-stdin", ...(input.workspaceId ? ["--workspace-id", input.workspaceId] : ["--workspace", input.workspace ?? "Workspace"])];
  const result = await stack.run(args, { stdin: `${input.password}\n` });
  const id = /in workspace ([0-9a-f-]{36})/.exec(result.stdout)?.[1];
  if (result.code !== 0 || !id) throw new Error(`admin create failed (${result.code}): ${result.stderr}`);
  return id;
}

// ---- a small API client for test setup and assertions (browser flows go through the UI, not through this) ----

export interface Session {
  cookie: string;
  csrf: string;
  workspaceId: string;
}

export async function login(baseUrl: string, email: string, password: string, workspaceId?: string): Promise<Session> {
  const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, ...(workspaceId ? { workspace_id: workspaceId } : {}) }),
  });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { csrf_token: string; user: { workspace_id: string } };
  return { cookie: (res.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "", csrf: body.csrf_token, workspaceId: body.user.workspace_id };
}

export async function api(baseUrl: string, session: Session | null, method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<{ status: number; json: any; text: string; headers: Headers }> {
  const headers: Record<string, string> = { ...extraHeaders };
  if (session) {
    headers.cookie = session.cookie;
    if (method !== "GET") headers["x-csrf-token"] = session.csrf;
  }
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${baseUrl}/api/v1${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, text, headers: res.headers };
}

/** Poll a run until it is complete or failed; returns the run view. */
export async function waitForRun(baseUrl: string, session: Session, id: string, timeoutMs = 60_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await api(baseUrl, session, "GET", `/impact-runs/${id}`);
    if (res.status !== 200) throw new Error(`run read failed: ${res.status} ${res.text}`);
    if (res.json.status === "complete" || res.json.status === "failed") return res.json;
    if (Date.now() > deadline) throw new Error(`run ${id} still ${res.json.status} after ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 150));
  }
}
