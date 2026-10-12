import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { redactSecrets } from "../../src/domain/redaction.js";

/**
 * Review round 6: the redactor never hides LESS than the tree it replaced (commit 435731e, "the baseline"). A differential
 * over random strings found secrets that the baseline hid and the round-5 redactor showed: a value decoded from %XX that
 * swallowed the next credential key, a block scalar cut at a quote, and a short key whose "value" was another key.
 *
 * Four frozen fixtures (seeds 6151, 7207, 9931 and 4242) pin the behaviour. Each case is a text with planted synthetic
 * secrets, written with placeholders ({S0}, {S1}, ...) so that no secret shape is in the file; the baseline hid every planted
 * secret of every case, and 300 cases per fixture are ones the round-5 redactor got wrong. A redactor that hides less fails
 * a named assertion that lists the cases.
 */

const here = dirname(fileURLToPath(import.meta.url));
const load = (seed: number): { seed: number; baseline: string; regressions: number; cases: { t: string; s: string[] }[] } =>
  JSON.parse(readFileSync(resolve(here, `../fixtures/redaction-no-leak/seed-${seed}.json`), "utf8"));
const fill = (c: { t: string; s: string[] }): string => c.s.reduce((text, secret, n) => text.split(`{S${n}}`).join(secret), c.t);
const S = "Zx9Kq2Lm7Pw4Rt8";

describe("R6 (no-leak regression): the minimal repros of the differential", () => {
  it.each([
    ["a decoded line break before the next key", `secret=abc%0Apassword="${S}"`],
    ["a decoded = and line break before the next key", `token%3Dabc%0Apassword%3D"${S}"`],
    ["a decoded space before the next key", `secret=abc%20password="${S}"`],
    ["a decoded & before the next key", `token=x%26api_key :${S}`],
    ["a block scalar cut at the quote of the next key (the text's own \\n)", `token:|\\n auth="${S}"`],
    ["a short key whose value is a key with a spaced colon", `pin: apikey :${S}`],
    ["a short key whose value is a key with a spaced arrow", `dsn: api_key => ${S}`],
    ["a short key whose value is the next key on the next line", `pin:\r\npassword =${S}`],
    ["a bracket group glued to the rest of its word", `password:[${S}]\\nsid%3D%20|%0A%20${S}`],
    // (round 7, a survivor of the mutation run) plain text, no percent or JSON layer: the word ends with the word, not with the group
    ["a bracket group glued to the rest of its word (an empty group, plain text)", `pass=[]${S}`],
    ["a bracket group glued to the rest of its word (an empty group, after a long key)", `x-api-key=[]${S}`],
    ["a bracket group glued to the rest of its word (the group holds the first value, percent-encoded line break)", `token=>[${S}]%0Apw%3A${S}`],    ["a word with the key glued behind a decoded separator", `jwt=api-key%3D%20'${S}'`],
    ["garbled: a quoted value that holds the next key's name (otp)", `otp":"null; <token": "${S}>`],
    ["garbled: a quoted value that holds the next key's name (dsn)", `dsn":"ab Basic x-api-key": [${S}; k`],
    ["garbled: a key name glued to a value with the secret behind it", `Basic DATABASE_URL=>null//client_secret = ${S}@h`],
    ["garbled: decoded quote, space and colon before the next key", `token += on%22%20PASSWORD%3A%20'${S}`],
    ["garbled: an unclosed quote runs to the end of the line, the key is inside it", `pw='x-api-key:\n  ${S}; `],
    ["garbled: a secret glued between a key word and its separator", `password=>apikeypin${S}credentials: |\n  x`],
    ["a LONG bare value (over 128 characters) that holds the next key", `token=${"x".repeat(150)}password="${S}"`],
    ["a LONG quoted value (over 128 characters) that holds the next key", `pin:"${"x".repeat(150)} api_key: ${S} k"`],
    ["a LONG decoded value (over 128 characters) before the next key", `token=${"x".repeat(150)}%20password="${S}"`],
    ["a LONG decoded value that holds several keys", `token=${"x".repeat(150)}%20secret=${"y".repeat(20)}%0Aapi_key=${S}`],
  ])("%s", (_name, text) => {
    const out = redactSecrets(text);
    expect(out.includes(S), `still readable: ${out}`).toBe(false);
    expect(redactSecrets(out), "a fixed point").toBe(out);
  });
});

describe("R6: a key name that is the value of a short key is left readable, the secret behind it is not", () => {
  it.each([
    [`pin: apikey :${S}`, "pin: apikey :[REDACTED]"],
    [`dsn: api_key => ${S}`, "dsn: api_key => [REDACTED]"],
    [`pin:\r\npassword =${S}`, "pin:\r\npassword =[REDACTED]"],
    [`pw: password="ab\\"${S}" for the batch job`, "pw: password=" + '"[REDACTED]" for the batch job'],
  ])("key words as values: %j", (text, expected) => {
    expect(redactSecrets(text)).toBe(expected);
  });
});

describe("R6 (no-leak regression): the strings that independent reviews reported, frozen", () => {
  it("every reported minimal string (32, each hidden by the baseline) hides its planted secret and is a fixed point", () => {
    const fixture = JSON.parse(readFileSync(resolve(here, "../fixtures/redaction-no-leak/reported.json"), "utf8")) as { cases: { t: string; s: string[] }[] };
    expect(fixture.cases.length).toBeGreaterThanOrEqual(32);
    const leaks = fixture.cases.filter((c) => {
      const out = redactSecrets(fill(c));
      return c.s.some((secret) => out.includes(secret)) || redactSecrets(out) !== out;
    });
    expect(leaks.map((c) => c.t)).toEqual([]);
  });
});

describe("R6 (no-leak regression): frozen fixtures, each case hidden by the baseline", () => {
  it.each([6151, 7207, 9931, 4242])("seed %i: at least 600 cases, at least 200 of them regressions of round 5, none leaks a planted secret", (seed) => {
    const fixture = load(seed);
    expect(fixture.baseline).toBe("435731e");
    expect(fixture.seed).toBe(seed);
    expect(fixture.cases.length).toBeGreaterThanOrEqual(600);
    expect(fixture.regressions).toBeGreaterThanOrEqual(200);
    // control: every case has planted secrets and placeholders for all of them
    expect(fixture.cases.filter((c) => c.s.length === 0 || c.s.some((_, n) => !c.t.includes(`{S${n}}`)))).toEqual([]);
    const leaks: { index: number; text: string; out: string }[] = [];
    const notFixed: number[] = [];
    fixture.cases.forEach((c, index) => {
      const text = fill(c);
      const out = redactSecrets(text);
      if (c.s.some((secret) => out.includes(secret))) leaks.push({ index, text: c.t, out: out.split(c.s[0] as string).join("S0") });
      if (redactSecrets(out) !== out) notFixed.push(index);
    });
    expect(leaks.slice(0, 5), `${leaks.length} of ${fixture.cases.length} cases show a planted secret that the baseline hid`).toEqual([]);
    expect(notFixed, "cases whose result changes when it is redacted again").toEqual([]);
  });
});
