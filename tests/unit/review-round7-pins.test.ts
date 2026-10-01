import { describe, expect, it } from "vitest";
import { redactSecrets } from "../../src/domain/redaction.js";

/**
 * Review round 7 (conformance): the limits docs/MANIFEST.md names as "each is pinned" and one property of the redactor
 * that a change of the pass bound touches. A KNOWN LIMIT test expects the CURRENT output, so a change in either direction is
 * a decision. Fake secrets are assembled at run time.
 */

const V = "Zx9Kq2Lm7Pw4Rt8Yv3Bn";
const hides = (text: string): boolean => !redactSecrets(text).includes(V);

describe("R7 KNOWN LIMIT (docs/MANIFEST.md): the name of a name/value pair is read up to 300 characters", () => {
  const named = (total: number): string => "a".repeat(total - "password".length) + "password";
  it.each([250, 299, 300])("a name of %i characters is a credential name: the value is hidden", (total) => {
    expect(hides(`{"name":"${named(total)}","value":"${V}"}`)).toBe(true);
    expect(hides(`name=${named(total)} value=${V}`)).toBe(true);
  });
  it.each([301, 310])("a name of %i characters is not read: the value stays visible", (total) => {
    expect(hides(`{"name":"${named(total)}","value":"${V}"}`)).toBe(false);
    expect(hides(`name=${named(total)} value=${V}`)).toBe(false);
  });
});

describe("R7 KNOWN LIMIT (docs/MANIFEST.md): the two halves of a name/value pair are at most 600 characters apart", () => {
  // The gap is the filler, the two blanks around it and the word `value=`: the edge falls between 597 and 598 filler characters here.
  const spaced = (filler: number): string => `name=password ${"x".repeat(filler)} value=${V}`;
  it.each([300, 590, 597])("a gap of %i filler characters: the value is hidden", (filler) => {
    expect(hides(spaced(filler))).toBe(true);
  });
  it.each([598, 601, 700])("a gap of %i filler characters: the value stays visible", (filler) => {
    expect(hides(spaced(filler))).toBe(false);
  });
});

describe("R7 KNOWN LIMIT (docs/MANIFEST.md): a value that begins with & after an equals sign is an empty value", () => {
  // After `=` the character `&` ends a value (the next query parameter starts there), so `password=&S` is an empty value followed by `S`.
  // After the colon of YAML `&S` is an anchor name in front of the value, and the value is hidden.
  it.each([`password=&${V}`, `PASSWORD=&${V}`, `password = &${V}`])("%s stays visible", (text) => {
    expect(redactSecrets(text)).toContain(V);
  });
  it("the YAML colon form hides the anchor name", () => {
    expect(redactSecrets(`password: &${V}`)).toBe("password: [REDACTED]");
  });
});

describe("R7: redacting twice gives the same result as once", () => {
  it("a chain of encoded line breaks behind a header value (found by a differential of the previous round)", () => {
    const text = "Authorization%3AA%0A)%0Aclientsecret%3A";
    const once = redactSecrets(text);
    expect(once).toBe("Authorization%3A[REDACTED]");
    expect(redactSecrets(once)).toBe(once);
  });
  it("each of up to 14 repeats of an encoded line break and bracket is hidden in one call", () => {
    for (const repeats of [1, 2, 3, 5, 8, 14]) {
      const once = redactSecrets(`Authorization%3AA${"%0A)".repeat(repeats)}%0Aclientsecret%3A`);
      expect(once, `${repeats} repeats`).toBe("Authorization%3A[REDACTED]");
      expect(redactSecrets(once)).toBe(once);
    }
  });
  it("KNOWN LIMIT: a chain of 30 repeats is hidden further by a second call, never shown", () => {
    const once = redactSecrets(`Authorization%3AA${"%0A)".repeat(30)}%0Aclientsecret%3A`);
    expect(once).not.toBe("Authorization%3A[REDACTED]");
    expect(once.startsWith("Authorization%3A[REDACTED]")).toBe(true);
    expect(redactSecrets(once)).toBe("Authorization%3A[REDACTED]");
  });
});
