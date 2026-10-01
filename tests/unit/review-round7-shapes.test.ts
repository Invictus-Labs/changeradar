import { describe, expect, it } from "vitest";
import { containsSecret, redactDeep, redactSecrets } from "../../src/domain/redaction.js";

/**
 * Review round 7 (conformance): shapes a review found unlisted that leaked end to end and are plausible in real text: Go and Gson
 * escaped separators, HTML-quoted JSON, pre-signed signatures, YAML plural credential parents, the `:=` operator behind the
 * names that assign with a spaced colon, and the user part of `x-oauth-basic` userinfo. Each is redacted after the fix and each has
 * a control that keeps the neighbouring identifier readable. Fake secrets are assembled at run time.
 */

const V = "Zx9Kq2Lm7Pw4Rt8Yv3Bn";
const U = "\\" + "u00"; // the start of a JSON escape for an ASCII character, spelled without a four-digit escape
const hides = (text: string): boolean => !redactSecrets(text).includes(V);

describe("R7: a JSON or HTML escape of an ASCII separator or quote is decoded like a percent escape", () => {
  it.each([
    ["a Gson escaped equals sign", `password${U}3d${V}`],
    ["a Gson escaped equals sign and apostrophes", `password${U}3d${U}27${V}${U}27`],
    ["a Gson escaped key and value with escaped quotes", `${U}22password${U}22:${U}22${V}${U}22`],
    ["HTML-quoted JSON", `{&quot;password&quot;:&quot;${V}&quot;}`],
    ["HTML-quoted JSON with numeric entities", `{&#34;password&#34;:&#34;${V}&#34;}`],
    ["an HTML apostrophe entity", `password=&#39;${V}&#39;`],
    ["an HTML entity for the equals sign", `password&#61;${V}`],
    ["a hexadecimal HTML entity for the equals sign", `password&#x3d;${V}`],
    ["an HTML-escaped ampersand between pairs", `a=1&amp;token=${V}`],
    ["a JSON escape of a letter of the key", `{"${U}70assword": "${V}"}`],
    ["a key glued to a line break written as text, behind a block scalar, with the := operator", `none true\\naccess_key otp => >-\n  ${V}%20api-key:|\\n  x\\ndsn:=${V}Q`],
  ])("%s", (_label, text) => {
    expect(hides(text), redactSecrets(text)).toBe(true);
  });

  it.each([
    ["an escaped quote in ordinary text", `He said &quot;hello&quot; and left`],
    ["an escaped ampersand in a link", `https://docs.example.test/a?x=1&amp;y=2`],
    ["a Gson escaped angle bracket", `if a ${U}3c b then ${U}3e c`],
  ])("control: %s is unchanged", (_label, text) => {
    expect(redactSecrets(text)).toBe(text);
  });
});

describe("R7: a pre-signed URL signature is hidden", () => {
  it.each([
    ["a Google storage signature", `https://storage.example.test/o?X-Goog-Signature=${V}`],
    ["a CloudFront policy, signature and key pair id", `https://d.example.test/x?Policy=abcdefgh&Signature=${V}&Key-Pair-Id=APKAEXAMPLE`],
    ["a lower-case signature parameter", `https://h.example.test/o?signature=${V}`],
    ["an S3 query-string signature", `https://h.example.test/o?AWSAccessKeyId=AKIAEXAMPLE&Signature=${V}`],
  ])("%s", (_label, text) => {
    expect(hides(text), redactSecrets(text)).toBe(true);
  });
  it("control: the word signature outside a query string is prose", () => {
    const text = "the signature is checked by the receiver, see signature.md";
    expect(redactSecrets(text)).toBe(text);
  });
});

describe("R7: a YAML plural credential parent hides the list under it", () => {
  it.each([`passwords:\n  - ${V}`, `tokens:\n  - ${V}`, `secrets:\n  - ${V}`, `credentials:\n  - ${V}`])("%j", (text) => {
    expect(hides(text), redactSecrets(text)).toBe(true);
  });
  it("control: a plural word that is a prose noun stays readable", () => {
    const text = "tokens are issued by the login service";
    expect(redactSecrets(text)).toBe(text);
  });
});

describe("R7: the := operator assigns behind the names that assign with a spaced colon", () => {
  const names = ["dsn", "sid", "jwt", "bearer", "pin", "otp", "session_id", "webhook_url", "pw", "pswd", "connection_string", "database_url"];
  for (const name of names) {
    it(`${name} := and ${name}:=`, () => {
      expect(hides(`${name} := ${V}`), `${name} := `).toBe(true);
      expect(hides(`${name}:=${V}`), `${name}:=`).toBe(true);
    });
  }
  it("control: a Go short declaration with a short value is unchanged", () => {
    expect(redactSecrets("pin := 42")).toBe("pin := 42");
  });
});

