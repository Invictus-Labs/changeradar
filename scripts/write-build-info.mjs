#!/usr/bin/env node
// Records which source the package was built from, next to the compiled server (dist/src/build-info.json), so a
// person holding only the package file can tell what it is: `changeradar version` prints it. Runs from `prepack`
// (npm pack) right after `npm run build` (prepack rebuilds, so the compiled files are the checkout that is
// stamped, never a stale dist next to a newer HEAD). No timestamps: the same source gives the same file.
//
// commit: the full 40 character HEAD of the checkout, or null when git is unavailable.
// dirty:  true when the working tree had uncommitted or untracked changes (ignored files do not count), false when
//         clean, null when unknown. A package that is dirty or has no commit cannot be tied to a reviewed revision.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = resolve(root, "dist/src/build-info.json");
if (!existsSync(resolve(root, "dist/src"))) {
  console.error("write-build-info: dist/src does not exist; run `npm run build` first");
  process.exit(1);
}

const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
let commit = null;
let dirty = null;
try {
  commit = git("rev-parse", "HEAD");
  if (!/^[0-9a-f]{40}$/.test(commit)) commit = null;
  else dirty = git("status", "--porcelain").length > 0;
} catch {
  commit = null;
  dirty = null;
}
const version = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;
writeFileSync(target, JSON.stringify({ name: "changeradar", version, commit, dirty }, null, 2) + "\n");
console.log(`write-build-info: version ${version}, commit ${commit ?? "unknown"}${dirty ? " (dirty)" : ""}`);
