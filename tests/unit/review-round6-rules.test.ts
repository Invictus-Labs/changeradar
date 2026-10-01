import { describe, expect, it } from "vitest";
import { redactDeep, redactSecrets } from "../../src/domain/redaction.js";

/**
 * Review round 6 (tests P3): one assertion per rule that hand mutations of the redactor showed unpinned (the header alternative for
 * Cookie, the `payload` value key, the typed-declaration type words and length limit, a credential word followed by a colon as a
 * value, two block indicators, the blank gap after a key). Each is checked in text and, where the rule exists there, in object form.
 */

const S = "Zx9qLm3vRt7wKp2N";

describe("R6: each redaction rule has its own assertion", () => {
  it.each([
    ["a Cookie header value that holds an assignment", `Cookie: a=${S}`],
    ["a name/value pair whose value key is `payload` (text)", `{"name":"DB_PASSWORD","payload":"${S}"}`],
    ["a typed declaration with the type SecretString", `password: SecretString = "${S}"`],
    ["a typed declaration with the type SecureString (a type word of eleven characters)", `password: SecureString = "${S}"`],
    ["a credential word and a colon as the value of a short key", `pw: password: "${S}"`],
    ["a block scalar with two indicators (`|-2`)", `password: |-2\n  ${S}`],
    ["a value forty blanks after the key", `password:${" ".repeat(40)}${S}`],
    ["a value after a comment line and blanks", `password:   \n\n   ${S}`],
    ["a block scalar after an equals sign (`auth = >-`)", `auth = >-\n  ${S}\nnext: 1`],
    ["a literal block scalar after an equals sign, glued", `password=|\n  ${S}`],
    ["a block scalar after `+=`", `token += |2\n  ${S}`],
  ])("%s", (_label, text) => {
    const out = redactSecrets(text);
    expect(out.includes(S), `still readable: ${out}`).toBe(false);
    expect(redactSecrets(out), "a fixed point").toBe(out);
  });

  it.each([
    ["a name/value object with the value key `payload`", { name: "DB_PASSWORD", payload: S }],
    ["a name/value object with the value key `content`", { key: "api_token", content: S }],
    ["a Cookie property", { Cookie: `a=${S}` }],
  ])("object form: %s", (_label, value) => {
    expect(JSON.stringify(redactDeep(value)).includes(S)).toBe(false);
  });
});
