import { describe, expect, it } from "vitest";
import { containsSecret, redactDeep, redactIdentifiers, redactSecrets } from "../../src/domain/redaction.js";

/**
 * Cross-check of the redactor against the classes of leak that an independent review found in a sibling redactor of the
 * same family: escaped-quote runs with no fixed cap, keys that glue a credential word to a token or to a long suffix,
 * object-level idempotence, escapes and line breaks used as separators, and assignment operators other than `=` and `:`.
 * Fake secrets are assembled at run time so no source line looks like a real token.
 */

const V = "Zx9Kq2Lm7Pw4Rt8Yv3Bn6Cd1Fg5Hj0";
const GH = ["gh", "p_", "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"].join("");
const nest = (layers: number, value: unknown): string => {
  let s = JSON.stringify(value);
  for (let i = 1; i < layers; i += 1) s = JSON.stringify(s);
  return s;
};

describe("cross-check (a): backslash runs in front of quoted keys and values have no fixed cap", () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])("a quoted key and value %i JSON layers deep (a run of 2^n - 1 backslashes) is redacted and detected", (layers) => {
    const text = `owner ${nest(layers, { password: V })}`;
    expect(redactSecrets(text), `layers ${layers}`).not.toContain(V);
    expect(containsSecret(text), `layers ${layers}`).toBe(true);
  });

  it.each([8, 9, 10])("a credential-shaped token %i layers deep and an unquoted key with a quoted value are redacted", (layers) => {
    expect(redactSecrets(nest(layers, { token: GH }))).not.toContain(GH);
    expect(redactSecrets(nest(layers, { note: `password=${V}` }))).not.toContain(V);
  });

  it("a very long run of backslashes after a key, and a key repeated to fill the text, stay linear", () => {
    // A ratio, not a wall time: an input 8 times as long takes about 8 times as long when the scan is linear (64 times if it is
    // quadratic), whatever the speed of the machine. The best of three runs of each size keeps a busy machine from deciding it.
    const shapes: ((n: number) => string)[] = [
      (n) => `password${"\\".repeat(n)}`,
      (n) => `password: ${"\\".repeat(n)}"x`,
      (n) => "password".repeat(Math.floor(n / 8)),
      (n) => `token_${"a".repeat(n)}`,
    ];
    const best = (make: (n: number) => string, n: number): number => {
      let fastest = Number.POSITIVE_INFINITY;
      for (let i = 0; i < 3; i += 1) {
        const input = make(n);
        const started = process.hrtime.bigint();
        redactSecrets(input);
        fastest = Math.min(fastest, Number(process.hrtime.bigint() - started) / 1e6);
      }
      return fastest;
    };
    for (const make of shapes) {
      const small = Math.max(best(make, 100_000), 2);
      const large = best(make, 800_000);
      expect(large / small, make(8).slice(0, 20)).toBeLessThan(30);
    }
  });
});

describe("cross-check (a2): a credential word inside a long key name still introduces an assignment", () => {
  it.each([
    `aws_secret_access_key_for_the_production_environment_in_eu_west = ${V}`,
    `token${"x".repeat(45)}=${V}`,
    `password_reset_service_account_credentials_for_nightly_export=${V}`,
    `"secret_${"a".repeat(80)}": "${V}"`,
  ])("%s", (text) => {
    expect(redactSecrets(text)).not.toContain(V);
  });

  it("a key that glues a credential word to a full token hides both the token and the value", () => {
    for (const key of [`token${GH}`, `password${GH}`, `pass<${GH}>`]) {
      const once = redactSecrets(`${key}=${V}`);
      expect(once, key).not.toContain(V);
      expect(once, key).not.toContain(GH);
    }
  });
});

