import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Review round 7 (a cross-check from a P0 of a sibling product: an exponentially backtracking regular expression, a quantified group
 * with an unbounded inner quantifier followed by an anchor). The work budget does NOT protect a single regex exec, so such a regular
 * expression must not exist: (1) a static audit of every regular expression literal and every construction from a string or a
 * template in src/ finds none (a quantified group that contains an unbounded quantifier, or an alternation under an unbounded
 * quantifier); (2) hostile texts of that shape (20, 24, 40 and 5,000 backslashes or percent escapes and a failing tail) go through the
 * redactors and the import validator in a child process with a hard wall clock.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The groups of a regular expression source with the quantifier that follows each. */
function groups(src: string): [string, string][] {
  const out: [string, string][] = [];
  const stack: number[] = [];
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (c === "\\") {
      i += 1;
      continue;
    }
    if (c === "[") {
      i += 1;
      while (i < src.length && src[i] !== "]") {
        if (src[i] === "\\") i += 1;
        i += 1;
      }
      continue;
    }
    if (c === "(") stack.push(i);
    else if (c === ")") {
      const start = stack.pop();
      if (start === undefined) continue;
      const q = /^(?:\*|\+|\?|\{\d+,\d*\}|\{\d+\})\??/.exec(src.slice(i + 1));
      out.push([src.slice(start + 1, i), q ? q[0] : ""]);
    }
  }
  return out;
}
const unbounded = (text: string): boolean => /[*+]|\{\d+,\}/.test(text.replace(/\\./g, "x").replace(/\[(?:\\.|[^\]\\])*\]/g, "C"));
function alternatives(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i] as string;
    if (c === "\\") {
      cur += c + (text[i + 1] ?? "");
      i += 1;
      continue;
    }
    if (c === "[") {
      let j = i;
      while (j < text.length && text[j] !== "]") {
        if (text[j] === "\\") j += 1;
        j += 1;
      }
      cur += text.slice(i, j + 1);
      i = j;
      continue;
    }
    if (c === "(") depth += 1;
    if (c === ")") depth -= 1;
    if (c === "|" && depth === 0) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  parts.push(cur);
  return parts;
}
/** The reasons a regular expression source is a backtracking risk (empty for a safe one). */
export function backtrackingRisks(src: string): string[] {
  const reasons: string[] = [];
  for (const [group, quantifier] of groups(src)) {
    if (!/^(?:\*|\+|\{\d+,\})/.test(quantifier)) continue;
    const inner = group.replace(/^\?:/, "");
    if (unbounded(inner)) reasons.push(`(${inner.slice(0, 50)})${quantifier}: a quantified group with an unbounded inner quantifier`);
    if (alternatives(inner).length > 1) reasons.push(`(${inner.slice(0, 50)})${quantifier}: an alternation under an unbounded quantifier`);
  }
  return reasons;
}

const LITERAL = /(?<![\w)\]}"'`])\/(?![/*])((?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\n\\[])+)\/([a-z]*)(?![\w$])/g;
const CONSTRUCTED = /RegExp\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
const RAW_TEMPLATE = /String\.raw`((?:\\.|[^`\\])*)`/g;
/** Every regular expression source in a TypeScript source: literals, constructions from a string, `String.raw` templates (substitutions become a plain group). */
export function regexSources(source: string): { line: number; src: string }[] {
  const found: { line: number; src: string }[] = [];
  source.split("\n").forEach((line, index) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
    for (const m of line.matchAll(LITERAL)) found.push({ line: index + 1, src: m[1] as string });
    for (const m of line.matchAll(CONSTRUCTED)) found.push({ line: index + 1, src: (m[2] as string).replace(/\$\{[^}]*\}/g, "(?:x)") });
    for (const m of line.matchAll(RAW_TEMPLATE)) found.push({ line: index + 1, src: (m[1] as string).replace(/\$\{[^}]*\}/g, "(?:x)") });
  });
  return found;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.tsx?$/.test(entry)) out.push(path);
  }
  return out;
}

/** Reasoned exceptions: file:line pattern -> why it cannot backtrack catastrophically. Empty: none was needed in round 7. */
const ALLOWED: Record<string, string> = {};

describe("R7 (regex audit): no regular expression of this product can backtrack exponentially", () => {
  it("the audit bites: planted shapes are found (control)", () => {
    for (const shape of ["(?:\\\\+[nr]?|%0[AaDd])+$", "(a+)+b", "(x*y*)*z", "(?:ab|cd)+", "((?:[0-9a-f]+::?)+)?"]) {
      expect(backtrackingRisks(shape), shape).not.toEqual([]);
    }
    for (const shape of ["(?:ab)?c", "(?:\\.[a-z]{1,8}){0,4}", "[a-z]+(?:x|y)", "(?:a|b)", "(?:a|b){1,3}"]) {
      expect(backtrackingRisks(shape), shape).toEqual([]);
    }
    expect(regexSources("const A = /(a+)+b/g;\nconst B = new RegExp('(x*)*y');\nconst C = String.raw`(?:${Q}|b)+`;").length).toBe(3);
  });

  it("every regular expression in src/ (literals, constructions, templates) is free of a quantified group with an unbounded inner quantifier and of an alternation under an unbounded quantifier", () => {
    const files = sourceFiles(join(root, "src"));
    let count = 0;
    const problems: string[] = [];
    for (const file of files) {
      for (const { line, src } of regexSources(readFileSync(file, "utf8"))) {
        count += 1;
        const risks = backtrackingRisks(src);
        const key = `${file.slice(root.length + 1)}:${line}`;
        if (risks.length > 0 && !(key in ALLOWED)) problems.push(`${key}: ${risks.join("; ")}`);
      }
    }
    expect(count, "the audit reads the regular expressions (control)").toBeGreaterThan(300);
    expect(problems).toEqual([]);
  });
});

describe("R7 (regex audit): hostile runs of backslashes and percent escapes with a failing tail finish at once", () => {
  const probe = resolve(root, "tests/helpers/regex-probe.ts");
  it.each([20, 24, 40, 5000])("%i escapes: the redactors and the import validator finish within a wall clock", (n) => {
    const run = spawnSync(process.execPath, ["--import", "tsx", probe, String(n)], { encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL", cwd: root });
    expect(run.status === 0 ? "finished" : `killed or failed within the wall clock: ${run.stderr.slice(-200)}`, "the child").toBe("finished");
    const result = JSON.parse(run.stdout.trim().split("\n").pop() as string) as { slowest_ms: number; shape: string };
    expect(result.slowest_ms, `the slowest shape was ${result.shape}`).toBeLessThan(3000);
  }, 120_000);
});
