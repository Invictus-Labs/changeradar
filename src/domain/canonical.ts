import { createHash } from "node:crypto";

/**
 * Canonical JSON encoding used for every content hash in ChangeRadar.
 *
 * Rules (documented in docs/DOMAIN.md):
 * - UTF-8, no insignificant whitespace.
 * - Object keys are sorted by UTF-16 code unit order (plain string comparison, never locale aware).
 * - Array order is preserved; callers sort arrays whose order is not meaningful.
 * - Strings use JSON string escaping; numbers must be finite (integers or plain decimals as JSON.stringify prints them).
 * - Object properties whose value is `undefined` are omitted. `undefined`, functions, symbols, bigint
 *   and non-finite numbers elsewhere are rejected with a TypeError.
 */
export function canonicalJson(value: unknown): string {
  return encode(value, new Set<object>());
}

function encode(value: unknown, stack: Set<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError("canonicalJson: non-finite number");
      }
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new TypeError(`canonicalJson: unsupported value of type ${typeof value}`);
  }
  const obj = value as object;
  if (stack.has(obj)) {
    throw new TypeError("canonicalJson: circular structure");
  }
  stack.add(obj);
  try {
    if (Array.isArray(obj)) {
      const parts: string[] = [];
      for (const item of obj) {
        if (item === undefined) {
          throw new TypeError("canonicalJson: undefined array element");
        }
        parts.push(encode(item, stack));
      }
      return `[${parts.join(",")}]`;
    }
    const record = obj as Record<string, unknown>;
    const keys = Object.keys(record).sort(compareStrings);
    const parts: string[] = [];
    for (const key of keys) {
      const v = record[key];
      if (v === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${encode(v, stack)}`);
    }
    return `{${parts.join(",")}}`;
  } finally {
    stack.delete(obj);
  }
}

/** Locale independent string comparison (UTF-16 code unit order). */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** `sha256:<64 hex>` over the canonical JSON encoding of `value`. */
export function hashCanonical(value: unknown): string {
  return `sha256:${sha256Hex(canonicalJson(value))}`;
}

const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

export function isHashString(value: unknown): value is string {
  return typeof value === "string" && HASH_PATTERN.test(value);
}

/** Short deterministic identifier: `<prefix>_<first 20 hex chars of sha256(canonical(value))>`. */
export function stableId(prefix: string, value: unknown): string {
  return `${prefix}_${sha256Hex(canonicalJson(value)).slice(0, 20)}`;
}
