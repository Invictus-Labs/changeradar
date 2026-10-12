import { describe, expect, it } from "vitest";
import { containsSecret, redactDeep, redactSecrets } from "../../src/domain/redaction.js";

/**
 * Review round 5 (security P1, P2 and the ruled must-fix): the shapes a credential can take that the round-4 scanner did not
 * read, at every JSON depth and in objects. Fake secrets are assembled at run time. Two things are pinned besides the
 * fixes: the CONTROLS (ordinary text next to a credential name stays readable) and a KNOWN LIMIT test for every shape that is
 * still not covered, so a change is a decision.
 */

const V = "Zx9Kq2Lm7Pw4Rt8Yv3Bn6Cd1Fg5Hj0";
const HEAD = V.slice(0, 10);
const TAIL = V.slice(10);
const NUM = "482915736204";
const nest = (layers: number, text: string): string => {
  let s = text;
  for (let i = 0; i < layers; i += 1) s = JSON.stringify(s).slice(1, -1);
  return s;
};
const stringifyLayers = (layers: number, value: unknown): string => {
  let s = JSON.stringify(value);
  for (let i = 1; i < layers; i += 1) s = JSON.stringify(s);
  return s;
};
const hides = (text: string, secret: string = V): void => {
  expect(redactSecrets(text), text).not.toContain(secret);
};

describe("R5 P1 (docs/MANIFEST.md:54): `name=... value=...` pairs without JSON quoting are read, in either order, at every depth", () => {
  const shapes: [string, (s: string) => string][] = [
    ["name=DB_PASSWORD value=S", (s) => `name=DB_PASSWORD value=${s}`],
    ["name=password value=S", (s) => `name=password value=${s}`],
    ["key=password value=S", (s) => `key=password value=${s}`],
    ["name: password, value: S", (s) => `name: password, value: ${s}`],
    ["quoted values", (s) => `name="DB_PASSWORD" value="${s}"`],
    ["single quoted", (s) => `name='x-api-key' value='${s}'`],
    ["semicolon", (s) => `name=password; value=${s}`],
    ["value first", (s) => `value=${s} name=password`],
    ["value first, comma", (s) => `value: ${s}, name: DB_PASSWORD`],
    ["another key in between", (s) => `name=password type=SecureString value=${s}`],
    ["YAML list item", (s) => `- name: DB_PASSWORD\n  value: ${s}`],
    ["YAML list item, value first", (s) => `- value: ${s}\n  name: DB_PASSWORD`],
    ["YAML with a key in between", (s) => `- name: /prod/db/password\n  type: SecureString\n  value: ${s}`],
  ];
  for (const [label, make] of shapes) {
    it(`${label}: hidden at JSON depth 0..6, and detected by the validator`, () => {
      for (let layers = 0; layers <= 6; layers += 1) {
        const text = `cfg ${nest(layers, make(V))}`;
        hides(text);
        expect(containsSecret(text), `${label} layers ${layers}`).toBe(true);
      }
    });
  }

  it("controls: a pair whose name is not a credential, and ordinary text, keep their words", () => {
    for (const text of ["name=HOME value=/srv/app-data", "name=title value=hello-world1", "- name: LOG_LEVEL\n  value: verbose9", "the name is password but value is here"]) {
      expect(redactSecrets(text), text).toBe(text);
    }
  });
});

