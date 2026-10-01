import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHECK_STATES,
  runContractCheck,
  summarizeChecks,
  validateCheckDefinition,
  type CheckOutcome,
  type CheckRunContext,
  type ContractCheckDefinition,
  type ContractCheckResult,
  type ContractCheckRunner,
} from "../../src/domain/contract-checks.js";
import { FAKE_AWS_KEY } from "../helpers/fake-secrets.js";
import { ManualTime, flushMicrotasks } from "../helpers/timers.js";

const definition = (patch: Partial<ContractCheckDefinition> = {}): ContractCheckDefinition => ({
  id: "chk.invoice",
  node_id: "contract.invoice",
  description: "GET the invoice contract",
  timeout_ms: 1000,
  ...patch,
});

function runner(fn: (def: ContractCheckDefinition, ctx: CheckRunContext) => Promise<CheckOutcome> | CheckOutcome): ContractCheckRunner & { calls: number } {
  const r = {
    read_only: true as const,
    calls: 0,
    run(def: ContractCheckDefinition, ctx: CheckRunContext) {
      r.calls += 1;
      return Promise.resolve(fn(def, ctx));
    },
  };
  return r;
}

const never = () => new Promise<CheckOutcome>(() => {});

describe("runContractCheck with a manual clock and timers", () => {
  it("reports PASSED only when the runner reports PASSED", async () => {
    const time = new ManualTime();
    const r = runner(() => ({ state: "PASSED", detail: "shape matches" }));
    const result = await runContractCheck(definition(), r, { clock: time, timers: time });
    expect(result).toMatchObject({ state: "PASSED", attempts: 1, detail: "shape matches", error_code: null, check_id: "chk.invoice", node_id: "contract.invoice" });
    expect(time.pending).toBe(0);
  });

  it("reports FAILED as FAILED and redacts secrets from the detail", async () => {
    const time = new ManualTime();
    const r = runner(() => ({ state: "FAILED", detail: `mismatch near ${FAKE_AWS_KEY}\nline2` }));
    const result = await runContractCheck(definition(), r, { clock: time, timers: time });
    expect(result.state).toBe("FAILED");
    expect(result.detail).not.toContain(FAKE_AWS_KEY);
    expect(result.detail).not.toContain("\n");
  });

  it("SEEDED NEGATIVE CONTROL: a hung runner times out within the limit and is never PASSED", async () => {
    const time = new ManualTime();
    let seen: CheckRunContext | undefined;
    const r = runner((_d, ctx) => ((seen = ctx), never()));
    const pending = runContractCheck(definition({ timeout_ms: 500 }), r, { clock: time, timers: time });
    let settled = false;
    void pending.then(() => (settled = true));
    await time.advance(499);
    expect(settled).toBe(false);
    expect(seen!.signal.aborted).toBe(false);
    await time.advance(1);
    const result = await pending;
    expect(result).toMatchObject({ state: "TIMED_OUT", error_code: "TIMEOUT", duration_ms: 500, attempts: 1 });
    expect(seen!.signal.aborted).toBe(true);
    expect(result.state).not.toBe("PASSED");
  });

  it("a late PASSED after the deadline cannot change a TIMED_OUT result", async () => {
    const time = new ManualTime();
    let release!: (o: CheckOutcome) => void;
    const r = runner(() => new Promise<CheckOutcome>((resolve) => (release = resolve)));
    const pending = runContractCheck(definition({ timeout_ms: 100 }), r, { clock: time, timers: time });
    await time.advance(100);
    const result = await pending;
    release({ state: "PASSED" });
    await flushMicrotasks();
    expect(result.state).toBe("TIMED_OUT");
  });

  it("a rejection after the deadline is not an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", listener);
    try {
      const time = new ManualTime();
      let fail!: (e: Error) => void;
      const r = runner(() => new Promise<CheckOutcome>((_res, rej) => (fail = rej)));
      const pending = runContractCheck(definition({ timeout_ms: 10 }), r, { clock: time, timers: time });
      await time.advance(10);
      await pending;
      fail(new Error("socket closed late"));
      await flushMicrotasks();
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });

  it("an async error becomes ERROR with a redacted message, never PASSED", async () => {
    const time = new ManualTime();
    const r = runner(async () => {
      throw new Error(`connect failed with ${FAKE_AWS_KEY}`);
    });
    const result = await runContractCheck(definition(), r, { clock: time, timers: time });
    expect(result).toMatchObject({ state: "ERROR", error_code: "RUNNER_ERROR" });
    expect(result.detail).not.toContain(FAKE_AWS_KEY);
  });

  it("a synchronous throw becomes ERROR and clears the timer", async () => {
    const time = new ManualTime();
    const r: ContractCheckRunner = {
      read_only: true,
      run() {
        throw new Error("boom");
      },
    };
    const result = await runContractCheck(definition(), r, { clock: time, timers: time });
    expect(result).toMatchObject({ state: "ERROR", error_code: "RUNNER_ERROR", detail: "boom" });
    expect(time.pending).toBe(0);
  });

  it("a non-Error rejection still becomes ERROR", async () => {
    const time = new ManualTime();
    const r = runner(() => Promise.reject("string failure") as unknown as Promise<CheckOutcome>);
    const result = await runContractCheck(definition(), r, { clock: time, timers: time });
    expect(result).toMatchObject({ state: "ERROR", detail: "runner failed" });
  });

  it.each([
    ["an unknown state", { state: "OK" }],
    ["a lowercase state", { state: "passed" }],
    ["a missing state", {}],
    ["null", null],
    ["a bare string", "PASSED"],
    ["a boolean", true],
  ])("%s becomes UNKNOWN, never PASSED", async (_name, outcome) => {
    const time = new ManualTime();
    const r = runner(() => outcome as unknown as CheckOutcome);
    const result = await runContractCheck(definition(), r, { clock: time, timers: time });
    expect(result).toMatchObject({ state: "UNKNOWN", error_code: "UNRECOGNIZED_OUTCOME" });
  });

  it("refuses a runner that does not declare itself read-only and never calls it", async () => {
    const time = new ManualTime();
    const r = { read_only: false, run: vi.fn(async () => ({ state: "PASSED" as const })) } as unknown as ContractCheckRunner;
    const result = await runContractCheck(definition(), r, { clock: time, timers: time });
    expect(result).toMatchObject({ state: "ERROR", error_code: "RUNNER_NOT_READ_ONLY", attempts: 0 });
    expect(r.run).not.toHaveBeenCalled();
  });

  it.each([
    ["zero timeout", { timeout_ms: 0 }],
    ["negative timeout", { timeout_ms: -5 }],
    ["fractional timeout", { timeout_ms: 1.5 }],
    ["NaN timeout", { timeout_ms: Number.NaN }],
    ["timeout above the cap", { timeout_ms: 120_001 }],
    ["five attempts", { max_attempts: 5 }],
    ["zero attempts", { max_attempts: 0 }],
    ["negative backoff", { backoff_base_ms: -1 }],
    ["bad check id", { id: "has space" }],
    ["bad node id", { node_id: "" }],
  ])("an invalid definition (%s) is ERROR without running", async (_name, patch) => {
    const time = new ManualTime();
    const r = runner(() => ({ state: "PASSED" }));
    const result = await runContractCheck(definition(patch), r, { clock: time, timers: time });
    expect(result).toMatchObject({ state: "ERROR", error_code: "INVALID_DEFINITION", attempts: 0 });
    expect(r.calls).toBe(0);
  });

  it("the timeout cap is configurable", async () => {
    const time = new ManualTime();
    const r = runner(() => ({ state: "PASSED" }));
    const tight = await runContractCheck(definition({ timeout_ms: 2000 }), r, { clock: time, timers: time, max_timeout_ms: 1000 });
    expect(tight.state).toBe("ERROR");
    const loose = await runContractCheck(definition({ timeout_ms: 2000 }), r, { clock: time, timers: time, max_timeout_ms: 5000 });
    expect(loose.state).toBe("PASSED");
  });

  it("validateCheckDefinition lists every problem and accepts a valid definition", () => {
    expect(validateCheckDefinition(definition())).toEqual([]);
    expect(validateCheckDefinition(definition({ timeout_ms: 0, max_attempts: 9, backoff_base_ms: -2, id: "" })).length).toBe(4);
  });

  it("retries ERROR with exponential backoff and keeps the failed attempts as evidence", async () => {
    const time = new ManualTime();
    const delays: number[] = [];
    const timers = {
      setTimeout: (cb: () => void, ms: number) => (delays.push(ms), time.setTimeout(cb, ms)),
      clearTimeout: (h: unknown) => time.clearTimeout(h),
    };
    let n = 0;
    const r = runner(async () => {
      n += 1;
      if (n < 3) throw new Error(`transient ${n}`);
      return { state: "PASSED" };
    });
    const pending = runContractCheck(definition({ max_attempts: 3, backoff_base_ms: 100 }), r, { clock: time, timers });
    await time.advance(1000);
    const result = await pending;
    expect(result.state).toBe("PASSED");
    expect(result.attempts).toBe(3);
    expect(result.attempt_log.map((a) => a.state)).toEqual(["ERROR", "ERROR", "PASSED"]);
    expect(result.attempt_log[0]!.detail).toBe("transient 1");
    // Delays scheduled: attempt timeout (1000), backoff 100, attempt timeout, backoff 200, attempt timeout.
    expect(delays.filter((d) => d !== 1000)).toEqual([100, 200]);
  });

  it("retries TIMED_OUT and, when every attempt times out, ends TIMED_OUT (never PASSED)", async () => {
    const time = new ManualTime();
    const r = runner(never);
    const pending = runContractCheck(definition({ timeout_ms: 50, max_attempts: 3, backoff_base_ms: 10 }), r, { clock: time, timers: time });
    await time.advance(1000);
    const result = await pending;
    expect(result).toMatchObject({ state: "TIMED_OUT", attempts: 3 });
    expect(result.attempt_log.map((a) => a.state)).toEqual(["TIMED_OUT", "TIMED_OUT", "TIMED_OUT"]);
    expect(r.calls).toBe(3);
  });

  it("FAILED and UNKNOWN are definitive and never retried", async () => {
    const time = new ManualTime();
    const failed = runner(() => ({ state: "FAILED" }));
    const r1 = await runContractCheck(definition({ max_attempts: 4 }), failed, { clock: time, timers: time });
    expect(r1).toMatchObject({ state: "FAILED", attempts: 1 });
    const unknown = runner(() => ({}) as unknown as CheckOutcome);
    const r2 = await runContractCheck(definition({ max_attempts: 4 }), unknown, { clock: time, timers: time });
    expect(r2).toMatchObject({ state: "UNKNOWN", attempts: 1 });
  });

  it("a persistent ERROR after all attempts stays ERROR", async () => {
    const time = new ManualTime();
    const r = runner(async () => {
      throw new Error("down");
    });
    const pending = runContractCheck(definition({ max_attempts: 2, backoff_base_ms: 0 }), r, { clock: time, timers: time });
    await time.advance(10);
    expect((await pending).state).toBe("ERROR");
  });

  it("truncates very long details", async () => {
    const time = new ManualTime();
    const r = runner(() => ({ state: "FAILED", detail: "x".repeat(5000) }));
    const result = await runContractCheck(definition(), r, { clock: time, timers: time });
    expect(result.detail!.length).toBeLessThan(600);
    expect(result.detail!.endsWith("...")).toBe(true);
  });

  it("results are immutable evidence", async () => {
    const time = new ManualTime();
    const result = await runContractCheck(definition(), runner(() => ({ state: "PASSED" })), { clock: time, timers: time });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.attempt_log)).toBe(true);
  });
});

