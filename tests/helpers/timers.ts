import type { Clock } from "../../src/domain/clock.js";
import type { Timers } from "../../src/domain/contract-checks.js";

/** Manual scheduler: nothing fires until `advance` is called. Also acts as the Clock. */
export class ManualTime implements Clock, Timers {
  #now: number;
  #next = 1;
  #timers = new Map<number, { at: number; callback: () => void }>();

  constructor(startIso = "2026-09-29T00:00:00Z") {
    this.#now = Date.parse(startIso);
  }

  now(): Date {
    return new Date(this.#now);
  }

  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.#next++;
    this.#timers.set(id, { at: this.#now + ms, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.#timers.delete(handle as number);
  }

  get pending(): number {
    return this.#timers.size;
  }

  /** Advance virtual time, firing due timers in order and letting promise continuations run between them. */
  async advance(ms: number): Promise<void> {
    const target = this.#now + ms;
    for (;;) {
      await flushMicrotasks();
      const due = [...this.#timers.entries()]
        .filter(([, t]) => t.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      this.#timers.delete(due[0]);
      this.#now = Math.max(this.#now, due[1].at);
      due[1].callback();
    }
    this.#now = target;
    await flushMicrotasks();
  }
}

export async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}
