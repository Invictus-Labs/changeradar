import pg from "pg";
import type { Database, Queryable, QueryResult } from "./index.js";

export function openPg(url: string): Database {
  const pool = new pg.Pool({
    connectionString: url,
    max: 10,
    // Without these, a busy or unreachable server makes requests wait for ever (all ten clients busy: the eleventh
    // caller queues without limit), and a stuck statement or an abandoned transaction pins a connection.
    connectionTimeoutMillis: 10_000,
    statement_timeout: 300_000,
    idle_in_transaction_session_timeout: 120_000,
  });
  // An idle client error must not crash the process; the next query surfaces the failure.
  pool.on("error", () => undefined);
  const run = async <T>(q: { query: pg.Pool["query"] }, text: string, params?: unknown[]): Promise<QueryResult<T>> => {
    const result = await q.query(text, params as unknown[]);
    return { rows: result.rows as T[] };
  };
  return {
    kind: "postgres",
    query: (text, params) => run(pool, text, params),
    exec: async (sql) => {
      await pool.query(sql);
    },
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const tx: Queryable = {
          query: (text, params) => run(client as unknown as pg.Pool, text, params),
          exec: async (sql) => {
            await client.query(sql);
          },
        };
        const result = await fn(tx);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}
