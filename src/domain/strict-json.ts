/**
 * Strict JSON parsing for every place untrusted JSON enters (API bodies, manifests, evidence bundles).
 *
 * `JSON.parse` keeps the LAST of several equal keys, so a reviewer reading `"verified_at":"1999-…"` earlier in a
 * document would see a different value than the one stored. That is rejected here, including keys that are equal
 * only after unicode escapes are decoded (`"owner"` and `"owner"`). Nesting depth and the number of
 * containers are limited BEFORE the real parse, so a body of a few million tiny `[]`/`{}` cannot make the engine
 * allocate hundreds of megabytes. The pre-scan is iterative, linear and tolerant of malformed text (which
 * `JSON.parse` then rejects), and error messages never echo any part of the input.
 */

export type JsonRejection = "MALFORMED_JSON" | "DUPLICATE_JSON_KEY" | "JSON_TOO_COMPLEX";

export class JsonRejectedError extends Error {
  constructor(
    readonly code: JsonRejection,
    message: string,
  ) {
    super(message);
    this.name = "JsonRejectedError";
  }
}

export interface StrictJsonOptions {
  /** Maximum container nesting. Manifests nest fewer than ten levels; the default leaves ample room. */
  readonly maxDepth?: number;
  /** Maximum number of objects plus arrays. Default: one per 8 bytes of input, at least 100,000. */
  readonly maxContainers?: number;
}

export const DEFAULT_MAX_DEPTH = 64;

interface Frame {
  /** Keys seen so far in this object; null for an array. */
  keys: Set<string> | null;
  expectKey: boolean;
}

/** Throws JsonRejectedError for duplicate keys, excessive depth or too many containers. Never parses values. */
export function checkJsonStructure(text: string, options: StrictJsonOptions = {}): void {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxContainers = options.maxContainers ?? Math.max(100_000, Math.floor(text.length / 8));
  const stack: Frame[] = [];
  let containers = 0;
  const n = text.length;
  for (let i = 0; i < n; i += 1) {
    const c = text.charCodeAt(i);
    if (c === 123 /* { */ || c === 91 /* [ */) {
      containers += 1;
      if (containers > maxContainers) throw new JsonRejectedError("JSON_TOO_COMPLEX", "JSON has too many objects and arrays");
      if (stack.length >= maxDepth) throw new JsonRejectedError("JSON_TOO_COMPLEX", `JSON is nested deeper than ${maxDepth} levels`);
      stack.push({ keys: c === 123 ? new Set<string>() : null, expectKey: c === 123 });
    } else if (c === 125 /* } */ || c === 93 /* ] */) {
      stack.pop();
    } else if (c === 34 /* " */) {
      let end = text.indexOf('"', i + 1);
      while (end !== -1) {
        let back = end - 1;
        while (back > i && text.charCodeAt(back) === 92) back -= 1;
        if ((end - 1 - back) % 2 === 0) break; // an even run of backslashes does not escape the quote
        end = text.indexOf('"', end + 1);
      }
      if (end === -1) return; // unterminated: JSON.parse rejects it
      const frame = stack[stack.length - 1];
      if (frame && frame.keys !== null && frame.expectKey) {
        const raw = text.slice(i + 1, end);
        let key = raw;
        if (raw.includes("\\")) {
          try {
            key = JSON.parse(`"${raw}"`) as string;
          } catch {
            key = raw; // invalid escape: JSON.parse rejects the document anyway
          }
        }
        if (frame.keys.has(key)) throw new JsonRejectedError("DUPLICATE_JSON_KEY", "JSON contains the same object key more than once");
        frame.keys.add(key);
        frame.expectKey = false;
      }
      i = end;
    } else if (c === 44 /* , */) {
      const frame = stack[stack.length - 1];
      if (frame && frame.keys !== null) frame.expectKey = true;
    }
  }
}

/** Strict parse: structure checks first, then the ordinary parse. Throws JsonRejectedError for every rejection. */
export function parseStrictJson(text: string, options: StrictJsonOptions = {}): unknown {
  checkJsonStructure(text, options);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new JsonRejectedError("MALFORMED_JSON", "Body is not valid JSON");
  }
}
