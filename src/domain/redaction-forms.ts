/**
 * The forms of a credential that are not `key = value` or a JSON pair, and the helpers that read a value's extent:
 *
 *   YAML block scalars           password: |          the indented lines that follow are the value
 *   command lines                --db-password S      -p=S      ENV PASSWORD S
 *   the value reader             a quoted string behind any run of backslashes, a Python literal (b'S'), an
 *                                object or array, or a bare word
 *
 * All of them work on the text as it is written at any JSON nesting depth: a line break nested d layers deep is a run of
 * backslashes and a letter, and a quote is a run of backslashes and the quote (`lineBreak`, `lineEnd`). Every scan reads a
 * run of backslashes once and never re-reads it, so none is superlinear.
 */
import { groupEnd, registerMemo, SENSITIVE_NAME, spend, type PairEnds, type PairSpan } from "./redaction-pairs.js";

/** Length of the line break that starts at `i`: a real one, one written as JSON text (a backslash run, then `n` or `r`), or `%0A` / `%0D`. */
export function lineBreak(text: string, i: number): number {
  const c = text.charCodeAt(i);
  if (c === 13 && text.charCodeAt(i + 1) === 10) return 2;
  if (c === 10 || c === 13) return 1;
  if (c === 92) {
    let run = 1;
    while (text.charCodeAt(i + run) === 92) run += 1;
    const letter = text.charCodeAt(i + run);
    return letter === 110 || letter === 114 ? run + 1 : 0;
  }
  if (c === 37 && text[i + 1] === "0") {
    const d = text[i + 2];
    if (d === "A" || d === "a" || d === "D" || d === "d") return 3;
  }
  return 0;
}

interface Line {
  /** Where the line's text ends (the break, the closing quote of the enclosing JSON string, or the end of the text). */
  end: number;
  /** Length of the break that follows (0 at the end of the text or when a quote ended the line). */
  brk: number;
  /** True when the line ended on the quote that closes the enclosing JSON string. */
  closed: boolean;
}

/**
 * The end of the line that starts at `from`, each backslash run read once. `stopRun` (the backslash run of the breaks of
 * this text, 0 for real breaks) makes a quote preceded by FEWER backslashes end the line too: that quote closes the JSON string
 * the text is written in, while a quote inside the secret at the same nesting has at least as many.
 */
function lineEnd(text: string, from: number, stopRun: number): Line {
  // A comment read (`stopRun` 0) that ended at `line.end` passed every character from `from`: a read that starts inside ends at the same
  // place, so the `#` comments that many block headers share (`pin=|#Basic pin=|#Basic ...`) are read once (linear).
  if (stopRun !== 0) return readLine(text, from, stopRun);
  if (commentLine.text === text && from >= commentLine.from && from < commentLine.line.end) return commentLine.line;
  const line = readLine(text, from, 0);
  commentLine = { text, from, line };
  return line;
}
let commentLine: { text: string; from: number; line: Line } = { text: "", from: 0, line: { end: 0, brk: 0, closed: false } };
// (a memo of one scan: cleared with the others when a call starts and ends, see registerMemo)
registerMemo(
  () => {
    commentLine = { text: "", from: 0, line: { end: 0, brk: 0, closed: false } };
  },
  () => commentLine.text !== "",
);

function readLine(text: string, from: number, stopRun: number): Line {
  let k = from;
  while (k < text.length) {
    const c = text.charCodeAt(k);
    if (c === 92) {
      let run = 1;
      while (text.charCodeAt(k + run) === 92) run += 1;
      const letter = text.charCodeAt(k + run);
      if (letter === 110 || letter === 114) return { end: k, brk: run + 1, closed: false };
      if (stopRun > 0 && letter === 34 && run < stopRun) return { end: k, brk: 0, closed: true };
      // A quote behind a backslash run that does not close the string is escaped text of the body, not a bare quote.
      k += run + (letter === 34 || letter === 39 ? 1 : 0);
      continue;
    }
    if (c === 10 || c === 13 || (c === 37 && lineBreak(text, k) > 0)) return { end: k, brk: lineBreak(text, k), closed: false };
    // Only a double quote closes the JSON string the text is written in (JSON never escapes an apostrophe, so one in the body is data).
    if (stopRun > 0 && c === 34) return { end: k, brk: 0, closed: true };
    k += 1;
  }
  return { end: text.length, brk: 0, closed: false };
}

