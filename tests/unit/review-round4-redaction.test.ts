import { describe, expect, it } from "vitest";
import { containsSecret, detectSecretKinds, redactDeep, redactIdentifiers, redactSecrets } from "../../src/domain/redaction.js";

/**
 * Review round 4 (security): name/value pairs and YAML next-line values inside JSON text nested any number of layers,
 * every shape of a credential name/value pair (text and objects), percent-encoded separators, whole-word and whole-key
 * credential names, short mixed shapes and the redactor's fixed point, format characters, control characters.
 * Fake secrets are assembled at run time so no source line looks like a real token.
 */

const V = "Zx9Kq2Lm7Pw4Rt8Yv3Bn6Cd1Fg5Hj0";
const GH = ["gh", "p_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"].join("");
const AWS = ["AK", "IA", "IOSFODNN7EXAMPLE"].join("");
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

describe("R4 P1 (redaction.ts): a name/value pair is redacted at every JSON depth", () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8])("{name: DB_PASSWORD, value} inside JSON text %i layer(s) deep", (layers) => {
    const text = `env ${stringifyLayers(layers, { env: [{ name: "DB_PASSWORD", value: V }] })}`;
    expect(redactSecrets(text), `layers ${layers}`).not.toContain(V);
    expect(containsSecret(text), `layers ${layers}`).toBe(true);
    expect(JSON.stringify(redactDeep({ owner: text }))).not.toContain(V);
  });
});

describe("R4 P1 (redaction.ts): a YAML value on the line after `key:` is redacted at every JSON depth, with and without a list dash", () => {
  const yaml = [`db:\n  password:\n    ${V}\n`, `db:\n  password:\n    - ${V}\n`, `password:\n- ${V}\n`, `token:\n  ${V}`];
  it.each([1, 2, 3, 4, 5, 6, 7, 8].flatMap((layers) => yaml.map((y, i) => [layers, i, y] as const)))("layers %i, form %i", (layers, _i, y) => {
    const text = `note ${nest(layers, y)}`;
    expect(redactSecrets(text), `layers ${layers}`).not.toContain(V);
    expect(containsSecret(text), `layers ${layers}`).toBe(true);
  });

  it("a YAML `- name:` / `value:` pair IS recognised since review round 5 (it was a documented limit in round 4; see review-round5-redaction.test.ts)", () => {
    expect(redactSecrets(`- name: DB_PASSWORD\n  value: ${V}`)).not.toContain(V);
  });
});

describe("R4 P1 (docs/MANIFEST.md:54): every shape of a credential name/value pair, in text and in objects, at every depth", () => {
  const shapes: [string, unknown][] = [
    ["adjacent", { name: "DB_PASSWORD", value: V }],
    ["value before name", { value: V, name: "DB_PASSWORD" }],
    ["a key in between (SSM)", { Name: "DB_PASSWORD", Type: "SecureString", Value: V }],
    ["path-shaped name", { Name: "/prod/db/password", Type: "SecureString", Value: V }],
    ["cookie pair", { name: "session", value: V }],
    ["cookie pair, value first", { value: V, name: "sessionid", path: "/" }],
    ["ECS valueFrom next to value", { name: "password", valueFrom: "arn:aws:ssm:eu:0:parameter/x", value: V }],
    ["Key/Value capitalised", { Key: "api_key", Value: V }],
    ["secret name variants", { name: "x-auth-token", value: V }],
    ["tuple list", [["password", V]]],
    ["argv array", ["run", "--password", V]],
    ["argv array, token flag", ["--token", V, "--verbose"]],
    ["list of pairs", { env: [{ name: "HOME", value: "/home/x" }, { name: "DB_PASSWORD", value: V }] }],
  ];
  it.each(shapes)("text at depth 0..6: %s", (_label, value) => {
    for (let layers = 1; layers <= 7; layers += 1) {
      const text = `cfg ${stringifyLayers(layers, value)}`;
      expect(redactSecrets(text), `${_label} layers ${layers}`).not.toContain(V);
    }
  });
  it.each(shapes)("objects: %s", (_label, value) => {
    expect(JSON.stringify(redactDeep({ result: value })), _label).not.toContain(V);
    expect(JSON.stringify(redactDeep({ result: { deeper: { deepest: [value] } } })), _label).not.toContain(V);
  });

  it("controls: names that are not credentials keep their values, and a `valueFrom` reference is not a secret", () => {
    expect(JSON.stringify(redactDeep({ name: "HOME", value: "/srv/app-data" }))).toContain("/srv/app-data");
    expect(JSON.stringify(redactDeep({ name: "author", value: "somebody-long-name" }))).toContain("somebody-long-name");
    expect(JSON.stringify(redactDeep({ name: "bypass", value: "route-around-it" }))).toContain("route-around-it");
    expect(redactSecrets('{"name":"HOME","value":"/srv/app-data"}')).toBe('{"name":"HOME","value":"/srv/app-data"}');
    expect(JSON.stringify(redactDeep({ name: "password", valueFrom: "arn:aws:ssm:eu:0:parameter/x" }))).toContain("arn:aws:ssm");
  });
});

