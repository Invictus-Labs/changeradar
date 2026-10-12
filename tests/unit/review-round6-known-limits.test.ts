import { describe, expect, it } from "vitest";
import { redactSecrets } from "../../src/domain/redaction.js";

/**
 * Review round 6 (conformance): docs/MANIFEST.md lists what is NOT covered, and every item on that list is pinned here or in an
 * earlier round's KNOWN LIMIT test, so a change in either direction is a decision. The shapes a review probed and that the
 * list did not name are pinned as well. Three of them were cheap to fix and are now redacted (controls below). Fake secrets are
 * assembled at run time.
 */

const V = "Zx9Kq2Lm7Pw4Rt8Yv3Bn6Cd1Fg5Hj0";
const join = (...parts: string[]): string => parts.join("");

describe("R6 KNOWN LIMITS (documented in docs/MANIFEST.md): each shape below is neither redacted nor detected, so a change is a decision", () => {
  const known: [string, string][] = [
    ["a Shopify access token", `${join("shp", "at_")}${V}`],
    ["a DigitalOcean token", `${join("dop_", "v1_")}${V}`],
    ["a PyPI upload token", `${join("py", "pi-")}${V}`],
    ["a Telegram bot token", `bot123456789:${V}`],
    ["a Mailgun key", `${join("ke", "y-")}${V}`],
    ["docker login -p S", `docker login -p ${V} registry.example.test`],
    ["a userinfo password that contains a question mark", `https://deploy:ab?${V}@host.example/x`],
    ["a userinfo password that contains a hash", `https://deploy:ab#${V}@host.example/x`],
    ["the bare word password followed by a blank, no operator", `password ${V}`],
    ["the bare word password followed by a tab", `password\t${V}`],
    ["a netrc entry", `machine host.example login deploy password ${V}`],
    ["R assignment with <-", `password <- "${V}"`],
    ["C# verbatim string", `password = @"${V}"`],
    ["a Cyrillic look-alike letter in the key", `p${String.fromCharCode(0x430)}ssword=${V}`],
    ["a JSON key with a space inside the word", `{"pass word":"${V}"}`],
    ["a credential key whose value is a nested `value:` key on the next line", `DB_PASSWORD:\n  value: ${V}\n`],
    ["curl --user user:S", `curl --user deploy:${V} https://host.example/x`],
    ["curl --proxy-user user:S", `curl --proxy-user deploy:${V} https://host.example/x`],
    ["sshpass -p S", `sshpass -p ${V} ssh host.example`],
    ["the name 'connection string' in a spaced text pair", `name: connection string, value: ${V}`],
    ["the name 'connection string' in a spaced quoted text pair", `name='connection string' value=${V}`],
  ];
  it.each(known)("%s", (_label, text) => {
    expect(redactSecrets(text), text).toContain(V);
  });
});

describe("R6 KNOWN LIMIT (documented in docs/MANIFEST.md): a credential inside multi-layer percent-encoded, CRLF-joined text where an earlier bracket, pipe or block marker precedes it", () => {
  // Two garbled strings that only the previous tree's habit of swallowing the next key hid (accepted as a residual risk, see the
  // ledger): each is pinned to the CURRENT output, so a change in either direction is a decision.
  const A = "Zx9Kq2Lm7Pw4Rt8Yv3Bn6";
  const B = "Qa4Wd8Ef2Gh6Jk1Lm5";
  const C = "Rt7Yu3Io9Pa5Sd2Fg8";
  it("a braced value behind a glued colon after a Cookie line", () => {
    const text = `x%20|%20passwd%20%3A[${A}]%0D%0ACookie%3A%20sid%3D${B}%0Abearer%3A{${C}}`;
    expect(redactSecrets(text)).toBe(`x%20|%20passwd%20%3A[REDACTED]{${C}}`);
  });
  it("a block marker and a token-shaped word in a percent-encoded soup", () => {
    const text = `password:%20jwt %3D |%0A%20${A}%0AeyJ${B}Q13SqyJo\\\\nnote%0AProxy-Authorization%3A Bearer%20${C}`;
    expect(redactSecrets(text)).toBe(`password:[REDACTED] %3D |%0A[REDACTED]%0AeyJ${B}Q13SqyJo\\\\nnote%0AProxy-Authorization%3A [REDACTED]`);
  });
});

describe("R6 KNOWN LIMIT (same class, found against the tree before the previous round): block markers and glued line breaks in one line", () => {
  const A = "Zx9Kq2Lm7Pw4Rt8Yv3Bn6";
  const B = "Qa4Wd8Ef2Gh6Jk1Lm5";
  const C = "Rt7Yu3Io9Pa5Sd2Fg8";
  it("a token-shaped word after a pipe block marker in a percent-encoded option line", () => {
    const text = `config%2C--password%20%27${A}%2Cx\\\\\\ntoken%20Password+%3D|\\n%20%20${B}%0AeyJ${C}Q2Wh9ATZ`;
    expect(redactSecrets(text)).toBe(`config%2C--password%20%27[REDACTED]%0AeyJ${C}Q2Wh9ATZ`);
  });
});

describe("R6: shapes a review found unlisted that are now redacted, and the controls that keep them precise", () => {
  it.each([
    ["credential: S", `credential: ${V}`],
    ["an Azure shared-access signature in a query string", `https://blob.example.test/c?sv=1&sig=${V}`],
    ["a pre-signed URL signature", `https://bucket.example.test/o?X-Amz-Signature=${V}`],
    ["a pre-signed URL security token", `https://bucket.example.test/o?x-amz-security-token=${V}`],
  ])("%s", (_label, text) => {
    expect(redactSecrets(text), text).not.toContain(V);
  });

  it.each([
    "https://host.example/x?signal=confirmed-and-long",
    "https://host.example/x?sign=confirmed-and-long",
    "https://host.example/x?a=1&signup=confirmed-and-long",
    "path/sig=abcdefghij",
    "the credential rotation is monthly",
  ])("control (ordinary text stays readable): %s", (text) => {
    expect(redactSecrets(text)).toBe(text);
  });
});
