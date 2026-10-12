import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openPg } from "../../src/db/pg.js";

const poolState = vi.hoisted(() => ({ current: null as object | null }));
vi.mock("pg", () => ({ default: { Pool: class {
  constructor() { if (!poolState.current) throw new Error("missing fixture pool"); return poolState.current; }
} } }));

function fixture() {
  const client = new EventEmitter();
  const query = vi.fn(async (_sql: string): Promise<{ rows: unknown[] }> => ({ rows: [] }));
  const release = vi.fn();
  Object.assign(client, { query, release });
  const pool = new EventEmitter();
  const connect = vi.fn(async () => client);
  Object.assign(pool, { connect, end: vi.fn(async () => undefined) });
  poolState.current = pool;
  return { client, query, release, connect, db: openPg("postgres://synthetic.invalid/fixture") };
}
afterEach(() => { poolState.current = null; });

describe("checked-out PostgreSQL transaction connection errors", () => {
  it("contains the independent error event, rejects the query, discards once and permits a fresh transaction", async () => {
    const f = fixture();
    const disconnected = Object.assign(new Error("synthetic disconnect"), { code: "57P01" });
    let rejectQuery!: (error: Error) => void;
    f.query.mockImplementation(async (sql) => sql === "SELECT pending"
      ? new Promise<{ rows: unknown[] }>((_resolve, reject) => { rejectQuery = reject; }) : { rows: [] });
    const transaction = f.db.transaction((tx) => tx.query("SELECT pending"));
    const rejected = expect(transaction).rejects.toBe(disconnected);
    await vi.waitFor(() => expect(f.query).toHaveBeenCalledWith("SELECT pending", undefined));
    // pg.Client first schedules rejected-query callbacks, then emits error independently.
    process.nextTick(() => rejectQuery(disconnected));
    try {
      expect(() => f.client.emit("error", disconnected)).not.toThrow();
    } finally {
      // Settle the queued query even when the old-source containment assertion fails.
      await rejected;
    }
    expect(f.query.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN", "SELECT pending", "ROLLBACK"]);
    expect(f.release).toHaveBeenCalledExactlyOnceWith(disconnected);
    expect(f.client.listenerCount("error")).toBe(0);
    const healthy = new EventEmitter();
    const healthyQuery = vi.fn(async () => ({ rows: [] }));
    const healthyRelease = vi.fn();
    Object.assign(healthy, { query: healthyQuery, release: healthyRelease });
    f.connect.mockResolvedValueOnce(healthy);
    await expect(f.db.transaction(async () => "recovered")).resolves.toBe("recovered");
    expect(healthyQuery.mock.calls).toEqual([["BEGIN"], ["COMMIT"]]);
    expect(healthyRelease).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(healthy.listenerCount("error")).toBe(0);
  });
  it("cannot certify success when a disconnect occurs between queries, even if callback returns", async () => {
    const f = fixture(); const disconnected = new Error("synthetic between-query disconnect");
    await expect(f.db.transaction(async () => { f.client.emit("error", disconnected); return "unsafe"; })).rejects.toBe(disconnected);
    expect(f.query.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN", "ROLLBACK"]);
    expect(f.release).toHaveBeenCalledExactlyOnceWith(disconnected);
    expect(f.client.listenerCount("error")).toBe(0);
  });
  it("preserves an ordinary callback failure and releases a healthy connection once", async () => {
    const f = fixture(); const failure = new Error("synthetic callback failure");
    await expect(f.db.transaction(async () => { throw failure; })).rejects.toBe(failure);
    expect(f.query.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN", "ROLLBACK"]);
    expect(f.release).toHaveBeenCalledTimes(1);
    expect(f.release.mock.calls[0]?.[0]).toBeUndefined();
    expect(f.client.listenerCount("error")).toBe(0);
  });
});
