import { describe, expect, it } from "vitest";
import { redactDeep, redactSecrets } from "../../src/domain/redaction.js";

/**
 * Review round 8 (logic P2, ruled a P1-class fix): `password: !]*9H_` was fully visible (hidden by 435731e). A word that starts with `!` right behind `key:` was taken
 * for a YAML tag and skipped, and what was left (`]*9H_`, five characters) is below the six of a value: a random printable password that opens with `!` and holds a
 * bracket, `*` or another delimiter early leaked whole. A `!` word is a TAG only when a blank, a line break or the end of the text follows it (`!!str S`,
 * `!tag S`, the verbatim `!<tag:yaml.org,2002:str> S`); a `!` word glued to more text is a VALUE, read like any other unquoted value.
 */

const S = "Zx9Kq2Lm7Pw4Rt8Yv3Bn";

describe("R8: a bang word glued to more text is a value", () => {
  it.each([
    ["the minimal string of the review", "!]*9H_"],
    ["a closing parenthesis and letters", "!MNv]*9H)Xa_"],
    ["a random printable password", "!e<n]8{,e^aP&Kk=n'<q)oZ"],
    ["a bracket after the bang", "![abcdefg]hijk"],
    ["a star", "!*abcdefghij"],
    ["an ampersand", "!&abcdefghij"],
  ])("%s: `password: %s` is hidden, at text and at object level", (_label, value) => {
    for (const text of [`password: ${value}`, `password:\n  ${value}`, `password:\n  - ${value}`, `token: ${value}`]) {
      const out = redactSecrets(text);
      expect(out.includes(value.slice(1)), `still readable: ${out}`).toBe(false);
      expect(JSON.stringify(redactDeep({ note: text })).includes(value.slice(1)), `object level: ${text}`).toBe(false);
    }
  });

  it("the tags stay tags: `!!str S`, `!tag S` and the verbatim tag hide S, and the short tags stay readable", () => {
    for (const [text, tag] of [
      [`password: !!str ${S}`, "!!str"],
      [`password: !tag ${S}`, "!tag"],
      [`password: !<tag:yaml.org,2002:str> ${S}`, ""],
      [`password: &a !!str ${S}`, "!!str"],
      [`password:\n  !!str ${S}`, "!!str"],
    ] as const) {
      const out = redactSecrets(text);
      expect(out.includes(S), out).toBe(false);
      if (tag !== "") expect(out.includes(tag), `the tag is readable: ${out}`).toBe(true);
    }
  });

  it("a tag at the end of the line, before the value on the next line, is still a tag", () => {
    expect(redactSecrets(`password: !!str\n  ${S}`).includes(S)).toBe(false);
    expect(redactSecrets(`password: !!str\r\n  ${S}`).includes(S)).toBe(false);
  });

  it("seeded random passwords that start with `!` (12 to 24 printable characters) are read like the same password that starts with a letter: readable whole only when that one is too", () => {
    let seed = 20271003;
    const random = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    // (A password with a delimiter early, `!hI,R1bzst8?_B`, is cut at the delimiter as any unquoted value is: the documented limit, the same for `xhI,R1bzst8?_B`.)
    let differ = 0;
    let first = "";
    for (let i = 0; i < 20_000; i += 1) {
      let rest = "";
      for (let k = 11 + Math.floor(random() * 13); k > 0; k -= 1) rest += String.fromCharCode(33 + Math.floor(random() * 94));
      // (a backslash in a `!` word, `!Q3\nJdja5...`, may be a line break written as text behind a tag: the `!`-tag plus escape class of the open owner list, not this rule)
      if (rest.includes("\\")) continue;
      for (const context of ["password: ", "password:\n  ", "password:\n  - "]) {
        const bang = `!${rest}`;
        const letter = `x${rest}`;
        const bangWhole = redactSecrets(`${context}${bang}`).includes(bang);
        const letterWhole = redactSecrets(`${context}${letter}`).includes(letter);
        if (bangWhole && !letterWhole) {
          differ += 1;
          if (first === "") first = JSON.stringify(`${context}${bang}`);
        }
      }
    }
    // before the change with this seed and sequence: 402 of the 50,172 cases without a backslash (0.8 percent) were readable whole only behind the bang
    expect(differ, `readable whole behind the bang only, the first: ${first}`).toBe(0);
  });

  // Second look (logic P1-B): the glued `!` word is a VALUE, so it is read by the rules of a value: a quote behind the bang opens a quoted value, a bracket, a brace or a
  // parenthesis opens a group (and the closing characters glued to more text belong to it). The first build of this rule returned "not a property" and the value reader
  // then stopped at the quote or the brace, so `password: !'dx$awi` and `password: !{7eDk}` were readable where the previous tree hid them.
  it.each([
    ["a quote behind the bang", "!'dx$awi", "dx$awi"],
    ["a brace group", "!{7eDk}", "7eDk"],
    ["a double quote and a text-written break", '!"7uQ\\nS', "7uQ"],
    ["a brace group glued to more text", "!{ab3}Kq9Zx2", "Kq9Zx2"],
    ["a parenthesis group glued to more text", "!(ab3)Kq9Zx2", "Kq9Zx2"],
    ["a bracket group glued to more text", "![ab3]Kq9Zx2", "Kq9Zx2"],
    ["a quoted value that is closed", '!"Kq9Zx2Lm7P"', "Kq9Zx2Lm7P"],
    ["a single-quoted value that is closed", "!'Kq9Zx2Lm7P'", "Kq9Zx2Lm7P"],
  ])("%s: `password: %s` hides what follows the bang", (_label, value, tail) => {
    for (const context of ["password: ", "password:\n  ", "password:\n  - ", "password=", "token: "]) {
      const out = redactSecrets(`${context}${value}`);
      expect(out.includes(tail), `still readable: ${JSON.stringify(out)}`).toBe(false);
      expect(JSON.stringify(redactDeep({ note: `${context}${value}` })).includes(tail), `object level: ${context}`).toBe(false);
    }
  });

  it("the tags stay tags behind the change: `!!str S`, `!tag S`, the verbatim tag, a tag at the end of a line, a tag after an anchor", () => {
    for (const text of [`password: !!str ${S}`, `password: !tag ${S}`, `password: !<tag:yaml.org,2002:str> ${S}`, `password: &a !!str ${S}`, `password: !!str\n  ${S}`]) {
      const out = redactSecrets(text);
      expect(out.includes(S), out).toBe(false);
    }
    // the tag itself is not the secret: the short tags stay readable
    expect(redactSecrets(`password: !!str ${S}`).includes("!!str")).toBe(true);
    expect(redactSecrets(`password: !tag ${S}`).includes("!tag")).toBe(true);
  });

  it("property: a `!` value whose rest starts with a quote, a bracket, a brace or a parenthesis leaks no more than the same rest without the bang (20,000 seeded passwords, four contexts)", () => {
    let seed = 20271004;
    const random = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const openers = "'\"[{(";
    let leaks = 0;
    let first = "";
    let cases = 0;
    for (let i = 0; i < 20_000; i += 1) {
      let rest = openers[Math.floor(random() * openers.length)] as string;
      for (let k = 10 + Math.floor(random() * 12); k > 0; k -= 1) rest += String.fromCharCode(33 + Math.floor(random() * 94));
      // (a backslash may be a line break written as text: the `!`-tag plus escape class of the owner list, not this rule)
      if (rest.includes("\\")) continue;
      const tail = rest.slice(-6);
      for (const context of ["password: ", "password:\n  ", "password:\n  - ", "password="]) {
        cases += 1;
        const bangLeaks = redactSecrets(`${context}!${rest}`).includes(tail);
        const plainLeaks = redactSecrets(`${context}${rest}`).includes(tail);
        if (bangLeaks && !plainLeaks) {
          leaks += 1;
          if (first === "") first = JSON.stringify(`${context}!${rest}`);
        }
      }
    }
    expect(cases).toBeGreaterThan(60_000);
    expect(leaks, `readable behind the bang only, the first: ${first}`).toBe(0);
  });
});
