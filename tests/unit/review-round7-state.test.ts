import { afterEach, describe, expect, it } from "vitest";
import * as api from "../../src/domain/redaction.js";

/**
 * Review round 7 (a ProofGate P0 was a module-level state and re-entrancy class): the reads that one scan remembers (the end of a run, of a
 * comment, of a backslash run, the last gap) live for ONE call. After every call, also one that threw, no memo holds a reference to the text
 * that was scanned (it can hold a secret), and calls that follow one another, or that nest, do not depend on what was scanned before.
 * The inspection is `scanStateHoldsText` of the redactor (a test hook); without it the tests fail by assertion.
 */

const V = "Zx9Kq2Lm7Pw4Rt8Yv3Bn";
const holds = (): boolean | string => (typeof (api as Record<string, unknown>).scanStateHoldsText === "function" ? (api as unknown as { scanStateHoldsText: () => boolean }).scanStateHoldsText() : "the scan state cannot be inspected");
/** Texts that make every memo remember something: property runs, unquoted reads, `#` comments, a block header, backslash runs, a gap ahead. */
const TEXTS = [
  `token:!token:!token:! pw=${V}`,
  `value=${V} value=${V} name=password`,
  `: #%3D[\\"DB_PASSWORD: #%3D[\\"DB_PASSWORD password: #${V}`,
  `#Basic pin=|#Basic pin=| sid[bearer: #${V}]:'`,
  `name: password${"\\".repeat(200)} x`,
  `otp: #apikey="${V}"\n  |\n    K12345`,
];

afterEach(() => api.setWorkBudget(64, 65_536));

describe("R7 (state): nothing a scan remembers outlives the call", () => {
  it("the scan state can be inspected (control)", () => {
    expect(holds()).toBe(false);
  });
  it.each(TEXTS.map((t, i) => [i, t] as const))("text %i: after redactSecrets, detectSecretKinds, redactIdentifier and redactDeep", (_i, text) => {
    api.redactSecrets(text);
    expect(holds(), "redactSecrets").toBe(false);
    api.detectSecretKinds(text);
    expect(holds(), "detectSecretKinds").toBe(false);
    api.redactIdentifier(text);
    expect(holds(), "redactIdentifier").toBe(false);
    api.redactDeep({ note: text, list: [text], [`k ${text}`]: { nested: text } });
    expect(holds(), "redactDeep (calls the text redactor for every string, nested)").toBe(false);
  });
  it("after a call that threw in the middle of a scan (the work budget forced to nothing)", () => {
    api.setWorkBudget(0, 1);
    const out = api.redactSecrets(TEXTS.join("\n"));
    expect(out, "the scan gave up (fail closed)").toBe("[REDACTED: value too large to scan]");
    expect(holds(), "state after the exception").toBe(false);
  });
  it("a call from a finally block, after another, and a call that nests another (redactDeep inside redactDeep of a redacted value)", () => {
    let inner = "";
    try {
      api.redactSecrets(TEXTS[0] as string);
    } finally {
      inner = api.redactSecrets(TEXTS[1] as string);
    }
    expect(inner.includes(V)).toBe(false);
    expect(holds()).toBe(false);
    const nested = api.redactDeep({ a: api.redactDeep({ b: TEXTS[2] }), c: TEXTS[3] });
    expect(JSON.stringify(nested).includes(V)).toBe(false);
    expect(holds()).toBe(false);
  });
  it("consecutive calls on different texts, in either order and interleaved with a text made of two of them, give the same outputs", () => {
    const first = TEXTS.map((t) => api.redactSecrets(t));
    const reversed = [...TEXTS].reverse().map((t) => api.redactSecrets(t)).reverse();
    const doubled = TEXTS.map((t, i) => api.redactSecrets(`${TEXTS[(i + 1) % TEXTS.length]}\n${t}`));
    expect(reversed).toEqual(first);
    expect(doubled.every((o) => !o.includes(V))).toBe(true);
    // the same texts once more, after all of that
    expect(TEXTS.map((t) => api.redactSecrets(t))).toEqual(first);
  });
});
