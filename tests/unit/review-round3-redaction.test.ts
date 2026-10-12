import { describe, expect, it } from "vitest";
import { containsSecret, detectSecretKinds, redactDeep, redactIdentifier, redactSecrets } from "../../src/domain/redaction.js";

/**
 * Review round 3 regression tests for the redactor: a quoted credential KEY nested in JSON two or more layers deep,
 * a value longer than the quoted-value cap, assignment and URL shapes that fell through, key names in redactDeep,
 * short prefixes inside ordinary words, and coverage sweeps. Literals that could look like credentials are assembled
 * from fragments at run time; none is real.
 */
const join = (...parts: string[]): string => parts.join("");
const VALUE = "Zx9Kq2Lm7Pw4Rt8Yv3Bn6Cd1Fg5Hj0";
const layer = (text: string, times: number): string => {
  let out = text;
  for (let i = 0; i < times; i += 1) out = JSON.stringify(out);
  return out;
};

describe("R3 P1 (redaction.ts:290): a quoted credential KEY at JSON depth 2 to 5 is recognised", () => {
  const keys = [join("pass", "word"), "token", join("api", "_key"), join("Author", "ization"), join("Coo", "kie"), join("client", "_secret")];
  for (const key of keys) {
    for (let depth = 1; depth <= 5; depth += 1) {
      it(`${key} at depth ${depth}: the value never survives, the validator refuses it, the output is a fixed point`, () => {
        const text = layer(JSON.stringify({ [key]: VALUE }), depth - 1);
        const out = redactSecrets(text);
        expect(out, text).not.toContain(VALUE);
        expect(detectSecretKinds(text), text).not.toEqual([]);
        expect(redactSecrets(out)).toBe(out);
      });
    }
  }

  it("a manifest-shaped owner (JSON of JSON around an object that holds a credential) is refused by the validator", () => {
    const owner = layer(JSON.stringify({ [join("pass", "word")]: VALUE }), 1);
    expect(containsSecret(owner)).toBe(true);
    expect(redactSecrets(owner)).not.toContain(VALUE);
  });

  it("seeded fuzz: nested key and value shapes, 1500 rounds, no leak and a fixed point every time", () => {
    let state = 20260929;
    const rnd = (n: number): number => {
      state ^= state << 13;
      state >>>= 0;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      return state % n;
    };
    const alnum = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    for (let round = 0; round < 1500; round += 1) {
      const secret = Array.from({ length: 14 + rnd(20) }, () => alnum[rnd(alnum.length)]).join("") + "7Q";
      const key = keys[rnd(keys.length)] as string;
      const shapes = [{ [key]: secret }, { note: "x", [key]: `ab"${secret}` }, { list: [{ [key]: secret }] }, { [key]: secret, tail: "y" }];
      const text = layer(JSON.stringify(shapes[rnd(shapes.length)]), rnd(5));
      const out = redactSecrets(text);
      expect(out, `round ${round}: ${text}`).not.toContain(secret);
      expect(redactSecrets(out), `round ${round}: not a fixed point`).toBe(out);
    }
  });
});

describe("R3 P2 (redaction.ts:381): a quoted value with no closing quote within the cap is redacted to the end", () => {
  it("70,000 characters then a tail: the tail does not survive and the output is a fixed point", () => {
    const text = `${join("pass", "word")}="${"A".repeat(70_000)}TAILSECRET more text on the same line`;
    const out = redactSecrets(text);
    expect(out).not.toContain("TAILSECRET");
    expect(redactSecrets(out)).toBe(out);
  });
  it("a value closed inside the cap keeps the text after it", () => {
    const out = redactSecrets(`${join("pass", "word")}="${"A".repeat(50_000)}" and then ordinary words`);
    expect(out).toContain("and then ordinary words");
  });
});

