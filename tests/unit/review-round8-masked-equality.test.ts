import { describe, expect, it } from "vitest";
import { COMPARE_BOUND, exceedsBound, maskedEqual, maskedEqualDeep } from "../../src/domain/derived-text.js";

/**
 * Review round 8 (logic P1, evidence.ts:537): the third reading of a recorded text. A recorded text matches a derived one when the visible fragments of the
 * record stand in the derivation literally and in order, the first at its start, the last at its end, and each marker hides a non-empty span: what a record
 * shows is always in the derivation, only what it hides may be anything.
 */

const M = "[REDACTED]";
const D = "edge auth:issuer|consumes|token:service was never verified";

describe("R8: maskedEqual", () => {
  it("accepts what a marker can stand for", () => {
    expect(maskedEqual(D, `edge auth:${M} was never verified`), "the record of the builds before round 7").toBe(true);
    expect(maskedEqual(D, `edge auth:${M}token:${M} was never verified`), "the record of this build").toBe(true);
    expect(maskedEqual("auth:xyz", `auth:${M}`), "the whole value hidden").toBe(true);
    expect(maskedEqual("a:bc", `a:${M}c`), "one character").toBe(true);
    expect(maskedEqual(D, D), "no marker: the text itself").toBe(true);
  });
  it("refuses a record that shows what the derivation lacks, or that hides nothing where it has a marker", () => {
    expect(maskedEqual(D, `edge auth:${M} never verified was`), "fragments out of order").toBe(false);
    expect(maskedEqual(D, `edge auth:${M}! was never verified`), "a visible character that the derivation lacks").toBe(false);
    expect(maskedEqual(D, `x edge auth:${M} was never verified`), "an unanchored start").toBe(false);
    expect(maskedEqual(D, `edge auth:${M} was never`), "an unanchored end").toBe(false);
    expect(maskedEqual(D, `edge auth:${M} was never verified twice`), "an extra visible tail").toBe(false);
    expect(maskedEqual(D, `edge auth:${M}issuer|consumes|token:service was never verified`), "an empty span (the marker in front of the whole rest)").toBe(false);
    expect(maskedEqual("abc:", `abc:${M}`), "an empty span at the end").toBe(false);
    expect(maskedEqual("abc", `${M}abc`), "an empty span at the start").toBe(false);
    expect(maskedEqual("a:bc", `a:${M}${M}`), "two adjacent markers are not a redaction of anything").toBe(false);
    expect(maskedEqual("abc", `${M}x${M}`), "a fragment that the derivation lacks").toBe(false);
    expect(maskedEqual("k:b:c", `k:${M}b:${M}c`), "the marker in front of `b:` would hide nothing: `b:` stands right behind `k:`").toBe(false);
    expect(maskedEqual("k:Xb:Yc", `k:${M}b:${M}c`), "the same record over a derivation in which each marker hides a character").toBe(true);
    expect(maskedEqual("k:a", `k:${M}`), "a single character may be hidden").toBe(true);
    expect(maskedEqual("k:", `k:${M}`), "nothing cannot be hidden").toBe(false);
  });
  it("property: a text with random non-empty disjoint spans hidden matches, and one visible character changed does not (20,000 cases)", () => {
    let seed = 20271002;
    const random = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    // (the alphabet has no `k`: every `k:` is a credential-shaped word that the record hides a span behind)
    const alphabet = "abcdefgh ij:|;-0123456789";
    for (let round = 0; round < 20_000; round += 1) {
      const pieces = 2 + Math.floor(random() * 40);
      let derived = "";
      let recorded = "";
      let visible = -1;
      let hidden = 0;
      for (let i = 0; i < pieces; i += 1) {
        if (random() < 0.2) {
          // `k:` and a hidden span of 1 to 6 characters behind it
          derived += "k:";
          recorded += "k:";
          for (let span = 1 + Math.floor(random() * 6); span > 0; span -= 1) derived += alphabet[Math.floor(random() * alphabet.length)];
          recorded += M;
          hidden += 1;
        } else {
          const c = alphabet[Math.floor(random() * alphabet.length)] as string;
          if (random() < 0.3) visible = recorded.length;
          derived += c;
          recorded += c;
        }
      }
      expect(maskedEqual(derived, recorded), `${JSON.stringify(derived)} ~ ${JSON.stringify(recorded)}`).toBe(true);
      if (visible >= 0 && hidden > 0 && derived[visible - 0] !== undefined) {
        // change one visible character of the record to one that the derivation does not contain at all
        const changed = `${recorded.slice(0, visible)}#${recorded.slice(visible + 1)}`;
        if (!derived.includes("#") && changed !== recorded) expect(maskedEqual(derived, changed), `${JSON.stringify(derived)} !~ ${JSON.stringify(changed)}`).toBe(false);
      }
    }
  });
  it("is bounded by the compare bound: 800 markers against 8,000 characters answer at once, and a longer record never gets here", () => {
    const derived = "a:b".repeat(Math.floor(COMPARE_BOUND / 3));
    const recorded = `a:${M}`.repeat(800);
    const started = Date.now();
    const answer = maskedEqual(derived, recorded);
    expect(Date.now() - started, "milliseconds for 800 markers").toBeLessThan(500);
    expect(typeof answer).toBe("boolean");
    const hostile = M.repeat(100_000);
    expect(exceedsBound(hostile), "100,000 markers are a record longer than the compare bound (refused before any comparison)").toBe(true);
  });
});

describe("R8: maskedEqualDeep", () => {
  it("compares shapes exactly and strings by masked equality", () => {
    expect(maskedEqualDeep({ message: [D, 1, null, true] }, { message: [`edge auth:${M} was never verified`, 1, null, true] })).toBe(true);
    expect(maskedEqualDeep({ a: [D] }, { a: [D, D] }), "array length").toBe(false);
    expect(maskedEqualDeep({ a: D }, { b: D }), "keys").toBe(false);
    expect(maskedEqualDeep({ a: 1 }, { a: 2 }), "numbers").toBe(false);
    expect(maskedEqualDeep({ a: D }, { a: [D] }), "shape").toBe(false);
    expect(maskedEqualDeep({ [`auth:issuer|x`]: 1 }, { [`auth:${M}`]: 1 }), "a key that holds a marker").toBe(true);
    expect(maskedEqualDeep({ [`auth:issuer|x`]: 1 }, { [`token:${M}`]: 1 }), "a key that holds a marker and does not match").toBe(false);
  });
  it("at most 32 keys with a marker are searched", () => {
    const derived: Record<string, number> = {};
    const recorded: Record<string, number> = {};
    for (let i = 0; i < 40; i += 1) {
      derived[`key${String(i).padStart(3, "0")}:x`] = i;
      recorded[`key${String(i).padStart(3, "0")}:${M}`] = i;
    }
    expect(maskedEqualDeep(derived, recorded)).toBe(false);
  });
});
