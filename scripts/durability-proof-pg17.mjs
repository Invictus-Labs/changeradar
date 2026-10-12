#!/usr/bin/env node
// AC-13 durability proof on a REAL PostgreSQL 17 server (the part of AC-13 the embedded database cannot show):
//
//   node scripts/durability-proof-pg17.mjs            run the proof (needs Docker; prints one receipt line per step)
//   node scripts/durability-proof-pg17.mjs --plan     print the steps and exit 0 without touching anything
//   npm run durability:pg17
//
// What it proves, in order, against a throwaway `postgres:17-alpine` container (published on 127.0.0.1 only, on a
// FIXED free port chosen before the container starts so that it is the same after `docker restart`, with a generated
// password that is passed through a private env file and never on a command line, removed at the end, also on SIGINT
// and SIGTERM; it never touches any other container or volume):
//   1. a run with a live contract check that HANGS is started by a SEPARATE worker process, the worker is killed with
//      `kill -9` while the check is in flight, a new worker is started, and the lease is reclaimed: the check ends
//      UNKNOWN, the run is INCOMPLETE, the run history shows the reclaim, and the external endpoint was hit EXACTLY ONCE
//      (an uncertain outcome is preserved, never re-run to a pass);
//   2. PostgreSQL is restarted (`docker restart`) while a run is verifiably QUEUED (the worker is paused with SIGSTOP, and
//      the run's status is read from the database immediately before the restart and again after it): /health/ready goes
//      503 NOT_READY and then 200 again, the API survives, the worker is resumed and survives, and the queued run
//      completes exactly once with the expected findings (nothing lost, nothing duplicated);
//   3. `pg_dump` of the database is restored into a CLEAN second database served by a second installation: snapshot
//      ids and hashes, run ids and verdicts, finding ids and the JSON report hash are identical, and the application
//      serves them.
//
// Exit codes: 0 every step passed; 1 a step failed (the step is named); 3 SKIPPED-no-docker (Docker or its daemon is
// not available; this is NEVER a pass: the gate reports it as skipped and AC-13 stays PARTIAL); 64 usage.
// It needs the compiled build (`npm run build`), because the point is to kill and restart the real processes.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "dist", "src", "cli.js");

export const STEPS = [
  "docker-available",
  "postgres-17-up",
  "install: migrate, admin, server, separate worker",
  "baseline snapshot, hanging contract check, run requested",
  "kill -9 the worker while the check is in flight",
  "restart the worker: lease reclaimed, check UNKNOWN, run INCOMPLETE, endpoint hit exactly once",
  "restart PostgreSQL with a run verifiably queued: not ready, then ready",
  "the queued run completed exactly once, nothing lost or duplicated",
  "pg_dump restored into a clean second database, served by a second installation",
  "references preserved: snapshot, run and finding ids, hashes, report hash",
];

const args = process.argv.slice(2);
if (args.includes("--plan")) {
  console.log(JSON.stringify({ script: "durability-proof-pg17", image: "postgres:17-alpine", steps: STEPS }, null, 2));
  process.exit(0);
}
if (args.length > 0) {
  console.error("usage: node scripts/durability-proof-pg17.mjs [--plan]");
  process.exit(64);
}

const started = new Date().toISOString();
const receipt = { script: "durability-proof-pg17", started_utc: started, steps: [], docker: null, postgres: null };
const say = (text) => console.log(text);

// ---- Docker preflight: never a pass without it ----
function dockerUsable() {
  const probe = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) return null;
  return probe.stdout.trim();
}
const dockerVersion = dockerUsable();
if (dockerVersion === null) {
  say("SKIPPED-no-docker: Docker or its daemon is not available, so the AC-13 durability proof was NOT run (this is not a pass)");
  process.exit(3);
}
receipt.docker = dockerVersion;
if (!existsSync(cli)) {
  console.error("durability-proof: dist/src/cli.js is missing; run `npm run build` first");
  process.exit(1);
}

