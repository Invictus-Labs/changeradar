import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "../../src/platform/cursor.js";
import { containsSecret, OVERSIZE_REDACTED, redactDeep, redactSecrets } from "../../src/domain/redaction.js";

/**
 * Review round 5 (tests P3): one exact-boundary assertion for each redaction and helper rule that a review's hand mutations
 * left alive: the six-character floor, the argument-vector guard, the pair name words, the `valueFrom` reference, plain-word pair
 * values at validator strength, the 512 K refusal of percent-escaped text, and the cursor length limit.
 */

const V = "Zx9Kq2Lm7Pw4Rt8Yv3Bn6Cd1Fg5Hj0";

describe("R5 (redaction-pairs.ts): the six-character floor of a value", () => {
  it("a pair value of six characters is hidden, one of five is not (text and assignment alike)", () => {
    expect(redactSecrets(`{"name":"DB_PASSWORD","value":"abc1ef"}`)).not.toContain("abc1ef");
    expect(redactSecrets(`{"name":"DB_PASSWORD","value":"abc1e"}`)).toContain("abc1e");
    expect(redactSecrets("password=abc1ef")).not.toContain("abc1ef");
    expect(redactSecrets("password=abc1e")).toContain("abc1e");
    expect(redactSecrets("name=DB_PASSWORD value=abc1ef")).not.toContain("abc1ef");
    expect(redactSecrets("name=DB_PASSWORD value=abc1e")).toContain("abc1e");
  });
});

describe("R5 (redaction-pairs.ts): an argument vector: the item after a credential flag is its value unless it is another flag", () => {
  it("[--password, --verbose] keeps the second flag, [--password, S] hides S, in text and in objects", () => {
    expect(redactDeep(["--password", "--verbose"])).toEqual(["--password", "--verbose"]);
    expect(redactDeep(["--password", "-x"])).toEqual(["--password", "-x"]);
    expect(redactDeep(["--password", V])).toEqual(["--password", "[REDACTED]"]);
    // In TEXT the item after the flag is read as its value whatever it is (fail closed): only the array form has the guard.
    expect(redactSecrets(`["--password","${V}"]`)).not.toContain(V);
  });

  it("an ECS `valueFrom` next to a credential name is a reference, not a value", () => {
    const text = `[{"name":"password","valueFrom":"arn:aws:ssm:eu-west-1:0:parameter/db-reference"}]`;
    expect(redactSecrets(text)).toBe(text);
  });
});

describe("R5 (redaction-pairs.ts): pair name words that were unpinned", () => {
  it.each(["signature", "sid", "otp", "totp", "pin", "pw", "x-signature", "session"])("{name: %s, value: S} is hidden in text and in objects", (name) => {
    expect(redactSecrets(JSON.stringify({ name, value: V }))).not.toContain(V);
    expect(JSON.stringify(redactDeep({ name, value: V }))).not.toContain(V);
  });

  it("controls: whole-word names do not match inside ordinary words", () => {
    for (const name of ["inside", "spinner", "resident", "signal", "topic"]) expect(redactSecrets(JSON.stringify({ name, value: V })), name).toContain(V);
  });
});

describe("R5 (redaction-pairs.ts): a plain-word pair value is redacted in logs but does not make the validator refuse the text", () => {
  it("low confidence: redactSecrets hides it, containsSecret needs a random-looking value", () => {
    const plain = `{"name":"DB_PASSWORD","value":"correcthorse"}`;
    expect(redactSecrets(plain)).not.toContain("correcthorse");
    expect(containsSecret(plain)).toBe(false);
    expect(containsSecret(`{"name":"DB_PASSWORD","value":"${V}"}`)).toBe(true);
  });
});

describe("R5 (redaction.ts): the 512 K limit of text that holds a percent escape", () => {
  const LIMIT = 512 * 1024;
  it("exactly at the limit the text is scanned; one character over it is refused whole", () => {
    const at = `${"a".repeat(LIMIT - 3)}%41`;
    const over = `${"a".repeat(LIMIT - 2)}%41`;
    expect(at.length).toBe(LIMIT);
    expect(redactSecrets(at)).toBe(at);
    expect(over.length).toBe(LIMIT + 1);
    expect(redactSecrets(over)).toBe(OVERSIZE_REDACTED);
  });

  it("text over the limit WITHOUT an escape is scanned (the refusal is for the decoded copy only)", () => {
    const plain = "a".repeat(LIMIT + 10);
    expect(redactSecrets(plain)).toBe(plain);
  });
});

describe("R5 (cursor.ts:42): a cursor of 512 characters is read, one of 513 or more is refused", () => {
  it("the boundary is exact", () => {
    // ["aaa..."] is N + 4 bytes; base64url of 384 bytes is exactly 512 characters.
    const at = encodeCursor(["a".repeat(380)]);
    expect(at.length).toBe(512);
    expect(decodeCursor(at, ["string"])).toEqual(["a".repeat(380)]);
    const over = encodeCursor(["a".repeat(381)]);
    expect(over.length).toBeGreaterThan(512);
    expect(() => decodeCursor(over, ["string"])).toThrow(/cursor is not valid/);
  });
});