describe("R5 P2 (redaction-pairs.ts): the pair scanner reads values of every type, a gap of any size, and the usual key spellings", () => {
  it("a number, a boolean-free bare word, an array and an object as the value (text at depth 0..6, and objects)", () => {
    const values: [string, unknown, string][] = [
      ["number", NUM, NUM],
      ["array", [V], V],
      ["object", { plain: V }, V],
      ["array of two", ["a-visible-word", V], V],
    ];
    for (const [label, value, secret] of values) {
      const pair = label === "number" ? `{"name":"DB_PASSWORD","value":${NUM}}` : JSON.stringify({ name: "DB_PASSWORD", value });
      for (let layers = 1; layers <= 6; layers += 1) {
        const text = `cfg ${stringifyLayers(layers, JSON.parse(pair))}`;
        hides(text, secret);
      }
      expect(JSON.stringify(redactDeep({ name: "DB_PASSWORD", value: label === "number" ? Number(NUM) : value })), label).not.toContain(secret);
    }
  });

  it("an object between the two halves, and a gap of 200 and of 500 characters", () => {
    for (let layers = 1; layers <= 6; layers += 1) {
      hides(`cfg ${stringifyLayers(layers, { name: "DB_PASSWORD", meta: { a: { b: 1 } }, value: V })}`);
      hides(`cfg ${stringifyLayers(layers, { name: "DB_PASSWORD", note: "n".repeat(200), value: V })}`);
      hides(`cfg ${stringifyLayers(layers, { name: "DB_PASSWORD", note: "n".repeat(500), value: V })}`);
      hides(`cfg ${stringifyLayers(layers, { value: V, note: "n".repeat(300), name: "DB_PASSWORD" })}`);
    }
  });

  const spellings: [string, string, string][] = [
    ["header", "Authorization", "value"],
    ["k", "api_key", "v"],
    ["name", "api_key", "data"],
    ["name", "api_key", "val"],
    ["name", "api_key", "content"],
    ["name", "api_key", "text"],
    ["label", "DB_PASSWORD", "value"],
    ["id", "DB_PASSWORD", "value"],
    ["ParameterKey", "DbPassword", "ParameterValue"],
    ["key", "api_key", "val"],
  ];
  it.each(spellings)("{%s: %s, %s: S} in text (depth 0..6, both orders) and in objects", (nameKey, name, valueKey) => {
    for (let layers = 1; layers <= 6; layers += 1) {
      hides(`cfg ${stringifyLayers(layers, { [nameKey]: name, [valueKey]: V })}`);
      hides(`cfg ${stringifyLayers(layers, { [valueKey]: V, [nameKey]: name })}`);
    }
    expect(JSON.stringify(redactDeep({ [nameKey]: name, [valueKey]: V }))).not.toContain(V);
    expect(JSON.stringify(redactDeep({ [valueKey]: V, [nameKey]: name }))).not.toContain(V);
  });

  it("credential words in the NAME: connection string, DATABASE_URL, csrf, private, pin, and path names in tuples and argv", () => {
    for (const name of ["connection string", "connectionString", "DATABASE_URL", "csrf_token", "private_note", "pin", "/prod/db/password", "webhook_url"]) {
      for (let layers = 1; layers <= 6; layers += 1) hides(`cfg ${stringifyLayers(layers, { name, value: V })}`);
      expect(JSON.stringify(redactDeep({ name, value: V })), name).not.toContain(V);
    }
    for (let layers = 1; layers <= 6; layers += 1) {
      hides(`cfg ${stringifyLayers(layers, [["/prod/db/password", V]])}`);
      hides(`cfg ${stringifyLayers(layers, ["run", "--db-password", V])}`);
    }
    expect(JSON.stringify(redactDeep({ argv: ["/prod/db/password", V] }))).not.toContain(V);
    expect(JSON.stringify(redactDeep({ argv: ["--db-password", V] }))).not.toContain(V);
  });

  it("names with brackets, braces and more than 100 characters: password[0], [db]password, ${DB_PASSWORD}, a 150 character name", () => {
    const long = `${"x".repeat(140)}password`;
    for (const name of ["password[0]", "[db]password", "${DB_PASSWORD}", long]) {
      for (let layers = 1; layers <= 6; layers += 1) {
        hides(`cfg ${stringifyLayers(layers, { name, value: V })}`);
        hides(`cfg ${stringifyLayers(layers, { value: V, name })}`);
      }
    }
  });

  it("controls: ordinary pairs, and a `valueFrom` reference next to a value, are not credentials", () => {
    const text = JSON.stringify({ env: [{ name: "HOME", value: "/srv/app-data" }, { name: "LOG_LEVEL", value: "verbose9x" }], meta: { a: { b: 1 } } });
    expect(redactSecrets(text)).toBe(text);
    expect(JSON.stringify(redactDeep({ name: "title", text: "hello-world-1" }))).toContain("hello-world-1");
  });
});

