import { describe, expect, it } from "vitest";
import { visibleUnknowns } from "../../src/services/impact.js";

/**
 * Review round 3 (logic P3, impact.ts:314): the run view lists at most 100 unknowns, and the markers that say a list is
 * incomplete come first, so a long run of ordinary unknowns can never push them out of the visible window.
 */

const unknown = (code: string, n: number) => ({ code, message: `${code} ${n}` });
const many = (code: string, count: number) => Array.from({ length: count }, (_, i) => unknown(code, i));

describe("R3 P3 (impact.ts:314): the truncation markers are always inside the visible unknowns", () => {
  it("both markers stay visible when 500 ordinary unknowns sort in front of them", () => {
    const all = [...many("CHECK_UNKNOWN", 250), ...many("EDGE_FIELD_NOT_IN_CONTRACT", 250), unknown("FINDINGS_TRUNCATED", 0), unknown("UNKNOWNS_TRUNCATED", 0)];
    const shown = visibleUnknowns(all) as { code: string }[];
    expect(shown).toHaveLength(100);
    expect(shown.slice(0, 2).map((u) => u.code).sort()).toEqual(["FINDINGS_TRUNCATED", "UNKNOWNS_TRUNCATED"]);
  });

  it("the ordinary unknowns keep their order behind the markers", () => {
    const all = [unknown("A", 0), unknown("UNKNOWNS_TRUNCATED", 0), unknown("B", 1), unknown("C", 2)];
    expect((visibleUnknowns(all) as { code: string }[]).map((u) => u.code)).toEqual(["UNKNOWNS_TRUNCATED", "A", "B", "C"]);
  });

  it("controls: a short list is returned whole, and exactly 100 or 101 ordinary unknowns are cut at 100", () => {
    expect(visibleUnknowns([])).toEqual([]);
    expect(visibleUnknowns(many("X", 3))).toHaveLength(3);
    expect(visibleUnknowns(many("X", 100))).toHaveLength(100);
    expect(visibleUnknowns(many("X", 101))).toHaveLength(100);
  });

  it("entries that are not objects are ordinary entries (no marker, no crash)", () => {
    expect(visibleUnknowns([null, "text", 3, unknown("FINDINGS_TRUNCATED", 0)])[0]).toMatchObject({ code: "FINDINGS_TRUNCATED" });
  });
});
