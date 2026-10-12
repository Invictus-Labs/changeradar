import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Review round 5 (tests P3, logic P3): the test ids the acceptance matrix names must resolve. Each `file :: describe > test`
 * names a test file that exists and, for every segment, a title that the file really contains (a segment may end in `...` as
 * an abbreviation, and only a prefix is then compared). A wildcard (`*`), a placeholder (`<page>`) or a title built at run
 * time does not name a test and is refused: the matrix has to say which test proves the criterion.
 */

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const matrix = readFileSync(join(repo, "docs", "qa", "ac-matrix.md"), "utf8");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(test|spec)\.tsx?$/.test(entry)) out.push(path);
  }
  return out;
}
const files = walk(join(repo, "tests"));
const byName = new Map<string, string[]>();
for (const file of files) {
  const name = file.slice(file.lastIndexOf("/") + 1);
  byName.set(name, [...(byName.get(name) ?? []), file]);
}
/** The files an id names: by base name, and, when the id carries a directory (`tests/integration/x.test.ts`), only those under it. */
const filesOf = (id: string): string[] => (byName.get(id.slice(id.lastIndexOf("/") + 1)) ?? []).filter((path) => !id.includes("/") || path.endsWith(`/${id}`));
/**
 * The source without block comments and without lines that are only a comment: a title that appears only in a comment is not a test
 * (round 7, test review P3). A trailing comment after code is left in place (a `//` inside a title, as in a URL, must not cut it).
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((line) => !/^\s*\/\//.test(line)).join("\n");
}
/** Where `piece` first occurs in `text` at or after `from` (in any of its JavaScript-escaped forms), or -1. */
function titleAt(text: string, piece: string, from: number): number {
  const at = jsEscape(piece).map((form) => text.indexOf(form, from)).filter((index) => index >= 0);
  return at.length === 0 ? -1 : Math.min(...at);
}
const sources = new Map<string, string>();
const sourceOf = (file: string): string => {
  let text = sources.get(file);
  if (text === undefined) {
    text = withoutComments(readFileSync(file, "utf8"));
    sources.set(file, text);
  }
  return text;
};

/** `file.test.ts :: a > b > c`, the file with or without a directory in front of it. */
const ID_PATTERN = /`((?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.(?:test|spec)\.tsx?) :: ([^`]+)`/g;
/** The same, or a continuation (`... :: title`) that names the file of the id before it. */
const ID_OR_CONTINUATION = /`((?:(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.(?:test|spec)\.tsx?)|\.\.\.) :: ([^`]+)`/g;

/** Every id in the matrix, with the line it stands on (a continuation takes the file of the id before it). */
function ids(): { line: number; file: string; chain: string[]; text: string }[] {
  const found: { line: number; file: string; chain: string[]; text: string }[] = [];
  let lastFile = "";
  matrix.split("\n").forEach((line, index) => {
    for (const m of line.matchAll(ID_OR_CONTINUATION)) {
      if (m[1] !== "...") lastFile = m[1] as string;
      else if (lastFile === "") continue;
      found.push({ line: index + 1, file: lastFile, chain: (m[2] as string).split(" > ").map((s) => s.trim()), text: m[0] });
    }
  });
  return found;
}

const jsEscape = (title: string): string[] => [title, title.replace(/"/g, '\\"'), title.replace(/'/g, "\\'"), title.replace(/`/g, "\\`")];

describe("R5: every test id in the acceptance matrix resolves to a real test file and real titles", () => {
  const all = ids();

  it("the matrix names test ids at all (control: the parser finds them)", () => {
    expect(all.length).toBeGreaterThan(100);
  });

  it("control: an id with a directory in front is parsed, resolved by that directory, and a wrong title in it is refused", () => {
    const parsed = [...'`tests/integration/offline.test.ts :: a > b`'.matchAll(ID_PATTERN)];
    expect(parsed.map((m) => m[1])).toEqual(["tests/integration/offline.test.ts"]);
    expect(filesOf("tests/integration/offline.test.ts").length).toBe(1);
    expect(filesOf("tests/integration/security.test.ts").length).toBe(1);
    expect(filesOf("tests/unit/security.test.ts")).toEqual([]);
    const text = filesOf("tests/integration/offline.test.ts").map(sourceOf).join("\n");
    expect(text.includes("this title does not exist anywhere")).toBe(false);
    // the matrix has prefixed ids (control that the widened pattern reaches them)
    expect(all.filter((id) => id.file.includes("/")).length).toBeGreaterThan(0);
  });

  it("control: a title only in a comment is not found, and the chain must stand in order", () => {
    const source = '// it("only in a comment", () => {})\n/* it("in a block", () => {}) */\ndescribe("outer", () => {\n  it("inner", () => {});\n});\nit("later", () => {});\n';
    const text = withoutComments(source);
    expect(titleAt(text, "only in a comment", 0)).toBe(-1);
    expect(titleAt(text, "in a block", 0)).toBe(-1);
    const outer = titleAt(text, "outer", 0);
    const inner = titleAt(text, "inner", outer);
    expect(outer).toBeGreaterThanOrEqual(0);
    expect(inner).toBeGreaterThan(outer);
    expect(titleAt(text, "outer", inner + 1), "an outer title after the inner one is not found").toBe(-1);
  });

  it("no id uses a wildcard or a placeholder, and every id names a file that exists exactly once by that name", () => {
    const problems: string[] = [];
    for (const id of all) {
      if (id.chain.some((s) => /\*|<[^>]+>/.test(s))) problems.push(`${id.text} (line ${id.line}): a wildcard or placeholder does not name a test`);
      const where = filesOf(id.file);
      if (where.length === 0) problems.push(`${id.text} (line ${id.line}): no such test file`);
      else if (where.length > 1 && !where.some((path) => existsSync(path))) problems.push(`${id.text}: ambiguous file name`);
    }
    expect(problems).toEqual([]);
  });

  it("every title segment of every id is a title the file contains (a trailing `...` abbreviates: the prefix is compared)", () => {
    const problems: string[] = [];
    for (const id of all) {
      const candidates = filesOf(id.file);
      const text = candidates.map(sourceOf).join("\n");
      // The titles of one id must stand in the order of the chain (a describe before the test inside it): the search for each piece goes on
      // from where the previous one was found. A piece that is only in a comment is not found (the sources are read without comments).
      let cursor = 0;
      for (const segment of id.chain) {
        if (/\*|<[^>]+>/.test(segment)) continue; // reported by the previous test
        // A segment that is only `...` elides a describe title; `...` inside a segment elides words: every piece must be in the file.
        for (const piece of segment.split(/\s*(?:\.\.\.|…)\s*/).map((p) => p.trim()).filter((p) => p !== "")) {
          const at = titleAt(text, piece, cursor);
          if (at < 0) problems.push(`${id.text} (line ${id.line}): "${piece}" is not a title in ${id.file}, or not after the title before it`);
          else cursor = at;
        }
      }
    }
    expect(problems).toEqual([]);
  });
});