describe("R3 P2 (redaction.ts:298): assignment and URL shapes that used to fall through", () => {
  const p = join("pass", "word");
  const forms: [string, string][] = [
    ["bracket, double quotes", `config["${p}"]="${VALUE}"`],
    ["bracket, single quotes", `config['${p}']='${VALUE}'`],
    ["bracket, unquoted", `env[${p.toUpperCase()}]=${VALUE}`],
    ["name and value pair", `{"name":"${p}","value":"${VALUE}"}`],
    ["name and value pair, key form", `{"key":"DB_${p.toUpperCase()}","value":"${VALUE}"}`],
    ["cookie name and value pair", `{"name":"${join("Coo", "kie")}","value":"sid=${VALUE}"}`],
    ["a wide gap after the colon", `${p}:${" ".repeat(40)}${VALUE}`],
    ["secret_key bare colon", `${join("SECRET", "_KEY")}: ${VALUE}`],
    ["secret_key lower case", `${join("secret", "_key")}: ${VALUE}`],
    ["passphrase", `${join("pass", "phrase")}: ${VALUE}`],
    ["credentials", `credentials: ${VALUE}`],
    ["pwd with quotes", `pwd: "${VALUE}"`],
    ["long userinfo", `${join("https", "://")}user:${"a1".repeat(300)}${VALUE}@host.example/p`],
    ["escaped slashes in a URL", `${join("https", ":\\/\\/")}user:${VALUE}@host.example`],
    ["lower case azure key", `${join("account", "key")}=${VALUE}${VALUE}==`],
    ["a NUL inside a token", join("gh", "\u0000", "p_", VALUE, "abcd")],
    ["a BEL inside a token", join("gh", "p", "\u0007", "_", VALUE, "abcd")],
  ];
  for (const [name, text] of forms) {
    it(`${name}: the value never survives`, () => {
      const out = redactSecrets(text);
      expect(out, text).not.toContain(VALUE);
      expect(redactSecrets(out)).toBe(out);
    });
  }
});

describe("R3 P2 (redaction.ts:102): redactDeep recognises credential words inside property names", () => {
  const names = ["db_password", "DB_PASSWORD", "dbPassword", "userPassword", "passwordHash", "secretKey", "apiSecret", "webhookSecret", "signing_key", "bearerToken", "githubToken", "GITHUB_TOKEN", "x-auth-token", "session_token", "jwt", "otp", "passphrase", "dsn", "connection_string", "clientSecret", "privateKey", "accessKey", "refreshToken"];
  for (const name of names) {
    it(`${name}: the value is replaced`, () => {
      expect(redactDeep({ [name]: VALUE })).toEqual({ [name]: "[REDACTED]" });
    });
  }
  it("identifier fields and ordinary names are not swept up", () => {
    const view = { credential_alias: "cred.warehouse", check_key: "chk.a", node_id: "svc.token:refresh-service", key: "k.1", status: "ok", tokens_used: 3, monkey: "banana", keyboard: "us", max_tokens: 100, tokenizer: true };
    expect(redactDeep(view)).toEqual(view);
  });
});

describe("R3 P2 (redaction.ts:78): short prefixes inside ordinary words are not credentials", () => {
  const benign = [
    "task-processing-worker-service",
    "risk-assessment-engine-v2",
    "disk-usage-monitor-service-eu",
    "desk-booking-frontend-production",
    "flask-session-store-service-a",
    "mask-pii-transform-job-nightly",
    "whisk-recipe-catalog-api-v2-public",
    "asterisk-pbx-gateway-service-primary",
    "disk-usage-team-emea-infra",
    "brisk-notifier-service-v3",
  ];
  for (const id of benign) {
    it(`${id}: the manifest validator accepts it and the text is unchanged`, () => {
      expect(detectSecretKinds(id)).toEqual([]);
      expect(redactSecrets(id)).toBe(id);
    });
  }
  const sk = join("s", "k-", "aB3dE6gH9jK2mN5pQ8sT1vX4yZ7bC0eF3hJ6kL9mN2pQ5s");
  const hf = join("h", "f_", "aB3dE6gH9jK2mN5pQ8sT1vX4yZ7bC0eF3h");
  for (const [name, token] of [["sk-", sk], ["hf_", hf]] as const) {
    for (const prefix of ["", "0", "_", "-", ".", "%20", "%0A", "\\n", "\\t", " ", '"', "="]) {
      it(`${name} token is still found after ${JSON.stringify(prefix)}`, () => {
        expect(redactSecrets(`${prefix}${token}`)).not.toContain(token.slice(4));
        expect(detectSecretKinds(`${prefix}${token}`)).not.toEqual([]);
      });
    }
  }
});

