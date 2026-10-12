import { describe, expect, it } from "vitest";
import { redactDeep, redactSecrets } from "../../src/domain/redaction.js";

/**
 * Review round 6 (security): the root causes of the differential no-leak regression (a value that starts with `#`, a bracket
 * group glued to more value, a value that looks like `key=` or `key:`, a short property followed by a backslash), pairs at every
 * JSON depth from 0 to 13 (the bound counted backslashes), block scalar bodies with a quote at any depth, a block scalar as the
 * value of a pair, and redacting twice. Fake secrets are assembled at run time.
 */

const S = "Zx9qLm3vRt7wKp2N";
const wrap = (text: string, depth: number): string => {
  let out = text;
  for (let i = 0; i < depth; i += 1) out = JSON.stringify(out).slice(1, -1);
  return out;
};
const leaksAt = (text: string, depths: number[]): number[] => depths.filter((d) => redactSecrets(wrap(text, d)).includes(S));

describe("R6 (redaction.ts): root causes of the regression against the previous tree, each hidden by the previous tree", () => {
  it.each([
    ["a value that starts with # after `key: `", `password: #${S}`],
    ["the same with a line after it", `password: #${S}\nnext: 1`],
    ["a value that starts with an empty bracket pair", `password=[]${S}`],
    ["a value that starts with a bracket group and goes on", `password=[abc]${S}`],
    ["the marker of a first pass followed by the rest of a value", `password=[REDACTED]${S}`],
    ["a value that looks like `Key=`", `password=${S}=`],
    ["a value that looks like `Key:`", `DB_PASSWORD=${S}:`],
    ["a value that looks like a credential word and a colon", `DB_PASSWORD=Secret2024:`],
    ["a short anchor followed by escaped backslashes", `password: !ab\\\\${S}`],
  ])("%s", (_label, text) => {
    const out = redactSecrets(text);
    expect(out.includes(S) || out.includes("Secret2024:"), `still readable: ${out}`).toBe(false);
    expect(redactSecrets(out), "a fixed point").toBe(out);
  });

  it("a short anchor followed by escaped backslashes is hidden with the value, as the previous tree did", () => {
    expect(redactSecrets(`password: !ab\\\\${S}`)).toBe("password: [REDACTED]");
  });

  it("controls: a comment of several words stays readable, and the value on the next line is hidden", () => {
    expect(redactSecrets(`password: # rotate monthly\n  ${S}`)).toBe("password: # rotate monthly\n  [REDACTED]");
    expect(redactSecrets(`pw: password="${S}"`)).toBe("pw: password=" + '"[REDACTED]"');
  });
});

describe("R6 (redaction-pairs.ts:69): a name/value pair is hidden at every JSON depth from 0 to 13", () => {
  const depths = Array.from({ length: 14 }, (_, d) => d);
  const shapes: [string, string][] = [
    ["name, value", `{"name":"DB_PASSWORD","value":"${S}"}`],
    ["value, name", `{"value":"${S}","name":"DB_PASSWORD"}`],
    ["a key between the halves", `{"name":"DB_PASSWORD","type":"x","note":"y","value":"${S}"}`],
    ["a path for a name and a Type key", `{"Name":"/prod/db/password","Type":"SecureString","Value":"${S}"}`],
    ["an object and an array between the halves", `{"name":"DB_PASSWORD","a":{"b":1},"c":[1,2],"value":"${S}"}`],
    ["a key of 500 characters between the halves", `{"name":"DB_PASSWORD","note":"${"x".repeat(500)}","value":"${S}"}`],
    ["a tuple", `["password","${S}"]`],
    ["an argument vector", `["run","--password","${S}"]`],
    ["the same pair without JSON quoting", `name=DB_PASSWORD value=${S}`],
  ];
  it.each(shapes)("%s", (_label, text) => {
    expect(leaksAt(text, depths), "JSON depths at which the secret is still readable").toEqual([]);
  });
});

describe("R6 (redaction-forms.ts): block scalars at every JSON depth", () => {
  const depths = [0, 1, 2, 3, 4];
  it.each([
    ["a body with a double quote inside", `password: |\n  ${"a".repeat(8)}"${S}\nnext: 1`],
    ["a body with an apostrophe inside", `password: |\n  ${"a".repeat(8)}'${S}\nnext: 1`],
    ["a body of several lines with a quote in one", `password: |\n  first line\n  ${"a".repeat(8)}"${S}\n  last\nnext: 1`],
    ["a block scalar as the value of a name/value pair in a YAML list", `- name: DB_PASSWORD\n  value: |\n    ${S}\n`],
    ["the folded form as the value of a pair", `- name: DB_PASSWORD\n  value: >-\n    ${S}\n`],
  ])("%s", (_label, text) => {
    expect(leaksAt(text, depths), "JSON depths at which the secret is still readable").toEqual([]);
  });
});