/** Number of blanks and list dashes in front of the key that a credential word at `from` belongs to, on its own line; 0 when the key is not at the start of a line. */
export function keyIndent(text: string, from: number): number {
  // Every walk is bounded: a credential word inside one very long key (`"passwordpassword...": |`) would otherwise read the whole
  // run back for each word (quadratic). A key longer than the bound is not a YAML key at the start of a line: 0, the wider reading.
  const floor = Math.max(0, from - MAX_KEY_WALK);
  let i = from;
  while (i > floor && /[A-Za-z0-9_.-]/.test(text[i - 1] as string)) i -= 1;
  if (i === floor && i > 0 && /[A-Za-z0-9_.-]/.test(text[i - 1] as string)) return 0;
  while (i > floor && (text[i - 1] === '"' || text[i - 1] === "'" || text[i - 1] === "\\")) i -= 1;
  let count = 0;
  while (i > floor && (text[i - 1] === " " || text[i - 1] === "\t" || text[i - 1] === "-")) {
    i -= 1;
    count += 1;
  }
  if (i === 0) return count;
  const before = text[i - 1];
  const escaped = (before === "n" || before === "r") && text[i - 2] === "\\";
  const percent = i >= 3 && text[i - 3] === "%" && text[i - 2] === "0" && /[AaDd]/.test(before as string);
  return before === "\n" || before === "\r" || escaped || percent ? count : 0;
}

/** Longest stretch keyIndent reads back from a credential word (the key, the quotes and the blanks in front of it). */
const MAX_KEY_WALK = 512;

/** Longest block scalar read line by line; beyond it the rest of the text is taken (fail closed). */
const MAX_BLOCK_LINES = 100_000;

/**
 * A YAML block scalar: `at` is the `|` or `>` after `key:`. The value is the more indented lines that follow the header
 * (indicators, spaces and a comment, then a line break); blank lines belong to it; the first line indented no more than the
 * key ends it. Null when the header is not followed by a line break or the body is empty (`a > b`, `| value`).
 */
export function blockScalar(text: string, at: number, indent: number): { start: number; end: number } | null {
  let i = at + 1;
  for (let n = 0; n < 2 && /[+\-0-9]/.test(text[i] ?? ""); n += 1) i += 1;
  while (text[i] === " " || text[i] === "\t") i += 1;
  if (text[i] === "#") i = lineEnd(text, i, 0).end;
  const first = lineBreak(text, i);
  if (first === 0) return null;
  let run = 0;
  while (text[i + run] === "\\") run += 1;
  const start = i + first;
  let cursor = start;
  let end = -1;
  for (let lines = 0; cursor < text.length; lines += 1) {
    if (lines >= MAX_BLOCK_LINES) return { start, end: text.length };
    let j = cursor;
    let here = 0;
    while (text[j] === " " || text[j] === "\t") {
      j += 1;
      here += 1;
    }
    const blank = lineBreak(text, j);
    if (blank > 0) {
      cursor = j + blank;
      continue;
    }
    if (j >= text.length || here <= indent) break;
    const line = lineEnd(text, j, run);
    end = line.end;
    if (line.closed || line.brk === 0) break;
    cursor = line.end + line.brk;
  }
  return end === -1 ? null : { start, end };
}

const isPrefixLetter = (c: string | undefined): boolean => c !== undefined && "bBrRuUfF".includes(c);

/**
 * The value that starts at `from`: a quoted string (behind a run of backslashes at any JSON depth, and a Python literal
 * prefix such as `b'`, `r"`, `rb'`, `f"`), an object or an array, or a bare word up to the next delimiter.
 */
export function readValue(text: string, from: number, ends: PairEnds): { start: number; end: number; quoted: boolean } {
  let i = from;
  let prefix = 0;
  while (prefix < 2 && isPrefixLetter(text[i + prefix])) prefix += 1;
  if (prefix > 0) {
    let k = i + prefix;
    while (text[k] === "\\") k += 1;
    if (text[k] === '"' || text[k] === "'") i += prefix;
  }
  // A value can open with a quote that is itself escaped once per JSON layer (`\"`, `\\\"`, ...): the run of backslashes in
  // front of the opening quote says how deep the text is nested (no cap: the run is read once).
  let openRun = 0;
  while (text[i + openRun] === "\\") openRun += 1;
  if (openRun > 0 && (text[i + openRun] === '"' || text[i + openRun] === "'")) {
    i += openRun;
  } else {
    openRun = 0;
    if (text[i] === "\\") i += 1;
  }
  const quote = text[i];
  if (quote === '"' || quote === "'") {
    const start = i + 1;
    return { start, end: ends.endOf(text, start, quote, openRun), quoted: true };
  }
  // A group ends where its brackets close, but never earlier than the word that its closing character is glued to (`[S]tail`, `{}S`, `(a)S`, `{a}}S` are one
  // word: the tail is data too; a random password can open a bracket, a brace or a parenthesis and close it a few characters later).
  if (quote === "[" || quote === "{" || quote === "(") {
    const group = quote === "(" ? parenEnd(text, i) : groupEnd(text, i, ends.endOf);
    return { start: i, end: Math.max(group, gluedWordEnd(text, group, ends), ends.unquotedEnd(text, i)), quoted: false };
  }
  return { start: i, end: ends.unquotedEnd(text, i), quoted: false };
}

