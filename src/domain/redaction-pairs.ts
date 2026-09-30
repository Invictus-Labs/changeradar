/**
 * Credential NAME / VALUE pairs, the structured shape of secrets in configuration written as data:
 *
 *   {"name":"DB_PASSWORD","value":"..."}              env lists, cookies, secret stores
 *   {"Name":"/prod/db/password","Type":"SecureString","Value":"..."}     a key in between, a path for a name
 *   {"value":"...","name":"session"}                  either order
 *   [["password","..."]]  ["--password","..."]        tuples and argument vectors
 *
 * in TEXT at any JSON nesting depth (a quote is `\\*["']`: a run of backslashes of any length, read once), and in OBJECTS
 * (`redactDeep({name: "DB_PASSWORD", value})`). Every pattern starts on a quote and uses bounded quantifiers, except the
 * backslash run in the middle of a pattern, which is read once per start; the value itself is delimited by the caller's
 * quote scan (no length cap, no backslash-run cap). The value may be a string, a number or bare word, an object or an
 * array; the two halves may be separated by other keys and by whole objects and arrays. The same pairs written without
 * JSON quoting (`name=DB_PASSWORD value=S`, `name: password, value: S`, a YAML list of `name:` / `value:` lines) are read
 * too. What is not covered stays in the documented limits (docs/MANIFEST.md): a name longer than 300 characters, a gap of
 * more than 600 characters, and key names that are not in NAME_KEYS and VALUE_KEYS.
 */

import { blockScalar, keyIndent } from "./redaction-forms.js";

export interface PairSpan {
  start: number;
  end: number;
  kind: string;
  low: boolean;
}

/** End of a quoted value that starts at `start` (see `quotedEnd` in redaction.ts). */
export type QuotedEnd = (text: string, start: number, quote: string, openRun: number) => number;

/**
 * A name that introduces a credential: a password, secret, token, key, cookie, session, or authorization word anywhere in
 * it (so `/prod/db/password` and `DB_PASSWORD` and `x-auth-token` are names of secrets), and `pass`, `auth`, `sid` as
 * whole words (so `bypass`, `author` and `inside` are not).
 */
export const SENSITIVE_NAME =
  /pass(?:word|wd|code|phrase)|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private|(?:signing|encryption|master|ssh|account|storage|license)[_-]?key|connection[_ -]?string|(?:database|db)[_ -]?url|webhook|csrf|xsrf|cookie|authorization|credential|session|jwt|bearer|dsn|signature|(?<![a-z])(?:pass|auth|sid|otp|totp|pin|pw|pswd|cred|creds|pem)(?![a-z])/i;

// A quote as JSON writes it at any depth: any number of backslashes, then the quote.
const Q = String.raw`\\*["']`;
/** The keys that hold the NAME half of a pair and the keys that hold the VALUE half (either half may be written first). */
const NAME_KEYS = String.raw`(?:name|key|header|k|id|label|field|variable|env|parametername|parameterkey|paramkey)`;
const VALUE_KEYS = String.raw`(?:[A-Za-z_]{0,12}value|v|val|data|content|text|payload)`;
const NAME_CHARS = String.raw`[A-Za-z0-9_./:$@ \[\]{}-]{0,300}`;
const NAME_PAIR = `["']${NAME_KEYS}${Q}\\s{0,10}[:=]\\s{0,10}${Q}(${NAME_CHARS})${Q}`;
/** A value key up to and including the `:` or `=` after it and the blanks behind it; what follows is the value. */
const VALUE_KEY = `["']${VALUE_KEYS}${Q}\\s{0,10}[:=]\\s{0,10}`;
const NAME_PAIR_G = new RegExp(NAME_PAIR, "gi");
const VALUE_KEY_G = new RegExp(VALUE_KEY, "gi");
const TUPLE_G = new RegExp(`["'](?:--?)?([A-Za-z0-9_./:$@\\[\\]{}-]{1,300})${Q}\\s{0,10},\\s{0,10}${Q}`, "gi");
// Sticky variants run at a position of the whole text (see `seek`).
/** The value key that follows a name. */
const VALUE_AFTER_NAME = new RegExp(VALUE_KEY, "iy");
/** The name that follows a value. */
const NAME_AFTER_VALUE = new RegExp(NAME_PAIR, "iy");

