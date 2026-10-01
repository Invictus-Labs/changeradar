import { describe, expect, it } from "vitest";
import { InvalidRunTransitionError } from "../../src/domain/errors.js";
import { RUN_STATUSES, canTransition, isTerminal, transition } from "../../src/domain/run-state.js";

describe("run state machine", () => {
  it("allows QUEUED -> RUNNING -> COMPLETE and RUNNING -> FAILED", () => {
    expect(transition("QUEUED", "RUNNING")).toBe("RUNNING");
    expect(transition("RUNNING", "COMPLETE")).toBe("COMPLETE");
    expect(transition("RUNNING", "FAILED")).toBe("FAILED");
  });

  it("allows lease reclaim (RUNNING -> QUEUED) and pre-start rejection (QUEUED -> FAILED)", () => {
    expect(canTransition("RUNNING", "QUEUED")).toBe(true);
    expect(canTransition("QUEUED", "FAILED")).toBe(true);
  });

  it("COMPLETE and FAILED are terminal and immutable", () => {
    for (const terminal of ["COMPLETE", "FAILED"] as const) {
      expect(isTerminal(terminal)).toBe(true);
      for (const to of RUN_STATUSES) expect(canTransition(terminal, to)).toBe(false);
    }
    expect(isTerminal("QUEUED")).toBe(false);
    expect(isTerminal("RUNNING")).toBe(false);
  });

  it("COMPLETE cannot be reached without RUNNING", () => {
    expect(canTransition("QUEUED", "COMPLETE")).toBe(false);
  });

  it("rejects illegal transitions with a typed error mapped to HTTP 409", () => {
    expect(() => transition("COMPLETE", "RUNNING")).toThrow(InvalidRunTransitionError);
    try {
      transition("QUEUED", "COMPLETE");
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toMatchObject({ code: "INVALID_RUN_TRANSITION", status: 409, from: "QUEUED", to: "COMPLETE" });
    }
  });

  it("does not allow a self transition", () => {
    for (const s of RUN_STATUSES) expect(canTransition(s, s)).toBe(false);
  });
});
