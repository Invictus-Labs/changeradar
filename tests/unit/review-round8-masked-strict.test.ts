import { describe, expect, it } from "vitest";
import { capText, maskedEqual, maskedEqualDeep, TEXT_CAP } from "../../src/domain/derived-text.js";

/**
 * Review round 8, second look (logic P1-A and P2): the masked reading of a recorded text.
 *
 * P2: a marker stands only behind a credential-shaped word and its separator (`access_token:[REDACTED]`, `key=[REDACTED]`); a record that is one marker, two markers
 * side by side, `edge [REDACTED]` or a marker in front of the whole text is not a redaction of anything the redactor writes; and the masked reading is applied to the
 * free text members (`message`, `reason`, `description`) only: a `code`, an `id`, an edge, a hash, a node id or an assessment is compared exactly.
 *
 * P1-A: a record that a restore CUT at the cap is a masked PREFIX of the derivation (no end anchor, the last fragment anywhere behind the last hidden span); a record that is
 * not at the cap keeps both anchors.
 */

const M = "[REDACTED]";

describe("R8 B7: a marker stands behind a credential-shaped word", () => {
  it("accepts `word:` and `word=` in front of every marker", () => {
    expect(maskedEqual("token:abc rest", `token:${M} rest`)).toBe(true);
    expect(maskedEqual("key=abc rest", `key=${M} rest`)).toBe(true);
    expect(maskedEqual("a.b-c_d:xyz", `a.b-c_d:${M}`)).toBe(true);
    expect(maskedEqual("auth:issuer|token:service ok", `auth:${M}token:${M} ok`)).toBe(true);
  });
  it("refuses a marker that is alone, at the start, behind a blank or behind a word without a separator, and two markers side by side", () => {
    expect(maskedEqual("abc", M), "one marker for the whole text").toBe(false);
    expect(maskedEqual("abc", `a${M}c`), "a marker behind a plain letter").toBe(false);
    expect(maskedEqual("edge abc", `edge ${M}`), "`edge [REDACTED]`").toBe(false);
    expect(maskedEqual("abc", `${M}${M}`), "two markers").toBe(false);
    expect(maskedEqual("token:abcd", `token:${M}${M}`), "two markers side by side behind a word").toBe(false);
    expect(maskedEqual("x token: abc", `x token: ${M}`), "a blank between the separator and the marker").toBe(false);
    expect(maskedEqual("token:abc", `:${M}`), "a separator with no word in front of it").toBe(false);
  });
});