describe("cross-check (b): object-level redaction is idempotent, also for keys that glue a credential word to a token", () => {
  const keys = [`token${GH}`, `password${GH}`, `pass<${GH}>`, `Bearer\\nbearer ${GH}`, "tokenghp_short", `x-auth-${GH}`];
  it.each(keys)("redactDeep(redactDeep(x)) equals redactDeep(x) for the key %s", (key) => {
    const x = { [key]: "value-1", nested: { [key]: [V, GH], text: `${key}=${V}` }, plain: key };
    const once = redactDeep(x);
    expect(JSON.stringify(redactDeep(once))).toBe(JSON.stringify(once));
    expect(JSON.stringify(once)).not.toContain(GH);
    // A name that held a full token hides the values under it as well (the name is then a credential name); a name that only
    // resembles one (`tokenghp_short`) or a bearer header dump does not turn every neighbouring value into a secret.
    if (key.includes(GH) && !key.startsWith("Bearer")) expect(JSON.stringify(once)).not.toContain(V);
  });

  it.each(keys)("redactIdentifiers is idempotent for %s and shows the token in neither a value nor a property name", (key) => {
    const x = { [key]: "value-1", nested: { [key]: [V, GH] } };
    const once = redactIdentifiers(x);
    expect(JSON.stringify(redactIdentifiers(once))).toBe(JSON.stringify(once));
    expect(JSON.stringify(once)).not.toContain(GH);
  });
});

describe("cross-check (c): escapes and line breaks as separators, and the YAML next-line form", () => {
  const separators = ["\\n", "\\t", "%0A", "%20", "\\r\\n", "\\\\n"];
  const names = ["pwd", "pass", "auth", "secret", "token", "passwd"];
  it("an escaped separator in front of a short name never hides the value (6 separators x 6 names x 3 forms)", () => {
    for (const sep of separators) {
      for (const name of names) {
        for (const form of [`${name}=${V}`, `${name}: ${V}`, `"${name}":"${V}"`]) {
          expect(redactSecrets(`line${sep}${form}`), `${sep} ${form}`).not.toContain(V);
        }
      }
    }
  });

  it.each([
    `password:\\n  ${V}`,
    `password:\n  ${V}`,
    `password:\r\n    ${V}`,
    `password:\\n- ${V}`,
    `password:\n- ${V}`,
    `password:%0A  ${V}`,
    `{"config":"key: v\\n  password:\\n    ${V}"}`,
    `token:\\n${V}`,
  ])("a value on the line after `key:` is redacted: %s", (text) => {
    expect(redactSecrets(text)).not.toContain(V);
  });

  it("a redacted YAML value stays redacted when redacted again", () => {
    const once = redactSecrets(`password:\n  ${V}`);
    expect(redactSecrets(once)).toBe(once);
  });

  it("controls: a colon at the end of a key that is not a credential, and ordinary next lines, are untouched", () => {
    expect(redactSecrets("description:\n  a plain sentence about nothing")).toBe("description:\n  a plain sentence about nothing");
    expect(redactSecrets("auth-service:\nv1.2.3 is the version")).toBe("auth-service:\nv1.2.3 is the version");
  });
});

describe("cross-check (d): assignment operators other than = and :", () => {
  it.each([
    `password => ${V}`,
    `"password" => "${V}"`,
    `:password => "${V}"`,
    `'password' => '${V}'`,
    `pass => ${V}`,
    `password := ${V}`,
    `--password = ${V}`,
    `--password=${V}`,
  ])("%s", (text) => {
    expect(redactSecrets(text)).not.toContain(V);
  });

  it("KNOWN LIMITS (documented in docs/MANIFEST.md): a value after a SHORT space-separated flag (`-p V`), `->`, and the bare key name `key` are not detected (a long flag with a secret last word is: review round 5)", () => {
    expect(redactSecrets(`--password ${V}`)).not.toContain(V);
    expect(redactSecrets(`-p ${V}`)).toContain(V);
    expect(redactSecrets(`password -> ${V}`)).toContain(V);
    expect(redactSecrets(`key=${V}`)).toContain(V);
  });

  it("KNOWN LIMIT (documented): a bare `:` after a credential word with anything glued to it is an identifier, not an assignment", () => {
    // `service.token:refresh` and `auth-service:v1.2.3` must stay readable; a quoted key or `=` still assigns.
    expect(redactSecrets(`token${GH}: ${V}`)).toContain(V);
    expect(redactSecrets(`password_reset_service_account_credentials_for_nightly_export: ${V}`)).toContain(V);
    expect(redactSecrets(`"password_reset_service_account_credentials_for_nightly_export": "${V}"`)).not.toContain(V);
  });
});
