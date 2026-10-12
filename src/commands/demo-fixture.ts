import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The synthetic manifests of `fixtures/demo.json`, with every freshness token replaced. */
export interface DemoFixture {
  fixture_version: number;
  manifests: {
    baseline: Record<string, unknown>;
    baseline_with_unverified_edge: Record<string, unknown>;
    proposal_breaking_removal: Record<string, unknown>;
    proposal_no_known_impact: Record<string, unknown>;
  };
  expected: Record<string, { assessment: string; [key: string]: unknown }>;
}

const FRESH_TOKEN = "@FRESH@";
const DAY_MS = 24 * 60 * 60 * 1000;

/** Locate `fixtures/demo.json` from source or compiled output (the package ships it next to `dist`). */
export function demoFixturePath(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i += 1) {
    const candidate = join(dir, "fixtures", "demo.json");
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error("changeradar: fixtures/demo.json not found");
}

const replaceTokens = (value: unknown, fresh: string): unknown => {
  if (value === FRESH_TOKEN) return fresh;
  if (Array.isArray(value)) return value.map((item) => replaceTokens(item, fresh));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceTokens(item, fresh)]));
  return value;
};

/**
 * Load the demo manifests. Edges are stamped as verified one day before `now` (UTC, whole seconds): staleness is
 * judged against the server's real clock (default maximum age 30 days), so a fixed date would turn every demo run
 * INCOMPLETE once it aged. Callers with a fixed clock pass it in and get byte-identical manifests.
 */
export function loadDemoFixture(now: Date, path: string = demoFixturePath()): DemoFixture {
  const fresh = new Date(Math.floor((now.getTime() - DAY_MS) / 1000) * 1000).toISOString().replace(".000Z", "Z");
  return replaceTokens(JSON.parse(readFileSync(path, "utf8")), fresh) as DemoFixture;
}

/** File names written by `changeradar sample-manifests`, and what each one is for. */
export const SAMPLE_FILES: Record<string, string> = {
  "baseline.json": "a synthetic multi-service manifest; import it as the baseline snapshot",
  "baseline-with-unverified-edge.json": "the same graph with one consumer edge never verified; import it to see INCOMPLETE",
  "proposal-breaking-removal.json": "a proposal that removes a required contract field; assess it to see AFFECTED",
  "proposal-no-known-impact.json": "a proposal that only adds an optional field; assess it to see NO_KNOWN_IMPACT",
  "snapshot-request.json": "the baseline wrapped as a ready-to-post POST /api/v1/snapshots request body",
};

/**
 * Write the synthetic sample manifests to `dir` (created owner-only). Existing files are never overwritten.
 * Returns the paths written.
 */
export function writeSampleManifests(dir: string, now: Date): string[] {
  const fixture = loadDemoFixture(now);
  const bodies: Record<string, unknown> = {
    "baseline.json": fixture.manifests.baseline,
    "baseline-with-unverified-edge.json": fixture.manifests.baseline_with_unverified_edge,
    "proposal-breaking-removal.json": fixture.manifests.proposal_breaking_removal,
    "proposal-no-known-impact.json": fixture.manifests.proposal_no_known_impact,
    "snapshot-request.json": { schema_version: 1, revision: "sample-baseline-1", manifest: fixture.manifests.baseline },
  };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const written: string[] = [];
  for (const [name, body] of Object.entries(bodies)) {
    const path = join(dir, name);
    writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    written.push(path);
  }
  return written;
}
