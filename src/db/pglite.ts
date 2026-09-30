import { PGlite } from "@electric-sql/pglite";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Database, QueryResult } from "./index.js";

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * The embedded engine is single process: two processes opening the same data directory would each load their own
 * copy of the files and silently diverge or corrupt it. An exclusive lock file next to the directory (`<dir>.lock`,
 * holding the owner's process id) refuses the second opener with a clear message. A lock whose owner is dead (a crash,
 * `kill -9`) is stale and is taken over. Returns the release function.
 */
const held = new Set<string>();

function lockDataDir(dataDir: string): () => void {
  const path = `${dataDir.replace(/[\\/]+$/, "")}.lock`;
  if (held.has(path)) throw new Error(`the embedded database at ${dataDir} is already open in this process; close it first`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; ; attempt += 1) {
    try {
      writeFileSync(path, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = Number.parseInt(readFileSync(path, "utf8"), 10);
      if (attempt === 0 && (!Number.isInteger(owner) || owner <= 0 || !isAlive(owner))) {
        rmSync(path, { force: true }); // stale: the owner is gone
        continue;
      }
      throw new Error(`the embedded database at ${dataDir} is in use by process ${owner}; only one process can use it at a time (stop that process first, or use PostgreSQL 17, which supports a separate worker; if no such process exists, delete ${path})`);
    }
  }
  held.add(path);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    held.delete(path);
    try {
      if (Number.parseInt(readFileSync(path, "utf8"), 10) === process.pid) rmSync(path, { force: true });
    } catch {
      // already gone
    }
  };
  process.once("exit", release);
  return release;
}

export async function openPglite(dataDir: string | undefined): Promise<Database> {
  const release = dataDir ? lockDataDir(dataDir) : () => undefined;
  let db: PGlite;
  try {
    db = dataDir ? new PGlite(dataDir) : new PGlite();
    await db.waitReady;
  } catch (error) {
    release();
    throw error;
  }
  return {
    kind: "pglite",
    async query<T>(text: string, params?: unknown[]): Promise<QueryResult<T>> {
      const result = await db.query<T>(text, params as unknown[]);
      return { rows: result.rows };
    },
    async exec(sql: string) {
      await db.exec(sql);
    },
    transaction(fn) {
      return db.transaction(async (tx) =>
        fn({
          async query<T>(text: string, params?: unknown[]): Promise<QueryResult<T>> {
            const result = await tx.query<T>(text, params as unknown[]);
            return { rows: result.rows };
          },
          async exec(sql: string) {
            await tx.exec(sql);
          },
        }),
      );
    },
    async close() {
      try {
        await db.close();
      } finally {
        release();
      }
    },
  };
}
