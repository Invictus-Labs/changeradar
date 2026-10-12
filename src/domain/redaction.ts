import { blockScalar, keyIndent, readValue, scanCommandForms } from "./redaction-forms.js";
import { knownEnd, newRun, pairedArrayIndexes, pairedValueKeys, remember, scanPairs, ScanBudgetExceeded, setWorkBudget, spend, startScan, type PairEnds } from "./redaction-pairs.js";

export { setWorkBudget };

/**
 * Secret redaction for logs and exports, and HTML escaping for report text (AC-09).
 *
 * BEST EFFORT. The detector is pattern based, so it is a safety net, not a guarantee: manifests must contain
 * credential aliases only, and the validator rejects what it recognises as a secret value. A secret in a shape
 * this file does not know passes both the validator and the redactor. `docs/MANIFEST.md` lists what is covered.
 *
 * Design (each rule exists because of a failure in review, see docs/qa/review-round1-ledger.md):
 * - Linear time. Every pattern starts on a literal prefix, uses bounded quantifiers, or is a hand-written scan that
 *   jumps past what it has already looked at. An unbounded quantifier is only ever the LAST element of a pattern,
 *   so it consumes a whole long value and can never backtrack. No pattern starts on a character class.
 * - No leading boundaries: a shape is recognised whatever glues to its front (a letter, a digit, `_`, `%20`, a
 *   literal `\n` or `%0A` from an escaped header dump). The price is a few more false positives inside words, which
 *   the validator only counts when the value looks random.
 * - The text is first folded to compatibility form (NFKC, per code point, expansion capped) with every default
 *   ignorable character and every combining mark removed, and every match is mapped back to the ORIGINAL text. So
 *   `gh<zero width>p_...`, `g<combining mark>hp_...` and fullwidth `ＡＫＩＡ...` are found, and text that holds no
 *   secret is returned byte for byte unchanged.
 * - There are NO scan windows (a window edge can split a key from its value): the whole string is scanned in one
 *   pass. Memory is bounded by refusing to scan what is too large: above MAX_SCAN_CHARS (or MAX_FOLD_CHARS for text
 *   that needs folding) `redactSecrets` returns a fixed placeholder and `detectSecretKinds` reports `oversize`,
 *   which the validator rejects. That is fail closed; every caller in the server passes at most 64 KB.
 * - Output is built from array parts and joined once; there is no per character concatenation.
 * - Identifier fields (node ids, check keys, finding ids, ...) are only ever redacted with the strictness the
 *   manifest validator applies (`redactIdentifier`), so an id that was accepted at import is never rewritten in a
 *   view or an export and two different ids never collapse into one.
 */

export const REDACTED = "[REDACTED]";
/** What `redactSecrets` returns for a string too large to scan (fail closed). */
export const OVERSIZE_REDACTED = "[REDACTED: value too large to scan]";

/** A detected secret: the character range to replace, in the text being scanned. */
interface Span {
  start: number;
  end: number;
  kind: string;
  /** Low-confidence spans are redacted in logs but only count for the manifest validator when random looking. */
  low: boolean;
}

/** Largest string that is scanned (characters). Larger input fails closed. */
const MAX_SCAN_CHARS = 8 * 1024 * 1024;
/** Largest string that needs folding (any non-ASCII character) that is scanned. Folding allocates per character. */
const MAX_FOLD_CHARS = 512 * 1024;
/** At most this many UTF-16 units are kept of one code point's NFKC form (U+FDFA expands to 18). */
const MAX_EXPANSION = 4;

/** Longest quoted value and gap the assignment scanner looks across (a key name and a backslash run have no cap). */
const MAX_QUOTED = 65536;
const MAX_GAP = 64;
const MAX_USERINFO = 4096;

interface TokenPattern {
  readonly kind: string;
  readonly regex: RegExp;
  /** Ordinary words can look like the token (`Bearer authentication`): the validator needs a random looking value. */
  readonly low?: boolean;
}

/**
 * The two shortest, most common prefixes (`sk-`, `hf_`) also occur inside ordinary words (`risk-assessment-...`,
 * `task-...`, `flask-...`). A LETTER directly in front therefore blocks them; a digit, `_`, `-`, `%20`, a quote or the
 * end of an escape sequence (`\n`, `\t`, `%0A`, which end in a letter) does not, so a glued token is still found.
 * Every other prefix is distinctive enough to match anywhere.
 */
const WORD_START = "(?:(?<![A-Za-z])|(?<=\\\\[nrt])|(?<=%0[AaDd]))";

/**
 * Prefix-anchored token shapes. Each ends in an open-ended class (consumes the whole token, never backtracks) or a
 * fixed length. A leading boundary is used only where the prefix is short enough to occur inside ordinary words.
 */
