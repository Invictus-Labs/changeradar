import { describe, expect, it } from "vitest";
import { redactDeep, redactSecrets } from "../../src/domain/redaction.js";

/**
 * Review round 7 (a cross-check by the security review of the sibling product, ruled P1): a value that OPENS a brace, a bracket or a parenthesis
 * and is glued to more word text behind the closing character (`password={}S`, `token:{a}S`, `(ab3)Xk9...`, a random password that starts with
 * `(` and closes it soon after) ended at the closing character for `{` and `(`: the tail behind it was readable in the output, in every tree since the
 * first. The square-bracket group was fixed in round 6 (R6 P1, the group ends with the word it is glued to); `{` and `(` follow the same rule now, and
 * closers glued to a word behind the group (`{a}}S`, `[a]]S`) belong to it. The fake secrets are assembled at run time.
 */

const S = "Zx9Kq2Lm7Pw4Rt8Yv3Bn";
const SHAPES: readonly string[] = ["{}@", "{a}@", "()@", "(a)@", "[]@", "[a]@", "[a]]@", "{a}}@", "((a))@", "(a(b)c)@", "{{a}}@", "{a:{b}}@", "(ab3)@", "{ab3}@", "[ab3]@"];
const KEYS: readonly string[] = ["password=", "password: ", "token:", "auth:", "DB_PASSWORD=", "x-api-key="];

/** The text with `S` behind the shape, inside each context that the generative check of the round used. */
const contextsOf = (key: string, shape: string): [string, string][] => {
  const value = shape.replace("@", S);
  return [
    ["text", `${key}${value}`],
    ["YAML next line", `${key.replace(/[ =:]+$/, "")}:\n  ${value}`],
    ["YAML list", `${key.replace(/[ =:]+$/, "")}:\n  - ${value}`],
    ["--password flag", `--password ${value}`],
    ["--token= flag", `--token=${value}`],
    ["inside a JSON string", JSON.stringify({ note: `${key}${value}` })],
  ];
};
const nested = (text: string, depth: number): string => {
  let out = text;
  for (let d = 0; d < depth; d += 1) out = JSON.stringify(out);
  return out;
};

describe("R7 (closed groups): the tail behind a brace, bracket or parenthesis group that opens the value is hidden, in every context and at JSON depth 0 to 3", () => {
  for (const shape of SHAPES) {
    it(`shape ${JSON.stringify(shape)} behind ${KEYS.length} key forms`, () => {
      for (const key of KEYS) {
        for (const [context, text] of contextsOf(key, shape)) {
          for (let depth = 0; depth <= 3; depth += 1) {
            const wrapped = nested(text, depth);
            const out = redactSecrets(wrapped);
            expect(out.includes(S), `${context}, depth ${depth}: still readable: ${out}`).toBe(false);
            expect(redactSecrets(out), `a fixed point: ${context}, depth ${depth}`).toBe(out);
            if (depth === 0) expect(JSON.stringify(redactDeep({ note: text, list: [text] })).includes(S), `object level, ${context}: ${text}`).toBe(false);
          }
        }
      }
    });
  }
});

describe("R7 (closed groups): nested parentheses with a tail that no other rule recognises (a plain word, not a random token)", () => {
  it("the group is closed by its own parenthesis, the word glued behind it is hidden with it", () => {
    for (const tail of ["Sunshine99", "hunter2hunter2", "correcthorse"]) {
      // (a blank inside the group: only the group reader, not the word after it, can tell where the group closes)
      for (const shape of [`(a(b)c)${tail}`, `((a)(b))${tail}`, `(a(b(c)))${tail}`, `(a)${tail}`, `{a{b}c}${tail}`, `(a(b) c)${tail}`, `((a) (b))${tail}`, `{a {b} c}${tail}`]) {
        for (const key of ["password=", "password: ", "token:"]) {
          const out = redactSecrets(`${key}${shape}`);
          expect(out.includes(tail), `${key}${shape} -> ${out}`).toBe(false);
        }
      }
    }
  });
});

