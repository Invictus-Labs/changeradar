import { describe, expect, it } from "vitest";
import { redactDeep, redactSecrets } from "../../src/domain/redaction.js";

/**
 * Review round 8 KNOWN LIMIT (docs/MANIFEST.md, "Not covered"; an open owner decision, NOT accepted): a bracket, a brace or a stray closer BETWEEN the two quoted
 * halves of a name/value pair ends the pair, because the two halves of a pair must belong to one object (the search leaves the object at a closer). 435731e read
 * the halves across such a character and hid the value; every later tree shows it. Valid JSON is not affected (the halves of one object are not separated by a
 * closer), the shapes need malformed text. The exact strings and what they do are pinned here so that a change in either direction is a decision.
 */

const S = "Zx9Kq2Lm7Pw4Rt8Yv3Bn";
const fill = (shape: string): string => shape.replace("@", S);

describe("R8 KNOWN LIMIT: a closer or an opening bracket between the two quoted halves of a name/value pair", () => {
  const readable = [
    '"name":"token"]"value":"@',
    '"name":"token"["value":"@',
    '"name":"token"],"value":"@"',
    '"name":"token" ] "value":"@',
    '{"name":"token"][\\"value\\":\\"@\\"}',
    '{"name":"token"]"value":"@"}',
    '{"name":"token"}{"value":"@"}',
    '"name":"token"}"value":"@"',
    '"key":"password"]"value":"@"',
  ];
  it.each(readable)("%s: the value is readable (pinned, at text and at object level)", (shape) => {
    expect(redactSecrets(fill(shape)).includes(S)).toBe(true);
    expect(JSON.stringify(redactDeep({ note: fill(shape) })).includes(S)).toBe(true);
  });
  it.each(['{"name":"token","value":"@"}', '"name":"token")"value":"@"', '"name":"token" x "value":"@"', '"name":"token";"value":"@"', '"name":"token","value":"@"'])(
    "control: %s is hidden (the halves of one object, or a separator that does not leave it)",
    (shape) => {
      expect(redactSecrets(fill(shape)).includes(S)).toBe(false);
    },
  );
});

describe("R8 (the verbatim tag, fixed): `password: !<tag:yaml.org,2002:str> S` is hidden now", () => {
  it("hides the value behind a verbatim tag at text and object level", () => {
    const text = `password: !<tag:yaml.org,2002:str> ${S}`;
    expect(redactSecrets(text).includes(S)).toBe(false);
    expect(JSON.stringify(redactDeep({ note: text })).includes(S)).toBe(false);
  });
});
