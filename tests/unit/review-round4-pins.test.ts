import { describe, expect, it } from "vitest";
import { classifyVersionChange } from "../../src/domain/semver.js";
import { defaultSettings } from "../../src/platform/context.js";
import { redactIdentifiers, redactSecrets } from "../../src/domain/redaction.js";

/**
 * Review round 4 (tests P3 boundary pins): exact boundaries of rules that were only pinned on one side, so that a change is a
 * decision and not an accident. Secrets are assembled at run time.
 */

const V = "Zx9Kq2Lm7Pw4Rt8Yv3Bn6Cd1Fg5Hj0";
const HF = ["hf", "_"].join("");

describe("R4 P2 (semver.ts, H52): a prerelease moving to another minor or patch is breaking", () => {
  it.each([
    ["1.2.3-rc.1", "1.3.3-rc.1"],
    ["1.2.3-rc.1", "1.2.4-rc.1"],
    ["1.2.3-rc.1", "1.3.0-rc.1"],
    ["1.2.3-rc.1", "1.2.3-rc.2"],
  ])("%s -> %s", (before, after) => {
    expect(classifyVersionChange(before, after).breaking).toBe(true);
  });
  it("controls: the same core and prerelease is not breaking, and graduating on the same core is not", () => {
    expect(classifyVersionChange("1.2.3-rc.1", "1.2.3-rc.1").breaking).toBe(false);
    expect(classifyVersionChange("1.2.3-rc.1", "1.2.3").breaking).toBe(false);
  });
});

describe("R4 P3 (redaction.ts): boundaries of the assignment and pair rules", () => {
  it("an unterminated quoted value is redacted to the end of its LINE, not of the text (H06)", () => {
    const out = redactSecrets(`password="${V}\nthe next line stays readable`);
    expect(out).not.toContain(V);
    expect(out).toContain("the next line stays readable");
  });

  it("a carriage return or a tab (real or escaped) is a gap in front of a YAML value (W07)", () => {
    for (const gap of ["\r\n  ", "\t", "\\r\\n  ", "\\t", " \n\t "]) expect(redactSecrets(`password:${gap}${V}`), JSON.stringify(gap)).not.toContain(V);
  });

  it("user information of about a thousand characters is still found (W14: the limit is far above 512)", () => {
    const password = ["Ab1", "x".repeat(1000)].join("");
    expect(redactSecrets(`https://svc:${password}@host.test/p`)).not.toContain(password.slice(0, 200));
  });

  it("the letter-glue rule of `hf_` has both sides (W16): a word ending in `hf_` is not a token, a spaced one is", () => {
    const tail = "a1B2c3D4e5F6g7H8i9J0k1L2m3";
    expect(redactSecrets(`pdf_${tail}`)).toBe(`pdf_${tail}`);
    expect(redactSecrets(`x ${HF}${tail}`)).not.toContain(tail);
    expect(redactSecrets(`9${HF}${tail}`)).not.toContain(tail);
  });

  it("a pair name may contain `credential` and a long prefix (W04, W05)", () => {
    expect(redactSecrets(JSON.stringify({ name: "credential_store", value: V }))).not.toContain(V);
    expect(redactSecrets(JSON.stringify({ name: "some.quite.long.prefix.of.a.name.password", value: V }))).not.toContain(V);
  });

  it("redactIdentifiers cuts nesting at 12 levels (H19)", () => {
    let deep: unknown = "leaf-value";
    for (let i = 0; i < 14; i += 1) deep = { next: deep };
    expect(JSON.stringify(redactIdentifiers(deep))).toContain("[TRUNCATED]");
    let shallow: unknown = "leaf-value";
    for (let i = 0; i < 6; i += 1) shallow = { next: shallow };
    expect(JSON.stringify(redactIdentifiers(shallow))).toContain("leaf-value");
  });
});

describe("R4 P3 (context.ts, H51): the default bundle limit is 64 MiB", () => {
  it("is 67,108,864 bytes", () => {
    expect(defaultSettings.maxBundleBytes).toBe(67_108_864);
  });
});
