import { describe, expect, it } from "vitest";
import { redactDeep, redactSecrets } from "../../src/domain/redaction.js";

/**
 * Review round 7 (test review P2-c): the hand mutations of the round-6 redaction rules that survived and LEAK when the rule is removed.
 * One exact assertion per rule, at the edge of the rule (the last length that is hidden), in text and in an object.
 * Fake secrets are assembled at run time.
 */

const seen = (out: string, secret: string): boolean => out.includes(secret);
const asObject = (text: string): string => JSON.stringify(redactDeep({ note: text, list: [text], nested: { message: text } }));

describe("R7: a # word of six characters is a value (the floor is six, not seven)", () => {
  it.each([
    ["password: #", "abcde"],
    ["token:  #", "Zq7Lm"],
    ["pin: #", "k9x2Q"],
  ])("%s + a five character word after the #", (head, word) => {
    const text = `${head}${word}`;
    expect(seen(redactSecrets(text), word), redactSecrets(text)).toBe(false);
    expect(seen(asObject(text), word), "object form").toBe(false);
  });
  it("control: a # word of five characters in all is a short comment and stays readable", () => {
    expect(redactSecrets("password: #abcd")).toBe("password: #abcd");
  });
});

describe("R7: a name glued in front of a key separator, six characters or more, is a secret (the floor is six)", () => {
  it.each([
    ["pw: apikey", "Xy12aB", ':"x"'],
    ["pw: apikey", "Q7z9Lm", ':"x"'],
  ])("%s + a glued word of six characters", (head, word, tail) => {
    const text = `${head}${word}${tail}`;
    expect(seen(redactSecrets(text), word), redactSecrets(text)).toBe(false);
    expect(seen(asObject(text), word), "object form").toBe(false);
  });
});

describe("R7: a bracket group glued to a key belongs to the key up to 128 characters (not 16)", () => {
  const S = "Zx9Kq2Lm7Pw4";
  it.each([20, 40, 100, 127])("a group of %i characters between the key and `=`", (size) => {
    const text = `token[${"abcdefghij".repeat(Math.ceil(size / 10)).slice(0, size)}]=${S}`;
    expect(seen(redactSecrets(text), S), redactSecrets(text)).toBe(false);
    expect(seen(asObject(text), S), "object form").toBe(false);
  });
  it("control: a group longer than the bound is not part of the key, and a plain bracket word is left alone", () => {
    expect(redactSecrets("token[abc] is a list")).toBe("token[abc] is a list");
  });
});
