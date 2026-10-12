/** Injectable UTC clock. The deterministic core never reads the system time directly. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** A clock frozen at a single UTC instant (ISO 8601 with a trailing Z). */
export function fixedClock(iso: string): Clock {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new RangeError("fixedClock requires a valid ISO 8601 timestamp");
  }
  return { now: () => new Date(ms) };
}
