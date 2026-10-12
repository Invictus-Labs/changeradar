import { describe, expect, it } from "vitest";
import { runContractCheck, type CheckOutcome, type ContractCheckRunner } from "../../src/domain/contract-checks.js";
import { systemClock } from "../../src/domain/clock.js";

describe("runContractCheck with real timers", () => {
  it("a hung read-only check times out within its configured limit and is TIMED_OUT, not PASSED", async () => {
    let aborted = false;
    const hung: ContractCheckRunner = {
      read_only: true,
      run: (_def, ctx) => {
        ctx.signal.addEventListener("abort", () => (aborted = true));
        return new Promise<CheckOutcome>(() => {});
      },
    };
    const started = performance.now();
    const result = await runContractCheck(
      { id: "chk.real", node_id: "contract.invoice", description: "hung", timeout_ms: 60 },
      hung,
      { clock: systemClock },
    );
    const elapsed = performance.now() - started;
    expect(result.state).toBe("TIMED_OUT");
    expect(elapsed).toBeGreaterThanOrEqual(50);
    expect(elapsed).toBeLessThan(1000);
    expect(aborted).toBe(true);
  });

  it("a runner that answers before the limit is reported as answered", async () => {
    const quick: ContractCheckRunner = {
      read_only: true,
      run: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { state: "PASSED" };
      },
    };
    const result = await runContractCheck({ id: "chk.real2", node_id: "contract.invoice", description: "quick", timeout_ms: 2000 }, quick, {
      clock: systemClock,
    });
    expect(result.state).toBe("PASSED");
    expect(result.duration_ms).toBeLessThan(1000);
  });
});
