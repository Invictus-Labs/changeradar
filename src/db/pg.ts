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
      // pg-pool removes the idle error listener while a client is checked out.
      // Connection errors also emit on the client, independently of rejected queries.
      let clientError: Error | undefined;
      const onClientError = (error: Error): void => { clientError ??= error; };
      client.on("error", onClientError);
      try {
        await client.query("BEGIN");
        const tx: Queryable = {
          query: (text, params) => run(client as unknown as pg.Pool, text, params),
          exec: async (sql) => {
            await client.query(sql);
          },
        };
        const result = await fn(tx);
        if (clientError) throw clientError;
        await client.query("COMMIT");
        if (clientError) throw clientError;
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        try {
          // Discard a disconnected client; release restores the pool's idle listener.
          client.release(clientError);
        } finally {
          client.removeListener("error", onClientError);
        }
      }
    },
    close: () => pool.end(),
  };
}