// ---- helpers ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () =>
  new Promise((resolvePort, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
async function until(label, fn, timeoutMs, everyMs = 250) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await sleep(everyMs);
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}${last instanceof Error ? ` (last error: ${last.message})` : ""}`);
}
function expect(condition, message) {
  if (!condition) throw new Error(message);
}

const suffix = randomBytes(3).toString("hex");
const container = `changeradar-durability-${suffix}`;
const work = mkdtempSync(join(tmpdir(), "changeradar-durability-"));
const pgPassword = randomBytes(16).toString("hex");
const encryptionKey = randomBytes(32).toString("base64");
const dbA = `cr_a_${suffix}`;
const dbB = `cr_b_${suffix}`;
const children = new Map(); // name -> ChildProcess (only processes this script started)
let containerCreated = false;
let workerPaused = false;
let hangServer = null;

const psql = (db, sql) => execFileSync("docker", ["exec", container, "psql", "-U", "cr", "-d", db, "-At", "-c", sql], { encoding: "utf8" }).trim();
const cleanupBody = async () => {
  for (const [name, child] of children) {
    try {
      if (child.exitCode === null && child.signalCode === null) {
        // A worker paused with SIGSTOP is resumed first, so it is never left stopped, then killed.
        if (workerPaused) child.kill("SIGCONT");
        child.kill("SIGKILL");
      }
    } catch {
      /* already gone */
    }
    children.delete(name);
  }
  if (hangServer) {
    hangServer.closeAllConnections?.();
    hangServer.close();
  }
  if (containerCreated) spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" });
  rmSync(join(work, "postgres.env"), { force: true });
  rmSync(work, { recursive: true, force: true });
};
// Idempotent: the normal path and a signal may both call it; only the first call does the work.
let cleanupPromise = null;
const cleanup = () => (cleanupPromise ??= cleanupBody());
// An interrupted run removes its container, its processes and its files, then exits 130 (SIGINT) or 143 (SIGTERM).
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
  process.on(signal, () => {
    console.error(`durability-proof: ${signal}, cleaning up`);
    cleanup().finally(() => process.exit(code));
  });
}

async function step(name, fn) {
  const at = new Date().toISOString();
  try {
    const detail = await fn();
    receipt.steps.push({ step: name, result: "PASS", at_utc: at, detail: detail ?? null });
    say(`PASS  ${name}${detail ? `: ${detail}` : ""}`);
  } catch (error) {
    receipt.steps.push({ step: name, result: "FAIL", at_utc: at, detail: error.message });
    say(`FAIL  ${name}: ${error.message}`);
    throw error;
  }
}

// ---- the external endpoint the check calls: it HANGS, and counts how often it was hit ----
const hang = { hits: 0, open: new Set() };
hangServer = http.createServer((req, res) => {
  hang.hits += 1;
  hang.open.add(res);
  res.on("close", () => hang.open.delete(res));
  // never answered: the check is "in flight" until the worker dies
});
await new Promise((r) => hangServer.listen(0, "127.0.0.1", r));
const hangPort = hangServer.address().port;

const apiPortA = await freePort();
const apiPortB = await freePort();
// Chosen before the container exists and published explicitly: a random published port (`-p 127.0.0.1::5432`) is not
// guaranteed to be the same after `docker restart`, and every connection string below carries this number.
const pgPort = await freePort();

const envFor = (db, apiPort) => ({
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? work,
  TMPDIR: work,
  CHANGERADAR_DATABASE_URL: `postgres://cr@127.0.0.1:${pgPort}/${db}`,
  CHANGERADAR_DATABASE_PASSWORD: pgPassword,
  CHANGERADAR_ENCRYPTION_KEY: encryptionKey,
  CHANGERADAR_HOST: "127.0.0.1",
  CHANGERADAR_PORT: String(apiPort),
  CHANGERADAR_PUBLIC_URL: `http://localhost:${apiPort}`,
  CHANGERADAR_CHECK_ALLOWED_HOSTS: `127.0.0.1:${hangPort}`,
  CHANGERADAR_CHECK_ALLOW_PRIVATE_NETWORK: "1",
  CHANGERADAR_JOB_LEASE_SECONDS: "5",
});
const runCli = (env, cliArgs) => execFileSync(process.execPath, [cli, ...cliArgs], { env, encoding: "utf8", cwd: work });
function launch(name, env, cliArgs) {
  const child = spawn(process.execPath, [cli, ...cliArgs], { env, cwd: work, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (d) => (output = (output + d).slice(-4000)));
  child.stderr.on("data", (d) => (output = (output + d).slice(-4000)));
  child.tail = () => output;
  children.set(name, child);
  return child;
}

const api = (port) => {
  const base = `http://127.0.0.1:${port}/api/v1`;
  let session = null;
  const call = async (method, path, body) => {
    const headers = { "content-type": "application/json" };
    if (session) {
      headers.cookie = session.cookie;
      if (method !== "GET") headers["x-csrf-token"] = session.csrf;
    }
    const res = await fetch(base + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    return { status: res.status, json, headers: res.headers, text };
  };
  call.login = async (email, password, workspaceId) => {
    const res = await call("POST", "/auth/login", { email, password, workspace_id: workspaceId });
    expect(res.status === 200, `login answered ${res.status}: ${res.text.slice(0, 200)}`);
    const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    session = { cookie, csrf: res.json.csrf_token };
  };
  return call;
};

const FRESH = new Date(Date.now() - 86_400_000).toISOString().replace(/\.\d+Z$/, "Z");
const manifest = (withAmount) => ({
  schema_version: 1,
  revision: "durability",
  provenance: { source: "durability-proof-pg17" },
  nodes: [
    { id: "contract.invoice", kind: "contract", version: "1.0.0", owner: "team-billing", contract: { fields: [{ name: "invoice_id", type: "string", required: true }, ...(withAmount ? [{ name: "amount", type: "number", required: true }] : [])] } },
    { id: "job.export", kind: "job", version: "1.0.0", owner: "team-data" },
    { id: "svc.mailer", kind: "service", version: "1.0.0", owner: "team-comms" },
  ],
  edges: [
    { source_id: "job.export", target_id: "contract.invoice", relation: "consumes", source_file: "manifests/job.yaml", source_line: 3, verified_at: FRESH },
    { source_id: "svc.mailer", target_id: "contract.invoice", relation: "consumes", source_file: "manifests/mailer.yaml", source_line: 5, verified_at: FRESH },
  ],
});

let exitCode = 0;
try {
  await step(STEPS[0], () => `Docker server ${dockerVersion}`);

  await step(STEPS[1], async () => {
    // The password goes to the container through a file only this user can read, never on the command line (`ps`).
    const envFile = join(work, "postgres.env");
    writeFileSync(envFile, `POSTGRES_PASSWORD=${pgPassword}\nPOSTGRES_USER=cr\n`, { mode: 0o600 });
    containerCreated = true;
    // No `--rm`: a container started with it is removed when it stops, and `docker restart` has to be able to stop and start it.
    // Cleanup removes it by its exact generated name.
    execFileSync("docker", ["run", "-d", "--name", container, "--env-file", envFile, "-p", `127.0.0.1:${pgPort}:5432`, "postgres:17-alpine"], { stdio: "ignore" });
    await until("PostgreSQL to accept connections", () => spawnSync("docker", ["exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "cr"], { stdio: "ignore" }).status === 0, 120_000, 1000);
    const version = psql("postgres", "SHOW server_version");
    expect(version.startsWith("17"), `expected PostgreSQL 17, got ${version}`);
    receipt.postgres = version;
    psql("postgres", `CREATE DATABASE ${dbA}`);
    return `PostgreSQL ${version} on 127.0.0.1:${pgPort}, container ${container}`;
  });

  let workspaceId = "";
  let adminEmail = "";
  let adminPassword = "";
  let workerA = null;
  const apiA = api(apiPortA);
  let snapshot = null;
  let runHang = "";

  await step(STEPS[2], async () => {
    const env = envFor(dbA, apiPortA);
    runCli(env, ["migrate"]);
    adminEmail = `ops-${suffix}@example.test`;
    const created = runCli(env, ["admin", "create", "--email", adminEmail, "--workspace", "Durability", "--generate-password"]);
    workspaceId = /in workspace ([0-9a-f-]{36})/.exec(created)?.[1] ?? "";
    adminPassword = /password \(shown once\): (\S+)/.exec(created)?.[1] ?? "";
    expect(workspaceId && adminPassword, "admin create did not print a workspace id and a password");
    launch("server-a", env, ["serve", "--no-worker"]);
    await until("the API to be ready", async () => (await fetch(`http://127.0.0.1:${apiPortA}/api/v1/health/ready`)).status === 200, 60_000);
    workerA = launch("worker-a", env, ["worker"]);
    await until("the worker to start", () => /worker started/.test(workerA.tail()), 30_000);
    await apiA.login(adminEmail, adminPassword, workspaceId);
    return `API on ${apiPortA}, worker pid ${workerA.pid} (a separate process)`;
  });

  await step(STEPS[3], async () => {
    const check = await apiA("POST", "/contract-checks", { key: "chk.hang", node_id: "contract.invoice", url: `http://127.0.0.1:${hangPort}/hang`, retries: 0, timeout_ms: 30_000, required_fields: [{ name: "invoice_id", type: "string" }] });
    expect(check.status === 201, `create check answered ${check.status}: ${check.text.slice(0, 200)}`);
    const imported = await apiA("POST", "/snapshots", { schema_version: 1, revision: "durability-1", manifest: manifest(true) });
    expect(imported.status === 201, `import answered ${imported.status}: ${imported.text.slice(0, 200)}`);
    snapshot = imported.json;
    const requested = await apiA("POST", "/impact-runs", { snapshot_id: snapshot.id, proposed_manifest: manifest(false), expected_hash: snapshot.hash });
    expect(requested.status === 202, `run request answered ${requested.status}: ${requested.text.slice(0, 200)}`);
    runHang = requested.json.id;
    await until("the worker to call the hanging endpoint", () => hang.hits >= 1, 60_000);
    const state = psql(dbA, `SELECT state FROM check_results WHERE run_id = '${runHang}'`);
    expect(state === "STARTED", `the check should be durably STARTED while in flight, found ${state}`);
    return `run ${runHang}, endpoint hit ${hang.hits} time(s), check STARTED`;
  });

  await step(STEPS[4], async () => {
    const pid = workerA.pid;
    process.kill(pid, "SIGKILL");
    await until("the worker process to be gone", () => workerA.exitCode !== null || workerA.signalCode !== null, 10_000, 100);
    expect(workerA.signalCode === "SIGKILL", `the worker did not die from SIGKILL (signal ${workerA.signalCode}, code ${workerA.exitCode})`);
    const status = psql(dbA, `SELECT status FROM impact_runs WHERE id = '${runHang}'`);
    expect(status === "RUNNING", `the run must still be RUNNING after the crash, found ${status}`);
    return `pid ${pid} killed with SIGKILL, run ${status}`;
  });

  await step(STEPS[5], async () => {
    const env = envFor(dbA, apiPortA);
    const hitsBefore = hang.hits;
    workerA = launch("worker-a2", env, ["worker"]);
    const view = await until(
      "the reclaimed run to complete",
      async () => {
        const res = await apiA("GET", `/impact-runs/${runHang}`);
        return res.json?.status === "complete" ? res.json : null;
      },
      120_000,
      1000,
    );
    expect(view.assessment === "INCOMPLETE", `the run must be INCOMPLETE, found ${view.assessment}`);
    expect(view.checks.length === 1 && view.checks[0].state === "UNKNOWN", `the check must be UNKNOWN, found ${JSON.stringify(view.checks.map((c) => c.state))}`);
    expect(view.unknowns.some((u) => u.code === "CHECK_UNKNOWN"), "a CHECK_UNKNOWN unknown must be recorded");
    expect(hang.hits === hitsBefore && hang.hits === 1, `the endpoint must have been hit exactly once, was hit ${hang.hits} time(s)`);
    const events = psql(dbA, `SELECT string_agg(from_status || '>' || to_status, ',' ORDER BY id) FROM run_events WHERE run_id = '${runHang}'`);
    expect(/RUNNING>QUEUED/.test(events), `the history must show the reclaim (RUNNING>QUEUED), found ${events}`);
    for (const res of hang.open) res.destroy();
    return `INCOMPLETE, check UNKNOWN, endpoint hit exactly once, history ${events}`;
  });

  let runQueued = "";
  await step(STEPS[6], async () => {
    // Pause the worker so the run cannot finish before the restart: without this a run that takes a few milliseconds is
    // COMPLETE long before `docker restart` and the step would prove nothing about queued work.
    process.kill(workerA.pid, "SIGSTOP");
    workerPaused = true;
    const requested = await apiA("POST", "/impact-runs", { snapshot_id: snapshot.id, proposed_manifest: manifest(false), expected_hash: snapshot.hash, run_checks: false, allow_superseded: true });
    expect(requested.status === 202, `run request answered ${requested.status}`);
    runQueued = requested.json.id;
    const beforeRestart = psql(dbA, `SELECT status FROM impact_runs WHERE id = '${runQueued}'`);
    expect(beforeRestart === "QUEUED", `the run must be QUEUED when PostgreSQL is restarted, found ${beforeRestart}`);
    const seen = [];
    let done = false;
    const poller = (async () => {
      while (!done) {
        try {
          const res = await fetch(`http://127.0.0.1:${apiPortA}/api/v1/health/ready`);
          seen.push(res.status);
        } catch {
          seen.push(0);
        }
        await sleep(100);
      }
    })();
    execFileSync("docker", ["restart", "-t", "2", container], { stdio: "ignore" });
    await until("PostgreSQL to accept connections again", () => spawnSync("docker", ["exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "cr"], { stdio: "ignore" }).status === 0, 120_000, 500);
    await until("the API to be ready again", async () => (await fetch(`http://127.0.0.1:${apiPortA}/api/v1/health/ready`)).status === 200, 120_000, 500);
    // The poller's last sample can predate the readiness flip (a 503 taken just before it), which would fail a healthy run:
    // stop it only after five consecutive samples of its own were 200.
    await until("five consecutive ready answers from the poller", () => seen.length >= 5 && seen.slice(-5).every((s) => s === 200), 30_000, 100);
    done = true;
    await poller;
    expect(seen.some((s) => s === 503), `/health/ready never answered 503 during the restart (saw ${[...new Set(seen)].join(",")})`);
    expect(seen.at(-1) === 200, "/health/ready did not end at 200");
    const restartedPort = Number(execFileSync("docker", ["port", container, "5432/tcp"], { encoding: "utf8" }).split("\n")[0].split(":").pop());
    expect(restartedPort === pgPort, `the published port changed across the restart (${pgPort} to ${restartedPort})`);
    expect(children.get("server-a").exitCode === null, "the API died during the PostgreSQL restart");
    const afterRestart = psql(dbA, `SELECT status FROM impact_runs WHERE id = '${runQueued}'`);
    expect(afterRestart === "QUEUED", `the queued run must survive the restart as QUEUED (nothing lost), found ${afterRestart}`);
    return `run ${runQueued} QUEUED before and after; ready answers seen: ${[...new Set(seen)].join(",")}, ended 200; API still running`;
  });

  await step(STEPS[7], async () => {
    // Resume the paused worker: it lost its database connections in the restart and has to recover on its own.
    process.kill(workerA.pid, "SIGCONT");
    workerPaused = false;
    await apiA.login(adminEmail, adminPassword, workspaceId);
    const view = await until(
      "the queued run to complete",
      async () => {
        const res = await apiA("GET", `/impact-runs/${runQueued}`);
        return res.json?.status === "complete" ? res.json : null;
      },
      120_000,
      1000,
    );
    expect(view.assessment === "AFFECTED" && view.totals.findings === 2, `expected AFFECTED with 2 findings, found ${view.assessment} with ${view.totals.findings}`);
    const completions = Number(psql(dbA, `SELECT count(*) FROM run_events WHERE run_id = '${runQueued}' AND to_status = 'COMPLETE'`));
    const findingRows = Number(psql(dbA, `SELECT count(*) FROM findings WHERE run_id = '${runQueued}'`));
    const runRows = Number(psql(dbA, `SELECT count(*) FROM impact_runs WHERE workspace_id = '${workspaceId}'`));
    expect(completions === 1, `the run must complete exactly once, completed ${completions} time(s)`);
    expect(findingRows === 2, `expected 2 finding rows, found ${findingRows}`);
    expect(runRows === 2, `expected exactly 2 runs in the workspace, found ${runRows}`);
    const hangHits = hang.hits;
    expect(hangHits === 1, `the external endpoint must still have been hit once, was hit ${hangHits}`);
    expect(workerA.exitCode === null && workerA.signalCode === null, "the worker died instead of recovering from the PostgreSQL restart");
    return "completed once by the resumed worker (still running), 2 finding rows, 2 runs, endpoint still hit once";
  });

  // What the second installation must serve, read from installation A before the dump.
  const reference = {};
  const readReference = async (call, label) => {
    const snaps = await call("GET", "/snapshots?limit=100");
    const runs = await call("GET", "/impact-runs?limit=100");
    const out = { snapshots: snaps.json.items.map((s) => [s.id, s.hash, s.document_hash]).sort(), runs: runs.json.items.map((r) => [r.id, r.assessment, r.proposed_hash]).sort(), detail: {} };
    for (const [id] of out.runs) {
      const findings = await call("GET", `/impact-runs/${id}/findings?limit=100`);
      const report = await call("GET", `/impact-runs/${id}/export?format=json`);
      expect(report.status === 200, `${label}: export of ${id} answered ${report.status}`);
      out.detail[id] = { findings: findings.json.items.map((f) => f.id), report_hash: report.json.report_hash };
    }
    return out;
  };

  await step(STEPS[8], async () => {
    Object.assign(reference, await readReference(apiA, "installation A"));
    const dump = spawnSync("docker", ["exec", container, "pg_dump", "-U", "cr", "-Fc", dbA], { maxBuffer: 512 * 1024 * 1024 });
    expect(dump.status === 0 && dump.stdout.length > 1000, `pg_dump failed (${dump.status}): ${String(dump.stderr).slice(0, 300)}`);
    const dumpFile = join(work, "a.dump");
    writeFileSync(dumpFile, dump.stdout);
    psql("postgres", `CREATE DATABASE ${dbB}`);
    const restore = spawnSync("docker", ["exec", "-i", container, "pg_restore", "-U", "cr", "-d", dbB, "--no-owner", "--no-privileges"], { input: dump.stdout, maxBuffer: 64 * 1024 * 1024 });
    expect(restore.status === 0, `pg_restore failed (${restore.status}): ${String(restore.stderr).slice(0, 300)}`);
    const envB = envFor(dbB, apiPortB);
    launch("server-b", envB, ["serve", "--no-worker"]);
    await until("the second installation to be ready", async () => (await fetch(`http://127.0.0.1:${apiPortB}/api/v1/health/ready`)).status === 200, 90_000);
    return `dump ${dump.stdout.length} bytes restored into ${dbB}; second installation on ${apiPortB}`;
  });

  await step(STEPS[9], async () => {
    const apiB = api(apiPortB);
    await apiB.login(adminEmail, adminPassword, workspaceId);
    const restored = await readReference(apiB, "installation B");
    expect(JSON.stringify(restored.snapshots) === JSON.stringify(reference.snapshots), "snapshot ids or hashes differ after the restore");
    expect(JSON.stringify(restored.runs) === JSON.stringify(reference.runs), "run ids, verdicts or hashes differ after the restore");
    for (const [id, detail] of Object.entries(reference.detail)) {
      expect(JSON.stringify(restored.detail[id].findings) === JSON.stringify(detail.findings), `finding ids of run ${id} differ`);
      expect(restored.detail[id].report_hash === detail.report_hash, `report hash of run ${id} differs`);
    }
    return `${restored.snapshots.length} snapshot(s), ${restored.runs.length} run(s), every finding id and report hash identical`;
  });
} catch (error) {
  exitCode = 1;
  console.error(`durability-proof: FAILED: ${error.message}`);
  for (const [name, child] of children) console.error(`--- ${name} tail ---\n${child.tail?.() ?? ""}`);
} finally {
  await cleanup();
}
receipt.ended_utc = new Date().toISOString();
receipt.result = exitCode === 0 ? "PASS" : "FAIL";
say(JSON.stringify(receipt));
say(exitCode === 0 ? "durability-proof: PASS (all steps, PostgreSQL 17)" : "durability-proof: FAIL");
process.exit(exitCode);
