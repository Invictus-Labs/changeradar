#!/usr/bin/env node
// Automated fresh-directory harness for docs/RUNBOOK-SMOKE.md.
//
// It runs the runbook's `bash` blocks, byte for byte and in order, in ONE bash session inside a fresh temporary
// directory, and checks each block's output against the `expect` block that follows it. It edits nothing: like an
// operator it exports CHANGERADAR_TARBALL (the runbook's "Before you start" section) and may choose a free
// CHANGERADAR_PORT, which the blocks read. Before that it proves the fail-fast path: step 1 without the variable must
// stop with the documented message and install nothing. This is SUPPLEMENTAL evidence for AC-11: it shows the
// documented commands work on a clean machine. It is not the independent human drill (docs/HUMAN-DRILL.md) and never
// satisfies AC-11.
//
// Usage: node scripts/runbook-harness.mjs         (builds a tarball with `npm pack` unless CHANGERADAR_TARBALL is set)
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// CR_RUNBOOK_FILE points the harness at another runbook (used only to prove that a wrong expectation fails the run).
const runbook = readFileSync(process.env.CR_RUNBOOK_FILE ?? join(root, "docs/RUNBOOK-SMOKE.md"), "utf8");

const blocks = [...runbook.matchAll(/```(bash|expect)\n([\s\S]*?)```/g)].map((m) => ({ kind: m[1], text: m[2] }));
const steps = [];
for (let i = 0; i < blocks.length; i += 1) {
  if (blocks[i].kind !== "bash") continue;
  const next = blocks[i + 1];
  steps.push({ index: steps.length, command: blocks[i].text, expect: next && next.kind === "expect" ? next.text.split("\n").map((l) => l.trim()).filter(Boolean) : [] });
}
if (steps.length < 10) {
  console.error(`runbook-harness: found only ${steps.length} bash blocks in docs/RUNBOOK-SMOKE.md`);
  process.exit(1);
}

const freePort = () =>
  new Promise((resolvePort, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });

const work = mkdtempSync(join(tmpdir(), "changeradar-runbook-"));
let tarball = process.env.CHANGERADAR_TARBALL;
if (!tarball) {
  if (!existsSync(join(root, "dist/src/cli.js"))) {
    console.error("runbook-harness: run `npm run build` first (or set CHANGERADAR_TARBALL)");
    process.exit(1);
  }
  // npm 11 prints the output of the `prepack` script (the build) in front of the JSON array on the same stream.
  const packedOut = execFileSync("npm", ["pack", "--pack-destination", work, "--json", "--loglevel=error"], { cwd: root, encoding: "utf8" });
  const packed = JSON.parse(packedOut.slice(packedOut.lastIndexOf("\n[") + 1));
  tarball = join(work, packed[0].filename);
}

const port = await freePort();

// Control: step 1 exactly as written, WITHOUT the package variable, must refuse with the documented message.
{
  const control = spawn("bash", ["-s"], { cwd: work, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? work, TMPDIR: work, LANG: "C" }, stdio: ["pipe", "pipe", "pipe"] });
  let controlOut = "";
  control.stdout.on("data", (c) => (controlOut += c.toString()));
  control.stderr.on("data", (c) => (controlOut += c.toString()));
  control.stdin.end(`set -euo pipefail\n{\n${steps[0].command}\n} 2>&1\n`);
  const controlCode = await new Promise((r) => control.on("close", r));
  if (controlCode === 0 || !/STOP: CHANGERADAR_TARBALL must be the full path/.test(controlOut) || /added \d+ packages?/.test(controlOut)) {
    console.error(`runbook-harness: step 1 without CHANGERADAR_TARBALL did not fail fast (exit ${controlCode}):\n${controlOut}`);
    rmSync(work, { recursive: true, force: true });
    process.exit(1);
  }
  console.log("control: step 1 without CHANGERADAR_TARBALL stops with the documented message and installs nothing");
}

// Control: a RELATIVE package path (the likely way to set the variable) is resolved before step 1 changes directory,
// so it installs instead of failing with a cryptic ENOENT after the `cd`.
{
  const relative = spawn("bash", ["-s"], { cwd: dirname(tarball), env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? work, TMPDIR: work, LANG: "C", CHANGERADAR_TARBALL: `./${basename(tarball)}` }, stdio: ["pipe", "pipe", "pipe"] });
  let relativeOut = "";
  relative.stdout.on("data", (c) => (relativeOut += c.toString()));
  relative.stderr.on("data", (c) => (relativeOut += c.toString()));
  relative.stdin.end(`set -euo pipefail\n{\n${steps[0].command}\n} 2>&1\n`);
  const relativeCode = await new Promise((r) => relative.on("close", r));
  if (relativeCode !== 0 || /ENOENT|STOP:/.test(relativeOut)) {
    console.error(`runbook-harness: step 1 with a relative CHANGERADAR_TARBALL failed (exit ${relativeCode}):\n${relativeOut}`);
    rmSync(work, { recursive: true, force: true });
    process.exit(1);
  }
  console.log("control: step 1 with a relative CHANGERADAR_TARBALL resolves it and installs");
}

let script = "set -euo pipefail\n";
for (const step of steps) {
  script += `echo "@@@BEGIN ${step.index}"\n{\n${step.command}\n} 2>&1\necho "@@@END ${step.index}"\n`;
}

const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? work, TMPDIR: work, LANG: "C", CHANGERADAR_TARBALL: tarball, CHANGERADAR_PORT: String(port) };
const child = spawn("bash", ["-s"], { cwd: work, env, stdio: ["pipe", "pipe", "pipe"] });
let out = "";
child.stdout.on("data", (c) => (out += c.toString()));
child.stderr.on("data", (c) => (out += c.toString()));
const timer = setTimeout(() => child.kill("SIGKILL"), 600_000);
child.stdin.end(script);
const code = await new Promise((r) => child.on("close", r));
clearTimeout(timer);

let failed = 0;
for (const step of steps) {
  const begin = out.indexOf(`@@@BEGIN ${step.index}\n`);
  const end = out.indexOf(`@@@END ${step.index}\n`);
  if (begin < 0 || end < 0) {
    console.log(`step ${step.index + 1}/${steps.length}: NOT RUN`);
    failed += 1;
    continue;
  }
  const output = out.slice(begin + `@@@BEGIN ${step.index}\n`.length, end);
  const missing = step.expect.filter((line) => !output.includes(line));
  if (missing.length > 0) {
    failed += 1;
    console.log(`step ${step.index + 1}/${steps.length}: FAIL, missing: ${missing.map((m) => JSON.stringify(m)).join(", ")}`);
    console.log(output.split("\n").map((l) => `    ${l}`).join("\n"));
  } else {
    console.log(`step ${step.index + 1}/${steps.length}: ok (${step.expect.length} expected line(s) found)`);
  }
}
if (code !== 0 && failed === 0) failed = 1;
if (code !== 0) console.log(`bash exited with ${code}\n${out.split("\n").slice(-25).join("\n")}`);
rmSync(work, { recursive: true, force: true });
console.log(failed === 0 ? `runbook-harness: all ${steps.length} runbook steps matched (supplemental evidence; AC-11 still needs the human receipt)` : `runbook-harness: ${failed} step(s) failed`);
process.exit(failed === 0 ? 0 : 1);