// The same pairs written WITHOUT JSON quoting: `name=DB_PASSWORD value=S`, `name: password, value: S`, and YAML lists
// (`- name: DB_PASSWORD` then `value: S` on the next line). Values may still be quoted; a key may be quoted on either side.
const NAME_TOKEN = String.raw`[A-Za-z0-9_./:$@\[\]{}-]{1,300}`;
/** Not glued to the letters of a word, except behind a line break WRITTEN AS TEXT (a backslash and an n, r or t). */
const WORD_EDGE = String.raw`(?:(?<![A-Za-z0-9_])|(?<=\\[nrt]))`;
const BARE_NAME_G = new RegExp(String.raw`${WORD_EDGE}${NAME_KEYS}[ \t]{0,10}[:=][ \t]{0,10}(?:${Q})?(${NAME_TOKEN})`, "gi");
const BARE_VALUE_G = new RegExp(String.raw`${WORD_EDGE}${VALUE_KEYS}[ \t]{0,10}[:=][ \t]{0,10}`, "gi");
const BARE_VALUE_HEAD = new RegExp(String.raw`(?:${Q})?${WORD_EDGE}${VALUE_KEYS}(?:${Q})?[ \t]{0,10}[:=][ \t]{0,10}`, "iy");
const BARE_NAME_HEAD = new RegExp(String.raw`(?:${Q})?${WORD_EDGE}${NAME_KEYS}(?:${Q})?[ \t]{0,10}[:=][ \t]{0,10}(?:${Q})?(${NAME_TOKEN})`, "iy");

/**
 * How far the other half of a pair may be: 600 characters that are not a backslash (objects and arrays in between are
 * skipped, and a quote nested d layers deep is a run of 2^d - 1 backslashes and a quote, so runs are not counted against
 * the 600), and never more than MAX_PAIR_SCAN characters of any kind: every start reads a bounded stretch of text. The
 * bound is 2^19 characters: a pair keeps its two halves within a few quotes of each other, and each quote at nesting depth 13
 * is 8,191 backslashes and 19 layers would be one quote per bound, so pairs are read to 16 layers of JSON (tested to 13).
 */
const MAX_PAIR_GAP = 600;
const MAX_PAIR_SCAN = 524_288;
/** The longest object or array read as one value. */
const MAX_GROUP = 1024;

/** What the caller's scans provide: the end of a quoted value and the end of an unquoted one. */
export interface PairEnds {
  endOf: QuotedEnd;
  unquotedEnd: (text: string, from: number) => number;
}

/**
 * The next key that matches `head` (a sticky pattern that starts on a quote) within MAX_PAIR_GAP characters after `from`,
 * without leaving the object or array that `from` is inside. Objects and arrays in between are skipped whole (their keys are
 * at another depth). Every candidate is a quote, and each position is tried once: linear in the gap.
 */
function seek(text: string, from: number, head: RegExp): RegExpExecArray | null {
  let depth = 0;
  let steps = 0;
  const limit = Math.min(text.length, from + MAX_PAIR_SCAN);
  for (let i = from; i < limit && steps < MAX_PAIR_GAP; i += 1) {
    spend(1);
    const c = text.charCodeAt(i);
    if (c === 92) {
      i = slashEnd(text, i) - 1;
      continue;
    }
    steps += 1;
    if (c === 123 || c === 91) depth += 1;
    else if (c === 125 || c === 93) {
      depth -= 1;
      if (depth < 0) return null;
    } else if (depth === 0 && (c === 34 || c === 39)) {
      head.lastIndex = i;
      const m = head.exec(text);
      if (m) return m;
    }
  }
  return null;
}