describe("R5 P2 (ruled must-fix): YAML block scalars, anchors and tags after a credential key", () => {
  const block = (layers: number, text: string): string => `note ${nest(layers, text)}`;
  const forms: [string, string][] = [
    ["literal", `password: |\n  ${V}\n  ${V}second\nnext: visible-setting\n`],
    ["folded strip", `password: >-\n  ${V}\nnext: visible-setting\n`],
    ["keep", `password: |+\n  ${V}\n\nnext: visible-setting\n`],
    ["indentation indicator", `password: |2\n  ${V}\nnext: visible-setting\n`],
    ["token folded", `token: >\n  ${V}\nnext: visible-setting\n`],
    ["CRLF", `api_key: |\r\n  ${V}\r\nnext: visible-setting\r\n`],
    ["comment on the header", `password: | # note\n  ${V}\nnext: visible-setting\n`],
    ["nested key", `db:\n  password: |\n    ${V}\n  next: visible-setting\n`],
    ["list item", `- password: |\n    ${V}\n- next: visible-setting\n`],
    ["anchor", `password: &a ${V}\nnext: visible-setting\n`],
    ["anchor, value on the next line", `password: &a\n  ${V}\nnext: visible-setting\n`],
    ["tag", `password: !!str ${V}\nnext: visible-setting\n`],
    ["tag and anchor", `password: !!str &a ${V}\nnext: visible-setting\n`],
    ["comment line after the key", `password:  # rotate monthly\n  ${V}\nnext: visible-setting\n`],
    ["nested list dashes", `password:\n- - ${V}\nnext: visible-setting\n`],
    ["flow sequence", `password: ["${V}"]\nnext: visible-setting\n`],
    ["flow sequence, two items", `password: [visible-word, ${V}]\nnext: visible-setting\n`],
    ["flow mapping", `password: {v: ${V}}\nnext: visible-setting\n`],
  ];
  for (const [label, yaml] of forms) {
    it(`${label}: the secret is gone at JSON depth 0..8 and the next setting stays`, () => {
      for (let layers = 0; layers <= 8; layers += 1) {
        const text = block(layers, yaml);
        const out = redactSecrets(text);
        expect(out, `${label} layers ${layers}`).not.toContain(V);
        expect(out, `${label} layers ${layers}: the sibling key is not swallowed`).toContain("visible-setting");
        expect(containsSecret(text), `${label} layers ${layers}`).toBe(true);
      }
    });
  }

  it("a multi-line block scalar is redacted to the end of its indented block, both lines (the second line too)", () => {
    const out = redactSecrets(`password: |\n  ${V}\n  ${TAIL}-second-line\nnext: keep`);
    expect(out).not.toContain(TAIL);
    expect(out).toContain("next: keep");
  });

  it("controls: a block scalar under an ordinary key, and a folded `>` in prose, are untouched", () => {
    const text = `description: |\n  a plain paragraph with words and 2 numbers\nnext: keep`;
    expect(redactSecrets(text)).toBe(text);
    expect(redactSecrets("a > b and c | d are operators")).toBe("a > b and c | d are operators");
  });
});

