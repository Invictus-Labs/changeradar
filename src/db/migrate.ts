import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database } from "./index.js";

const MIGRATION_FILE = /^\d{3}_[a-z0-9_]+\.sql$/;
/** Arbitrary constant key for the advisory lock that serializes concurrent migrators. */
const MIGRATION_LOCK_KEY = 7_311_902_001;

/** Locate the repository migrations directory from source or compiled output. */
export function migrationsDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i += 1) {
    const candidate = join(dir, "migrations");
    if (existsSync(join(candidate, "001_identity.sql"))) return candidate;
    dir = dirname(dir);
  }
  throw new Error("changeradar: migrations directory not found");
}

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationError";
  }
}

export interface MigrationResult {
  applied: string[];
}

function listMigrations(dir: string): string[] {
  return readdirSync(dir).filter((f) => MIGRATION_FILE.test(f)).sort();
}

const checksumOf = (sql: string) => createHash("sha256").update(sql).digest("hex");

/**
 * Apply pending migrations in order inside ONE transaction guarded by an advisory lock. Either every
 * pending migration applies or none does: a failed migration leaves the schema exactly as it was and
 * throws, which keeps the server not-ready (no partially migrated boot). A modified applied migration
 * and a database that is ahead of this build are also refused.
 */
export async function migrate(db: Database, dir = migrationsDir()): Promise<MigrationResult> {
  const files = listMigrations(dir);
  const applied: string[] = [];
  // Content problems surface as MigrationError. Anything else (connection lost, permissions) propagates
  // unchanged, so callers can tell "the database is unavailable" from "a migration is broken".
  await db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);
    await tx.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL)",
    );
    const done = await tx.query<{ version: string; checksum: string }>("SELECT version, checksum FROM schema_migrations");
    const known = new Map(done.rows.map((r) => [r.version, r.checksum]));
    for (const version of known.keys()) {
      if (!files.includes(version)) {
        throw new MigrationError(`database has migration ${version} unknown to this build; refusing to start`);
      }
    }
    for (const file of files) {
      const sql = readFileSync(join(dir, file), "utf8");
      const checksum = checksumOf(sql);
      const previous = known.get(file);
      if (previous !== undefined) {
        if (previous !== checksum) throw new MigrationError(`applied migration ${file} was modified; refusing to start`);
        continue;
      }
      try {
        await tx.exec(sql);
      } catch (error) {
        throw new MigrationError(`migration ${file} failed: ${(error as Error).message}`);
      }
      await tx.query("INSERT INTO schema_migrations (version, checksum, applied_at) VALUES ($1, $2, now())", [file, checksum]);
      applied.push(file);
    }
  });
  return { applied };
}

/** True when every migration shipped with this build is recorded as applied (used by readiness). */
export async function isSchemaCurrent(db: Database, dir = migrationsDir()): Promise<boolean> {
  try {
    const done = await db.query<{ version: string }>("SELECT version FROM schema_migrations");
    const have = new Set(done.rows.map((r) => r.version));
    return listMigrations(dir).every((f) => have.has(f));
  } catch {
    return false;
  }
}
