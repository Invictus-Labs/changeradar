/**
 * The one bound on stored and derived free text. A restore cuts every string it turns into live state to this many characters
 * (an untrusted bundle must not become unbounded state), and the decision engine cuts every string it DERIVES (unknown
 * messages, finding reasons) to the same length when it creates them. The two must agree: a derived string longer than the
 * restore cap would be cut by a restore, and verification (which re-derives the run and compares) would then refuse every
 * later export of the restored installation.
 */
export const TEXT_CAP = 2000;

import { redactSecrets } from "./redaction.js";

const MARKER = "[REDACTED]";

/** A marker of a record stands behind a credential-shaped word and its separator: `access_token:[REDACTED]`, `key=[REDACTED]`. */
const AFTER_WORD = /[A-Za-z0-9_.-][:=]$/;
/** The members of a derived record that hold free text built from manifest names: the only strings that masked equality reads (see maskedEqualDeep). */
const FREE_TEXT = new Set(["message", "reason", "description"]);
/**
 * True when a recorded text has the shape of a cut of a longer derivation: a cut lands at the cap, or up to MARKER.length - 1 characters earlier when it would split a
 * surrogate pair or a marker (the cut drops the half). Such a record is matched as a masked PREFIX of the derivation, any other keeps both anchors. (A cut that drops the
 * partial word glued to its last marker ends AT that marker, and a record that ends at a marker already matches with both anchors: the marker hides the rest.)
 */
export function looksCut(recorded: string): boolean {
  return recorded.length <= TEXT_CAP && recorded.length > TEXT_CAP - MARKER.length;
}

/**
 * `text` cut to the cap. A cut never lands INSIDE a redaction marker: the marker that the cut would split is dropped whole, because a
 * half marker (`[REDACT`) is read as a value by the next redaction and grows back into a whole one, and then the same text cut
 * before and after redacting would differ. Redaction can LENGTHEN text (`api_key:abc` becomes `api_key:[REDACTED]`), so a bound that
 * holds before redaction is not one after it: every stored or compared text is cut AFTER redacting (evidence.ts), through this function.
 */
function cut(text: string, limit: number = TEXT_CAP): string {
  if (text.length <= limit) return text;
  let end = limit;
  const marker = text.lastIndexOf(MARKER, end - 1);
  if (marker >= 0 && marker + MARKER.length > end) end = marker;
  // A cut never separates the two halves of a surrogate pair either: a lone half is refused by the database (jsonb), and by
  // verification (bundle-bounds.ts), so a text cut in the middle of an astral character would export and then not restore.
  const last = text.charCodeAt(end - 1);
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1;
  const out = text.slice(0, end);
  // A cut of REDACTED text must leave text that redaction leaves alone (round 8): the cut can land behind a marker, inside the first letters of the next credential-shaped
  // word (`access_token:[REDACTED]api`), and the redactor reads that partial word as a value and hides it, so the stored text would not be a fixed point and
  // neither reading of verification would match it. The partial word glued to the last marker is dropped with the rest of the tail.
  const mark = out.lastIndexOf(MARKER);
  if (mark >= 0 && mark + MARKER.length < out.length && redactSecrets(out) !== out) return out.slice(0, mark + MARKER.length);
  return out;
}

/**
 * The bound on a text that verification compares with its own derivation: a run written by an earlier build may hold a derived
 * message longer than TEXT_CAP (it was cut at 2,000 only from round 5 on), and redacting a text of any length is work, so both
 * sides of a comparison are cut to this many characters (four times the cap) BEFORE they are redacted. A RECORDED text longer than
 * this is refused (exceedsBound), never compared on its prefix; only the text this build derives is cut, which it may be for a
 * manifest with very many unknown field names.
 */
export const COMPARE_BOUND = 4 * TEXT_CAP;

/** Every string inside a JSON value cut to `limit` (a cut never splits a marker or a surrogate pair). */
export const boundLeaves = (value: unknown, limit: number = COMPARE_BOUND): unknown => {
  if (typeof value === "string") return cut(value, limit);
  if (Array.isArray(value)) return value.map((item) => boundLeaves(item, limit));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, boundLeaves(item, limit)]));
  return value;
};

export const boundText = (text: string, limit: number = COMPARE_BOUND): string => cut(text, limit);

/**
 * True when any string inside a JSON value is longer than `limit`. Verification refuses a recorded text longer than COMPARE_BOUND
 * instead of comparing its prefix: a decision engine of this version derives at most TEXT_CAP characters per text, an earlier build
 * at most a few thousand, and a text of any other length is not a record of either (cost of reading it is linear, of redacting it is not).
 */
export const exceedsBound = (value: unknown, limit: number = COMPARE_BOUND): boolean => {
  if (typeof value === "string") return value.length > limit;
  if (Array.isArray(value)) return value.some((item) => exceedsBound(item, limit));
  if (value !== null && typeof value === "object") return Object.values(value).some((item) => exceedsBound(item, limit));
  return false;
};

export const capText = (text: string | null): string | null => (text !== null ? cut(text) : text);

