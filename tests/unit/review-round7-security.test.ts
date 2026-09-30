import { describe, expect, it } from "vitest";
import { redactSecrets } from "../../src/domain/redaction.js";

/**
 * Review round 7 (security): a form that starts a line is recognised after a line break WRITTEN AS TEXT (a backslash and an n, as JSON
 * text and log lines carry it), exactly like after a real one. Every case is hidden after a real line break by the tree before this one,
 * and stays hidden here for each glue. Fake secrets are assembled at run time.
 */

const V = "Zx9Kq2Lm7Pw4Rt8Yv3Bn";
const hides = (text: string): boolean => !redactSecrets(text).includes(V);

const GLUES = ["oncall a=1\\n", "oncall a=1\\r\\n", "oncall a=1\\t", "oncall a=1\n", "oncall a=1\r\n", "x %0A", "x%0D%0A"];
const FORMS: [string, string][] = [
  ["sid=", `sid=${V}`],
  ["sid:", `sid: ${V}`],
  ["pw=", `pw=${V}`],
  ["pswd:", `pswd: ${V}`],
  ["pin:", `pin: ${V}`],
  ["otp=", `otp=${V}`],
  ["long flag", `--db-password ${V}`],
  ["-p=", `-p=${V}`],
  ["ENV", `ENV DB_SECRET ${V}`],
  ["ARG", `ARG API_TOKEN ${V}`],
  ["bare pair", `name=DB_PASSWORD value=${V}`],
];

describe("R7 (redaction.ts, redaction-forms.ts, redaction-pairs.ts): forms that start a line after a line break written as text", () => {
  for (const glue of GLUES) {
    it.each(FORMS)(`after ${JSON.stringify(glue)}: %s`, (_label, form) => {
      expect(hides(`${glue}${form}`)).toBe(true);
    });
  }

  it("a manifest-style owner text with the break written as a JSON escape in text", () => {
    expect(hides(`oncall a=1\\npw=${V}`)).toBe(true);
    expect(hides(`\\npin: ${V}`)).toBe(true);
    expect(hides(`\\r\\nsid=${V}`)).toBe(true);
  });

  it.each([
    ["an ordinary word that ends in n, glued to the short key", `turnpin: ${V}`],
    ["an ordinary word that ends in n, glued to a short key with =", `openpw=${V}`],
    ["a word that ends in n before a blank and a flag whose last word is not a secret word", `turn --note ${V}`],
    ["a backslash and an n inside a word that is not a break: the key is glued to letters", `a\\ndsnpin: ${V}`],
    ["an ordinary sentence that mentions a pin", `turn the pin on and open pw later`],
  ])("precision: %s is not a line break and stays as it was", (_label, text) => {
    expect(redactSecrets(text)).toBe(text);
  });
});