describe("runContractCheck with fake timers (vitest) and the default timers", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("times out under vi.useFakeTimers using the default timer facade", async () => {
    vi.useFakeTimers({ now: new Date("2026-09-29T00:00:00Z") });
    const clock = { now: () => new Date() };
    const pending = runContractCheck(definition({ timeout_ms: 2000 }), runner(never), { clock });
    await vi.advanceTimersByTimeAsync(1999);
    let settled = false;
    void pending.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(result).toMatchObject({ state: "TIMED_OUT", duration_ms: 2000, started_at: "2026-09-29T00:00:00.000Z", finished_at: "2026-09-29T00:00:02.000Z" });
  });

  it("a fast pass under fake timers leaves no timer behind", async () => {
    vi.useFakeTimers();
    const clock = { now: () => new Date() };
    const result = await runContractCheck(definition(), runner(() => ({ state: "PASSED" })), { clock });
    expect(result.state).toBe("PASSED");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("summarizeChecks", () => {
  const result = (state: ContractCheckResult["state"]): ContractCheckResult => ({
    check_id: "c",
    node_id: "n",
    state,
    attempts: 1,
    started_at: "2026-09-29T00:00:00.000Z",
    finished_at: "2026-09-29T00:00:00.000Z",
    duration_ms: 0,
    detail: null,
    error_code: null,
    attempt_log: [],
  });

  it("all_passed requires at least one check and every check PASSED", () => {
    expect(summarizeChecks([]).all_passed).toBe(false);
    expect(summarizeChecks([result("PASSED"), result("PASSED")]).all_passed).toBe(true);
  });

  it.each(CHECK_STATES.filter((s) => s !== "PASSED"))("one %s check means not all passed", (state) => {
    const s = summarizeChecks([result("PASSED"), result(state)]);
    expect(s.all_passed).toBe(false);
    expect(s.total).toBe(2);
    expect(s.passed).toBe(1);
  });

  it("counts every state", () => {
    const s = summarizeChecks(CHECK_STATES.map(result));
    expect(s).toMatchObject({ total: 5, passed: 1, failed: 1, timed_out: 1, error: 1, unknown: 1, all_passed: false });
  });
});
