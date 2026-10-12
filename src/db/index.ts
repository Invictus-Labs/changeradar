import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";

export interface QueryResult<T> {
  rows: T[];
}

export interface Queryable {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
  /** Run a multi-statement script without parameters (migrations only). */
  exec(sql: string): Promise<void>;
}

export interface Database extends Queryable {
  readonly kind: "postgres" | "pglite";
  /**
   * Run `fn` in one transaction. Inside `fn` use ONLY the `tx` handle: on the embedded engine a query
   * issued on the outer handle waits for the open transaction and would deadlock.
   */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * Open a database from a URL.
 * - postgres://... or postgresql://... uses a node-postgres pool (production path, PostgreSQL 17 target).
 * - pglite:memory or pglite:<dir> uses embedded PostgreSQL (standalone mode and default tests).
 * Both run the same SQL migrations and the same application SQL.
 */
export async function openDatabase(url: string): Promise<Database> {
  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) {
    const { openPg } = await import("./pg.js");
    return openPg(url);
  }
  if (url.startsWith("pglite:")) {
    const target = url.slice("pglite:".length);
    const { openPglite } = await import("./pglite.js");
    if (target === "memory" || target === "") return openPglite(undefined);
    if (!existsSync(target)) await mkdir(target, { recursive: true, mode: 0o700 });
    return openPglite(target);
  }
  throw new Error("CHANGERADAR_DATABASE_URL must start with postgres://, postgresql:// or pglite:");
}