describe("R7 (closed groups): what stays as it was (precision)", () => {
  it("a group followed by a blank, a delimiter or the end is the value and nothing behind it is taken (the outputs of the tree before this change)", () => {
    expect(redactSecrets(`password: {a: 1} # the note`)).toBe("password: [REDACTED] # the note");
    expect(redactSecrets(`password={"a":1} next=1`)).toBe("password=[REDACTED] next=1");
    expect(redactSecrets(`token:{k:v}`)).toBe("token:{k:v}"); // five characters: below the six of a value
    expect(redactSecrets(`auth: {type: basic, realm: x}`)).toBe("auth: [REDACTED]");
    expect(redactSecrets(`credentials: [alice, bob]`)).toBe("credentials: [REDACTED]");
  });
  it("a group that holds a secret value is hidden as before, and the closers of the enclosing structure are kept", () => {
    expect(redactSecrets(`x: {"k":{"password":{"hash":"${S}"}}}`).includes(S)).toBe(false);
    expect(redactSecrets(`x: {"k":{"password":{"hash":"abc"}}}`)).toBe(`x: {"k":{"password":[REDACTED]}}`);
    expect(redactSecrets(`{"password":{"hash":"abc","salt":"def"},"name":"bob"}`)).toBe(`{"password":[REDACTED],"name":"bob"}`);
  });
  it("the parameters behind a hidden value are kept (the marker is a bracket group, but a delimiter ends its word)", () => {
    for (const text of [`password=${S}&user=bob`, `DB_PASSWORD=${S};host=db;`, `password: ${S}, retries: 3`, `build=1&password=${S}&app=2`]) {
      const out = redactSecrets(text);
      expect(out.includes(S)).toBe(false);
      expect(out, text).toBe(text.replace(S, "[REDACTED]"));
    }
  });
  it("a value that does not close is read as a plain word, not to the end of the text", () => {
    expect(redactSecrets(`password=(unclosed${S} next=1`)).toBe("password=[REDACTED] next=1");
    // a brace or bracket group with no closing character is taken to the end of the text (the existing safe failure, unchanged)
    expect(redactSecrets(`token={unclosed${S} next=1`)).toBe("token=[REDACTED]");
  });
});

// A seeded generator of the round's check: random printable passwords, a closed group at the start (set C), the safe alphabet with a random first character (set B) and
// uniform printable characters (set A, which leaks as the documented limit on delimiters does).
let seed = 20270930;
const random = (): number => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2 ** 32;
};
const pick = (chars: string): string => chars.charAt(Math.floor(random() * chars.length));
const SAFE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^*_-+.~/?:=";
const setC = (): string => {
  const open = pick("{[(");
  const close = open === "{" ? "}" : open === "[" ? "]" : ")";
  let value = open;
  for (let i = Math.floor(random() * 7); i > 0; i -= 1) value += pick(SAFE);
  value += close;
  for (let i = 4 + Math.floor(random() * 14); i > 0; i -= 1) value += pick(SAFE);
  return value;
};
const setB = (): string => {
  let value = random() < 0.5 ? pick("{[(<>\"'&|;,") : pick(SAFE);
  for (let i = 7 + Math.floor(random() * 17); i > 0; i -= 1) value += pick(SAFE);
  return value;
};
const setA = (): string => {
  let value = "";
  for (let i = 8 + Math.floor(random() * 17); i > 0; i -= 1) value += String.fromCharCode(33 + Math.floor(random() * 94));
  return value;
};
const GENERATIVE_CONTEXTS: [string, (v: string) => string][] = [
  ["password=", (v) => `password=${v}`],
  ["password: ", (v) => `password: ${v}`],
  ["YAML next line", (v) => `password:\n  ${v}`],
  ["YAML list", (v) => `password:\n  - ${v}`],
  ["--password ", (v) => `--password ${v}`],
  ["--token=", (v) => `--token=${v}`],
  ["JSON text", (v) => JSON.stringify({ password: v })],
  ["JSON string", (v) => JSON.stringify({ note: `password=${v}` })],
];
const leaks = (make: () => string, count: number): { cases: number; leaked: number; first: string } => {
  let leaked = 0;
  let first = "";
  for (let i = 0; i < count; i += 1) {
    const value = make();
    for (const [name, build] of GENERATIVE_CONTEXTS) {
      const text = build(value);
      const shown = name.startsWith("JSON") ? JSON.stringify(value).slice(1, -1) : value;
      if (redactSecrets(text).includes(shown.slice(-6))) {
        leaked += 1;
        if (first === "") first = JSON.stringify(text);
      }
    }
  }
  return { cases: count * GENERATIVE_CONTEXTS.length, leaked, first };
};

describe("R7 (closed groups): seeded random passwords", () => {
  it("set C (a group at the start, the rest safe characters): the last six characters are never readable, in all eight contexts", () => {
    const result = leaks(setC, 3000);
    expect(result.leaked, `of ${result.cases} cases, the first: ${result.first}`).toBe(0);
  });
  it("set B (safe alphabet, random first character): no more leaks than before the fix (only a delimiter or quote as the first character leaks)", () => {
    const result = leaks(setB, 3000);
    // measured before the fix with this seed: the leaks are the values that start with a quote, `&`, `|`, `;`, `,`, `<` or `>` (the documented limit on values that start with a delimiter)
    expect(result.leaked, `of ${result.cases} cases, the first: ${result.first}`).toBeLessThanOrEqual(BASELINE_B);
  });
  it("set A (uniform printable characters, which leaks as the documented limit on delimiters, blanks and quotes does): no more leaks than before the fix", () => {
    const result = leaks(setA, 3000);
    expect(result.leaked, `of ${result.cases} cases, the first: ${result.first}`).toBeLessThanOrEqual(BASELINE_A);
  });
});

// The leaks of the tree before this change, for the same seed and sequence (24,000 cases each): set C leaked 11,074 of them.
const BASELINE_B = 2492;
const BASELINE_A = 11131; // what the tree leaks now for this seed (11,131 measured at the final candidate, not the 11,107 of the review: the sequence of this file differs) (the tree before the change leaked 11,904): a rise is a regression