describe("R7 (redaction.ts:442): a word that starts with # after a YAML node property is the value, not a comment", () => {
  it.each([`password: &a #${V}`, `password: !!str #${V}`, `token:  &anchor  #${V}`, `secret: !!str &a #${V}`])("%s", (text) => {
    expect(hides(text), redactSecrets(text)).toBe(true);
  });
  it("control: a comment of several words after a property stays readable, and the value on the next line is hidden", () => {
    expect(redactSecrets("password: &a # rotate monthly")).toBe("password: &a # rotate monthly");
    expect(hides(`password: &a # rotate monthly\n  ${V}`)).toBe(true);
    expect(redactSecrets(`password: &a # rotate monthly\n  ${V}`)).toContain("# rotate monthly");
  });
});

describe("R7: a # word in a gap is hidden whatever key was read first (the gap of an earlier key may lie behind it)", () => {
  it.each([`sid[bearer: #${V}]:'`, `sid[bearer: #${V}]`, `pin[token: #${V}]: x`])("%s", (text) => {
    expect(hides(text), redactSecrets(text)).toBe(true);
  });
  it("in a text nested in JSON strings 0 to 3 deep, and as a value or a key of an object", () => {
    let text = `sid[bearer: #${V}]:'`;
    for (let depth = 0; depth <= 3; depth += 1) {
      expect(hides(text), `depth ${depth}: ${redactSecrets(text)}`).toBe(true);
      expect(JSON.stringify(redactDeep({ note: text, list: [text], nested: { [`k ${text}`]: 1 } })).includes(V), `object form, depth ${depth}`).toBe(false);
      text = JSON.stringify(text).slice(1, -1);
    }
  });
  it("a gap read ahead of a key that comes first in the text: several keys, the later gap first", () => {
    for (const text of [`sid[x][bearer: #${V}]:'y' pw[token: #${V}]:'z'`, `pin[dsn: #${V}]: pin[otp: #${V}]: q`]) {
      expect(hides(text), redactSecrets(text)).toBe(true);
    }
  });
});

describe("R7 (redaction.ts:450, test review P1): a credential assignment in a comment glued to the key is hidden when a block scalar header follows on a later line", () => {
  // The comment `#apikey="S"` is read as a value of `otp:` and the scan then jumped from the key to the block, past the key inside the comment.
  const shapes: [string, string][] = [
    ["otp with a glued comment, then a pipe block", `otp: #apikey="${V}"\n  |\n    K12345`],
    ["pin with a glued comment, then a folded block", `pin: #TOKEN= ${V}\n>\n 9`],
    ["dsn with a glued comment, then a folded block with a strip indicator", `dsn: #pass="${V}"\n  >-\n    block text`],
    ["a block header with a comment, and the credential inside it (literal backslash-n, unclosed quote)", `key:|# secret='${V}\\n 9`],
    ["the same behind a property", `otp: &a #apikey="${V}"\n  |\n    K12345`],
    ["control: the comment followed by a plain line", `otp: #apikey="${V}"\n  plain: line`],
    ["control: the comment followed by a list item", `otp: #apikey="${V}"\n  - item`],
    ["control: the comment followed by a nested key", `otp: #apikey="${V}"\n  nested:\n    k: v`],
    ["control: a spaced comment", `otp: # apikey="${V}"\n  |\n    K12345`],
    ["control: no space before the value", `sid: #secret=${V}\n  |\n    K12345`],
  ];
  it.each(shapes)("%s", (_label, text) => {
    expect(hides(text), redactSecrets(text)).toBe(true);
  });
  it("in a text nested in JSON strings 0 to 3 deep, and as a value or a key of an object", () => {
    for (const [label, base] of shapes.slice(0, 3)) {
      let text = base;
      for (let depth = 0; depth <= 3; depth += 1) {
        expect(hides(text), `${label}, depth ${depth}: ${redactSecrets(text)}`).toBe(true);
        expect(JSON.stringify(redactDeep({ note: text, list: [text] })).includes(V), `${label}, object form, depth ${depth}`).toBe(false);
        text = JSON.stringify(text).slice(1, -1);
      }
    }
  });
});

describe("R7: two flags whose first quote is not closed hide both values", () => {
  const W = "Qa4Wd8Ef2Gh6Jk1Lm5Nb";
  it.each([
    [`env\\n--api-key '${V} | --client-secret '${W}"`],
    [`run --api-key '${V} | --client-secret '${W}`],
    [`x -p='${V} and -p='${W}`],
    [`ENV DB_SECRET '${V} ENV API_TOKEN '${W}`],
  ])("%s", (text) => {
    const out = redactSecrets(text);
    expect(out.includes(V), out).toBe(false);
    expect(out.includes(W), out).toBe(false);
  });
});

describe("R7: the user part of x-oauth-basic userinfo is the credential", () => {
  const AT = String.fromCharCode(64); // assembled at run time: no URL with a password sits in the file
  it.each([`http://${V}:x-oauth-basic${AT}host.example.test/repo`, `https://${V}:X-OAuth-Basic${AT}host.example.test/repo.git`])("%s", (text) => {
    expect(hides(text), redactSecrets(text)).toBe(true);
    expect(containsSecret(text)).toBe(true);
  });
  it("control: an ordinary user name with a password keeps the user readable", () => {
    expect(redactSecrets(`https://deploy:${V}${AT}host.example.test/x`)).toBe(`https://deploy:[REDACTED]${AT}host.example.test/x`);
  });
});
