import { describe, expect, it } from "vitest";
import { fixedClock, systemClock } from "../../src/domain/clock.js";
import { DomainError, ERROR_STATUS, InvalidExpectedHashError, InvalidRunTransitionError, StaleBaselineError, statusForCode } from "../../src/domain/errors.js";
import { parseSemver } from "../../src/domain/semver.js";

describe("clock", () => {
  it("fixedClock always returns the same UTC instant", () => {
    const clock = fixedClock("2026-09-29T00:00:00Z");
    expect(clock.now().toISOString()).toBe("2026-09-29T00:00:00.000Z");
    expect(clock.now().getTime()).toBe(clock.now().getTime());
  });

  it("fixedClock rejects an unparseable timestamp", () => {
    expect(() => fixedClock("yesterday-ish")).toThrow(RangeError);
  });

  it("systemClock reads real time", () => {
    const before = Date.now();
    const now = systemClock.now().getTime();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });
});

describe("errors", () => {
  it("maps every documented code to the HTTP status from the PRD interface contract", () => {
    expect(statusForCode("STALE_BASELINE")).toBe(409);
    expect(statusForCode("INVALID_RUN_TRANSITION")).toBe(409);
    expect(statusForCode("MALFORMED_JSON")).toBe(400);
    expect(statusForCode("PAYLOAD_TOO_LARGE")).toBe(413);
    expect(statusForCode("DANGLING_EDGE")).toBe(422);
    expect(statusForCode("UNSUPPORTED_SCHEMA_VERSION")).toBe(422);
    for (const status of Object.values(ERROR_STATUS)) expect([400, 409, 413, 422]).toContain(status);
  });

  it("typed errors carry their code, status and context and are DomainErrors", () => {
    const stale = new StaleBaselineError("sha256:" + "a".repeat(64), "sha256:" + "b".repeat(64));
    expect(stale).toBeInstanceOf(DomainError);
    expect(stale).toBeInstanceOf(Error);
    expect(stale).toMatchObject({ name: "StaleBaselineError", code: "STALE_BASELINE", status: 409 });
    expect(new InvalidExpectedHashError()).toMatchObject({ code: "INVALID_EXPECTED_HASH", status: 422 });
    expect(new InvalidRunTransitionError("QUEUED", "COMPLETE")).toMatchObject({ from: "QUEUED", to: "COMPLETE", status: 409 });
  });
});

describe("parseSemver", () => {
  it.each([
    ["1.2.3", { major: 1, minor: 2, patch: 3, prerelease: null }],
    ["v10.0.1", { major: 10, minor: 0, patch: 1, prerelease: null }],
    ["2.0.0-rc.1", { major: 2, minor: 0, patch: 0, prerelease: "rc.1" }],
    ["1.0.0+build.5", { major: 1, minor: 0, patch: 0, prerelease: null }],
  ])("parses %s", (input, expected) => {
    expect(parseSemver(input)).toEqual(expected);
  });

  it.each(["1.2", "latest", "", "1.2.3.4", "a.b.c", "1234567890.0.0"])("rejects %j", (input) => {
    expect(parseSemver(input)).toBeNull();
  });
});