const isLetter = (c: number): boolean => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);

/** `seek` for keys that may be written without quotes: candidates are letters, quotes and backslashes. */
function seekBare(text: string, from: number, head: RegExp): RegExpExecArray | null {
  let depth = 0;
  let steps = 0;
  const limit = Math.min(text.length, from + MAX_PAIR_SCAN);
  for (let i = from; i < limit && steps < MAX_PAIR_GAP; i += 1) {
    spend(1);
    const c = text.charCodeAt(i);
    if (c !== 92) steps += 1;
    if (c === 123 || c === 91) depth += 1;
    else if (c === 125 || c === 93) {
      depth -= 1;
      if (depth < 0) return null;
    } else if (depth === 0 && (isLetter(c) || c === 34 || c === 39 || c === 92)) {
      head.lastIndex = i;
      const m = head.exec(text);
      if (m) return m;
      // A head tried at a backslash reads the whole run (`\\*["']`); the positions inside the run would read the same run again, so it is passed once.
      if (c === 92) i = slashEnd(text, i) - 1;
    }
  }
  return null;
}

/**
 * The work budget of ONE scan of one text (see startScan): every read that could be repeated for many starts counts the characters it
 * reads. When the count passes 64 per input character (plus a floor) the scan is abandoned with ScanBudgetExceeded and the caller
 * hides the WHOLE text (fail closed, never in part), so no shape of text can make one call cost more than a constant times its length.
 */
export class ScanBudgetExceeded extends Error {}
let budget = { perChar: 64, floor: 65_536 };
let workLeft = Number.POSITIVE_INFINITY;
/** Forces the budget (a test setting: the defaults are 64 steps per character and a floor of 65,536). */
export function setWorkBudget(perChar: number, floor: number): void {
  budget = { perChar, floor };
}
/**
 * Every memo of a scan (a read remembered for the scan of ONE text) is registered here, so that a call clears them all when it starts and
 * again when it ends, also after a throw: no state outlives a call and no reference to a scanned text (which can hold a secret) is kept.
 * `holds` says whether a memo still refers to a text (the inspection of the tests).
 */
const memos: { clear: () => void; holds: () => boolean }[] = [];
export function registerMemo(clear: () => void, holds: () => boolean): void {
  memos.push({ clear, holds });
}
export const memoHoldsText = (): boolean => memos.some((memo) => memo.holds());
/** Begins the scan of one text (and, called with 0 in a `finally`, ends it): clears every memo and sets the work budget. */
export function startScan(length: number): void {
  for (const memo of memos) memo.clear();
  workLeft = budget.perChar * length + budget.floor;
}
export function spend(units: number): void {
  workLeft -= units;
  if (workLeft < 0) throw new ScanBudgetExceeded("the work budget of one scan is spent");
}

/**
 * A read that ended at `end` passed every character from `from`, none of which ends it: a read of the same kind that starts inside
 * that stretch ends at the same place. Each read keeps its last stretch, keyed by the text itself (a stale entry is never wrong).
 */
export interface Run {
  text: string;
  from: number;
  end: number;
}
export const newRun = (): Run => {
  const run: Run = { text: "", from: 0, end: 0 };
  registerMemo(
    () => {
      run.text = "";
      run.from = 0;
      run.end = 0;
    },
    () => run.text !== "",
  );
  return run;
};
/** The end that a read starting at `from` would find, or -1 when the last stretch says nothing about `from`. */
export const knownEnd = (run: Run, text: string, from: number): number => (run.text === text && from >= run.from && from < run.end ? run.end : -1);
export const remember = (run: Run, text: string, from: number, end: number): number => {
  run.text = text;
  run.from = from;
  run.end = end;
  return end;
};

const slashes = newRun();
/** End of the run of backslashes that `from` is in (each run is read once). */
function slashEnd(text: string, from: number): number {
  const known = knownEnd(slashes, text, from);
  if (known >= 0) {
    spend(1);
    return known;
  }
  let j = from;
  while (text.charCodeAt(j) === 92) j += 1;
  spend(j - from);
  return remember(slashes, text, from, j);
}

