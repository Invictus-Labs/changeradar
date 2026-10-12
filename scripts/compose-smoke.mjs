#!/usr/bin/env node
// Real Docker Compose startup with PostgreSQL 17, a full smoke against it, and teardown.
//
//   node scripts/compose-smoke.mjs
//
// It uses a throwaway Compose project name and volume, publishes the application on 127.0.0.1 only (a free port),
// generates the database password and the encryption key for this run, and always removes the project (containers,
// network and volume) at the end. It never touches containers or volumes outside its own project. Exit 0 = every
// check passed; non-zero = a check failed (the failing step is printed).
//
// Requires Docker with the Compose plugin and network access to pull the two base images (node:22.12-alpine and
// postgres:17-alpine) the first time.
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const project = `changeradar-smoke-${randomBytes(3).toString("hex")}`;
const work = mkdtempSync(join(tmpdir(), "changeradar-compose-"));
const envFile = join(work, "env");
const freePort = () =>
  new Promise((resolvePort, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
const port = await freePort();
writeFileSync(
  envFile,
  [
    `POSTGRES_PASSWORD=${randomBytes(16).toString("hex")}`,
    `CHANGERADAR_ENCRYPTION_KEY=${randomBytes(32).toString("base64")}`,
    `CHANGERADAR_PUBLIC_URL=http://localhost:${port}`,
    `CHANGERADAR_HOST_PORT=${port}`,
    "",
  ].join("\n"),
  { mode: 0o600 },
);

const compose = (args, options = {}) => execFileSync("docker", ["compose", "-p", project, "--env-file", envFile, "--project-directory", root, ...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
const exec = (args, input) => compose(["exec", "-T", "changeradar", "node", "dist/src/cli.js", ...args], input === undefined ? {} : { input, stdio: ["pipe", "pipe", "pipe"] });
const started = new Date().toISOString();
const results = [];
let failed = false;
const check = async (name, fn) => {
  try {
    const detail = await fn();
    results.push(`PASS  ${name}${detail ? `: ${detail}` : ""}`);
    console.log(results.at(-1));
  } catch (error) {
    failed = true;
    results.push(`FAIL  ${name}: ${error.message}`);
    console.error(results.at(-1));
    throw error;
  }
};
const expect = (condition, message) => {
  if (!condition) throw new Error(message);
};

const base = `http://localhost:${port}`;
const call = async (session, method, path, body) => {
  const headers = { "content-type": "application/json" };
  if (session) {
    headers.cookie = session.cookie;
    if (method !== "GET") headers["x-csrf-token"] = session.csrf;
  }
  const res = await fetch(`${base}/api/v1${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null; // the HTML export is not JSON
  }
  return { status: res.status, text, json, headers: res.headers };
};

try {
  console.log(`compose project ${project}, application on http://localhost:${port} (127.0.0.1 only), started ${started}`);
  await check("docker compose up --build (PostgreSQL 17 + application image)", () => {
    compose(["up", "-d", "--build", "--wait", "--wait-timeout", "240"], { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
    return "started";
  });

  await check("published ports are loopback only; the database publishes nothing", () => {
    const ps = JSON.parse(`[${compose(["ps", "--format", "json"]).trim().split("\n").filter(Boolean).join(",")}]`);
    const app = ps.find((s) => s.Service === "changeradar");
    const db = ps.find((s) => s.Service === "db");
    expect(app && db, "both services must be running");
    const published = (svc) => (svc.Publishers ?? []).filter((p) => p.PublishedPort);
    expect(published(db).length === 0, `database publishes ports: ${JSON.stringify(published(db))}`);
    expect(published(app).length > 0 && published(app).every((p) => p.URL === "127.0.0.1"), `application publishes: ${JSON.stringify(published(app))}`);
    return `application ${published(app).map((p) => `${p.URL}:${p.PublishedPort}`).join(",")}`;
  });

  await check("the database is PostgreSQL 17", () => {
    const out = compose(["exec", "-T", "db", "psql", "-U", "changeradar", "-d", "changeradar", "-tAc", "show server_version"]).trim();
    expect(/^17\./.test(out), `server_version is ${out}`);
    return out;
  });

  await check("readiness and the web UI", async () => {
    const ready = await call(null, "GET", "/health/ready");
    expect(ready.status === 200 && ready.json.status === "ready", `ready answered ${ready.status}`);
    const page = await fetch(`${base}/`);
    expect(page.status === 200 && (await page.text()).includes('id="root"'), "web UI shell not served");
    expect((page.headers.get("content-security-policy") ?? "").includes("default-src 'none'"), "CSP header missing");
    return "ready, UI served";
  });

  let workspaceId = "";
  let password = "";
  await check("admin create inside the container (no default password; generated password printed once)", () => {
    const out = exec(["admin", "create", "--email", "operator@example.test", "--workspace", "Compose smoke", "--generate-password"]);
    workspaceId = /in workspace ([0-9a-f-]{36})/.exec(out)?.[1] ?? "";
    password = /password \(shown once\): (\S+)/.exec(out)?.[1] ?? "";
    expect(workspaceId && password.length >= 12, "no workspace id or password in the output");
    return `workspace ${workspaceId}`;
  });

  let session;
  await check("sign in", async () => {
    const res = await fetch(`${base}/api/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "operator@example.test", password, workspace_id: workspaceId }) });
    expect(res.status === 200, `login answered ${res.status}`);
    const body = await res.json();
    session = { cookie: (res.headers.getSetCookie()[0] ?? "").split(";")[0], csrf: body.csrf_token };
    return body.user.role;
  });

  let samples;
  await check("sample-manifests inside the container", () => {
    exec(["sample-manifests", "--out", "/tmp/samples"]);
    const read = (name) => JSON.parse(compose(["exec", "-T", "changeradar", "cat", `/tmp/samples/${name}`]));
    samples = { baseline: read("baseline.json"), breaking: read("proposal-breaking-removal.json"), noImpact: read("proposal-no-known-impact.json"), unverified: read("baseline-with-unverified-edge.json") };
    return "5 files";
  });

  let runId = "";
  let firstReport;
  await check("import, run with a seeded breaking removal, worker completes it: AFFECTED with direct and transitive consumers and owners", async () => {
    const snap = await call(session, "POST", "/snapshots", { schema_version: 1, revision: "compose-1", manifest: samples.baseline });
    expect(snap.status === 201, `import answered ${snap.status} ${snap.text.slice(0, 200)}`);
    const receipt = await call(session, "POST", "/impact-runs", { snapshot_id: snap.json.id, proposed_manifest: samples.breaking, expected_hash: snap.json.hash });
    expect(receipt.status === 202, `run answered ${receipt.status}`);
    runId = receipt.json.id;
    let run;
    for (let i = 0; i < 300; i += 1) {
      run = (await call(session, "GET", `/impact-runs/${runId}`)).json;
      if (run.status === "complete" || run.status === "failed") break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(run.status === "complete" && run.assessment === "AFFECTED", `run ended ${run.status}/${run.assessment}`);
    const summary = run.affected.map((f) => `${f.direct ? "direct" : "transitive"}:${f.consumer_id}:${f.consumer_owner}`).sort();
    expect(summary.length === 5 && summary.includes("direct:job.invoice-export:team-data") && summary.includes("transitive:svc.dashboard:team-web"), `consumers: ${summary.join(", ")}`);
    firstReport = (await call(session, "GET", `/impact-runs/${runId}/export?format=json`)).json;
    const html = (await call(session, "GET", `/impact-runs/${runId}/export?format=html`)).text;
    const ids = firstReport.findings.map((f) => f.id).sort();
    expect(JSON.stringify([...new Set(html.match(/fnd_[0-9a-f]+/g))].sort()) === JSON.stringify(ids), "JSON and HTML finding ids differ");
    return summary.join("; ");
  });

  await check("INCOMPLETE and NO_KNOWN_IMPACT on PostgreSQL 17", async () => {
    const moved = await call(session, "POST", "/snapshots", { schema_version: 1, revision: "compose-2", manifest: samples.unverified });
    expect(moved.status === 201, "second import failed");
    const wait = async (id) => {
      for (let i = 0; i < 300; i += 1) {
        const run = (await call(session, "GET", `/impact-runs/${id}`)).json;
        if (run.status === "complete" || run.status === "failed") return run;
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error("run did not finish");
    };
    const incomplete = await wait((await call(session, "POST", "/impact-runs", { snapshot_id: moved.json.id, proposed_manifest: samples.breaking, expected_hash: moved.json.hash })).json.id);
    expect(incomplete.assessment === "INCOMPLETE" && incomplete.unknowns.length > 0, `got ${incomplete.assessment}`);
    const stale = await call(session, "POST", "/impact-runs", { snapshot_id: moved.json.id, proposed_manifest: samples.noImpact, expected_hash: `sha256:${"0".repeat(64)}` });
    expect(stale.status === 409 && stale.json.error.code === "STALE_BASELINE", `stale hash answered ${stale.status}`);
    return "INCOMPLETE with unknowns; stale hash is 409";
  });

  await check("evidence bundle: export, verify, and the data survives an application restart", async () => {
    exec(["export", "--workspace-id", workspaceId, "--out", "/data/smoke-bundle.json"]);
    const verified = exec(["verify-bundle", "--in", "/data/smoke-bundle.json"]);
    expect(verified.includes("bundle ok"), verified);
    compose(["restart", "changeradar"]);
    let ready = false;
    for (let i = 0; i < 120 && !ready; i += 1) {
      ready = await fetch(`${base}/api/v1/health/ready`).then((r) => r.ok, () => false);
      if (!ready) await new Promise((r) => setTimeout(r, 1000));
    }
    expect(ready, "application did not become ready after the restart");
    const relogin = await fetch(`${base}/api/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "operator@example.test", password, workspace_id: workspaceId }) });
    expect(relogin.status === 200, "cannot sign in after the restart");
    const again = { cookie: (relogin.headers.getSetCookie()[0] ?? "").split(";")[0], csrf: (await relogin.json()).csrf_token };
    const report = (await call(again, "GET", `/impact-runs/${runId}/export?format=json`)).json;
    expect(report.report_hash === firstReport.report_hash, "report hash changed across the restart");
    return `report hash ${report.report_hash.slice(0, 19)} unchanged`;
  });
} catch (error) {
  failed = true;
  console.error(`compose smoke failed: ${error.message}`);
  const logs = spawnSync("docker", ["compose", "-p", project, "--env-file", envFile, "--project-directory", root, "logs", "--no-color", "--tail", "40"], { cwd: root, encoding: "utf8" });
  console.error(`${logs.stdout ?? ""}${logs.stderr ?? ""}`.slice(-4000));
} finally {
  const down = spawnSync("docker", ["compose", "-p", project, "--env-file", envFile, "--project-directory", root, "down", "-v", "--remove-orphans", "--timeout", "10"], { cwd: root, encoding: "utf8" });
  const leftover = spawnSync("docker", ["ps", "-a", "--filter", `label=com.docker.compose.project=${project}`, "-q"], { encoding: "utf8" }).stdout.trim();
  const volumes = spawnSync("docker", ["volume", "ls", "-q", "--filter", `label=com.docker.compose.project=${project}`], { encoding: "utf8" }).stdout.trim();
  console.log(`teardown: docker compose down -v exit ${down.status}; leftover containers: ${leftover ? leftover.split("\n").length : 0}; leftover volumes: ${volumes ? volumes.split("\n").length : 0}`);
  if (leftover || volumes || down.status !== 0) failed = true;
  rmSync(work, { recursive: true, force: true });
  console.log(`finished ${new Date().toISOString()}: ${failed ? "FAILED" : "all compose checks passed"}`);
}
process.exit(failed ? 1 : 0);