/** The same bound for every string INSIDE a JSON value (unknowns, assessment detail, warnings, check definitions and results). */
export const capLeaves = (value: unknown): unknown => {
  if (typeof value === "string") return cut(value);
  if (Array.isArray(value)) return value.map(capLeaves);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, capLeaves(item)]));
  return value;
};

/** A derived string, cut to the cap when it is longer (identity below the cap, so short text is byte for byte what it was). */
export const capDerived = (text: string): string => cut(text);

/**
 * MASKED EQUALITY of a derived text and a recorded one: the recorded text is what an earlier build's redactor left of the derived text, and two
 * redactors do not hide the same pieces (`edge auth:issuer|consumes|token:service was never verified` was written `edge auth:[REDACTED] was never verified`
 * by the builds before round 7 and is `edge auth:[REDACTED]token:[REDACTED] was never verified` now), so neither redacting the recorded text again nor the derived
 * one gives the other. Split at the markers, the visible fragments of the recorded text must stand in the derived text LITERALLY and IN ORDER, the first at its start, the
 * last at its end, and each marker stands for a NON-EMPTY span between them: what the record shows is always in the derivation, only what it hides may be anything.
 * A greedy search finds the earliest place of each fragment, which is the best choice for an in-order match, and each search is bounded by the compare bound
 * (verification refuses a recorded text longer than COMPARE_BOUND before it gets here), so the cost does not grow with the number of markers.
 */
export function maskedEqual(derived: string, recorded: string, prefix = false): boolean {
  const parts = recorded.split(MARKER);
  if (parts.length === 1) return prefix ? derived.startsWith(recorded) : derived === recorded;
  // Every marker stands behind a credential-shaped word and its separator (`access_token:[REDACTED]`): a record that is one marker, two markers side by side or
  // `edge [REDACTED]` is not something the redactor writes, and accepting it would let a resealed bundle blank a text. (The fragments tested are the ones in front of a
  // marker, all but the last.) With `prefix` the record is a CUT of the derivation (see looksCut): it may end anywhere inside it.
  for (let i = 0; i < parts.length - 1; i += 1) if (!AFTER_WORD.test(parts[i] as string)) return false;
  const first = parts[0] as string;
  const last = parts[parts.length - 1] as string;
  if (!derived.startsWith(first)) return false;
  let at = first.length;
  for (let i = 1; i < parts.length - 1; i += 1) {
    const fragment = parts[i] as string;
    // the marker in front of the fragment hides at least one character, so the fragment starts at `at + 1` or later (an empty fragment, two markers side by side,
    // is found at the end of the text at the latest, and the last check then fails because nothing is left for the marker behind it)
    const found = derived.indexOf(fragment, at + 1);
    if (found < 0) return false;
    at = found + fragment.length;
  }
  // A record that is a CUT of the derivation (a restore cut it at the cap) ends somewhere inside it: the last fragment then stands anywhere behind the last hidden span
  // and nothing is required after it.
  if (prefix) return derived.indexOf(last, at + 1) >= at + 1;
  return derived.length - last.length >= at + 1 && derived.endsWith(last);
}

/**
 * Masked equality of two JSON values of the same shape (arrays of one length, objects of one set of keys, equal numbers, booleans and nulls): every string of the
 * recorded value matches the derived one under `maskedEqual`. A key of the recorded object that holds a marker matches a key of the derived object the same way (at
 * most 32 such keys: it is a search, and nothing legitimate has more).
 */
export function maskedEqualDeep(derived: unknown, recorded: unknown, free = false): boolean {
  // Only the free text members are read by masked equality (a code, an id, an edge, a node id, a hash and the assessment are compared exactly), and a record that looks
  // like a cut of the derivation is read as its masked prefix.
  if (typeof recorded === "string") return typeof derived === "string" && (free ? maskedEqual(derived, recorded, looksCut(recorded)) : derived === recorded);
  if (Array.isArray(recorded)) return Array.isArray(derived) && derived.length === recorded.length && recorded.every((item, i) => maskedEqualDeep(derived[i], item, free));
  if (recorded !== null && typeof recorded === "object") {
    if (derived === null || typeof derived !== "object" || Array.isArray(derived)) return false;
    const d = derived as Record<string, unknown>;
    const keys = Object.keys(recorded);
    if (keys.length !== Object.keys(d).length) return false;
    const used = new Set<string>();
    let searched = 0;
    for (const key of keys) {
      let match: string | undefined = Object.hasOwn(d, key) && !used.has(key) ? key : undefined;
      if (match === undefined && key.includes(MARKER)) {
        searched += 1;
        if (searched > 32) return false;
        match = Object.keys(d).find((candidate) => !used.has(candidate) && maskedEqual(candidate, key));
      }
      if (match === undefined) return false;
      used.add(match);
      if (!maskedEqualDeep(d[match], (recorded as Record<string, unknown>)[key], FREE_TEXT.has(match))) return false;
    }
    return true;
  }
  return derived === recorded;
}
