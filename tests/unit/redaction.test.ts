import { describe, expect, it } from "vitest";
import {
  REDACTED,
  containsSecret,
  detectSecretKinds,
  escapeHtml,
  redactDeep,
  redactSecrets,
  safeReportText,
} from "../../src/domain/redaction.js";
import { ALL_FAKE_SECRETS, FAKE_ASSIGNMENT, FAKE_AWS_KEY, FAKE_BEARER, FAKE_URL_WITH_PASSWORD, SECRET_CORES } from "../helpers/fake-secrets.js";

describe("redactSecrets", () => {
  it.each(ALL_FAKE_SECRETS.map((s, i) => [i, s] as const))("removes planted fake secret #%i", (_i, secret) => {
    const out = redactSecrets(`before ${secret} after`);
    for (const core of SECRET_CORES) expect(out).not.toContain(core);
    expect(out).toContain(REDACTED);
    expect(out.startsWith("before ")).toBe(true);
  });

  it("leaves ordinary text and credential aliases untouched", () => {
    const text = "svc.billing consumes contract.invoice via cred.smtp (alias only) at manifests/billing.yaml:12";
    expect(redactSecrets(text)).toBe(text);
  });

  it("redacts only the value of an assignment and keeps the key readable", () => {
    const out = redactSecrets(FAKE_ASSIGNMENT);
    expect(out).toBe(`password=${REDACTED}`);
  });

  it("does not leak the value when the key text equals the value text", () => {
    const out = redactSecrets("secret=secretsecret");
    expect(out).toBe(`secret=${REDACTED}`);
  });

  it("keeps the URL scheme and host but drops the embedded password", () => {
    const out = redactSecrets(FAKE_URL_WITH_PASSWORD);
    expect(out).toContain("localhost");
    expect(out).not.toContain("plantedPass1234");
  });

  it("redacts every occurrence in a multi line log", () => {
    const out = redactSecrets(`line1 ${FAKE_AWS_KEY}\nline2 ${FAKE_BEARER}\nline3 ok`);
    expect(out).not.toContain(FAKE_AWS_KEY);
    expect(out).not.toContain("plantedBearerToken");
    expect(out).toContain("line3 ok");
  });

  it("redacts an unterminated private key block to the end of the text", () => {
    // The header is assembled from fragments, like every other credential-shaped fixture, so no source line holds a whole one.
    const out = redactSecrets(`x ${["-----BEGIN", " PRIVATE", " KEY-----"].join("")}\nabcdef`);
    expect(out).toBe(`x ${REDACTED}`);
  });

  it("is idempotent", () => {
    const once = redactSecrets(`a ${FAKE_AWS_KEY} b`);
    expect(redactSecrets(once)).toBe(once);
  });
});

describe("detectSecretKinds / containsSecret", () => {
  it("names the kind of each detected secret, sorted and unique", () => {
    expect(detectSecretKinds(`${FAKE_AWS_KEY} ${FAKE_AWS_KEY}`)).toEqual(["aws_access_key"]);
    expect(detectSecretKinds(`${FAKE_BEARER} ${FAKE_AWS_KEY}`)).toEqual(["aws_access_key", "bearer_token"]);
  });

  it("returns nothing for aliases and identifiers", () => {
    expect(detectSecretKinds("cred.payments.api-key")).toEqual([]);
    expect(detectSecretKinds("token:prod-payments")).toEqual([]);
    expect(containsSecret("svc.billing")).toBe(false);
  });

  it("flags a random looking assignment but not a plain word assignment in validation mode", () => {
    expect(containsSecret(FAKE_ASSIGNMENT)).toBe(true);
    expect(containsSecret("password=correcthorse")).toBe(false);
    // Logs are stricter: the same plain assignment is still redacted.
    expect(redactSecrets("password=correcthorse")).toBe(`password=${REDACTED}`);
  });
});

describe("redactDeep", () => {
  it("redacts nested strings, sensitive keys and secret-looking keys", () => {
    const value = {
      msg: `token ${FAKE_AWS_KEY}`,
      headers: { Authorization: "Bearer anything", "x-request-id": "abc" },
      list: [FAKE_ASSIGNMENT, 1, null, true],
      [FAKE_AWS_KEY]: "value",
    };
    const out = JSON.stringify(redactDeep(value));
    for (const core of SECRET_CORES) expect(out).not.toContain(core);
    expect(out).not.toContain("Bearer anything");
    expect(out).toContain("x-request-id");
  });

  it("reduces errors to name and redacted message", () => {
    const out = redactDeep(new Error(`failed with ${FAKE_AWS_KEY}`)) as { name: string; message: string };
    expect(out.name).toBe("Error");
    expect(out.message).not.toContain(FAKE_AWS_KEY);
  });

  it("cuts cycles and excessive depth instead of recursing forever", () => {
    const cyc: Record<string, unknown> = { a: 1 };
    cyc.self = cyc;
    expect((redactDeep(cyc) as Record<string, unknown>).self).toBe("[CIRCULAR]");
    let deep: unknown = "leaf";
    for (let i = 0; i < 30; i += 1) deep = { d: deep };
    expect(JSON.stringify(redactDeep(deep))).toContain("[TRUNCATED]");
  });

  it("stringifies bigint, symbol and function values and keeps primitives", () => {
    const out = redactDeep({ b: 1n, s: Symbol("x"), f: () => 1, n: 5, t: true }) as Record<string, unknown>;
    expect(out).toEqual({ b: "bigint", s: "symbol", f: "function", n: 5, t: true });
  });

  it("does not treat a shared reference as circular", () => {
    const shared = { x: "ok" };
    expect(redactDeep({ a: shared, b: shared })).toEqual({ a: { x: "ok" }, b: { x: "ok" } });
  });
});

describe("escapeHtml", () => {
  const malicious = [
    `<script>alert(1)</script>`,
    `"><img src=x onerror=alert(1)>`,
    `'><svg/onload=alert(1)>`,
    "`onmouseover=alert(1)",
    `<a href="javascript:alert(1)">x</a>`,
    `&lt;already&gt; & <b>`,
  ];

  it.each(malicious)("neutralizes %s", (input) => {
    const out = escapeHtml(input);
    expect(out).not.toMatch(/[<>"'`]/);
    expect(out.replace(/&(amp|lt|gt|quot|#39|#96);/g, "")).not.toContain("&");
  });

  it("escapes ampersands first so entities are not double decoded", () => {
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });

  it("maps null and undefined to an empty string and coerces other values", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
    expect(escapeHtml(42)).toBe("42");
  });

  it("safeReportText redacts before escaping", () => {
    const out = safeReportText(`<b>${FAKE_AWS_KEY}</b>`);
    expect(out).not.toContain(FAKE_AWS_KEY);
    expect(out).toContain("&lt;b&gt;");
    expect(safeReportText(null)).toBe("");
  });
});
