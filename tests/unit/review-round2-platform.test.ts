import { describe, expect, it } from "vitest";
import { fixedClock } from "../../src/domain/clock.js";
import { runContractCheck } from "../../src/domain/contract-checks.js";
import { isDatabaseUnavailable, unavailable } from "../../src/platform/errors.js";
import { neutralize } from "../../src/platform/terminal-text.js";

/**
 * Review round 2 regression tests for the platform helpers: the CLI output sanitiser (security P1, run.ts:250), the
 * retryable 503 (conformance P3) and the database-outage mapping (test-adequacy P2, errors.ts:61).
 */

describe("R2 P1 (run.ts:250): neutralize escapes every character a terminal would act on", () => {
  const cases: [string, string, string][] = [
    ["ESC (CSI colour)", "a\u001b[31mred\u001b[0m", "a\\u{1b}[31mred\\u{1b}[0m"],
    ["OSC title with BEL", "x\u001b]0;pwned\u0007y", "x\\u{1b}]0;pwned\\u{7}y"],
    ["C1 CSI (U+009B)", "a\u009b2Jb", "a\\u{9b}2Jb"],
    ["NUL", "a\u0000b", "a\\u{0}b"],
    ["DEL", "a\u007fb", "a\\u{7f}b"],
    ["bidi override", "evil‮gnp.exe", "evil\\u{202e}gnp.exe"],
    ["bidi isolate", "a⁦b⁩c", "a\\u{2066}b\\u{2069}c"],
    ["line separator", "a b", "a\\u{2028}b"],
    ["paragraph separator", "a b", "a\\u{2029}b"],
    ["carriage return (overwrites the line)", "safe\rEVIL", "safe\\u{d}EVIL"],
    ["backspace", "ab\bc", "ab\\u{8}c"],
    ["zero width space", "a​b", "a\\u{200b}b"],
    ["private use", "ab", "a\\u{e000}b"],
    ["lone surrogate", "a\ud800b", "a\\u{d800}b"],
  ];
  for (const [name, input, expected] of cases) {
    it(name, () => {
      expect(neutralize(input)).toBe(expected);
    });
  }

  it("keeps newlines, tabs and ordinary text (including non-ASCII letters) unchanged", () => {
    const text = "changeradar: usage\n\tverify-bundle --in FILE\nnaïve café 日本語 — ok";
    expect(neutralize(text)).toBe(text);
  });

  it("is idempotent, and its output holds no control character other than newline and tab", () => {
    const hostile = "\u001b[2J\u001b]52;c;x\u0007\u009b\u0000\r‮\ud800end";
    const once = neutralize(hostile);
    expect(neutralize(once)).toBe(once);
    // eslint-disable-next-line no-control-regex
    expect(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/.test(once)).toBe(false);
  });

  it("a long hostile string stays linear", () => {
    const text = "\u001b[31m".repeat(200_000);
    const started = performance.now();
    neutralize(text);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe("R2 P3 (contract-checks.ts:198): runContractCheck never rejects, even when reading the outcome throws", () => {
  const definition = { id: "chk.invoice", node_id: "contract.invoice", description: "GET", timeout_ms: 1000 };
  it("a result whose `state` getter throws is an ERROR outcome, not a rejection", async () => {
    const hostile = {
      get state(): never {
        throw new Error("getter exploded");
      },
    };
    const runner = { read_only: true as const, run: () => Promise.resolve(hostile as never) };
    const settled = await runContractCheck(definition, runner, { clock: fixedClock("2026-09-29T00:00:00Z") }).then(
      (value) => ({ resolved: value }),
      (error: unknown) => ({ rejected: String(error) }),
    );
    expect(settled, "runContractCheck must not reject").not.toHaveProperty("rejected");
    const result = (settled as { resolved: Awaited<ReturnType<typeof runContractCheck>> }).resolved;
    expect(result).toMatchObject({ state: "ERROR", error_code: "RUNNER_ERROR", check_id: "chk.invoice" });
    expect(result.detail).toContain("getter exploded");
  });
});

describe("R2 P3 (server.ts:123 vs :139): every 503 is retryable and says so", () => {
  it("the readiness 503 carries Retry-After", () => {
    const error = unavailable();
    expect(error.status).toBe(503);
    expect(error.headers).toEqual({ "retry-after": "5" });
    expect(unavailable("X", "y").headers).toEqual({ "retry-after": "5" });
  });
});

describe("R2 P2 (errors.ts:61): isDatabaseUnavailable over codes, texts and aggregates", () => {
  const withCode = (code: string, message = "boom"): Error => Object.assign(new Error(message), { code });

  it("connection and shutdown SQLSTATEs and Node socket codes", () => {
    for (const code of ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "ECONNABORTED", "53300", "57P01", "57P02", "57P03"]) {
      expect(isDatabaseUnavailable(withCode(code)), code).toBe(true);
    }
  });

  it("any SQLSTATE of class 08 (connection exception)", () => {
    for (const code of ["08000", "08003", "08006", "08001", "08004", "08P01"]) expect(isDatabaseUnavailable(withCode(code)), code).toBe(true);
  });

  it("other SQLSTATEs are defects, not outages", () => {
    for (const code of ["23505", "42P01", "22P02", "40001", "XX000", "07000", "0", ""]) expect(isDatabaseUnavailable(withCode(code)), code).toBe(false);
  });

  it("the error text of a closed or unreachable database", () => {
    for (const message of ["Connection terminated unexpectedly", "PGlite is closed", "Cannot use a pool after calling end on the pool", "connect ECONNREFUSED 127.0.0.1:5432", "timeout exceeded when trying to connect", "the database is closed", "Client was closed and is not queryable"]) {
      expect(isDatabaseUnavailable(new Error(message)), message).toBe(true);
    }
  });

  it("an AggregateError is an outage when any member is, and not otherwise", () => {
    expect(isDatabaseUnavailable(new AggregateError([new Error("nope"), withCode("57P01")], "all failed"))).toBe(true);
    expect(isDatabaseUnavailable(new AggregateError([new Error("nope"), withCode("23505")], "all failed"))).toBe(false);
    expect(isDatabaseUnavailable(new AggregateError([], "empty"))).toBe(false);
    expect(isDatabaseUnavailable(new AggregateError([new AggregateError([withCode("08006")])], "nested"))).toBe(true);
  });

  it("non-errors and ordinary defects are not outages", () => {
    expect(isDatabaseUnavailable("connection terminated")).toBe(false);
    expect(isDatabaseUnavailable({ code: "57P01" })).toBe(false);
    expect(isDatabaseUnavailable(null)).toBe(false);
    expect(isDatabaseUnavailable(new TypeError("x is not a function"))).toBe(false);
    expect(isDatabaseUnavailable(withCode(String(57)))).toBe(false);
  });

  it("a numeric code is ignored (only string codes are SQLSTATE or socket codes)", () => {
    expect(isDatabaseUnavailable(Object.assign(new Error("boom"), { code: 57 }))).toBe(false);
  });
});
