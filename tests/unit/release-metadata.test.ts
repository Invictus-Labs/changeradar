import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { APP_VERSION } from "../../src/platform/version.js";

/** Review round 1 (P2/P3): the packed documents must not link to files the package does not carry. */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string; files: string[] };

/** Is `path` (repo relative, forward slashes) shipped by the `files` allowlist of package.json? */
function shipped(path: string): boolean {
  if (["package.json", "LICENSE", "README.md"].includes(path)) return true;
  return pkg.files
    .filter((entry) => !entry.startsWith("!"))
    .some((entry) => {
      if (entry === path) return true;
      if (!entry.includes("*")) return path.startsWith(`${entry}/`);
      const [dir, glob] = [dirname(entry), entry.slice(dirname(entry).length + 1)];
      return dirname(path) === dir && new RegExp(`^${glob.replaceAll(".", "\\.").replaceAll("*", "[^/]*")}$`).test(path.slice(dir.length + 1));
    });
}

function markdownFiles(): string[] {
  const out = ["README.md", "SECURITY.md", "CONTRIBUTING.md", "CHANGELOG.md", "THIRD-PARTY-NOTICES.md"];
  for (const dir of ["docs", "docs/qa"]) for (const name of readdirSync(join(root, dir))) if (name.endsWith(".md")) out.push(`${dir}/${name}`);
  return out.filter((file) => shipped(file));
}

describe("release metadata", () => {
  it("APP_VERSION is the package.json version", () => {
    expect(APP_VERSION).toBe(pkg.version);
  });

  it("the shipped documents link only to files the package ships", () => {
    const dead: string[] = [];
    for (const file of markdownFiles()) {
      const text = readFileSync(join(root, file), "utf8");
      for (const match of text.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
        const target = match[1] as string;
        if (/^[a-z]+:/i.test(target) || target.startsWith("mailto:")) continue;
        const repoPath = normalize(join(dirname(file), target)).replaceAll("\\", "/");
        if (!existsSync(join(root, repoPath))) dead.push(`${file} -> ${target} (missing in the repository)`);
        else if (!shipped(repoPath)) dead.push(`${file} -> ${target} (not shipped in the package)`);
      }
    }
    expect(dead).toEqual([]);
  });

  it("control: the link check does catch a link to an unshipped file", () => {
    expect(shipped("docs/qa/ac-matrix.md")).toBe(true);
    expect(shipped("SECURITY.md")).toBe(true);
    expect(shipped("tests/unit/diff.test.ts")).toBe(false);
    expect(shipped("scripts/verify-quality.sh")).toBe(false);
    expect(shipped("docs/prd/changeradar.html")).toBe(false);
  });

  it("the package carries the notices for the bundled web dependencies", () => {
    expect(shipped("THIRD-PARTY-NOTICES.md")).toBe(true);
    const notices = readFileSync(join(root, "THIRD-PARTY-NOTICES.md"), "utf8");
    for (const name of ["react", "react-dom", "react-router", "react-router-dom", "scheduler", "cookie", "set-cookie-parser"]) expect(notices).toContain(`## ${name} `);
    expect(notices).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/);
  });
});