/** Where the parenthesis that opens at `start` closes (one past it), within MAX_GROUP characters of the group reader; `start` itself when it does not close (the value is then read as a plain word). */
function parenEnd(text: string, start: number): number {
  let depth = 0;
  const cap = Math.min(text.length, start + 1024);
  for (let i = start; i < cap; i += 1) {
    const c = text.charCodeAt(i);
    if (c === 40) depth += 1;
    else if (c === 41) {
      depth -= 1;
      if (depth === 0) {
        spend(i - start + 1);
        return i + 1;
      }
    }
  }
  spend(cap - start);
  return start;
}

/**
 * The end of the word that begins at `from`, the end of a group, when the closing character is glued to it: the closers behind the group (`}` `)` `]`) belong
 * to the word when a word character follows them (`{a}}S`), and stay out of it when a delimiter or the end follows (`{"a":{"password":{..}}}`: the closers of the
 * enclosing structure are kept). A delimiter right behind the group ends the value (the documented limit on values that contain one).
 */
function gluedWordEnd(text: string, from: number, ends: PairEnds): number {
  let k = from;
  while (text[k] === "}" || text[k] === ")" || text[k] === "]") k += 1;
  spend(k - from);
  const after = ends.unquotedEnd(text, k);
  return k > from && after === k ? from : after;
}

const LONG_FLAG = /(?:(?<![A-Za-z0-9_-])|(?<=\\[nrt]))--([A-Za-z0-9][A-Za-z0-9_.-]{0,60})[ \t]+/g;
/** A flag whose LAST word is a secret word (`--db-password`, `--api-key`, `--client-secret`); `--token-file` and `--key-path` are not. */
const FLAG_SECRET_WORD = /(?:^|[-_.])(?:password|passwd|pass|pwd|passphrase|secret|token|key|apikey|credential|credentials|cookie|authorization|bearer)$/i;
const SHORT_P_EQUALS = /(?:(?<![A-Za-z0-9_-])|(?<=\\[nrt]))-[pP]=/g;
const ENV_DECLARATION = /(?:(?<![A-Za-z0-9_])|(?<=\\[nrt]))(?:ENV|ARG)[ \t]+([A-Za-z0-9_.-]{1,100})[ \t]+/g;

/**
 * Command line and Dockerfile forms that have no `=` between the name and the value: `--db-password S`, `--api-key "S"`,
 * `-p=S` and `ENV PASSWORD S` / `ARG API_TOKEN S`. A short flag followed by a space (`-p S`, `-u user:S`) is NOT read: `-p 8080`
 * is a port (docs/MANIFEST.md, not covered).
 */
export function scanCommandForms(text: string, out: PairSpan[], ends: PairEnds): void {
  const take = (from: number): number => {
    const value = readValue(text, from, ends);
    if (value.end - value.start >= 6) out.push({ start: value.start, end: value.end, kind: "credential_command", low: true });
    return value.end;
  };
  let m: RegExpExecArray | null;
  LONG_FLAG.lastIndex = 0;
  // Every match of the three readers is one counted step of the scan (the flags that are not credential flags take no value and read nothing else).
  while ((m = LONG_FLAG.exec(text)) !== null) {
    spend(1);
    const at = m.index + m[0].length;
    if (!FLAG_SECRET_WORD.test(m[1] as string) || text[at] === "-") continue;
    // The scan goes on right behind the flag, INSIDE the value it takes: a quote that is not closed (`--api-key 'S | --secret 'S2`) makes
    // the value run up to the next quote, and the next flag lives in it, so both values are hidden (each start reads its own value).
    take(at);
  }
  SHORT_P_EQUALS.lastIndex = 0;
  while ((m = SHORT_P_EQUALS.exec(text)) !== null) {
    spend(1);
    take(m.index + m[0].length);
  }
  ENV_DECLARATION.lastIndex = 0;
  while ((m = ENV_DECLARATION.exec(text)) !== null) {
    spend(1);
    if (!SENSITIVE_NAME.test(m[1] as string)) continue;
    take(m.index + m[0].length);
  }
}
