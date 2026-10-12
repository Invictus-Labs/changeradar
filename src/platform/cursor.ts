import { badRequest } from "./errors.js";

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 50;

/** Opaque cursor: base64url of a small JSON tuple. Malformed cursors are a 400, never a crash. */
export function encodeCursor(parts: readonly (string | number)[]): string {
  return Buffer.from(JSON.stringify(parts), "utf8").toString("base64url");
}

/**
 * What one part of a cursor must be, so that nothing malformed reaches the SQL cast (a 500 there):
 *   number  a non-negative safe integer (a `bigint` id)      int4  a non-negative integer that fits a 4 byte column
 *   iso     a `YYYY-MM-DDTHH:MM:SS[.fff]Z` timestamp that is a real date (no 2026-02-31, no bare year, no expanded year)
 *   uuid    a UUID                                            string  any text
 */
export type CursorPart = "string" | "number" | "int4" | "iso" | "uuid";

const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?Z$/;
const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function partIsValid(value: unknown, part: CursorPart): boolean {
  switch (part) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
    case "int4":
      return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647;
    case "uuid":
      return typeof value === "string" && UUID_TEXT.test(value);
    case "iso": {
      const m = typeof value === "string" ? ISO_TIMESTAMP.exec(value) : null;
      if (m === null) return false;
      const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
      if (year < 1 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
      // A real calendar date: the day must exist in that month.
      return day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
    }
  }
}

export function decodeCursor(cursor: string | undefined, shape: readonly CursorPart[]): (string | number)[] | null {
  if (cursor === undefined || cursor === "") return null;
  if (cursor.length > 512) throw badRequest("INVALID_CURSOR", "cursor is not valid");
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (Array.isArray(parsed) && parsed.length === shape.length && parsed.every((v, i) => partIsValid(v, shape[i] as CursorPart))) {
      return parsed as (string | number)[];
    }
  } catch {
    // fall through to the uniform error
  }
  throw badRequest("INVALID_CURSOR", "cursor is not valid");
}

/** Parses `?limit=`: default 50, at most 100, positive integers only. */
export function parseLimit(raw: unknown): number {
  if (raw === undefined) return DEFAULT_PAGE_SIZE;
  const value = typeof raw === "string" && /^\d{1,4}$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(value) || value < 1 || value > MAX_PAGE_SIZE) {
    throw badRequest("INVALID_LIMIT", `limit must be an integer between 1 and ${MAX_PAGE_SIZE}`);
  }
  return value;
}

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}