describe("R8 B7: a record that is a cut is a masked prefix of the derivation", () => {
  const D = "edge auth:issuer|consumes|token:service declares field(s) alpha, beta, gamma that the contract does not have";
  it("prefix mode: fragments in order, the first at the start, no end anchor, every marker hides a non-empty span", () => {
    expect(maskedEqual(D, `edge auth:${M} declares field(s) alpha, be`, true)).toBe(true);
    expect(maskedEqual(D, `edge auth:${M} declares field(s) alpha, beta, gamma that the contract does not have`, true), "the whole text").toBe(true);
    expect(maskedEqual(D, "edge auth:issuer|consumes|tok", true), "no marker: a prefix of the derivation").toBe(true);
    expect(maskedEqual(D, `edge auth:${M}`, true), "the cut right behind a marker").toBe(true);
    expect(maskedEqual(D, `edge auth:${M} declares field(s) beta, alpha`, true), "fragments out of order").toBe(false);
    expect(maskedEqual(D, `edge auth:${M} declares field(s) alpha#`, true), "a character that the derivation lacks").toBe(false);
    expect(maskedEqual(D, `x edge auth:${M} declares`, true), "an unanchored start").toBe(false);
    expect(maskedEqual(D, `edge auth:${M}issuer|consumes|token:service declares`, true), "an empty span").toBe(false);
    expect(maskedEqual(D, "edge auth:issuer|consumes|token:servicX", true), "no marker, a changed character").toBe(false);
    expect(maskedEqual("abc:x", `abc:${M}`, true)).toBe(true);
    expect(maskedEqual("abc:", `abc:${M}`, true), "nothing is left to hide").toBe(false);
  });
  it("without the prefix mode the end stays anchored", () => {
    expect(maskedEqual(D, `edge auth:${M} declares field(s) alpha, be`)).toBe(false);
    expect(maskedEqual(D, "edge auth:issuer|consumes|tok")).toBe(false);
  });

  it("maskedEqualDeep uses the prefix mode only for a free text of 1,991 to 2,000 characters; a record that ends at a marker needs no prefix mode", () => {
    const filler = (length: number): string => "f".repeat(length);
    const derived = { message: `edge k:secret ${filler(2600)} end` };
    const recordOf = (length: number): string => `edge k:${M} ${filler(3000)}`.slice(0, length);
    expect(maskedEqualDeep(derived, { message: recordOf(TEXT_CAP) }), "2,000").toBe(true);
    expect(maskedEqualDeep(derived, { message: recordOf(TEXT_CAP - 9) }), "1,991").toBe(true);
    expect(maskedEqualDeep(derived, { message: recordOf(TEXT_CAP - 10) }), "1,990 and no marker at the end: anchored").toBe(false);
    expect(maskedEqualDeep(derived, { message: recordOf(TEXT_CAP + 1) }), "2,001: not a cut").toBe(false);
    expect(maskedEqualDeep(derived, { message: recordOf(1500) }), "1,500").toBe(false);
    // a cut that dropped the partial word glued to its last marker ends AT that marker, at any length: the marker hides the rest, so both anchors hold without the prefix mode
    const endsAtMarker = (length: number): string => `edge k:${M} ${filler(length - 31)} j:${M}`;
    const derivedJ = (length: number) => ({ message: `edge k:secret ${filler(length - 31)} j:value and more` });
    expect(endsAtMarker(1990).length).toBe(1990);
    for (const length of [1990, 1936, 1935, 1500]) expect(maskedEqualDeep(derivedJ(length), { message: endsAtMarker(length) }), `a record that ends at a marker, ${length}`).toBe(true);
    expect(maskedEqualDeep(derivedJ(1500), { message: endsAtMarker(1500).replace("edge k:", "edge x:") }), "a fragment that the derivation lacks").toBe(false);
  });

  it("property: the real cut of a record that hides values (every cut position from 1,960 to 2,040 by the padding in front) is a prefix of the derivation", () => {
    let checked = 0;
    for (let pad = 0; pad < 200; pad += 1) {
      const head = `${"n".repeat(pad)} `;
      let derived = head;
      let legacy = head;
      for (let i = 0; i < 100 && legacy.length < TEXT_CAP + 400; i += 1) {
        derived += "access_token:abcdeapikey:abcdef ";
        legacy += `access_token:${M}apikey:${M} `;
      }
      const cutRecord = capText(legacy) as string;
      if (legacy.length <= TEXT_CAP) continue;
      expect(cutRecord.length, `pad ${pad}`).toBeLessThanOrEqual(TEXT_CAP);
      expect(maskedEqualDeep({ message: derived }, { message: cutRecord }), `pad ${pad}: ${JSON.stringify(cutRecord.slice(-40))}`).toBe(true);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(150);
  });
});

describe("R8 B7: the masked reading applies to free text members only", () => {
  const M1 = `edge k:${M} was never verified`;
  const D1 = "edge k:secret|consumes|j:other was never verified";
  it("message, reason and description accept a genuine record; code, id, edge, node_id, baseline_hash and assessment are compared exactly", () => {
    for (const key of ["message", "reason", "description"]) expect(maskedEqualDeep({ [key]: D1 }, { [key]: M1 }), key).toBe(true);
    for (const key of ["code", "id", "node_id", "baseline_hash", "assessment", "source_id", "target_id"]) {
      expect(maskedEqualDeep({ [key]: D1 }, { [key]: M1 }), key).toBe(false);
      expect(maskedEqualDeep({ [key]: D1 }, { [key]: D1 }), `${key}, equal`).toBe(true);
    }
  });
  it("arrays and nested objects take the member name of the object they sit in", () => {
    expect(maskedEqualDeep({ unknowns: [{ code: "C", message: D1 }] }, { unknowns: [{ code: "C", message: M1 }] })).toBe(true);
    expect(maskedEqualDeep({ unknowns: [{ code: D1, message: D1 }] }, { unknowns: [{ code: M1, message: D1 }] })).toBe(false);
    expect(maskedEqualDeep({ limits: [D1] }, { limits: [M1] }), "a bare array of strings is not free text").toBe(false);
    expect(maskedEqualDeep({ coverage: { limits: [{ code: "C", message: D1 }] } }, { coverage: { limits: [{ code: "C", message: M1 }] } })).toBe(true);
    expect(maskedEqualDeep({ coverage: { limits: [{ code: "C", message: D1 }] } }, { coverage: { limits: [{ code: M1, message: D1 }] } })).toBe(false);
  });
  it("a free text that is itself a forgery is refused: one marker, two markers, `edge [REDACTED]`", () => {
    for (const forged of [M, `${M}${M}`, `edge ${M}`, `${M} was never verified`]) expect(maskedEqualDeep({ message: D1 }, { message: forged }), forged).toBe(false);
  });
  it("a top-level string is free text only when the caller says so", () => {
    expect(maskedEqualDeep(D1, M1)).toBe(false);
    expect(maskedEqualDeep(D1, M1, true)).toBe(true);
  });
  it("an object key that holds a marker must also stand behind a credential-shaped word", () => {
    expect(maskedEqualDeep({ "auth:issuer|x": 1 }, { [`auth:${M}`]: 1 })).toBe(true);
    expect(maskedEqualDeep({ code: 1 }, { [M]: 1 }), "a schema key blanked").toBe(false);
  });
});