/**
 * End (exclusive) of the object or array that opens at `start`, nested groups counted and strings skipped whole (through the
 * caller's quote scan). Over MAX_GROUP characters, or with no closing bracket, the group is taken to the end of the text:
 * redacting too much is the safe failure.
 */
export function groupEnd(text: string, start: number, endOf: QuotedEnd): number {
  let depth = 0;
  const cap = Math.min(text.length, start + MAX_GROUP);
  for (let i = start; i < cap; ) {
    const c = text[i];
    if (c === "[" || c === "{") depth += 1;
    else if (c === "]" || c === "}") {
      depth -= 1;
      if (depth === 0) return i + 1;
    } else if (c === '"' || c === "'") {
      let run = 0;
      while (i - 1 - run >= start && text[i - 1 - run] === "\\") run += 1;
      // `endOf` answers where the closing delimiter STARTS (a bare quote, or the backslash run of an escaped one): step over it.
      const closing = endOf(text, i + 1, c, run);
      let k = closing;
      while (text[k] === "\\") k += 1;
      i = text[k] === c ? k + 1 : Math.max(closing, i + 1);
      continue;
    }
    i += 1;
  }
  return text.length;
}

/**
 * The value that starts at `pos` (just after `:` or `=` and the blanks): a quoted string (behind any run of backslashes), an
 * object or array, or a bare word or number. Records the span when it has at least six characters and returns where the
 * value ends. `requireValue` (tuples) accepts only a quoted string that is not itself a key.
 */
function pushValue(text: string, pos: number, ends: PairEnds, out: PairSpan[], requireValue: boolean): number {
  let q = pos;
  while (text[q] === "\\") q += 1;
  const c = text[q];
  if (c === '"' || c === "'") {
    let run = 0;
    while (q - 1 - run >= 0 && text[q - 1 - run] === "\\") run += 1;
    const start = q + 1;
    const end = ends.endOf(text, start, c, run);
    // A string followed by `:` is a KEY (`"valueFrom":`), not a value.
    if (requireValue) {
      let k = end;
      while (text[k] === "\\" || text[k] === '"' || text[k] === "'") k += 1;
      while (text[k] === " " || text[k] === "\t") k += 1;
      if (text[k] === ":") return end;
    }
    if (end - start >= 6) out.push({ start, end, kind: "credential_pair", low: true });
    return end;
  }
  if (requireValue) return q;
  // A YAML block scalar as the value (`value: |` and the indented lines under it): the header is not the value, the body is.
  if (c === "|" || c === ">") {
    let key = q;
    while (key > 0 && (text[key - 1] === " " || text[key - 1] === "\t" || text[key - 1] === ":" || text[key - 1] === "=")) key -= 1;
    const block = blockScalar(text, q, keyIndent(text, key - 1));
    if (block !== null) {
      out.push({ start: block.start, end: block.end, kind: "credential_pair", low: true });
      return block.end;
    }
  }
  const end = c === "[" || c === "{" ? groupEnd(text, q, ends.endOf) : ends.unquotedEnd(text, q);
  if (end - q >= 6) out.push({ start: q, end, kind: "credential_pair", low: true });
  return Math.max(end, q);
}

