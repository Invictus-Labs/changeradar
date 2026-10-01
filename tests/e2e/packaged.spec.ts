import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { loadDemoFixture } from "../../src/commands/demo-fixture.js";
import { ALL_FAKE_SECRETS, FAKE_API_KEY, FAKE_AWS_KEY, FAKE_BEARER, FAKE_GITHUB_TOKEN, FAKE_STRIPE_KEY, SECRET_CORES } from "../helpers/fake-secrets.js";
import { api, createStack, createUser, freePort, generatedPassword, login, REPO_ROOT, type Stack, waitForRun } from "./support/stack.js";

/**
 * Packaged end to end: the npm tarball is built with `npm pack`, installed into a fresh directory OUTSIDE the
 * repository, and everything below runs through that installed binary (`node_modules/changeradar/dist/src/cli.js`),
 * never through the repository build. The installation has no account, no license server and no network: the
 * lifecycle tests run with a preload that refuses every non-loopback connection and records each attempt.
 */

const execFileAsync = promisify(execFile);
const work = mkdtempSync(join(tmpdir(), "changeradar-packaged-"));
const denyLog = join(work, "deny.log");
const denier = join(REPO_ROOT, "tests/e2e/support/deny-network.cjs");
const offline = { NODE_OPTIONS: `--require="${denier}"`, CR_DENY_LOG: denyLog };
const fixture = loadDemoFixture(new Date());
let installDir = "";
let cli = "";
let packageDir = "";
const stacks: Stack[] = [];
/** Everything every spawned process printed, so the secret scan covers stdout and stderr of the whole run. */
const emitted: string[] = [];
let bundleText = "";
let bundlePath = "";
let originalReportHash = "";
let originalFindingIds: string[] = [];

const stackFor = async (extraEnv: NodeJS.ProcessEnv = {}, useOffline = true): Promise<Stack> => {
  const stack = await createStack({ cli, cwd: join(installDir, "work"), extraEnv: { ...(useOffline ? offline : {}), ...extraEnv } });
  const run = stack.run.bind(stack);
  stack.run = async (args, opts) => {
    const result = await run(args, opts);
    emitted.push(result.stdout, result.stderr);
    return result;
  };
  stacks.push(stack);
  return stack;
};

/** The JSON array `npm pack --json` prints: npm 11 puts the output of the `prepack` script (the build) on the same stream in front of it. */
const npmJson = (stdout: string): any[] => JSON.parse(stdout.slice(stdout.lastIndexOf("\n[") + 1)) as any[];

const allFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? allFiles(join(dir, entry.name)) : [join(dir, entry.name)]));

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  expect(existsSync(join(REPO_ROOT, "dist/src/cli.js")), "run `npm run build` first").toBe(true);
  const packed = npmJson(execFileSync("npm", ["pack", "--pack-destination", work, "--json", "--loglevel=error"], { cwd: REPO_ROOT, encoding: "utf8" })) as { filename: string }[];
  const tarball = join(work, packed[0]!.filename);
  installDir = join(work, "install");
  mkdirSync(join(installDir, "work"), { recursive: true });
  writeFileSync(join(installDir, "package.json"), JSON.stringify({ name: "changeradar-install-check", version: "0.0.0", private: true }));
  await execFileAsync("npm", ["install", tarball, "--no-audit", "--no-fund", "--ignore-scripts", "--loglevel=error", "--prefer-offline"], { cwd: installDir, timeout: 300_000 });
  packageDir = join(installDir, "node_modules/changeradar");
  cli = join(packageDir, "dist/src/cli.js");
  expect(existsSync(cli)).toBe(true);
  writeFileSync(denyLog, "");
  test.info().annotations.push({ type: "tarball", description: `${packed[0]!.filename} sha256:${createHash("sha256").update(readFileSync(tarball)).digest("hex")}` });
});

test.afterAll(() => {
  for (const stack of stacks) stack.cleanup();
  rmSync(work, { recursive: true, force: true });
});

