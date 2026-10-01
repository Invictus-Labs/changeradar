import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { redactSecrets } from "../../src/domain/redaction.js";

/**
 * Review round 7 KNOWN LIMIT (docs/MANIFEST.md, open owner decision): garbled multi-layer strings that an older tree hid and this one
 * shows in part. The independent-style differentials of round 7 (garbled soups, mutations of the frozen fixtures, multi-line
 * configuration documents with glued comments, key-dense strings) found these; each was minimised (ddmin) to the strings below. The
 * current output is expected: a change in either direction is a decision. This is a record of a measured difference, NOT a claim
 * that the class is accepted: every string leaks standing alone in the older trees too once the text that swallowed it is removed.
 */

const here = dirname(fileURLToPath(import.meta.url));
const doc = JSON.parse(readFileSync(resolve(here, "../fixtures/redaction-no-leak/known-limit-garbled.json"), "utf8")) as {
  cases: { t: string; s: string[]; target: number; older_tree: string; fixed?: string }[];
};
const fill = (c: { t: string; s: string[] }): string => c.s.reduce((text, secret, n) => text.split(`{S${n}}`).join(secret), c.t);

const V = "Zx9Kq2Lm7Pw4Rt8Yv3Bn";
const BQ = String.fromCharCode(92, 34);

describe("R7 KNOWN LIMIT: the minimal strings of the security and test reviews (S is the planted value)", () => {
  // Each was hidden by 435731e (the last also by the round-6 base) and is readable now; the reviewers classified them as garbled multi-layer soups.
  const pinned: [string, string][] = [
    ["a quoted pass=, a privatekey and a percent-encoded line break", `otp: pass%3D"privatekey=%0Af7Q'${V}`],
    ["a dsn with a percent-encoded colon, pass=, apikey= and a quote", `dsn%3A%0Apass=%20"apikey=%0A%20'${V}`],
    ["a percent-encoded key, a glued h, a pipe and a comment", `privatekey%3ahToken =|#${V}\\n &`],
    ["apikey+= with a glued word, a quote and a text-written line break", `apikey+=Zaccesskey: %27XZ\\n  %27${V}`],
    ["credential and authorization with percent-encoded separators and an escaped quote", `credential%3Dr%20authorization %3acredential=%0A20${BQ}${V}`],
  ];
  it.each(pinned)("%s", (_label, text) => {
    expect(redactSecrets(text).includes(V), redactSecrets(text)).toBe(true);
  });
  it("control: the sibling `apikey: #%20token=\"S\"` with a text-written line break, a pipe block and a stray word is hidden now", () => {
    expect(redactSecrets(`apikey: #%20token="${V}"\\n|\\n h`).includes(V)).toBe(false);
  });
});

describe("R7 KNOWN LIMIT: garbled strings that an older tree hid and the current tree shows", () => {
  it("the fixture holds the strings of the report (control)", () => {
    expect(doc.cases.length).toBeGreaterThanOrEqual(20);
    expect(new Set(doc.cases.map((c) => c.older_tree))).toEqual(new Set(["435731e", "round-6 base", "round-7 base"]));
  });
  it.each(doc.cases.map((c, i) => [i, c.older_tree, c.t] as const))("case %i (hidden by the %s): %j leaves its planted value readable", (index) => {
    const c = doc.cases[index] as (typeof doc.cases)[number];
    const out = redactSecrets(fill(c));
    // a case with a `fixed` note was a limit until the closed-group rule (round 7, ruled P1): its value is hidden now and the test says so
    if (c.fixed !== undefined) expect(out.includes(c.s[c.target] as string), `the planted value ${c.target} is hidden since the closed-group rule: ${out}`).toBe(false);
    else expect(out.includes(c.s[c.target] as string), `the planted value ${c.target} is expected to be readable (a KNOWN LIMIT pin): ${out}`).toBe(true);
  });
});