const TOKEN_PATTERNS: readonly TokenPattern[] = [
  { kind: "aws_access_key", regex: /(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA)[0-9A-Z]{16}[0-9A-Z]*/g },
  { kind: "github_token", regex: /gh[pousr]_[A-Za-z0-9]{20,}/g },
  { kind: "github_token", regex: /github_pat_[A-Za-z0-9_]{20,}/g },
  { kind: "gitlab_token", regex: /glpat-[A-Za-z0-9_-]{20,}/g },
  { kind: "npm_token", regex: /npm_[A-Za-z0-9]{20,}/g },
  { kind: "huggingface_token", regex: new RegExp(`${WORD_START}hf_[A-Za-z0-9]{20,}`, "g") },
  { kind: "slack_token", regex: /xox[abposr]-[A-Za-z0-9-]{10,}/g },
  { kind: "slack_webhook", regex: /hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{8,}/g },
  { kind: "discord_webhook", regex: /discord(?:app)?\.com\/api\/webhooks\/[0-9]{6,}\/[A-Za-z0-9_-]{20,}/g },
  { kind: "stripe_key", regex: /[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { kind: "stripe_key", regex: /whsec_[A-Za-z0-9]{16,}/g },
  { kind: "api_key", regex: new RegExp(`${WORD_START}sk-[A-Za-z0-9_-]{20,}`, "g") },
  { kind: "google_api_key", regex: /AIza[0-9A-Za-z_-]{35}/g },
  { kind: "google_oauth_token", regex: /ya29\.[0-9A-Za-z_-]{20,}/g },
  { kind: "sendgrid_key", regex: /SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g },
  { kind: "twilio_key", regex: /(?:SK|AC)[0-9a-fA-F]{32}(?![A-Za-z0-9])/g },
  { kind: "azure_key", regex: /(?:AccountKey|SharedAccessKey|SharedAccessSignature)\s{0,10}=\s{0,10}[A-Za-z0-9+/%=]{20,}/gi },
  { kind: "bearer_token", regex: /Bearer\s{1,10}[A-Za-z0-9._~+/-]{6,}=*/gi, low: true },
  // `Basic responsibilities` is prose; a real credential is base64 and looks random, so the validator needs that.
  { kind: "basic_auth", regex: /Basic\s{1,10}[A-Za-z0-9+/]{16,}=*/gi, low: true },
];

/** Whole-line headers: the value up to the end of the line is the secret. No leading boundary (see the header). */
const HEADER_LINE = /(?:Set-Cookie|Cookie|Proxy-Authorization|Authorization)\s{0,10}:\s{0,10}([^\r\n]+)/gi;

/** Names that introduce a credential value (`name suffix = value`). The value is found by a bounded scan. */
const ASSIGNMENT_KEY = /(?:client[_-]?secret|private[_-]?key|api[_-]?key|access[_-]?key|(?:signing|encryption|master|ssh|license|stripe|account|storage)[_-]?key|secret|token|pass(?:word|wd)?|pwd|credential|set-cookie|cookie|auth(?:orization)?|session[_-]?id|sessionid|connection[_-]?string|(?:database|db)[_-]?url|dsn|webhook|jwt|bearer|\[REDACTED\](?=["'])|x-amz-(?:signature|security-token)|(?<=[?&])(?:sig(?![A-Za-z])|(?:x-goog-)?signature)|(?:(?<![A-Za-z])|(?<=\\[nrt])|(?<=%0[AaDd]))(?:sid|pw|pswd|pin|otp)(?![A-Za-z]))/gi;
/**
 * A key may be followed by a bare `:` (no quote) only when it is exactly one of these: `service.password-reset:v2.1.0`
 * and `auth-service:v1.2.3` are identifiers, not assignments. `=` and JSON style `"key": ` accept the wider set and
 * a suffix (`aws_secret_access_key = ...`).
 */
const BARE_COLON_KEY = /^(?:client[_-]?secret|private[_-]?key|api[_-]?key|access[_-]?key|secret[_-]?key|secret|token|pass(?:word|wd|phrase)?|pwd|credentials|auth(?:orization)?)s?$/i;
/**
 * More exact names that assign with a bare `:` ONLY in the spaced style of YAML and config files (`dsn: value`, a blank, a
 * quote or a line break after the colon): `/sid:abcdef1` in a route or a `key:value` glued pair stays an identifier.
 */
const SPACED_COLON_KEY = /^(?:credential|session[_-]?id|sessionid|sid|connection[_-]?string|(?:database|db)[_-]?url|dsn|webhook[_-]?url|jwt|bearer|(?:signing|encryption|master|ssh|license|stripe|account|storage)[_-]?key|pw|pswd|pin|otp)$/i;

/** Property names (exact) whose values are always replaced by redactDeep, regardless of content. */
const SENSITIVE_EXACT =
  /^(?:pass(?:word|wd)?|pwd|secret|token|api[_-]?key|apikey|x-api-key|access[_-]?key|aws[_-]?secret[_-]?access[_-]?key|secret[_-]?access[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|authorization|proxy-authorization|cookie|set-cookie|session|session[_-]?id|sessionid|client[_-]?secret|private[_-]?key|credential|credentials|bearer)$/i;

/** A property name that CONTAINS a credential word as a whole word (`DB_PASSWORD`, `githubToken`, `x-auth-token`, `secretKey`). */
const CREDENTIAL_WORDS = new Set(["password", "passwd", "pwd", "passphrase", "secret", "token", "cookie", "authorization", "credential", "credentials", "bearer", "jwt", "otp", "dsn", "apikey"]);
const CREDENTIAL_PAIRS = new Set(["api key", "access key", "private key", "signing key", "connection string"]);
function hasCredentialWord(key: string): boolean {
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  for (let i = 0; i < words.length; i += 1) {
    if (CREDENTIAL_WORDS.has(words[i] as string)) return true;
    if (i + 1 < words.length && CREDENTIAL_PAIRS.has(`${words[i]} ${words[i + 1]}`)) return true;
  }
  return false;
}

/**
 * Whether redactDeep replaces the value under this property name. Identifier fields (`credential_alias`, `check_key`,
 * ...) are handled at validator strength instead, so a name that merely contains a credential word does not hide an id.
 */
const SENSITIVE_KEY = {
  test: (key: string): boolean => SENSITIVE_EXACT.test(key) || (!IDENTIFIER_KEY.test(key) && (hasCredentialWord(key) || LOWER_KEY_SECRET.test(key.toLowerCase()))),
};

/**
 * Counters and limits that carry the word `token` in the ordinary sense (LLM usage, page tokens). This is a narrow
 * allow-list, not a segment rule: the NAME must be exactly one of these (lower case, `-` and `_` alike) AND the value must be
 * a number or a boolean. The same names holding a string, an array or an object (`tokens_used: "<secret>"`) stay hidden,
 * and so does every name not listed (`tokens`, `api_tokens`, `token`, `access_token`).
 */
const ORDINARY_TOKEN_NAMES = new Set(["tokens_used", "tokens_total", "tokens_remaining", "token_count", "token_limit", "max_tokens", "prompt_tokens", "completion_tokens", "total_tokens", "tokenizer"]);
function isOrdinaryTokenCounter(key: string, value: unknown): boolean {
  return (typeof value === "number" || typeof value === "boolean") && ORDINARY_TOKEN_NAMES.has(key.toLowerCase().replace(/-/g, "_"));
}

/**
 * The whole lower-cased key, for names that run words together (`PGPASSWORD`, `dbpass`, `adminpwd`, `signingkey`,
 * `stripeKey`, `DATABASE_URL`, `slack_webhook`) or are one word (`Auth`, `cookies`). `pass` and `auth` count only as the
 * last word, so `passport`, `compass`, `bypass`, `author` and `authority` keep their values.
 */
const LOWER_KEY_SECRET =
  /password|passwd|passcode|passphrase|pwd|secret|token|cookie|credential|webhook|jwt|bearer|dsn$|(?:^|[^a-z])(?:pass|auth|pin|pw|pswd|sid|otp|totp|cred|creds|pem)$|(?:db|user|admin|smtp|ftp|root|mail|redis|pg)pass|(?:signing|encryption|master|ssh|private|access|api|license|stripe|auth|account|storage|cert)[_-]?key|keyfile|(?:database|db|redis|mongo|amqp|broker)[_-]?url|(?:mongo|jdbc|smtp|hook)[_-]?(?:uri|url)|jsessionid|phpsessid|connect\.sid|(?:recovery|activation)[_-]?code/;

const isDigit = (c: number): boolean => c >= 48 && c <= 57;
const isAlpha = (c: number): boolean => (c >= 97 && c <= 122) || (c >= 65 && c <= 90);
const isB64Url = (c: number): boolean => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || isDigit(c) || c === 45 || c === 95;

// Exported for tests only (tests/unit/review-round7-validator-equivalence.test.ts); not part of the package interface.
export function looksRandomAt(text: string, start: number, end: number, digit: NextMark, letter: NextMark): boolean {
  return nextMark(text, start, isDigitCode, digit) < end && nextMark(text, start, isLetterCode, letter) < end;
}

/**
 * The place of the next digit (or letter) at or after `from`, `Infinity` when there is none: a low-confidence span counts for the validator only
 * when it holds both. Nested spans share their end (`-p=-p=-p=...`: every opener's value runs to the end of the text), so the answer of one search
 * serves every later start up to the place it found, one pass over the text for all of them instead of a slice and a search per span (quadratic).
 * The distance searched is charged to the work budget. A `NextMark` lives in one call of `findSpansUnbudgeted`.
 */
export interface NextMark {
  text: string;
  from: number;
  at: number;
}
const isDigitCode = (code: number): boolean => code >= 48 && code <= 57;
const isLetterCode = (code: number): boolean => (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
function nextMark(text: string, from: number, wanted: (code: number) => boolean, memo: NextMark): number {
  if (memo.text === text && from >= memo.from && from <= memo.at) return memo.at;
  let at = from;
  while (at < text.length && !wanted(text.charCodeAt(at))) at += 1;
  spend(at - from + 1);
  memo.text = text;
  memo.from = from;
  memo.at = at < text.length ? at : Infinity;
  return memo.at;
}

/** Every other format character (general category Cf): they render as nothing, so they can split a token like the rest. */
const FORMAT_CHAR = /^\p{Cf}$/u;

/**
 * Every Default_Ignorable_Code_Point (zero width, joiners, bidi controls, variation selectors, fillers, tags, ...), every
 * other format character (U+13430..U+1343F, U+FFF9..U+FFFB, the Arabic number signs, ...) and every control character
 * except tab, line feed and carriage return (`gh<NUL>p_...` and `ghp<BEL>_...` are one token).
 */
function isIgnorable(cp: number): boolean {
  return (
    (cp >= 0x80 && FORMAT_CHAR.test(String.fromCodePoint(cp))) ||
    (cp < 0x20 && cp !== 9 && cp !== 10 && cp !== 13) ||
    cp === 0x7f ||
    (cp >= 0x80 && cp <= 0x9f) ||
    cp === 0xad ||
    cp === 0x034f ||
    cp === 0x061c ||
    cp === 0x115f ||
    cp === 0x1160 ||
    cp === 0x17b4 ||
    cp === 0x17b5 ||
    (cp >= 0x180b && cp <= 0x180f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x206f) ||
    cp === 0x3164 ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    cp === 0xfeff ||
    cp === 0xffa0 ||
    (cp >= 0xfff0 && cp <= 0xfff8) ||
    (cp >= 0x1bca0 && cp <= 0x1bca3) ||
    (cp >= 0x1d173 && cp <= 0x1d17a) ||
    (cp >= 0xe0000 && cp <= 0xe0fff)
  );
}

/** Combining marks: `g` + U+0301 composes to a letter that matches nothing, so they are dropped while matching. */
const COMBINING_MARK = /^\p{M}$/u;

/** Text that needs folding: any non-ASCII character, and any control character other than tab, line feed and carriage return. */
const NON_ASCII = /[^\x09\x0a\x0d\x20-\x7e]/;

interface Folded {
  readonly text: string;
  /** Original index at which the source of each folded character starts / ends. */
  readonly from: Int32Array;
  readonly to: Int32Array;
}

/**
 * NFKC per code point with ignorable characters and combining marks dropped, remembering where each folded
 * character came from. Typed arrays sized once (at most MAX_EXPANSION units per code point), so a string full of
 * expanders (U+FDFA becomes 18 characters) cannot grow the allocation without bound.
 */
function fold(source: string): Folded {
  const capacity = source.length * MAX_EXPANSION;
  const units = new Uint16Array(capacity);
  const from = new Int32Array(capacity);
  const to = new Int32Array(capacity);
  let length = 0;
  for (let i = 0; i < source.length; ) {
    const cp = source.codePointAt(i) as number;
    const width = cp > 0xffff ? 2 : 1;
    if (cp < 0x80 && !isIgnorable(cp)) {
      units[length] = cp;
      from[length] = i;
      to[length] = i + 1;
      length += 1;
    } else if (!isIgnorable(cp)) {
      const original = String.fromCodePoint(cp);
      if (cp < 0x300 || !COMBINING_MARK.test(original)) {
        let form = original.normalize("NFKC");
        if (form.length > MAX_EXPANSION) form = form.slice(0, MAX_EXPANSION);
        for (let k = 0; k < form.length; k += 1) {
          units[length] = form.charCodeAt(k);
          from[length] = i;
          to[length] = i + width;
          length += 1;
        }
      }
    }
    i += width;
  }
  return { text: new TextDecoder("utf-16le").decode(units.subarray(0, length)), from, to };
}

// ---- hand written scans (each linear: bounded, or jumps past what it has covered) ----

function scanPrivateKeys(text: string, out: Span[]): void {
  let i = text.indexOf("-----BEGIN ");
  while (i !== -1) {
    // Also PGP armor: the same header with `PGP` in front of `PRIVATE KEY` and `BLOCK` after it.
    if (/^-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/.test(text.slice(i, i + 90))) {
      let end = text.length; // an unterminated block is consumed to the end of the text
      let at = text.indexOf("-----END ", i + 11);
      while (at !== -1) {
        const trailer = /^-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/.exec(text.slice(at, at + 90));
        if (trailer) {
          end = at + trailer[0].length;
          break;
        }
        at = text.indexOf("-----END ", at + 9);
      }
      out.push({ start: i, end, kind: "private_key", low: false });
      i = text.indexOf("-----BEGIN ", end);
    } else {
      i = text.indexOf("-----BEGIN ", i + 11);
    }
  }
}

/** End of the run of base64url characters that starts at `from` (linear in the run). */
function runEnd(text: string, from: number): number {
  let i = from;
  while (i < text.length && isB64Url(text.charCodeAt(i))) i += 1;
  return i;
}

/**
 * JWT: `eyJ` + three dot separated base64url segments of at least eight characters. A failed start cannot be
 * rescued by any start inside the same run (same run end, shorter first segment), so the scan jumps past it.
 */
function scanJwt(text: string, out: Span[]): void {
  let i = text.indexOf("eyJ");
  while (i !== -1) {
    const e1 = runEnd(text, i);
    if (text.charCodeAt(e1) === 46 && e1 - (i + 3) >= 8) {
      const e2 = runEnd(text, e1 + 1);
      if (text.charCodeAt(e2) === 46 && e2 - (e1 + 1) >= 8) {
        const e3 = runEnd(text, e2 + 1);
        if (e3 - (e2 + 1) >= 8) {
          out.push({ start: i, end: e3, kind: "jwt", low: false });
          i = text.indexOf("eyJ", e3);
          continue;
        }
      }
    }
    i = text.indexOf("eyJ", Math.max(i + 3, e1));
  }
}

const isSchemeChar = (c: number): boolean => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || isDigit(c) || c === 43 || c === 46 || c === 45;
const isAuthorityEnd = (c: number): boolean => c === 47 || c === 63 || c === 35 || c === 34 || c === 39 || c === 60 || c === 62 || c === 32 || (c >= 9 && c <= 13);

/** `scheme://user:password@host` and `scheme://token@host`: the secret part of the userinfo is replaced. */
function scanUrlCredentials(text: string, out: Span[]): void {
  SCHEME_SEPARATOR.lastIndex = 0;
  let separator: RegExpExecArray | null;
  while ((separator = SCHEME_SEPARATOR.exec(text)) !== null) {
    const i = separator.index;
    let s = i;
    while (s > 0 && i - s < 32 && isSchemeChar(text.charCodeAt(s - 1))) s -= 1;
    // Whatever glues to the front of the scheme (`-`, `.`, a digit, the `0` of `%20`) is not part of it.
    while (s < i && !isAlpha(text.charCodeAt(s))) s += 1;
    if (s < i) {
      const start = i + separator[0].length;
      let end = start;
      let at = -1;
      while (end < text.length && end - start < MAX_USERINFO && !isAuthorityEnd(text.charCodeAt(end))) {
        if (text.charCodeAt(end) === 64) at = end;
        end += 1;
      }
      if (at > start) {
        const userinfo = text.slice(start, at);
        const colon = userinfo.indexOf(":");
        if (colon !== -1) {
          if (at - (start + colon + 1) > 0) out.push({ start: start + colon + 1, end: at, kind: "url_credentials", low: false });
          // A URL whose password is the fixed word `x-oauth-basic` (GitHub) carries the credential in its user part.
          if (colon > 0 && /^x-oauth-basic$/i.test(text.slice(start + colon + 1, at))) out.push({ start, end: start + colon, kind: "url_credentials", low: false });
        } else if (userinfo.length >= 8) {
          // A user name alone is only treated as a credential when it looks like a token (git@host is not one).
          out.push({ start, end: at, kind: "url_credentials", low: true });
        }
      }
    }
    SCHEME_SEPARATOR.lastIndex = Math.max(SCHEME_SEPARATOR.lastIndex, i + separator[0].length);
  }
}

/** `://`, and the same with escaped slashes (`:\/\/`) as JSON writes it. */
const SCHEME_SEPARATOR = /:(?:\/\/|\\\/\\\/)/g;

/** `key = value`, `"key": "value"`, `key: value` where the key names a credential. */
function scanAssignments(text: string, out: Span[]): void {
  ASSIGNMENT_KEY.lastIndex = 0;
  // End of the run of key characters scanned last. Credential words inside one long key share it, so the scan stays
  // linear however much text follows the credential word inside a key name (there is no cap on that suffix).
  let runEnd = -1;
  // A consumed value is scanned again for a key inside it (a key can hide in a value, and the value must not take its secret
  // with it). A short one always; a long one while this budget lasts, which keeps the extra reading a constant times the text.
  let rescanBudget = 8 * text.length + 65_536;
  const rescans = (length: number): boolean => {
    if (length <= RESCAN_LIMIT) return true;
    if (rescanBudget < length) return false;
    rescanBudget -= length;
    return true;
  };
  let m: RegExpExecArray | null;
  while ((m = ASSIGNMENT_KEY.exec(text)) !== null) {
    const keyEnd = m.index + m[0].length;
    // A word that is not a key here is passed over; the search goes on one character into it, because another credential word may
    // overlap it (`jwt` inside `Mjwtoken` hides the `token` behind it if the search resumed after `jwt`).
    const at = m.index;
    const next = (): void => {
      ASSIGNMENT_KEY.lastIndex = at + 1;
    };
    let i = keyEnd;
    if (keyEnd < runEnd) {
      i = runEnd;
    } else {
      while (i < text.length && isKeyChar(text.charCodeAt(i))) i += 1;
      runEnd = i;
    }
    // A bare-colon key is one short name, so a longer key is never tested (and never sliced).
    let bareKey = i - m.index <= 24 && BARE_COLON_KEY.test(text.slice(m.index, i));
    const spacedKey = i - m.index <= 24 && SPACED_COLON_KEY.test(text.slice(m.index, i));
    // A credential word glued to a bracketed token (`pass<ghp_...>=value`, `token[...]=value`): the group belongs to the key,
    // so `=` still assigns; a bare `:` does not (the key is no longer exactly a name, and the answer must not change
    // when the token inside the group has been redacted). Looked for within 128 characters on the same line: linear.
    if (text[i] === "<" || text[i] === "[" || text[i] === "(") {
      const close = text[i] === "<" ? ">" : text[i] === "[" ? "]" : ")";
      let j = i + 1;
      while (j < text.length && j - i <= 128 && text[j] !== close && text[j] !== "\n") j += 1;
      if (text[j] === close) {
        i = j + 1;
        bareKey = false;
      }
    }
    let quotedKey = false;
    // The key's closing quote is preceded by a whole RUN of backslashes at JSON depth 2 and deeper (`\"`, `\\\"`, ...),
    // exactly like the value's opening quote below. The run has no cap: it is read once and then consumed.
    let keyRun = 0;
    while (text[i + keyRun] === "\\") keyRun += 1;
    if (keyRun > 0) i += text[i + keyRun] === '"' || text[i + keyRun] === "'" ? keyRun : 1;
    if (text[i] === '"' || text[i] === "'") {
      quotedKey = true;
      i += 1;
    }
    if (text[i] === "]") i += 1; // config["password"]=..., env[PASSWORD]=...
    i = skipBlank(text, i);
    let separator = text[i];
    // `?=` (make), `+=` (shell, make), `||=` and `??=` (JS, Ruby) assign as well.
    if ((separator === "?" || separator === "+") && text[i + 1] === "=") {
      i += 1;
      separator = "=";
    } else if ((separator === "|" || separator === "?") && text[i + 1] === separator && text[i + 2] === "=") {
      i += 2;
      separator = "=";
    }
    // `auth-service:v1.2.3` and `job.secret-rotation:nightly2` are identifiers: a bare `:` only counts after a plain key name.
    const spacedColon = separator === ":" && spacedKey && /[ \t\r\n"'\\=]/.test(text[i + 1] ?? "");
    if ((separator !== ":" && separator !== "=") || (separator === ":" && !quotedKey && !bareKey && !spacedColon)) {
      next();
      continue;
    }
    let after = i + 1;
    // `=>` (Ruby, PHP, Perl hashes) and `:=` (Go, Pascal) assign as well.
    if ((separator === "=" && text[after] === ">") || (separator === ":" && text[after] === "=")) after += 1;
    // A `#` right after `key: ` may open a comment (the value is then on the next line) or be the first character of the value
    // (`password: #S`): the first word of it is hidden as a value, and a comment of several words is left readable.
    // After `key:` YAML may put the value on the next line, and JSON text writes that line break as `\n`.
    i = separator === ":" ? skipGap(text, after) : skipBlank(text, after);
    // The gap may hold `#` words (a comment, on the key's line or on a line of its own): the first word of each, when it has six
    // characters or more, is hidden as a value as well, since `password:` then `  #S` on the next line is a value that starts with `#`.
    if (separator === ":") hideHashWords(text, after, i, out);
    if (separator === ":" || separator === "=") {
      // A YAML node property (`&anchor`, `!!str`, `!tag`) may stand between the key and its value. A property of six
      // characters or more is redacted too: a secret can begin with `!` or `&`, and hiding an anchor name costs nothing.
      // (After `=` only the block scalar header below is read: `auth = >-` then the indented lines.)
      const properties = separator === ":" ? skipNodeProperties(text, i, out) : i;
      i = properties;
      // A block scalar (`|`, `>-`, `|2`): the value is the more indented lines that follow, read to the end of the block.
      if (text[i] === "|" || text[i] === ">") {
        const block = blockScalar(text, i, keyIndent(text, m.index));
        if (block !== null) {
          out.push({ start: block.start, end: block.end, kind: "credential_assignment", low: true });
          // A block that ends at a quote (`token:|\n auth="S"`, the text's own `\n`) can hide a key and leave its value: a short block is scanned again from its start.
          // (from the end of the KEY, not the block: a comment in the gap between them can hold a key of its own, `otp: #apikey="S"` then the block)
          ASSIGNMENT_KEY.lastIndex = Math.max(ASSIGNMENT_KEY.lastIndex, rescans(block.end - block.start) ? keyEnd : block.end);
          continue;
        }
      }
    }
    // A `!` that is still here was not a tag (see skipNodeProperties: glued to more text it is a VALUE, hidden whole from the `!`): it is hidden up to the furthest of two readings,
    // the value read from the character behind the `!` (a quote opens a quoted value, a bracket, a brace or a parenthesis a group: `!'dx$awi`, `!]*9H_`, `!{7eDk}`) and the word up to
    // a blank, a comma, a closing bracket or brace, a backslash or a quote (the span that a tree before round 8 hid: `!;gEo7H1=q...`). The value behind that word is read as any other.
    // (A short word that a backslash ends, `!ab\\\apikey: S`, is the other way out of skipNodeProperties: it is read as a bare value from the `!`, with the key inside it kept.)
    if (text[i] === "!") {
      const word = propertyWordEnd(text, i);
      if (text[word] !== "\\") {
        const end = Math.max(readValue(text, i + 1, ASSIGN_ENDS).end, word);
        if (end - i >= 6) out.push({ start: i, end, kind: "credential_assignment", low: true });
        i = end;
      }
    }
    let value = readValue(text, i, ASSIGN_ENDS);
    // `password: string = "S"`: a type name after the key, and the value behind the `=`.
    if (!value.quoted && value.end - value.start <= 16 && TYPE_WORD.test(text.slice(value.start, value.end))) {
      const equals = skipBlank(text, value.end);
      if (text[equals] === "=" && text[equals + 1] !== ">") value = readValue(text, skipBlank(text, equals + 1), ASSIGN_ENDS);
    }
    // A bare word that ends in `=` or `:` is the head of ANOTHER assignment (`pw: password="..."`), not this one's value: the next
    // credential word is scanned on its own instead of being jumped over.
    const headOfAnother = !value.quoted && value.end - value.start <= RESCAN_LIMIT && startsAssignment(text, value.start, value.end);
    if (headOfAnother) {
      // The key word stays readable, but whatever is glued between it and the separator (`apikeyS:`) may be a secret: it is hidden.
      const glued = HEAD_OF_ASSIGNMENT.exec(text.slice(value.start, value.end))?.[1] ?? "";
      if (glued.length >= 6) out.push({ start: value.end - 1 - glued.length, end: value.end - 1, kind: "credential_assignment", low: true });
    }
    // A short bare value that holds a key with its separator (`!ab\\\apikey:`, `[]PASSWORD[auth=[]Bearer`) hides everything but that
    // key: the word and its separator stay readable, because a later pass may still need the key, while what comes before it and
    // everything behind it (the key's own value, and whatever else the value swallowed) is hidden.
    const embedded = value.end - value.start >= 6 && !headOfAnother && !value.quoted && value.end - value.start <= RESCAN_LIMIT ? embeddedKey(text, value.start, value.end) : null;
    if (embedded !== null) {
      out.push({ start: value.start, end: embedded.at, kind: "credential_assignment", low: true });
      if (embedded.after < value.end) out.push({ start: embedded.after, end: value.end, kind: "credential_assignment", low: true });
      ASSIGNMENT_KEY.lastIndex = Math.max(ASSIGNMENT_KEY.lastIndex, keyEnd);
    } else if (value.end - value.start >= 6 && !headOfAnother) {
      out.push({ start: value.start, end: value.end, kind: "credential_assignment", low: true });
      // A bare value may hold the next assignment (`pin: apikey :S`, `secret=abc%0Apassword="S"`, `sid=client_secret:="S"`): the
      // scan goes on INSIDE a short one, and inside a long one from where it would end without the decoded characters, so
      // the value never hides a key that is scanned on its own (each read ends at once or is remembered: linear).
      let resume = value.end;
      if (rescans(value.end - value.start)) resume = keyEnd;
      else if (!value.quoted && decodedMask !== null) resume = Math.min(value.end, unquotedEnd(text, value.start, false));
      ASSIGNMENT_KEY.lastIndex = Math.max(ASSIGNMENT_KEY.lastIndex, resume);
    } else {
      next();
    }
  }
}

/**
 * Where the first key that is embedded in the bare value `text[start, end)` begins (the start of its key run), or -1: a credential word
 * followed by `=` anywhere, or by `:` when it is exactly a bare-colon name that starts a word. A key at the very start of the value is
 * not embedded (the value starts with it: see startsAssignment).
 */
function embeddedKey(text: string, start: number, end: number): { at: number; after: number } | null {
  const word = text.slice(start, end);
  const keys = new RegExp(ASSIGNMENT_KEY.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = keys.exec(word)) !== null) {
    keys.lastIndex = m.index + 1;
    let run = m.index;
    while (run > 0 && isKeyChar(word.charCodeAt(run - 1))) run -= 1;
    let stop = m.index + m[0].length;
    while (stop < word.length && isKeyChar(word.charCodeAt(stop))) stop += 1;
    const separator = word[stop];
    // A clean key: exactly a credential word (nothing key-like is glued in front of it or behind it, where a secret could sit).
    const clean = run === m.index && (stop === m.index + m[0].length || BARE_COLON_KEY.test(word.slice(run, stop)));
    const assigns = separator === "=" || (separator === ":" && BARE_COLON_KEY.test(word.slice(run, stop)));
    if (clean && assigns && m.index > 0) return { at: start + m.index, after: start + stop + 1 };
  }
  return null;
}

/** Longest bare value or block scalar that is scanned again from its start for a credential key inside it. */
const RESCAN_LIMIT = 128;

/** A bare word that is itself a credential key followed by its `=` or `:` (`password=`, `api_key =>`): the head of another assignment, not a value. */
const HEAD_OF_ASSIGNMENT = /^(?:client[_-]?secret|private[_-]?key|api[_-]?key|access[_-]?key|secret|token|pass(?:word|wd)?|pwd|credential|cookie|auth(?:orization)?)([A-Za-z0-9_.-]*)[=:]$/i;

function startsAssignment(text: string, start: number, end: number): boolean {
  const word = text.slice(start, end);
  // `key=` with a quoted value right behind it (`pw: password="S"`) is the head of another assignment. The same word with nothing
  // quoted behind it (`DB_PASSWORD=Secret2024:`) is the value itself and is hidden with everything else.
  const quoteBehind = text[end] === '"' || text[end] === "'" || text[end] === "\\";
  if (quoteBehind && HEAD_OF_ASSIGNMENT.test(word)) return true;
  // `apikey:` with a value behind it is the head too: the scan treats exactly these names as keys before a bare colon, and the key
  // must stay readable for the pass after this one (`pin : apikey: Bearer hpassword%22%20S`).
  if (word.endsWith(":") && (BARE_COLON_KEY.test(word.slice(0, -1)) || /^(?:set-cookie|cookie|proxy-authorization|authorization):$/i.test(word)) && skipBlank(text, end) < text.length && text[skipBlank(text, end)] !== "\n") return true;
  // the bare key name alone, with its separator behind the blanks (`pin: apikey :S`, `dsn: api_key => S`)
  const separator = text[skipBlank(text, end)];
  return (separator === ":" || separator === "=") && BARE_COLON_KEY.test(word);
}

/** The type words of a typed declaration (`password: string = "S"`); the word after the key is then a type, not the value. */
const TYPE_WORD = /^(?:string|str|number|int|integer|float|double|bool|boolean|any|object|secret|secretstring|securestring)$/i;

/** What the pair and form scans use to find where a value ends: a decoded `%20` between the halves of a pair (`value%3DS%20name%3Dpassword`) still separates them. */
const PAIR_ENDS: PairEnds = { endOf: (text, start, quote, openRun) => quotedEnd(text, start, quote, openRun), unquotedEnd: (text, from) => unquotedEnd(text, from, false) };
/** What the assignment scan uses: a character decoded from `%XX` is data of the value (`password%3Dab%26cd...`), never its end. */
const ASSIGN_ENDS: PairEnds = { endOf: PAIR_ENDS.endOf, unquotedEnd: (text, from) => unquotedEnd(text, from, true) };

const isKeyChar = (c: number): boolean => isAlpha(c) || isDigit(c) || c === 95 || c === 46 || c === 45;
/** Ends an unquoted value: whitespace and control characters, quotes, `,` `;` `&` and brackets. */
const isValueEnd = (c: number): boolean => c <= 32 || c === 34 || c === 39 || c === 44 || c === 59 || c === 38 || c === 123 || c === 125 || c === 41;

/** Skip spaces and tabs, at most MAX_GAP of them. */
function skipBlank(text: string, from: number): number {
  const limit = from + MAX_GAP;
  let i = from;
  while (i < text.length && i < limit && (text.charCodeAt(i) === 32 || text.charCodeAt(i) === 9)) i += 1;
  return i;
}

/**
 * Marks the characters of the text being scanned that were decoded from a `%XX` escape (set only while the decoded copy is
 * scanned, see findSpans): such a character is DATA of the value, never a delimiter that ends it (`password%3Dab%26cd...`).
 */
let decodedMask: Uint8Array | null = null;

let maskedRead = { from: 0, end: 0 };

/** The last stretch of an unquoted read and of a property read and of a comment read (see Run in redaction-pairs.ts): each read that starts inside one ends at its end. */
const plainRead = newRun();
const propertyRun = newRun();
const commentRun = newRun();

function unquotedEnd(text: string, from: number, honourMask = false): number {
  spend(1);
  if (!honourMask || decodedMask === null) {
    const known = knownEnd(plainRead, text, from);
    if (known >= 0) return known;
    let j = from;
    while (j < text.length && !isValueEnd(text.charCodeAt(j))) j += 1;
    spend(j - from);
    return remember(plainRead, text, from, j);
  }
  // A read that ended at `end` passed every character between: a read that starts inside it ends at the same place. The scan
  // starts reads inside a long masked value again (see scanAssignments), so this keeps the whole scan linear.
  if (from >= maskedRead.from && from < maskedRead.end) return maskedRead.end;
  let j = from;
  while (j < text.length && (!isValueEnd(text.charCodeAt(j)) || decodedMask[j] === 1)) j += 1;
  spend(j - from);
  maskedRead = { from, end: j };
  return j;
}

/**
 * The first word of each `#` in the gap `text[from, to)` (a comment, or a value that starts with `#`: `password: &a #S`), when it has
 * six characters or more: hidden as a value. `hashScanned` is where the last gap of this text was read to, so a long comment that
 * many keys share is read once.
 */
let hashScanned = { text: "", from: 0, to: 0 };
function hideHashWords(text: string, from: number, to: number, out: Span[]): void {
  // The memo covers [from, to) of one text and is used only when the new gap STARTS inside it: a key that reads ahead through a
  // bracket group (`sid[bearer: #S]:`) is processed before the key inside the group, whose gap lies behind the memo's start.
  const inside = hashScanned.text === text && from >= hashScanned.from && from < hashScanned.to;
  const start = inside ? hashScanned.to : from;
  hashScanned = inside ? { text, from: hashScanned.from, to: Math.max(to, hashScanned.to) } : { text, from, to };
  for (let k = start; k < to; k += 1) {
    if (text[k] !== "#" || k === from || (text[k - 1] !== " " && text[k - 1] !== "\t" && text[k - 1] !== "\n" && text[k - 1] !== "\r" && text[k - 1] !== "n" && text[k - 1] !== "r" && text[k - 1] !== "t")) continue;
    let word = k;
    while (word < text.length && text.charCodeAt(word) > 32 && text[word] !== '"' && text[word] !== "'") word += 1;
    if (word - k >= 6) out.push({ start: k, end: word, kind: "credential_assignment", low: true });
    k = Math.max(k, word - 1);
  }
  spend(1 + Math.max(0, to - start));
}

/** The longest verbatim tag (`!<...>`), counted from the `!` to its closing `>`. A longer one is not read as a tag (documented in docs/MANIFEST.md). */
const VERBATIM_TAG_MAX = 256;

/** The end of the word that starts at `start` (a `&anchor`, a `!tag`, or a glued `!` value): up to a blank, a comma, a closing bracket or brace, a backslash or a quote; remembered, so a read that starts inside it ends at once. */
function propertyWordEnd(text: string, start: number): number {
  const known = knownEnd(propertyRun, text, start);
  if (known >= 0) return known;
  let i = start;
  // A verbatim tag (`!<tag:yaml.org,2002:str>`) holds commas and colons: it ends at its `>`, at most VERBATIM_TAG_MAX characters from the `!`. The search is bounded
  // to that window and counted against the work budget (round 8: an unbounded search to the end of the text, repeated for every `!<` start, was quadratic).
  if (text[i] === "!" && text[i + 1] === "<") {
    const window = text.slice(i + 2, i + VERBATIM_TAG_MAX + 1);
    const at = window.indexOf(">");
    spend(at >= 0 ? at + 1 : window.length);
    if (at >= 0) i = i + 2 + at + 1;
  }
  while (i < text.length && !/[\s,\]}\\"']/.test(text[i] as string)) i += 1;
  spend(i - start);
  return remember(propertyRun, text, start, i);
}

/**
 * YAML node properties after `key:` (`&anchor`, `!!str`, `!tag`, in any order, at most four): skipped, then the gap
 * again (the value may follow on the next line). A property of six characters or more is also recorded as a span, because a
 * secret can begin with `!` or `&` and would otherwise be skipped as a property.
 */
function skipNodeProperties(text: string, from: number, out: Span[]): number {
  let i = from;
  for (let n = 0; n < 4 && (text[i] === "&" || text[i] === "!"); n += 1) {
    const start = i;
    spend(1);
    i = propertyWordEnd(text, i);
    // A `!` word is a TAG only when a blank, a line break or the end of the text follows it (`!!str S`, `!tag S`): glued to more text it is a VALUE
    // (round 8: `password: !]*9H_` was taken for the tag `!` and the five characters `]*9H_` that were left are below the six of a value).
    if (text[start] === "!" && i < text.length && text[i] !== " " && text[i] !== "\t" && text[i] !== "\n" && text[i] !== "\r" && text[i] !== "\\") return start;
    // A short property followed by a backslash that is not a line break (`!ab\\S`) is the start of the value, not a property.
    if (text[start] === "!" && i - start < 6 && text[i] === "\\") {
      let run = i;
      while (text[run] === "\\") run += 1;
      // (a run that ends at a quote opens a quoted value, and one that ends at n, r or t is a line break: neither is part of the value)
      if (text[run] !== "n" && text[run] !== "r" && text[run] !== "t" && text[run] !== '"' && text[run] !== "'") return start;
    }
    if (i - start >= 6) out.push({ start, end: i, kind: "credential_assignment", low: true });
    const gap = i;
    i = skipGap(text, i);
    // A `#` word after a property (`password: &a #S`, `!!str #S`) is the value, not a comment: hidden like a `#` word after the key.
    hideHashWords(text, gap, i, out);
  }
  return i;
}

/**
 * After `key:`: blanks, real and escaped line breaks (`\n`, `\r`, `\t`, `%0A`, `%0D`) and one YAML list dash, at most
 * MAX_GAP characters, so `password:` followed by the value on the next line (as YAML, or as JSON text that holds YAML)
 * is still an assignment.
 */
function skipGap(text: string, from: number): number {
  let i = from;
  let dashes = 0;
  spend(1);
  // MAX_GAP counts separators (a blank, a line break of any nesting, a dash), not the characters a nested line break takes.
  for (let steps = 0; i < text.length && steps < MAX_GAP; steps += 1) {
    const c = text.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13) {
      i += 1;
    } else if (c === 92) {
      // A line break inside JSON text nested `d` times is a run of 2^d - 1 backslashes and a letter (`\\\\n`): the whole
      // run (no cap; it is read once) and the letter are one break. A backslash run that ends otherwise is not a gap.
      let run = 1;
      while (text[i + run] === "\\") run += 1;
      const letter = text[i + run];
      if (letter === "n" || letter === "r" || letter === "t") i += run + 1;
      else break;
    } else if (c === 37 && text[i + 1] === "0" && (text[i + 2] === "A" || text[i + 2] === "a" || text[i + 2] === "D" || text[i + 2] === "d")) i += 3;
    else if (c === 45 && dashes < 3 && (text[i + 1] === " " || text[i + 1] === "\\")) {
      // Nested list items (`- - S`): up to three dashes.
      dashes += 1;
      i += 1;
    } else if (c === 35 && i > from && (text[i - 1] === " " || text[i - 1] === "\t")) {
      // A YAML comment after the key (`password:  # rotate monthly`) runs to the end of its line; the value follows on the next.
      const known = knownEnd(commentRun, text, i);
      if (known >= 0) i = known;
      else {
        const begin = i;
        while (i < text.length && text.charCodeAt(i) !== 10 && text.charCodeAt(i) !== 13 && !(text.charCodeAt(i) === 92 && /[nr]/.test(text[i + 1] ?? ""))) i += 1;
        spend(i - begin);
        remember(commentRun, text, begin, i);
      }
    } else break;
  }
  return i;
}

/**
 * End of a quoted value that starts at `start`, counting the RUN of backslashes in front of each quote. A plain
 * value (`openRun` 0) is closed by a quote preceded by an even run (`ab\"cd` does not close it, `ab\\"` does). A value
 * opened with an escaped quote (`openRun` k, JSON inside JSON) is closed by a quote preceded by exactly k backslashes;
 * a longer run is the same text one layer deeper and does not close it. Each run is read once (linear). With no closing
 * quote before a newline or MAX_QUOTED the value is taken to run to that point: over redacting the rest of the line is
 * the safe failure, leaking the tail is not.
 */
function quotedEnd(text: string, start: number, quote: string, openRun: number): number {
  const cap = Math.min(text.length, start + MAX_QUOTED);
  let j = start;
  while (j < cap) {
    const c = text[j];
    if (c === "\n") return j;
    if (c === "\\") {
      let run = 1;
      while (j + run < cap && text[j + run] === "\\") run += 1;
      if (text[j + run] === quote) {
        if (openRun > 0 ? run === openRun : run % 2 === 0) return openRun > 0 ? j : j + run;
        j += run + 1;
      } else {
        j += run;
      }
      continue;
    }
    // A bare quote closes a plain value; inside an escaped-quote value it is just text (only `\"` closes that one).
    if (c === quote && openRun === 0) return j;
    j += 1;
  }
  // The cap was reached with no closing quote: the tail is part of the value, so redact to the end of the text. Stopping
  // at the cap would leave the tail readable and make the output change when it is redacted a second time.
  return text.length;
}

/** All secret spans of one (folded) text, in that text's coordinates. */
function scanText(text: string): Span[] {
  const spans: Span[] = [];
  // Name/value pairs (either order, a key in between, path-shaped names, tuples, argument vectors) at any JSON depth:
  // the shapes, and what is not covered, are in redaction-pairs.ts and docs/MANIFEST.md.
  scanPairs(text, spans, PAIR_ENDS);
  // Command line and Dockerfile forms without an `=`: `--db-password S`, `-p=S`, `ENV PASSWORD S` (redaction-forms.ts).
  scanCommandForms(text, spans, PAIR_ENDS);
  scanPrivateKeys(text, spans);
  scanJwt(text, spans);
  scanUrlCredentials(text, spans);
  scanAssignments(text, spans);
  for (const pattern of TOKEN_PATTERNS) {
    pattern.regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.regex.exec(text)) !== null) {
      spans.push({ start: m.index, end: m.index + m[0].length, kind: pattern.kind, low: pattern.low === true });
      if (m[0].length === 0) pattern.regex.lastIndex += 1;
    }
  }
  HEADER_LINE.lastIndex = 0;
  let h: RegExpExecArray | null;
  while ((h = HEADER_LINE.exec(text)) !== null) {
    const value = h[1] as string;
    const start = h.index + h[0].length - value.length;
    spans.push({ start, end: start + value.length, kind: "credential_header", low: true });
  }
  return spans;
}

/**
 * Spans in ORIGINAL coordinates for the whole text, found in ONE pass (no windows: a window edge can split a key
 * from its value). `validator` keeps low-confidence spans only when random looking. Returns null when the text is
 * too large to scan (see MAX_SCAN_CHARS and MAX_FOLD_CHARS): the caller must then refuse, never pass the text on.
 */
function findSpans(source: string, validator: boolean): Span[] | null {
  // One scan has a work budget (redaction-pairs.ts, ScanBudgetExceeded): when the counted reads pass 64 per character the scan is
  // abandoned and null is returned, which every caller treats as a refusal (the whole text is hidden), never as "nothing found".
  startScan(source.length);
  try {
    return findSpansUnbudgeted(source, validator);
  } catch (error) {
    if (error instanceof ScanBudgetExceeded) return null;
    throw error;
  } finally {
    // What the scan remembered ends with the call, also after a throw (the memos are keyed by the text, which can hold a secret): startScan
    // clears every registered memo, and the gap memo of this module is reset here.
    startScan(0);
    hashScanned = { text: "", from: 0, to: 0 };
  }
}

// The inspection of the tests: does any memo of a scan still refer to a text? (imported here, next to its only use)
import { memoHoldsText } from "./redaction-pairs.js";
export const scanStateHoldsText = (): boolean => memoHoldsText() || hashScanned.text !== "";

function findSpansUnbudgeted(source: string, validator: boolean): Span[] | null {
  if (source.length > MAX_SCAN_CHARS) return null;
  const needsFold = NON_ASCII.test(source);
  if (needsFold && source.length > MAX_FOLD_CHARS) return null;
  const folded = needsFold ? fold(source) : null;
  const text = folded ? folded.text : source;
  const all: Span[] = [];
  const digit: NextMark = { text: "", from: 0, at: 0 };
  const letter: NextMark = { text: "", from: 0, at: 0 };
  const keep = (span: Span, scanned: string, decoded: Folded | null): void => {
    if (validator && span.low && !looksRandomAt(scanned, span.start, span.end, digit, letter)) return;
    if (decoded) {
      span.end = decoded.to[span.end - 1] as number;
      span.start = decoded.from[span.start] as number;
    }
    if (folded) {
      span.end = folded.to[span.end - 1] as number;
      span.start = folded.from[span.start] as number;
    }
    all.push(span);
  };
  for (const span of scanText(text)) keep(span, text, null);
  // Percent-encoded separators (`password%3D...`, `Authorization%3A%20Bearer...`, `https%3A%2F%2Fu%3Ap%40h`) hide every
  // assignment, header and userinfo shape. One level is decoded into a COPY that remembers where each character came
  // from, the copy is scanned as well, and its spans are mapped back onto the text (exact: one decoded character stands
  // for one or three original ones). Text this large is refused rather than scanned without the decoded copy; a value
  // encoded twice is a documented limit (docs/MANIFEST.md).
  if (PERCENT_ESCAPE.test(text)) {
    if (text.length > MAX_FOLD_CHARS) return null;
    const decoded = percentDecode(text);
    if (decoded !== null) {
      // A character that came from an escape (several original characters for one) is data of the value, never its end.
      const mask = new Uint8Array(decoded.text.length);
      for (let j = 0; j < mask.length; j += 1) if ((decoded.to[j] as number) - (decoded.from[j] as number) > 1) mask[j] = 1;
      decodedMask = mask;
      maskedRead = { from: 0, end: 0 };
      try {
        for (const span of scanText(decoded.text)) keep(span, decoded.text, decoded);
      } finally {
        decodedMask = null;
      }
    }
  }
  return all;
}

/** A `%XX` escape, a JSON escape of an ASCII character (`backslash, u, 00, two hex digits`: Go and Gson write `=` and `'` so) or an HTML entity of one. */
const PERCENT_ESCAPE = /%[0-9A-Fa-f]{2}|\\u00[0-9A-Fa-f]{2}|&(?:#[0-9]{2,3}|#[xX][0-9A-Fa-f]{2}|quot|apos|amp);/;
const ESCAPE_AT = new RegExp(String.raw`%([0-9A-Fa-f]{2})|\\u00([0-9A-Fa-f]{2})|&(?:#([0-9]{2,3})|#[xX]([0-9A-Fa-f]{2})|(quot|apos|amp));`, "y");
const NAMED_ENTITY: Record<string, number> = { quot: 34, apos: 39, amp: 38 };

/**
 * `text` with each `%XX`, JSON escape or HTML entity that stands for a printable ASCII character (`%XX` also for tab, LF, CR)
 * replaced by it; null when there is none. `from` and `to` map each decoded character back to the original characters.
 */
function percentDecode(text: string): Folded | null {
  const units = new Uint16Array(text.length);
  const from = new Int32Array(text.length);
  const to = new Int32Array(text.length);
  let length = 0;
  let changed = false;
  for (let i = 0; i < text.length; ) {
    let width = 1;
    let unit = text.charCodeAt(i);
    if (unit === 37 || unit === 92 || unit === 38) {
      ESCAPE_AT.lastIndex = i;
      const m = ESCAPE_AT.exec(text);
      if (m !== null) {
        const code = m[1] !== undefined ? parseInt(m[1], 16) : m[2] !== undefined ? parseInt(m[2], 16) : m[3] !== undefined ? parseInt(m[3], 10) : m[4] !== undefined ? parseInt(m[4], 16) : (NAMED_ENTITY[m[5] as string] as number);
        if ((code >= 0x20 && code < 0x7f) || (m[1] !== undefined && (code === 9 || code === 10 || code === 13))) {
          unit = code;
          width = m[0].length;
          changed = true;
        }
      }
    }
    units[length] = unit;
    from[length] = i;
    to[length] = i + width;
    length += 1;
    i += width;
  }
  return changed ? { text: new TextDecoder("utf-16le").decode(units.subarray(0, length)), from, to } : null;
}

/** Sort and coalesce overlapping spans in place (the spans are this module's own objects). */
function mergeSpans(spans: Span[]): Span[] {
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Span[] = [];
  for (const span of spans) {
    const prev = merged[merged.length - 1];
    if (prev && span.start <= prev.end) {
      if (span.end > prev.end) prev.end = span.end;
    } else {
      merged.push(span);
    }
  }
  return merged;
}

/** `text` with every span replaced by `[REDACTED]`; text with no span is returned unchanged (same string). */
function applySpans(text: string, found: Span[] | null): string {
  if (found === null) return OVERSIZE_REDACTED;
  const spans = mergeSpans(found);
  if (spans.length === 0) return text;
  const parts: string[] = [];
  let at = 0;
  for (const span of spans) {
    parts.push(text.slice(at, span.start), REDACTED);
    at = span.end;
  }
  parts.push(text.slice(at));
  return parts.join("");
}

/**
 * Replace every secret-looking token in `text` with `[REDACTED]` (log strength: low-confidence shapes are redacted
 * too). Text with no secret is returned unchanged. Text too large to scan is REPLACED by OVERSIZE_REDACTED: a
 * refusal, never a pass-through.
 */
export function redactSecrets(text: string): string {
  return redactStable(text, false);
}

/**
 * Redaction repeated until nothing changes (at most REDACT_PASSES times), so the output is a fixed point: what one pass
 * leaves behind can become a secret once the token in front of it is gone (`AKIA...sk-...`: the letter that blocked the
 * short prefix is replaced), and a result that depends on how often it was redacted would differ between an export and
 * the re-derivation that verifies it. Text with no secret costs one pass and comes back as the same string. Some
 * percent-encoded shapes hide one more piece per pass (`Authorization%3A[REDACTED]%0A)%0A...`: the marker glues to what
 * follows), so the bound is 32, not 4; a longer chain is still hidden, only not yet a fixed point.
 */
const REDACT_PASSES = 32;
function redactStable(text: string, validator: boolean): string {
  let current = text;
  for (let pass = 0; pass < REDACT_PASSES; pass += 1) {
    if (current.length < 6) return current;
    const next = applySpans(current, findSpans(current, validator));
    if (next === current) return current;
    current = next;
  }
  return current;
}

/**
 * Redact at the strength of the manifest validator: only what the validator would have refused at import. Used for
 * identifier fields, so an id that was accepted is shown and exported exactly as it was imported.
 */
export function redactIdentifier(text: string): string {
  return redactStable(text, true);
}

/**
 * Kinds of secret-looking values found in `text`, sorted and de-duplicated. Used by the manifest
 * validator, so low-confidence matches (assignments, headers, bare user names in URLs) need a random-looking
 * value to count. Text too large to scan reports `oversize`, which the validator rejects.
 */
export function detectSecretKinds(text: string): string[] {
  if (text.length < 6) return [];
  const found = findSpans(text, true);
  if (found === null) return ["oversize"];
  return [...new Set(found.map((s) => s.kind))].sort();
}

/** Property names whose value (a string, or an array of strings) is an identifier, redacted only with redactIdentifier. */
const IDENTIFIER_KEY =
  /^(?:id|key|check_key|check_id|node_id|source_id|target_id|origin_id|consumer_id|finding_key|snapshot_id|run_id|workspace_id|credential_alias|path|change_ids|node_ids|check_keys|from|to|origin_node_ids|changed_node_ids)$/;

function redactIdentifierValue(value: unknown): unknown {
  if (typeof value === "string") return redactIdentifier(value);
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value.map((item) => redactIdentifier(item as string));
  return undefined;
}

export function containsSecret(text: string): boolean {
  return detectSecretKinds(text).length > 0;
}

const MAX_REDACT_DEPTH = 12;

/**
 * Deep copy of `value` that is safe to log or export: strings are pattern-redacted, values under
 * sensitive property names are replaced, property names are redacted too, cycles and excessive depth are cut off.
 * Errors are reduced to name and redacted message.
 */
export function redactDeep(value: unknown): unknown {
  return redactInner(value, new WeakSet<object>(), 0);
}

/**
 * Deep copy of JSON-shaped `value` with EVERY string redacted at validator strength (`redactIdentifier`): for records
 * made of identifiers, names and URLs that were checked at exactly that strength when they were stored (a contract check
 * definition), where log-strength rewriting would alter accepted values. Property names go through the same redaction, so
 * a name that carries a token is not shown either (the schema's own names never change).
 */
export function redactIdentifiers(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redactIdentifier(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_REDACT_DEPTH) return "[TRUNCATED]";
  if (Array.isArray(value)) return value.map((item) => redactIdentifiers(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) put(out, redactIdentifier(key), redactIdentifiers(item, depth + 1));
  return out;
}

/** Own property assignment that keeps a `__proto__` key as DATA (plain assignment would set the prototype and drop it). */
function put(out: Record<string, unknown>, key: string, value: unknown): void {
  if (key === "__proto__") Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
  else out[key] = value;
}

/** A property name or a pair's name as text matching sees it: folded like any scanned text (a name too long to fold is hidden by the caller). */
function foldName(name: string): string {
  return NON_ASCII.test(name) && name.length <= MAX_FOLD_CHARS ? fold(name).text : name;
}

function redactInner(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (value === null || typeof value !== "object") {
    if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") {
      return String(typeof value);
    }
    return value;
  }
  if (depth >= MAX_REDACT_DEPTH) return "[TRUNCATED]";
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  try {
    if (value instanceof Error) {
      return { name: value.name, message: redactSecrets(value.message) };
    }
    if (Array.isArray(value)) {
      // The item after a credential name (`["password", S]`, `["--token", S]`) is the secret.
      const paired = pairedArrayIndexes(value, foldName);
      return value.map((item, index) => (paired.has(index) ? REDACTED : redactInner(item, seen, depth + 1)));
    }
    const out: Record<string, unknown> = {};
    // `{name: "DB_PASSWORD", value: S}`: the value half of a pair whose name is a credential name, in either order.
    const pairedValues = pairedValueKeys(value as Record<string, unknown>, foldName);
    for (const key of Object.keys(value)) {
      const raw = (value as Record<string, unknown>)[key];
      const safeKey = redactSecrets(key);
      // A property name is matched after the same fold as text (invisible, combining and fullwidth characters removed), so
      // `pass<zero width>word` names a credential like `password`.
      const folded = foldName(key);
      // Identifier fields keep the strength the validator applied at import, so a shown or exported id is never rewritten.
      const identifier = IDENTIFIER_KEY.test(key) ? redactIdentifierValue(raw) : undefined;
      // A name that itself held a secret (a credential word glued to a token: `tokenghp_...`) hides its value too. Without
      // this the value survives the first pass and is replaced by the second (`token[REDACTED]` names a credential), so
      // the result would depend on how many times it was redacted.
      const hidden = (SENSITIVE_KEY.test(folded) && !isOrdinaryTokenCounter(folded, raw)) || safeKey !== key || pairedValues.has(key);
      put(out, safeKey, hidden ? REDACTED : identifier !== undefined ? identifier : redactInner(raw, seen, depth + 1));
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
  "`": "&#96;",
};

/**
 * Escape text for an HTML text node or a quoted attribute value. Untrusted report text is always
 * routed through this function so that hostile markup renders as literal text (AC-09).
 */
export function escapeHtml(input: unknown): string {
  if (input === null || input === undefined) return "";
  return String(input).replace(/[&<>"'`]/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}

/** Escape then redact: the composition used for any text placed in a report. */
export function safeReportText(input: unknown): string {
  return escapeHtml(redactSecrets(input === null || input === undefined ? "" : String(input)));
}