test("the network denier bites (positive control): a non-loopback attempt fails and is recorded", async () => {
  const before = readFileSync(denyLog, "utf8");
  const result = await execFileAsync(process.execPath, ["-e", "fetch('http://example.invalid/').then(()=>process.exit(3),(e)=>{console.log('DENIED '+e.message);process.exit(0)})"], { env: { ...process.env, ...offline } });
  expect(result.stdout).toContain("DENIED");
  expect(readFileSync(denyLog, "utf8").slice(before.length)).toContain("fetch example.invalid");
  writeFileSync(denyLog, ""); // the control is not part of the offline run being proven
});

test("the tarball ships the build, migrations, fixture, licence and docs, and nothing else: no tests, sources, maps, env files or personal paths", async () => {
  const listing = execFileSync("npm", ["pack", "--dry-run", "--json", "--loglevel=error"], { cwd: REPO_ROOT, encoding: "utf8" });
  const files = (npmJson(listing)[0].files as { path: string }[]).map((f) => f.path);
  for (const required of ["dist/src/cli.js", "dist/web/index.html", "migrations/001_identity.sql", "migrations/003_jobs_outbox.sql", "fixtures/demo.json", "LICENSE", "README.md", ".env.example", "docs/OPERATIONS.md", "docs/RUNBOOK-SMOKE.md", "docs/HUMAN-DRILL.md", "schemas/dependencies.json"]) {
    expect(files, required).toContain(required);
  }
  expect(files.filter((f) => /^(tests|src|scripts|\.claude|node_modules)\//.test(f) || /\.map$/.test(f) || /(^|\/)\.env$/.test(f) || /\.(pem|key)$/.test(f))).toEqual([]);

  // Text scan of the installed package: no personal path, private topology marker or planted secret shape.
  const offenders: string[] = [];
  for (const file of allFiles(packageDir)) {
    if (file.includes(`${join("node_modules", "changeradar", "node_modules")}`)) continue;
    const text = readFileSync(file).toString("utf8");
    if (/\/Users\/|\/home\/[a-z]|C:\\Users\\/i.test(text)) offenders.push(`personal path in ${file}`);
    for (const core of SECRET_CORES) if (text.includes(core)) offenders.push(`planted secret in ${file}`);
  }
  expect(offenders).toEqual([]);
});

test("the installed binary explains itself: help exits 0, an unknown command exits 64, a missing file or password choice fails clearly", async () => {
  const stack = await stackFor();
  const help = await stack.run(["help"]);
  expect(help.code).toBe(0);
  expect(help.stderr + help.stdout).toContain("demo");
  expect((await stack.run(["frobnicate"])).code).toBe(64);
  const missing = await stack.run(["verify-bundle", "--in", join(stack.dir, "nope.json")]);
  // 66 is the documented exit status for an input file that is missing or unreadable (README, "Command line").
  expect(missing.code).toBe(66);
  const noPassword = await stack.run(["admin", "create", "--email", "someone@example.test", "--workspace", "W"]);
  expect(noPassword.code).toBe(1);
  expect(noPassword.stderr).toContain("no default password");
});

test("offline lifecycle: migrate, admin create, serve, worker, import, run, export, verify-bundle, restore into a second clean installation", async () => {
  const A = await stackFor({ CHANGERADAR_LOG: "1" });
  const migrate = await A.run(["migrate"]);
  expect(migrate.code, migrate.stderr).toBe(0);
  expect(migrate.stdout).toContain("applied:");
  expect((await A.run(["migrate"])).stdout).toContain("schema up to date");

  const admin = await A.run(["admin", "create", "--email", "admin@example.test", "--workspace", "Packaged", "--generate-password"]);
  expect(admin.code, admin.stderr).toBe(0);
  const workspaceId = /in workspace ([0-9a-f-]{36})/.exec(admin.stdout)![1]!;
  const password = /password \(shown once\): (\S+)/.exec(admin.stdout)![1]!;
  expect(password.length).toBeGreaterThanOrEqual(12);
  const again = await A.run(["admin", "create", "--email", "admin@example.test", "--workspace-id", workspaceId, "--generate-password"]);
  expect(again.code).toBe(1); // already a member; and no second password was printed
  expect(again.stdout).not.toContain("password (shown once)");

  await createUser(A, { email: "viewer@example.test", password: generatedPassword(), role: "viewer", workspaceId });
  const cred = await A.run(["credential", "set", "--workspace-id", workspaceId, "--alias", "cred.warehouse"], { stdin: `${FAKE_STRIPE_KEY}\n` });
  expect(cred.code, cred.stderr).toBe(0);
  expect((await A.run(["credential", "list", "--workspace-id", workspaceId])).stdout.trim()).toBe("cred.warehouse");

  const server = await A.serve();
  emitted.push(server.output());
  try {
    expect(((await api(A.baseUrl, null, "GET", "/health/ready")).json as { status: string }).status).toBe("ready");
    const session = await login(A.baseUrl, "admin@example.test", password, workspaceId);

    // Planted secrets in a header, a query string, a cookie and a manifest: refused or ignored, never echoed or logged.
    const probe = await fetch(`${A.baseUrl}/api/v1/snapshots?token=${encodeURIComponent(FAKE_GITHUB_TOKEN)}`, { headers: { cookie: `${session.cookie}; leak=${FAKE_API_KEY}`, authorization: FAKE_BEARER, "x-api-key": FAKE_API_KEY } });
    expect(probe.status).toBeLessThan(500);
    const secretManifest = structuredClone(fixture.manifests.baseline) as { nodes: { owner: string }[] };
    secretManifest.nodes[0]!.owner = FAKE_AWS_KEY;
    const refused = await api(A.baseUrl, session, "POST", "/snapshots", { schema_version: 1, revision: "secret-1", manifest: secretManifest });
    expect(refused.status).toBe(422);
    expect(refused.text).not.toContain(FAKE_AWS_KEY);
    expect((await api(A.baseUrl, session, "GET", "/snapshots")).json.items).toEqual([]);

    const snap = await api(A.baseUrl, session, "POST", "/snapshots", { schema_version: 1, revision: "packaged-1", manifest: fixture.manifests.baseline });
    expect(snap.status, snap.text).toBe(201);
    const receipt = await api(A.baseUrl, session, "POST", "/impact-runs", { snapshot_id: snap.json.id, proposed_manifest: fixture.manifests.proposal_breaking_removal, expected_hash: snap.json.hash }, { "idempotency-key": "packaged-run-1" });
    expect(receipt.status, receipt.text).toBe(202);
    const replay = await api(A.baseUrl, session, "POST", "/impact-runs", { snapshot_id: snap.json.id, proposed_manifest: fixture.manifests.proposal_breaking_removal, expected_hash: snap.json.hash }, { "idempotency-key": "packaged-run-1" });
    expect(replay.json.id).toBe(receipt.json.id);
    const run = await waitForRun(A.baseUrl, session, receipt.json.id);
    expect(run.status).toBe("complete");
    expect(run.assessment).toBe("AFFECTED");
    expect(run.affected.map((f: any) => `${f.direct ? "direct" : "transitive"}:${f.consumer_id}:${f.consumer_owner}`).sort()).toEqual(
      ["direct:job.invoice-export:team-data", "direct:svc.ledger-sync:team-finance", "transitive:artifact.invoice-report:team-data", "transitive:job.audit-archive:team-compliance", "transitive:svc.dashboard:team-web"].sort(),
    );

    const json = await api(A.baseUrl, session, "GET", `/impact-runs/${receipt.json.id}/export?format=json`);
    const html = await api(A.baseUrl, session, "GET", `/impact-runs/${receipt.json.id}/export?format=html`);
    originalReportHash = json.json.report_hash;
    originalFindingIds = json.json.findings.map((f: any) => f.id).sort();
    expect([...new Set(html.text.match(/fnd_[0-9a-f]+/g) ?? [])].sort()).toEqual(originalFindingIds);
    emitted.push(json.text, html.text, refused.text, run.error ? JSON.stringify(run.error) : "");
    // The web UI is served from the same installed process.
    const shell = await fetch(`${A.baseUrl}/`);
    expect(shell.status).toBe(200);
    expect(await shell.text()).toContain("<div id=\"root\">");
  } finally {
    emitted.push(server.output());
    expect(await server.stop()).toBe(0); // SIGTERM: a clean shutdown with exit 0
  }

  bundlePath = join(A.dir, "backups", "packaged.json");
  const exported = await A.run(["export", "--workspace-id", workspaceId, "--out", bundlePath]);
  expect(exported.code, exported.stderr).toBe(0);
  expect(statSync(bundlePath).mode & 0o777).toBe(0o600);
  expect((await A.run(["export", "--workspace-id", workspaceId, "--out", bundlePath])).code).toBe(73); // never overwrites (73: the output could not be written)
  const verified = await A.run(["verify-bundle", "--in", bundlePath]);
  expect(verified.code, verified.stderr).toBe(0);
  expect(verified.stdout).toContain("bundle ok");
  bundleText = readFileSync(bundlePath, "utf8");

  // Restore into a second clean installation (its own database and key): ids, hashes and references are preserved.
  const B = await stackFor();
  const restored = await B.run(["restore", "--in", bundlePath]);
  expect(restored.code, restored.stderr).toBe(0);
  expect(restored.stdout).toContain(`restored workspace ${workspaceId}`);
  const secondPassword = generatedPassword();
  await createUser(B, { email: "admin@example.test", password: secondPassword, role: "admin", workspaceId });
  const serverB = await B.serve();
  try {
    const sessionB = await login(B.baseUrl, "admin@example.test", secondPassword, workspaceId);
    const runs = await api(B.baseUrl, sessionB, "GET", "/impact-runs");
    expect(runs.json.items).toHaveLength(1);
    const reportB = await api(B.baseUrl, sessionB, "GET", `/impact-runs/${runs.json.items[0].id}/export?format=json`);
    expect(reportB.json.report_hash).toBe(originalReportHash);
    expect(reportB.json.findings.map((f: any) => f.id).sort()).toEqual(originalFindingIds);
    const baseline = await api(B.baseUrl, sessionB, "GET", "/baseline");
    expect(baseline.json.snapshot.hash).toMatch(/^sha256:/);
  } finally {
    emitted.push(serverB.output());
    await serverB.stop();
  }

  // Offline: with every non-loopback connection refused and recorded, the whole lifecycle worked and nothing was attempted.
  expect(readFileSync(denyLog, "utf8")).toBe("");

  // Planted fake secrets: absent from every process output, response, exported file and database file of installation A.
  const haystacks: { name: string; data: Buffer }[] = emitted.map((text, i) => ({ name: `output ${i}`, data: Buffer.from(text) }));
  for (const file of allFiles(A.dir)) haystacks.push({ name: file.replace(A.dir, "<A>"), data: readFileSync(file) });
  for (const file of allFiles(B.dir)) haystacks.push({ name: file.replace(B.dir, "<B>"), data: readFileSync(file) });
  const leaks: string[] = [];
  for (const { name, data } of haystacks) {
    for (const secret of [...ALL_FAKE_SECRETS, ...SECRET_CORES]) if (data.includes(secret)) leaks.push(`${name} contains a planted secret`);
    // The one-time password appears in the single `admin create` output that printed it, and nowhere else.
    if (!name.startsWith("output") && data.includes(password)) leaks.push(`${name} contains the administrator password`);
  }
  expect(leaks).toEqual([]);
  expect(emitted.filter((text) => text.includes(password))).toHaveLength(1);
});

test("truncated, tampered, unsupported and oversize bundles are rejected with exit 2 and leave no partial state; the clean installation then restores the good bundle", async () => {
  expect(bundleText.length).toBeGreaterThan(1000);
  const C = await stackFor();
  const write = (name: string, text: string) => {
    const file = join(C.dir, name);
    writeFileSync(file, text);
    return file;
  };
  const parsed = JSON.parse(bundleText) as Record<string, unknown>;
  const bad: [string, string, string][] = [
    ["truncated", write("truncated.json", bundleText.slice(0, Math.floor(bundleText.length * 0.6))), "BUNDLE_"],
    ["tampered", write("tampered.json", bundleText.replace("team-data", "team-datx")), "BUNDLE_"],
    ["unsupported version", write("version.json", JSON.stringify({ ...parsed, schema_version: 2 })), "BUNDLE_UNSUPPORTED_VERSION"],
    ["wrong format", write("format.json", JSON.stringify({ ...parsed, format: "something-else" })), "BUNDLE_"],
    ["not JSON", write("garbage.json", "\u0000\u0001 not a bundle"), "BUNDLE_"],
  ];
  for (const [label, file, code] of bad) {
    const verify = await C.run(["verify-bundle", "--in", file]);
    expect(verify.code, `${label}: verify-bundle`).toBe(2);
    expect(verify.stderr, label).toContain(code);
    const restore = await C.run(["restore", "--in", file]);
    expect(restore.code, `${label}: restore`).toBe(2);
    expect(restore.stderr, label).toContain(code);
  }
  const tooBig = await C.run(["restore", "--in", bundlePath], { env: { CHANGERADAR_MAX_BUNDLE_BYTES: "1024" } });
  expect(tooBig.code).toBe(2);
  expect(tooBig.stderr).toContain("BUNDLE_TOO_LARGE");
  // No partial state: a restore that had written anything would now make the good restore fail with a conflict.
  const good = await C.run(["restore", "--in", bundlePath]);
  expect(good.code, good.stderr).toBe(0);
  const conflict = await C.run(["restore", "--in", bundlePath]);
  expect(conflict.code).toBe(2);
  expect(conflict.stderr).toContain("RESTORE_CONFLICT");
});

test("limits are enforced before any processing: 25 MB, 10,000 nodes and 50,000 edges are rejected with 413 and nothing is stored", async () => {
  const D = await stackFor();
  const password = generatedPassword();
  const workspaceId = await createUser(D, { email: "admin@example.test", password, role: "admin", workspace: "Limits" });
  const server = await D.serve();
  try {
    const session = await login(D.baseUrl, "admin@example.test", password, workspaceId);
    const post = (manifest: unknown) => api(D.baseUrl, session, "POST", "/snapshots", { schema_version: 1, revision: "limits", manifest });

    const huge = await post({ schema_version: 1, revision: "x", nodes: [], edges: [], pad: "a".repeat(26 * 1024 * 1024) });
    expect(huge.status).toBe(413);
    expect(huge.json.error.code).toBe("PAYLOAD_TOO_LARGE");
    // Garbage items prove the counts are checked BEFORE any node or edge is looked at (otherwise this would be a 422).
    const nodes = await post({ schema_version: 1, revision: "x", nodes: Array.from({ length: 10_001 }, () => 1), edges: [] });
    expect(nodes.status).toBe(413);
    expect(nodes.json.error.code).toBe("TOO_MANY_NODES");
    const edges = await post({ schema_version: 1, revision: "x", nodes: [], edges: Array.from({ length: 50_001 }, () => 1) });
    expect(edges.status).toBe(413);
    expect(edges.json.error.code).toBe("TOO_MANY_EDGES");
    expect((await api(D.baseUrl, session, "GET", "/snapshots")).json.items).toEqual([]);

    // And exactly at the node limit a valid manifest is accepted.
    const atLimit = { schema_version: 1, revision: "at-limit", provenance: { source: "limits" }, nodes: Array.from({ length: 10_000 }, (_v, i) => ({ id: `svc.n${i}`, kind: "service", owner: "team-limits", version: "1.0.0" })), edges: [] };
    const accepted = await post(atLimit);
    expect(accepted.status, accepted.text.slice(0, 300)).toBe(201);
    expect(accepted.json.node_count).toBe(10_000);
  } finally {
    await server.stop();
  }
});

test("a failed migration stops readiness: not ready, 503 everywhere but liveness, the worker does not start, nothing is half applied", async () => {
  const E = await stackFor();
  expect((await E.run(["migrate"])).code).toBe(0); // the good build applies 001 to 003
  const brokenDir = join(installDir, "node_modules", "changeradar-broken");
  cpSync(packageDir, brokenDir, { recursive: true });
  writeFileSync(join(brokenDir, "migrations", "004_broken.sql"), "CREATE TABLE half_applied (id int);\nSELECT 1/0;\n");
  const brokenCli = join(brokenDir, "dist/src/cli.js");
  const broken = await createStack({ cli: brokenCli, cwd: join(installDir, "work"), extraEnv: { ...offline } });
  stacks.push(broken);
  // Same database and key as E, different binary.
  const server = await broken.serve({ env: { CHANGERADAR_DATABASE_URL: E.env.CHANGERADAR_DATABASE_URL!, CHANGERADAR_ENCRYPTION_KEY: E.env.CHANGERADAR_ENCRYPTION_KEY! } }).catch((error: Error) => error);
  expect(server instanceof Error, "serve must still listen so liveness can answer").toBe(false);
  if (server instanceof Error) return;
  try {
    expect(server.output()).toContain("NOT READY");
    const live = await fetch(`${broken.baseUrl}/api/v1/health/live`);
    expect(live.status).toBe(200);
    const ready = await fetch(`${broken.baseUrl}/api/v1/health/ready`);
    expect(ready.status).toBe(503);
    expect(((await ready.json()) as { error: { code: string } }).error.code).toBe("NOT_READY");
    expect((await fetch(`${broken.baseUrl}/api/v1/snapshots`)).status).toBe(503);
    expect((await fetch(`${broken.baseUrl}/api/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(503);
  } finally {
    await server.stop();
  }
  const migrateBroken = await broken.run(["migrate"], { env: { CHANGERADAR_DATABASE_URL: E.env.CHANGERADAR_DATABASE_URL!, CHANGERADAR_ENCRYPTION_KEY: E.env.CHANGERADAR_ENCRYPTION_KEY! } });
  expect(migrateBroken.code).toBe(1);
  // All or nothing: the good build still sees a fully migrated database and the half-applied table never existed.
  const recovered = await E.serve();
  try {
    expect((await fetch(`${E.baseUrl}/api/v1/health/ready`)).status).toBe(200);
  } finally {
    await recovered.stop();
  }
});

test("kill -9 while a job is in flight: restart reclaims the lease and the uncertain external outcome stays UNKNOWN and the run INCOMPLETE", async () => {
  // A local endpoint that accepts a contract check request and never answers: the check is in flight when the process dies.
  const seen: string[] = [];
  const sockets = new Set<import("node:net").Socket>();
  const slow = http.createServer((req) => {
    seen.push(`${req.method} ${req.url}`);
  });
  slow.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => slow.listen(0, "127.0.0.1", resolve));
  const endpointPort = (slow.address() as AddressInfo).port;
  const F = await stackFor({ CHANGERADAR_JOB_LEASE_SECONDS: "5", CHANGERADAR_CHECK_ALLOWED_HOSTS: `127.0.0.1:${endpointPort}`, CHANGERADAR_CHECK_ALLOW_PRIVATE_NETWORK: "1" }, false);
  const password = generatedPassword();
  const workspaceId = await createUser(F, { email: "admin@example.test", password, role: "admin", workspace: "Restart" });
  let server = await F.serve();
  let runId = "";
  try {
    const session = await login(F.baseUrl, "admin@example.test", password, workspaceId);
    const check = await api(F.baseUrl, session, "POST", "/contract-checks", { key: "invoice-live", node_id: "contract.invoice", url: `http://127.0.0.1:${endpointPort}/invoice`, timeout_ms: 30_000, retries: 0 });
    expect(check.status, check.text).toBe(201);
    const snap = await api(F.baseUrl, session, "POST", "/snapshots", { schema_version: 1, revision: "restart-1", manifest: fixture.manifests.baseline });
    const receipt = await api(F.baseUrl, session, "POST", "/impact-runs", { snapshot_id: snap.json.id, proposed_manifest: fixture.manifests.proposal_breaking_removal, expected_hash: snap.json.hash });
    expect(receipt.status, receipt.text).toBe(202);
    runId = receipt.json.id;
    const deadline = Date.now() + 60_000;
    while (seen.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    expect(seen, "the worker must have started the live check").toEqual(["GET /invoice"]);
    const midway = await api(F.baseUrl, session, "GET", `/impact-runs/${runId}`);
    expect(midway.json.status).toBe("running");
    expect(midway.json.assessment).toBeNull();
    expect(midway.json.checks[0].state).toBe("STARTED");
  } finally {
    server.child.kill("SIGKILL");
    await server.exited;
  }
  for (const socket of sockets) socket.destroy();

  server = await F.serve();
  try {
    const session = await login(F.baseUrl, "admin@example.test", password, workspaceId);
    const run = await waitForRun(F.baseUrl, session, runId, 90_000);
    expect(run.status).toBe("complete");
    expect(run.assessment, "an uncertain outcome must never become a safe or complete verdict").toBe("INCOMPLETE");
    expect(run.checks).toHaveLength(1);
    expect(run.checks[0].state).toBe("UNKNOWN");
    expect(run.unknowns.map((u: any) => u.code)).toContain("CHECK_UNKNOWN");
    expect(run.affected.length).toBeGreaterThan(0); // the known breaks stay visible next to the unknown
    expect(seen, "the interrupted check must not be re-run after the restart").toEqual(["GET /invoice"]);
  } finally {
    await server.stop();
    slow.closeAllConnections();
    slow.close();
  }
});

test("serve on a port that is already taken exits non-zero and does not hang", async () => {
  const blocker = http.createServer();
  await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const port = (blocker.address() as AddressInfo).port;
  try {
    const G = await stackFor({ CHANGERADAR_PORT: String(port) });
    const result = await Promise.race([
      G.run(["serve"], { timeoutMs: 40_000 }),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("serve hung instead of exiting")), 45_000)),
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/EADDRINUSE|address already in use/i);
  } finally {
    blocker.close();
  }
});

test("the synthetic demo runs from the installed tarball with outbound access denied, and prints its one-time passwords once", async () => {
  const dir = join(work, "demo");
  const port = await freePort();
  const child = spawn(process.execPath, [cli, "demo", "--dir", dir, "--port", String(port)], { cwd: join(installDir, "work"), env: { PATH: process.env.PATH ?? "", HOME: work, ...offline }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (c: Buffer) => (output += c.toString()));
  child.stderr.on("data", (c: Buffer) => (output += c.toString()));
  const exited = new Promise<number | null>((resolve) => child.on("close", resolve));
  try {
    const deadline = Date.now() + 90_000;
    while (!output.includes("Press Ctrl+C") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    expect(output).toContain("Press Ctrl+C");
    expect(output).toContain(`http://localhost:${port}/`);
    const adminPassword = /administrator\s+\S+\s+password \(shown once\): (\S+)/.exec(output)![1]!;
    const session = await login(`http://localhost:${port}`, "demo-admin@example.test", adminPassword);
    const runs = await api(`http://localhost:${port}`, session, "GET", "/impact-runs");
    expect(runs.json.items.map((r: any) => r.assessment).sort()).toEqual(["AFFECTED", "INCOMPLETE", "NO_KNOWN_IMPACT"]);
    expect((await fetch(`http://localhost:${port}/`)).status).toBe(200);
  } finally {
    child.kill("SIGTERM");
    expect(await exited).toBe(0);
  }
  expect(readFileSync(denyLog, "utf8")).toBe("");
});

test("a seeded mandatory failure turns the quality gate red (exit 1, GATE RED), and a corrupted bundle turns the packaged binary red (exit 2)", async () => {
  const gate = await execFileAsync("bash", ["scripts/verify-quality.sh", "--seeded-failure"], { cwd: REPO_ROOT, timeout: 60_000 }).then(
    () => ({ code: 0, out: "" }),
    (error: { code: number; stdout: string; stderr: string }) => ({ code: error.code, out: error.stdout + error.stderr }),
  );
  expect(gate.code).toBe(1);
  expect(gate.out).toContain("GATE RED");
  expect(gate.out).toContain("seeded mandatory failure");
  expect(gate.out).not.toContain("GATE GREEN");

  const H = await stackFor();
  const corrupted = join(H.dir, "corrupted.json");
  writeFileSync(corrupted, bundleText.replace("AFFECTED", "NO_KNOWN_IMPACT"));
  const verdict = await H.run(["verify-bundle", "--in", corrupted]);
  expect(verdict.code).toBe(2);
  expect(verdict.stdout).not.toContain("bundle ok");
});