describe("R6: a key embedded in a short bare value (and the values of the previous tree that swallowed it)", () => {
  it("the key word and its separator stay readable, what comes before and everything behind it is hidden", () => {
    expect(redactSecrets(`pin: !ab\\\\\\apikey: ${S}`)).toBe("pin: [REDACTED]apikey: [REDACTED]");
    const swallowed = redactSecrets(`token%3D%2Cpass%3Ab%27${S}%27%5C%5Cnpin%3D%20${S}Zz9`);
    expect(swallowed.includes(S), swallowed).toBe(false);
  });
  it("the tail behind an embedded key is hidden, in plain text and in a percent-encoded list, at text and at object level (a survivor of the mutation run, round 7)", () => {
    // Plain text, no percent, JSON or HTML layer: the word `bearer=null` behind the value that holds the key `secret=...=bearer` is swallowed with it.
    expect(redactSecrets(`secret=${S}=bearer=null`)).toBe("secret=[REDACTED]bearer=[REDACTED]");
    expect(redactSecrets(`token=${S}=token:pin`)).toBe("token=[REDACTED]token:[REDACTED]");
    // One level of percent encoding (the decoded copy): every value of the list is hidden, the last one included.
    const [a, b, c] = ["Qn4Tr8Wv2Kp7Lm3Xz9", "Hb6Yc1Dg5Fj0Ns8Pq", "Md7Vx3Ke9Rt2Wp5Lz"];
    const encoded = `jwt%3D${a}%2Capi_key%3A%3D%22${b}%22%2Csigning_key%3A!!str%20${c}`;
    const text = redactSecrets(encoded);
    const deep = JSON.stringify(redactDeep({ note: encoded, list: [encoded] }));
    for (const value of [a, b, c]) {
      expect(text.includes(value), `${value} in ${text}`).toBe(false);
      expect(deep.includes(value), `${value} in ${deep}`).toBe(false);
    }
  });
  it("KNOWN LIMIT (docs/MANIFEST.md: the signing, encryption, master, ssh, license, stripe, account and storage key names assign only in the spaced style): a glued colon stays an identifier", () => {
    const value = "Qn4Tr8Wv2Kp7Lm3Xz9";
    for (const glued of [`signing_key:!!str ${value}`, `jwt=abc,api_key:="x",signing_key:!!str ${value}`, `encryption_key:${value}`, `master_key:!!str ${value}`]) {
      expect(redactSecrets(glued).includes(value), `pinned limit, readable: ${glued}`).toBe(true);
      expect(JSON.stringify(redactDeep({ v: glued })).includes(value), `pinned limit at object level: ${glued}`).toBe(true);
    }
    // the spaced forms of the same names, and the glued form of the names that assign with a bare colon, are hidden
    for (const hidden of [`signing_key: !!str ${value}`, `signing_key: ${value}`, `signing_key=${value}`, `signing_key: !tag ${value}`, `api_key:!!str ${value}`, `secret_key:${value}`]) {
      expect(redactSecrets(hidden).includes(value), `hidden: ${hidden}`).toBe(false);
      expect(JSON.stringify(redactDeep({ v: hidden })).includes(value), `hidden at object level: ${hidden}`).toBe(false);
    }
  });
  it("a BRACE or PARENTHESIS group glued to the word behind it is hidden like the square-bracket group (R7, ruled P1: `password={}S` and `(ab3)Xk9...` were readable in every tree before)", () => {
    // The square-bracket form (`password=[]S`, `pass=[]S`) was hidden since R6; `{` and `(` now follow the same rule (tests/unit/review-round7-closed-groups.test.ts has the whole matrix).
    const value = "Zx9Kq2Lm7Pw4Rt8Yv3Bn";
    for (const glued of [`password={}${value}`, `password: {}${value}`, `token:{}${value}`, `auth:{a}${value}`, `password=()${value}`, `password=[]${value}`, `password: []${value}`, `auth:[a]${value}`]) {
      expect(redactSecrets(glued).includes(value), `readable: ${glued}`).toBe(false);
      expect(JSON.stringify(redactDeep({ v: glued })).includes(value), `readable at object level: ${glued}`).toBe(false);
    }
  });
  it("an anchor followed by escaped backslashes keeps the previous reading (the secret behind it is hidden)", () => {
    expect(redactSecrets(`pin: &a\\\\${S}`).includes(S)).toBe(false);
    expect(redactSecrets(`pin: !ab\\\\":"${S}`).includes(S)).toBe(false);
  });
});

describe("R6 (redaction-forms.ts): a block scalar ends at the closing quote of the enclosing JSON string", () => {
  const body = `password: |\n  ${S}`;
  it("depth 1: the text after the closing quote is kept, exactly", () => {
    expect(redactSecrets(JSON.stringify({ a: body }))).toBe('{"a":"password: [REDACTED]"}');
    expect(redactSecrets(JSON.stringify({ a: body, b: "next" }))).toBe('{"a":"password: [REDACTED]","b":"next"}');
  });
  it("depth 2: the escaped closing quote ends the block (the members behind it are kept)", () => {
    const out = redactSecrets(JSON.stringify({ a: JSON.stringify({ b: body, c: "next" }) }));
    expect(out.includes(S)).toBe(false);
    expect(out.endsWith(',\\"c\\":\\"next\\"}"}')).toBe(true);
  });
  it("an apostrophe in the body is data, not the end", () => {
    expect(redactSecrets(JSON.stringify({ a: `password: |\n  it's ${S}` }))).toBe('{"a":"password: [REDACTED]"}');
  });
});

describe("R6 (redaction.ts:818): redacting a string array twice gives the same result as redacting it once", () => {
  it("an element that already holds the marker does not hide the element behind it in the second pass", () => {
    // `!` is outside the characters of a name, so the raw element is not a name; the redacted one (`Authorization:[REDACTED]`) would be.
    for (const value of [["Authorization:abcdef!ghij", "next-element"], ["x", "token=abcdefgh!ijkl", "next-element", "last"], ["Authorization:abcdefghijk", "next-element"], ["password", S, "after"]]) {
      const once = redactDeep(value);
      expect(redactDeep(once)).toEqual(once);
    }
  });
});