describe("R3 P2 (tests): identifier keys, every name, and the whole Default_Ignorable set", () => {
  const idKeys = ["id", "key", "check_key", "check_id", "node_id", "source_id", "target_id", "origin_id", "consumer_id", "finding_key", "snapshot_id", "run_id", "workspace_id", "credential_alias", "path", "change_ids", "node_ids", "check_keys", "from", "to", "origin_node_ids", "changed_node_ids"];
  const accepted = "svc.token:refresh-service";
  const secretId = join("gh", "p_", "aB3dE6gH9jK2mN5pQ8sT1vX4yZ7bC0eF3hJ6");
  for (const name of idKeys) {
    it(`${name}: an accepted id survives (string and array forms), a secret-shaped one is redacted`, () => {
      expect(redactDeep({ [name]: accepted })).toEqual({ [name]: accepted });
      expect(redactDeep({ [name]: [accepted, accepted] })).toEqual({ [name]: [accepted, accepted] });
      const out = JSON.stringify(redactDeep({ [name]: secretId, other: [secretId] }));
      expect(out).not.toContain("aB3dE6gH9jK2mN5pQ8sT1vX4yZ7bC0eF3hJ6");
    });
  }

  it("every Default_Ignorable_Code_Point inside a token is folded away (one code point at a time, and runs of four)", () => {
    const token = join("gh", "p_");
    const rest = "aB3dE6gH9jK2mN5pQ8sT1vX4yZ7bC0eF3hJ6";
    const missed: string[] = [];
    let checked = 0;
    for (let cp = 0; cp <= 0x10ffff; cp += 1) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const ch = String.fromCodePoint(cp);
      if (!/\p{Default_Ignorable_Code_Point}/u.test(ch)) continue;
      checked += 1;
      for (const gap of [ch, ch.repeat(4)]) {
        const text = `x ${token}${rest.slice(0, 10)}${gap}${rest.slice(10)} y`;
        if (redactSecrets(text).includes(rest.slice(10))) missed.push(`U+${cp.toString(16)}`);
      }
    }
    expect(checked).toBeGreaterThan(300);
    expect(missed.slice(0, 10)).toEqual([]);
  });

  it("ZWNJ, ZWJ, LRM, RLM and the invisible operators (U+2061 to U+206F) named in the review", () => {
    const rest = "aB3dE6gH9jK2mN5pQ8sT1vX4yZ7bC0eF3hJ6";
    for (const gap of ["‌", "‍", "‎", "‏", "⁡", "⁢", "⁣", "⁤", "⁪", "⁯"]) {
      expect(redactSecrets(`${join("gh", "p_")}${rest.slice(0, 8)}${gap}${rest.slice(8)}`), JSON.stringify(gap)).not.toContain(rest.slice(8));
    }
  });
});

describe("R3: redactIdentifier keeps every accepted id and is a fixed point", () => {
  it("the benign ids of round 2 and 3 are unchanged at identifier strength", () => {
    for (const id of ["risk-assessment-engine-v2", "auth-service:v1.2.3", "svc.token:refresh-service", "contract.token:abcdef"]) expect(redactIdentifier(id)).toBe(id);
  });
});