describe("R4 P1 (redaction.ts): generative sweep, secret shape x template x JSON layers 0..8 x percent-encoding layers", () => {
  const secrets: [string, string][] = [
    ["random password", V],
    ["github token", GH],
    ["aws access key", AWS],
  ];
  const templates: [string, (s: string) => string][] = [
    ["assignment", (s) => `password=${s}`],
    ["colon", (s) => `token: ${s}`],
    ["json key", (s) => JSON.stringify({ password: s })],
    ["name/value", (s) => JSON.stringify({ env: [{ name: "DB_PASSWORD", value: s }] })],
    ["value/name", (s) => JSON.stringify({ value: s, name: "api_key" })],
    ["yaml next line", (s) => `db:\n  password:\n    ${s}`],
    ["header", (s) => `Authorization: Bearer ${s}`],
    ["url userinfo", (s) => `https://svc:${s}@host.test/x`],
    ["arrow", (s) => `password => ${s}`],
    ["argv", (s) => JSON.stringify(["run", "--password", s])],
  ];
  it("no secret survives redactDeep, the export text redactor, in any combination", () => {
    const leaks: string[] = [];
    for (const [secretLabel, secret] of secrets) {
      for (const [templateLabel, template] of templates) {
        for (let layers = 0; layers <= 8; layers += 1) {
          for (const pct of [0, 1]) {
            let text = nest(layers, template(secret));
            if (pct === 1) text = text.replace(/[=:"@\s]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
            const out = JSON.stringify(redactDeep({ owner: text }));
            if (out.includes(secret)) leaks.push(`${secretLabel} / ${templateLabel} / layers ${layers} / percent ${pct}`);
          }
        }
      }
    }
    expect(leaks).toEqual([]);
  });
});

describe("R4 P2 (redaction.ts:314): percent-encoded separators do not hide an assignment, a header or userinfo", () => {
  it.each([
    `password%3D${V}`,
    `password%3A%20${V}`,
    `%22password%22%3A%22${V}%22`,
    `Authorization%3A%20Bearer%20${V}`,
    `next=https%3A%2F%2Fuser%3A${V}%40host.test%2Fx`,
    `token%3D${V}%26other%3D1`,
    `pass%20word`.replace("pass%20word", `--password%3D${V}`),
    `secret%3A%0A%20%20${V}`,
  ])("%s", (text) => {
    expect(redactSecrets(text)).not.toContain(V);
    expect(containsSecret(text)).toBe(true);
  });

  it("text with no secret in it is returned byte for byte, percent escapes and all", () => {
    const text = "a%20b%3Dc%22d%40e and 100%25 of it, next=%2Fhome%2Fx";
    expect(redactSecrets(text)).toBe(text);
  });

  it("a `%` at the very end of the text, or a truncated or invalid escape, changes nothing and puts nothing odd in the mapping", () => {
    const tails = ["%", "%4", "%41", "%4x", "%x4", "%%", "%%%", "abc%3", "abc%3D", "abc%3d%", "a%20b%2", "%25", "%2541"];
    for (const text of tails) {
      const out = redactSecrets(text);
      expect(out, JSON.stringify(text)).toBe(text);
      expect(out).not.toMatch(/undefined|NaN/);
      expect(containsSecret(text), JSON.stringify(text)).toBe(false);
    }
    // With a secret in front, only the secret is replaced and the tail is kept byte for byte.
    for (const tail of ["%", "%4", "%41", "%4x", "%3", "%3D"]) {
      const out = redactSecrets(`password%3D${V}${tail}`);
      expect(out.startsWith("password%3D"), tail).toBe(true);
      expect(out, tail).not.toContain(V);
      expect(out.endsWith("[REDACTED]") || out.endsWith(tail), tail).toBe(true);
      expect(out).not.toMatch(/undefined|NaN/);
    }
    // Inside a longer token: the escape ends the text right after a token that is found through the decoded copy.
    const inToken = redactSecrets(`Authorization%3A%20Bearer%20${V}%`);
    expect(inToken).not.toContain(V);
    expect(inToken).not.toMatch(/undefined|NaN/);
  });

  it("the mapping back is exact: only the secret's own characters are replaced", () => {
    const out = redactSecrets(`before password%3D${V} after`);
    expect(out.startsWith("before password%3D")).toBe(true);
    expect(out.endsWith(" after")).toBe(true);
  });

  it("KNOWN LIMIT (documented): a value encoded twice (%253D) is not decoded twice", () => {
    expect(redactSecrets(`password%253D${V}`)).toContain(V);
  });
});

describe("R4 P2 (redaction.ts:113): a credential-looking property name hides its value, whatever its spelling", () => {
  const names = ["PGPASSWORD", "dbpass", "userpass", "adminpwd", "DB_PASS", "smtp_pass", "passcode", "signingkey", "encryption_key", "master_key", "ssh_key", "secretkey", "cookies", "database_url", "DATABASE_URL", "redis_url", "webhook_url", "stripeKey", "slack_webhook", "Auth", "auth", "secretKey", "DB_PASSWORD", "x-api-key", "authToken", "connectionString"];
  it.each(names)("redactDeep hides the value under %s", (name) => {
    expect(JSON.stringify(redactDeep({ [name]: V }))).not.toContain(V);
  });
  it("controls: names that only contain the letters keep their value", () => {
    for (const name of ["passport", "author", "compass", "description", "url", "changed_node_ids", "consumers_found", "bypass", "authority", "message"]) {
      expect(JSON.stringify(redactDeep({ [name]: "plain-visible-value" })), name).toContain("plain-visible-value");
    }
  });
});

describe("R4 P2 (redaction.ts:567): redacting twice equals redacting once (a bounded fixed point)", () => {
  it.each([
    `${AWS}sk-${"a1B2c3D4e5F6g7H8i9J0k1L2"}`,
    `${AWS}hf_${"a1B2c3D4e5F6g7H8i9J0k1L2m3"}`,
    "password=bearer\nabcdefghijk=>",
    "secret://api_key&@",
    `credential[${["xo", "xb-"].join("")}1234567890-abcdefgh=client_secret`,
    `${GH}${GH}`,
  ])("%s", (text) => {
    const once = redactSecrets(text);
    expect(redactSecrets(once)).toBe(once);
  });
});

describe("R4 P3 (redaction.ts:142): every format character, and every control character, is folded away when matching", () => {
  it.each([0x13430, 0x1343f, 0xfff9, 0xfffa, 0xfffb, 0x0600, 0x110bd, 0xe0001, 0x2028, 0x2029].map((cp) => [cp.toString(16)]))("U+%s splits nothing", (hex) => {
    const ch = String.fromCodePoint(parseInt(hex as string, 16));
    const skip = ch === " " || ch === " "; // line separators are whitespace, not format characters
    if (skip) return;
    expect(redactSecrets(`gh${ch}p_${GH.slice(4)}`)).not.toContain(GH.slice(4));
    expect(redactSecrets(`pass${ch}word=${V}`)).not.toContain(V);
  });

  it("every control code point that the folding treats as ignorable is swept (C0 except tab/LF/CR, DEL, C1)", () => {
    const codes: number[] = [];
    for (let cp = 0; cp < 0x20; cp += 1) if (cp !== 9 && cp !== 10 && cp !== 13) codes.push(cp);
    codes.push(0x7f);
    for (let cp = 0x80; cp <= 0x9f; cp += 1) codes.push(cp);
    const leaks = codes.filter((cp) => {
      const ch = String.fromCodePoint(cp);
      return redactSecrets(`gh${ch}p_${GH.slice(4)}`).includes(GH.slice(4)) || redactSecrets(`pass${ch}word=${V}`).includes(V);
    });
    expect(leaks).toEqual([]);
  });
});

describe("R4 P3 (redaction.ts:662): an own `__proto__` property is kept, and no prototype is polluted", () => {
  it("redactDeep and redactIdentifiers copy it as data", () => {
    const input = JSON.parse('{"__proto__":{"a":1},"b":2}') as Record<string, unknown>;
    for (const out of [redactDeep(input), redactIdentifiers(input)] as Record<string, unknown>[]) {
      expect(Object.keys(out)).toEqual(["__proto__", "b"]);
      expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
      expect(({} as Record<string, unknown>).a).toBeUndefined();
    }
  });
});

describe("R4: detectSecretKinds agrees with the redactor on the new pair shapes", () => {
  it("reports credential_pair for a pair the validator would refuse", () => {
    expect(detectSecretKinds(JSON.stringify({ name: "DB_PASSWORD", value: V }))).toContain("credential_pair");
  });
});

describe("R4: counters that carry the word token stay visible only as an exact name holding a number or a boolean", () => {
  const listed = ["tokens_used", "tokens_total", "tokens_remaining", "token_count", "token_limit", "max_tokens", "prompt_tokens", "completion_tokens", "total_tokens", "tokenizer", "Max-Tokens"];
  for (const name of listed) {
    it(`${name}: a number or a boolean is kept; a string, an array, an object or null is hidden`, () => {
      expect(redactDeep({ [name]: 42 })).toEqual({ [name]: 42 });
      expect(redactDeep({ [name]: true })).toEqual({ [name]: true });
      expect(redactDeep({ [name]: V })).toEqual({ [name]: "[REDACTED]" });
      expect(redactDeep({ [name]: [V] })).toEqual({ [name]: "[REDACTED]" });
      expect(redactDeep({ [name]: { inner: V } })).toEqual({ [name]: "[REDACTED]" });
      expect(redactDeep({ [name]: null })).toEqual({ [name]: "[REDACTED]" });
    });
  }

  it("pinned as HIDDEN even with a number: tokens, api_tokens, token, access_token, x_tokens_used, tokensUsed (not on the list)", () => {
    for (const name of ["tokens", "api_tokens", "token", "access_token", "x_tokens_used", "tokensUsed"]) {
      expect(redactDeep({ [name]: 5 }), name).toEqual({ [name]: "[REDACTED]" });
    }
  });

  it("a planted secret under those names as a string is hidden at any depth, in the text of JSON too", () => {
    const nested = { a: { b: [{ tokens_used: V, tokenizer: V, tokens: [V] }] } };
    expect(JSON.stringify(redactDeep(nested))).not.toContain(V);
    expect(redactSecrets(JSON.stringify({ tokens_used: V }))).not.toContain(V);
  });
});
