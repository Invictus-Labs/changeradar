import { describe, expect, it } from "vitest";
import { looksRandomAt, type NextMark, setWorkBudget } from "../../src/domain/redaction.js";
import { startScan as startScanForTest } from "../../src/domain/redaction-pairs.js";

/**
 * Review round 7 (cross-check, `-p=` repeated was quadratic in the validator): the validator keeps a low-confidence span only when it holds a
 * digit and a letter. The first implementation cut the span out and searched it twice; the replacement asks for the next digit and the next
 * letter at or after the start of the span and remembers the answer for the later spans of the same text (nested spans share their end). The
 * two must give the SAME decision for every span, so the old implementation is copied here as the oracle.
 *
 * What counts: a digit is `0` to `9` and a letter is `A` to `Z` or `a` to `z` (the old expressions had no `u` and no `i` flag), so a non-ASCII
 * letter, a fullwidth digit and a surrogate pair count as neither, in both.
 */

/** The implementation that this one replaced (redaction.ts before the fix), verbatim. */
const looksRandomOracle = (value: string): boolean => /[0-9]/.test(value) && /[A-Za-z]/.test(value);

let seed = 20270930;
const random = (): number => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2 ** 32;
};
const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
const ALPHABETS: readonly (readonly string[])[] = [
  ["0", "1", "7", "9"], // digits only
  ["a", "Z", "q", "M", "A", "z"], // letters only (both ends of both ranges)
  ["-", "=", ":", " ", "_", ".", "/", "\\", "%", "@", "[", "`", "{"], // neither (the characters next to the ranges: / : @ [ ` {)
  ["é", "ß", "Ω", "中", "１", "Ａ", "😀", "𝔸"], // non-ASCII letters, fullwidth digits and letters, surrogate pairs
  ["0", "a", "-", "é", "😀", "Z", "9", "="], // a mix
];

describe("R7 (validator decision): the memoised digit and letter search equals the slice-and-search it replaced", () => {
  it("agrees on every span of 2,500 random texts (200,000 spans in all), spans nested, empty and in any order", () => {
    setWorkBudget(64, 1_000_000_000);
    let cases = 0;
    let random_looking = 0;
    for (let round = 0; round < 2500; round += 1) {
      const alphabet = pick(ALPHABETS);
      const length = Math.floor(random() * 60);
      // a text of one alphabet, with a run of another spliced in, so that the first digit and the first letter sit at different places
      let text = Array.from({ length }, () => pick(alphabet)).join("");
      if (random() < 0.5) text = text.slice(0, Math.floor(random() * text.length)) + pick(pick(ALPHABETS)) + text.slice(Math.floor(random() * text.length));
      const digit: NextMark = { text: "", from: 0, at: 0 };
      const letter: NextMark = { text: "", from: 0, at: 0 };
      startScanForTest(text.length);
      const ends = [text.length, Math.floor(random() * (text.length + 1))];
      for (let i = 0; i < 80; i += 1) {
        // half of the spans share one end (nested), the others are anywhere; empty spans (start = end) and spans that end before the first digit or letter occur
        const end = random() < 0.5 ? (ends[0] as number) : Math.floor(random() * (text.length + 1));
        const start = Math.floor(random() * (end + 1));
        const expected = looksRandomOracle(text.slice(start, end));
        expect(looksRandomAt(text, start, end, digit, letter), `${JSON.stringify(text)} [${start}, ${end})`).toBe(expected);
        cases += 1;
        if (expected) random_looking += 1;
      }
    }
    expect(cases).toBeGreaterThanOrEqual(200_000);
    // the property is not vacuous: both outcomes occur often
    expect(random_looking).toBeGreaterThan(20_000);
    expect(cases - random_looking).toBeGreaterThan(20_000);
  });

  it("agrees when the spans of one text arrive with falling starts and with two different texts on the same memos", () => {
    setWorkBudget(64, 1_000_000_000);
    for (let round = 0; round < 500; round += 1) {
      const a = Array.from({ length: 40 }, () => pick(pick(ALPHABETS))).join("");
      const b = Array.from({ length: 40 }, () => pick(pick(ALPHABETS))).join("");
      const digit: NextMark = { text: "", from: 0, at: 0 };
      const letter: NextMark = { text: "", from: 0, at: 0 };
      startScanForTest(80);
      for (const text of [a, b, a]) {
        for (let start = text.length; start >= 0; start -= 1) {
          expect(looksRandomAt(text, start, text.length, digit, letter), `${JSON.stringify(text)} [${start}, end)`).toBe(looksRandomOracle(text.slice(start)));
        }
      }
    }
  });

  it("charges the work of a run of nested spans in proportion to the text, not to the square of it", () => {
    // `-p=` repeated: every opener's span runs to the end, none holds a digit or a letter after the first p: the old check cost the sum of the span lengths
    const text = "-p=".repeat(40_000);
    const digit: NextMark = { text: "", from: 0, at: 0 };
    const letter: NextMark = { text: "", from: 0, at: 0 };
    setWorkBudget(4, 0); // 4 steps per character: room for a linear scan, none for a quadratic one (the spans alone would need 480,000,000)
    startScanForTest(text.length);
    expect(() => {
      for (let start = 0; start < text.length; start += 3) looksRandomAt(text, start, text.length, digit, letter);
    }, "a run of 40,000 nested spans is searched within 4 steps per character").not.toThrow();
    // and the budget is real: with none left the first search throws
    setWorkBudget(0, 0);
    startScanForTest(text.length);
    expect(() => looksRandomAt(text, 0, text.length, { text: "", from: 0, at: 0 }, { text: "", from: 0, at: 0 })).toThrow(/work budget/);
    setWorkBudget(64, 65_536);
  });
});