describe("R5 P2 (ruled must-fix): assignment operators, flags, environment declarations and typed declarations", () => {
  const each: [string, string][] = [
    ["?=", `PASSWORD ?= ${V}`],
    ["+=", `PASSWORD += ${V}`],
    ["||=", `password ||= ${V}`],
    ["??=", `password ??= ${V}`],
    ["tool -p=S", `tool -p=${V}`],
    ["tool -P=S", `tool -P=${V} --verbose`],
    ["ENV NAME S", `ENV PASSWORD ${V}`],
    ["ARG NAME S", `ARG API_TOKEN ${V}`],
    ["typed assignment", `password: string = "${V}"`],
    ["typed assignment, bare", `secret: string = ${V}`],
    ["typed assignment, json key", `"token": number = "${V}"`],
    ["--db-password S", `--db-password ${V}`],
    ["--api-key S", `run --api-key ${V} --verbose`],
    ["--client-secret quoted", `--client-secret "${V}"`],
    ["--access-token single quoted", `--access-token '${V}'`],
  ];
  for (const [label, text] of each) {
    it(`${label}: hidden at JSON depth 0..6`, () => {
      for (let layers = 0; layers <= 6; layers += 1) {
        const nested = `cmd ${nest(layers, text)}`;
        hides(nested);
        expect(containsSecret(nested), `${label} layers ${layers}`).toBe(true);
      }
    });
  }

  it("a typed declaration leaves no marker next to a visible secret", () => {
    const out = redactSecrets(`password: string = "${V}"`);
    expect(out).not.toContain(V);
    expect(out).not.toMatch(/\[REDACTED\] = "/);
  });

  it("Python string literal prefixes (b'', b\"\", r\"\", u'', f\"\") do not hide the value from the reader, in assignments and dict literals", () => {
    for (const text of [`password = b'${V}'`, `password = b"${V}"`, `token = r"${V}"`, `password = u'${V}'`, `secret = f"${V}"`, `{'password': b'${V}'}`, `{"password": rb'${V}'}`]) {
      for (let layers = 0; layers <= 5; layers += 1) hides(`code ${nest(layers, text)}`);
    }
  });

  it("controls: ports, files, counts and short flags keep their values", () => {
    for (const text of ["--port 8080-alt", "-p 8080", "--token-file /run/secrets/tokens2", "--password-file /run/secrets/p9", "--key-file /etc/keys/k1.pem", "--passenger-count 12345678", "ENV LOG_LEVEL verbose9", "ARG VERSION 1.2.3-beta"]) {
      expect(redactSecrets(text), text).toBe(text);
    }
  });
});

describe("R5 P2 (redaction.ts:102): the text keyword list follows the object key list", () => {
  const assignments = ["session_id", "sessionid", "sid", "connection_string", "DATABASE_URL", "dsn", "webhook_url", "pw", "pswd", "pin", "otp", "signing_key", "encryption_key", "master_key", "ssh_key", "jwt", "bearer"];
  it.each(assignments)("%s=S and %s: S are hidden in text at depth 0..5", (name) => {
    for (let layers = 0; layers <= 5; layers += 1) {
      hides(`cfg ${nest(layers, `${name}=${V}`)}`);
      hides(`cfg ${nest(layers, `${name}: ${V}`)}`);
      hides(`cfg ${nest(layers, JSON.stringify({ [name]: V }))}`);
    }
  });

  it("connectionString and camel case names in text", () => {
    hides(`connectionString: "${V}"`);
    hides(`{"connectionString": "${V}"}`);
  });

  const keys = ["pin", "pw", "pswd", "sid", "totp", "cred", "creds", "pem", "jsessionid", "PHPSESSID", "connect.sid", "account_key", "accountKey", "storage_key", "mongo_uri", "jdbc_url", "smtp_url", "hookUrl", "recovery_code", "activation_code"];
  it.each(keys)("the object key %s hides its value", (key) => {
    expect(redactDeep({ [key]: V }), key).toEqual({ [key]: "[REDACTED]" });
  });

  it("controls: words that merely contain a short name keep their values", () => {
    for (const text of ["inside=abcdefghij", "spinner=abcdefghij", "pinned=abcdefghij", "swordfish=abcdefghij", "topic=abcdefghij1"]) expect(redactSecrets(text), text).toBe(text);
    expect(redactDeep({ pinned: "yes-it-is", spinner: "abcdefghij" })).toEqual({ pinned: "yes-it-is", spinner: "abcdefghij" });
  });

  it("KNOWN LIMIT (documented): the ordinary words key, login, seed, license, ssn and sas are not treated as credential names", () => {
    expect(redactDeep({ key: "k", login: "alice", seed: "s", license: "MIT", ssn: "n", sas: "x" })).toEqual({ key: "k", login: "alice", seed: "s", license: "MIT", ssn: "n", sas: "x" });
  });
});

describe("R5 P2 (redaction.ts:131): a property name is matched after the same fold as text (invisible, combining and fullwidth characters)", () => {
  const ZW = String.fromCharCode(0x200b);
  const COMB = String.fromCharCode(0x301);
  const VS16 = String.fromCharCode(0xfe0f);
  const FULL_T = String.fromCharCode(0xff54);
  const names = [`pass${ZW}word`, `tok${COMB}en`, `${FULL_T}oken`, `secr${ZW}et`, `Authoriz${ZW}ation`, `DB_PASS${ZW}WORD`, `pass${VS16}word`, `pass${String.fromCharCode(0)}word`, `pass${String.fromCharCode(7)}word`, `api${ZW}_key`];
  it.each(names)("the value under a name with a hidden character is hidden: %j", (name) => {
    expect(redactDeep({ [name]: V }), JSON.stringify(name)).toEqual({ [redactSecrets(name)]: "[REDACTED]" });
  });

  it("a pair whose NAME carries a hidden character is still a pair", () => {
    expect(JSON.stringify(redactDeep({ name: `DB_PASS${ZW}WORD`, value: V }))).not.toContain(V);
  });

  it("controls: ordinary names with a hidden character keep their value", () => {
    expect(redactDeep({ [`reg${ZW}ion`]: "eu-west-1x" })).toEqual({ [`reg${ZW}ion`]: "eu-west-1x" });
  });
});

describe("R5 P2/P3 (redaction.ts:565): characters that came from %XX are data, never a terminator, in the decoded copy", () => {
  const cases: [string, string][] = [
    ["%26", `password%3D${HEAD}%26${TAIL}`],
    ["%26, head under six", `password%3Dab%26${TAIL}`],
    ["%2C", `password%3D${HEAD}%2C${TAIL}`],
    ["%3B", `password%3D${HEAD}%3B${TAIL}`],
    ["%7D", `password%3D${HEAD}%7D${TAIL}`],
    ["%20", `password%3D${HEAD}%20${TAIL}`],
    ["%22", `password%3D${HEAD}%22${TAIL}`],
    ["%29", `password%3D${HEAD}%29${TAIL}`],
  ];
  it.each(cases)("%s inside the value: neither the head nor the tail stays visible (JSON depth 0..3)", (_label, text) => {
    for (let layers = 0; layers <= 3; layers += 1) {
      const out = redactSecrets(nest(layers, text));
      expect(out).not.toContain(TAIL);
      expect(out).not.toContain(HEAD);
    }
  });

  it("an unencoded terminator still ends an unquoted value (control): `password=abcdefghij&user=alice` keeps the next parameter", () => {
    expect(redactSecrets(`password=${HEAD}&user=alice`)).toContain("&user=alice");
  });
});

describe("R5 KNOWN LIMITS (documented in docs/MANIFEST.md): each shape below is neither redacted nor detected, so a change is a decision", () => {
  const known: [string, string, string][] = [
    ["a password of five characters or fewer", "password=ab1x9", "ab1x9"],
    ["a plain passphrase with spaces: only the first word is read", `password: correct horse battery staple`, "horse battery staple"],
    ["an unquoted value that contains a quote: the head is under six characters", `password=ab"${TAIL}`, TAIL],
    ["an unquoted value with an apostrophe", `password=it's-a-${TAIL}`, TAIL],
    ["a value with a space and punctuation", `password=p@ss w0rd!${TAIL}`, TAIL],
    ["scheme-less //user:pw@host", `//deploy:${V}@host.example`, V],
    ["XML element text", `<password>${V}</password>`, V],
    ["prose: the password is S", `the password is ${V}`, V],
    ["YAML doubled-quote escape: the tail after the doubled quote", `password: 'ab''${TAIL}'`, TAIL],
    ["short flag -p S", `tool -p ${V}`, V],
    ["short flag glued: -pS", `tool -p${V}`, V],
    ["curl -u user:S", `curl -u deploy:${V} https://host.example/x`, V],
    ["a userinfo password that contains a slash", `https://deploy:ab/${TAIL}@host.example/x`, TAIL],
    ["a value after ->", `password -> ${V}`, V],
    ["the bare key name key", `key=${V}`, V],
  ];
  it.each(known)("%s", (_label, text, visible) => {
    expect(redactSecrets(text), text).toContain(visible);
  });
});
