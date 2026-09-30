import { capText, TEXT_CAP } from "../domain/derived-text.js";
import { redactSecrets } from "../domain/redaction.js";
import type { EvidenceBundle } from "./evidence.js";

/**
 * The values of a hash-consistent bundle that the database would refuse (a timestamp that is not a timestamp, a NUL character,
 * an integer past its column, a check the table's constraints reject): verification names them as a bundle rejection
 * (BUNDLE_SCHEMA_INVALID, exit 2) instead of letting a restore fail on a database message. The schema types already say what
 * each field is; this is what each column can HOLD. Restore also maps any database data or constraint error to the same code,
 * so a bound missed here still cannot surface as an unexplained failure.
 */

const INT4 = 2_147_483_647;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const FINDING_KEY = /^fnd_[0-9a-f]{20}$/;

/** A real calendar date and clock time (`Date.parse` accepts 31 February and rolls it over; the database does not). */
function isTimestamp(value: string): boolean {
  if (!TIMESTAMP.test(value)) return false;
  const [year, month, day, hour, minute, second] = value.slice(0, 19).split(/[-T:]/).map(Number) as [number, number, number, number, number, number];
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth && hour <= 23 && minute <= 59 && second <= 60;
}
const inRange = (value: number, min: number, max: number): boolean => Number.isInteger(value) && value >= min && value <= max;

const NUL = String.fromCharCode(0);

/** True when `text` holds a UTF-16 surrogate that has no partner (PostgreSQL jsonb refuses it, and a text column rewrites it). */
function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i += 1;
      else return true;
    } else if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
}

/**
 * The first thing at any depth that the database cannot hold or that restore would not keep: a NUL character (PostgreSQL text
 * cannot), an unpaired surrogate, or an object KEY longer than the text cap (restore caps every string value but a key has
 * no cap to cut to without merging two keys, so a longer key is refused; the redactor reads a key in full on every view).
 */
function unstorableText(value: unknown): string | null {
  if (typeof value === "string") return value.includes(NUL) ? "a text holds a NUL character" : hasLoneSurrogate(value) ? "a text holds an unpaired surrogate" : null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const problem = unstorableText(item);
      if (problem !== null) return problem;
    }
    return null;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (key.length > TEXT_CAP) return `an object key is longer than ${TEXT_CAP} characters`;
      // Redaction can LENGTHEN a key (a six-character value becomes the ten-character marker, and a repeated short unit such as `pwd: a|` grows 2.1 times), and every
      // export redacts the keys it writes and refuses one over the cap: a key that redaction lengthens past it would be accepted here and then never exportable. No
      // growth factor is assumed (the earlier premise of 10/6 was false): EVERY key of six characters or more is redacted (a shorter text is never changed), a key
      // is at most the cap long at this point, and the work is linear in it (200,000 ordinary keys take about 0.4 seconds).
      if (key.length >= 6 && redactSecrets(key).length > TEXT_CAP) return `an object key is longer than ${TEXT_CAP} characters once redacted`;
      const problem = unstorableText(key) ?? unstorableText(item);
      if (problem !== null) return problem;
    }
  }
  return null;
}

/** The first thing wrong with `bundle`'s values, or null. */
export function boundsProblem(bundle: EvidenceBundle): string | null {
  const unstorable = unstorableText(bundle);
  if (unstorable !== null) return unstorable;
  const stamps: [string, string | null | undefined][] = [["created_at", bundle.created_at], ["workspace created_at", bundle.workspace.created_at]];
  for (const s of bundle.snapshots) stamps.push(["snapshot imported_at", s.imported_at]);
  for (const c of bundle.contract_checks) stamps.push(["check created_at", c.created_at], ["check disabled_at", c.disabled_at]);
  for (const r of bundle.impact_runs) {
    stamps.push(["run created_at", r.created_at], ["run started_at", r.started_at], ["run finished_at", r.finished_at]);
    for (const e of r.events) stamps.push(["event at", e.at]);
    for (const c of r.checks) stamps.push(["check result started_at", c.started_at], ["check result finished_at", c.finished_at]);
  }
  for (const [label, value] of stamps) if (value !== null && value !== undefined && !isTimestamp(value)) return `${label} is not a timestamp`;

  if (!inRange(bundle.baseline.version, 0, INT4)) return "the baseline version is out of range";
  for (const s of bundle.snapshots) {
    if (!inRange(s.baseline_version, 0, INT4) || !inRange(s.node_count, 0, INT4) || !inRange(s.edge_count, 0, INT4)) return `snapshot ${s.id} holds a count that is out of range`;
  }
  for (const c of bundle.contract_checks) {
    if (!inRange(c.timeout_ms, 1, 120_000) || !inRange(c.retries, 0, 3) || !inRange(c.expect_status, 100, 599)) return `check ${c.key.slice(0, 40)} holds a timeout, retry count or status the table refuses`;
  }
  for (const r of bundle.impact_runs) {
    if (!inRange(r.baseline_version, 0, INT4)) return `run ${r.id} baseline version is out of range`;
    for (const f of r.findings) {
      if (!FINDING_KEY.test(f.finding_key)) return `run ${r.id} holds a finding id that is not fnd_ and 20 hex digits`;
      if (!inRange(f.position, 0, INT4) || !inRange(f.depth, 1, INT4) || !inRange(f.path_omitted_hops ?? 0, 0, INT4) || !inRange(f.change_ids_omitted ?? 0, 0, INT4)) return `run ${r.id} holds a finding count that is out of range`;
    }
  }
  // Restore cuts every key text to the cap, and the database keeps contract check keys (per workspace) and check result keys (per
  // run) unique: two keys that differ only past the cap are one key afterwards, so they are refused here, not by a unique violation.
  const seenChecks = new Set<string>();
  for (const c of bundle.contract_checks) {
    const kept = capText(c.key) as string;
    if (seenChecks.has(kept)) return `two contract check keys are the same after the cut to ${TEXT_CAP} characters`;
    seenChecks.add(kept);
  }
  for (const r of bundle.impact_runs) {
    const seenResults = new Set<string>();
    for (const c of r.checks) {
      const kept = capText(c.check_key) as string;
      if (seenResults.has(kept)) return `run ${r.id} holds two check results whose keys are the same after the cut to ${TEXT_CAP} characters`;
      seenResults.add(kept);
    }
  }
  return null;
}