/** Spans of the secret VALUE of every name/value pair in `text` (see the file header). */
export function scanPairs(text: string, out: PairSpan[], ends: PairEnds): void {
  // 1. name first: `"name":"<secret name>" ... "value":<secret>`
  NAME_PAIR_G.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NAME_PAIR_G.exec(text)) !== null) {
    const after = m.index + m[0].length;
    if (!SENSITIVE_NAME.test(m[1] as string)) continue;
    const next = seek(text, after, VALUE_AFTER_NAME);
    if (next) pushValue(text, next.index + next[0].length, ends, out, false);
  }
  // 2. value first: `"value":<secret> ... "name":"<secret name>"`
  VALUE_KEY_G.lastIndex = 0;
  while ((m = VALUE_KEY_G.exec(text)) !== null) {
    const probe: PairSpan[] = [];
    const end = pushValue(text, m.index + m[0].length, ends, probe, false);
    const name = seek(text, end, NAME_AFTER_VALUE);
    if (name && SENSITIVE_NAME.test(name[1] as string)) out.push(...probe);
  }
  // 3. tuples and argument vectors: `"password","<secret>"`, `"--password","<secret>"`. The match ends on the opening quote of
  // the next string, which may itself be a credential name (`["run","--password","<secret>"]`): search again from the next
  // character, not from the end of the match.
  TUPLE_G.lastIndex = 0;
  while ((m = TUPLE_G.exec(text)) !== null) {
    const next = m.index + 1;
    if (SENSITIVE_NAME.test(m[1] as string)) pushValue(text, m.index + m[0].length - 1, ends, out, true);
    TUPLE_G.lastIndex = next;
  }
  // 4. the same pairs without JSON quoting (`name=DB_PASSWORD value=S`, YAML lists), name first ...
  BARE_NAME_G.lastIndex = 0;
  while ((m = BARE_NAME_G.exec(text)) !== null) {
    if (!SENSITIVE_NAME.test(m[1] as string)) continue;
    const head = seekBare(text, m.index + m[0].length, BARE_VALUE_HEAD);
    if (head) pushValue(text, head.index + head[0].length, ends, out, false);
  }
  // 5. ... and value first.
  BARE_VALUE_G.lastIndex = 0;
  while ((m = BARE_VALUE_G.exec(text)) !== null) {
    const probe: PairSpan[] = [];
    const end = pushValue(text, m.index + m[0].length, ends, probe, false);
    const name = seekBare(text, end, BARE_NAME_HEAD);
    if (name && SENSITIVE_NAME.test(name[1] as string)) out.push(...probe);
  }
}

const NAME_KEY = /^(?:name|key|header|k|id|label|field|variable|env|parametername|parameterkey|paramkey)$/i;
const VALUE_KEY_NAME = /^(?:[a-z_]{0,12}value|v|val|data|content|text|payload)$/i;

/**
 * The keys of `object` that hold the value half of a name/value pair whose name is a credential name. `fold` is the text
 * fold of the caller (invisible and combining characters removed), so a name that hides a character is still read.
 */
export function pairedValueKeys(object: Record<string, unknown>, fold: (text: string) => string = (text) => text): Set<string> {
  const hidden = new Set<string>();
  const keys = Object.keys(object);
  const named = keys.some((k) => NAME_KEY.test(fold(k)) && typeof object[k] === "string" && SENSITIVE_NAME.test(fold(object[k] as string)));
  if (!named) return hidden;
  for (const k of keys) if (VALUE_KEY_NAME.test(fold(k))) hidden.add(k);
  return hidden;
}

/** The indexes of `array` that follow a credential name (`["password", S]`, `["--password", S]`, `["run", "--token", S]`, `["/prod/db/password", S]`). */
export function pairedArrayIndexes(array: readonly unknown[], fold: (text: string) => string = (text) => text): Set<number> {
  const hidden = new Set<number>();
  for (let i = 0; i + 1 < array.length; i += 1) {
    const item = array[i];
    const next = array[i + 1];
    if (typeof item !== "string" || typeof next !== "string") continue;
    // An element that already holds the marker (`Authorization:[REDACTED]`) is redacted text, not a name: redacting twice changes nothing.
    if (item.includes("[REDACTED]")) continue;
    const name = fold(item);
    if (/^--?[A-Za-z0-9_./:$@[\]{}-]{1,300}$|^[A-Za-z0-9_./:$@[\]{}-]{1,300}$/.test(name) && SENSITIVE_NAME.test(name) && !next.startsWith("-")) hidden.add(i + 1);
  }
  return hidden;
}
