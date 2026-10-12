import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hashCanonical } from "../../src/domain/canonical.js";
import { redactSecrets } from "../../src/domain/redaction.js";
import { BundleError, buildBundle, serializeBundle, verifyBundle, type EvidenceBundle } from "../../src/services/evidence.js";
import { restoreBundle } from "../../src/services/restore.js";
import { createHarness } from "../helpers/harness.js";

/**
 * Review round 8 (logic and conformance P2, bundle-bounds.ts:61): verification refused an object key whose REDACTED form exceeds the 2,000-character cap only
 * for keys longer than 1,000 characters, on the premise that the marker is at most 10/6 as long as what it hides. The premise is false: `pwd: a|` repeated grows
 * 2.14 times, `x://:b@` 2.28 times, so a key of 994 characters (redacted 2,122 and 2,272) was accepted by verify and restore and every later export refused it
 * ("an object key is longer than 2000 characters"). Every key of six characters or more is redacted now, so that a key that verification accepts is a key that an export writes.
 */

const here = dirname(fileURLToPath(import.meta.url));
const ENGINE1 = readFileSync(resolve(here, "../fixtures/upgrade/engine1-bundle.json"), "utf8").replace(/\b([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12})\b/g, "$1-$2-$3-$4-$5");
const LIMIT = 64 * 1024 * 1024;
const CAP = 2000;

function reseal(bundle: Record<string, any>): string {
  const { bundle_hash: _drop, hashes: _h, stale_runs: _s, ...body } = bundle;
  const hashes = { snapshots: hashCanonical(body.snapshots), impact_runs: hashCanonical(body.impact_runs), contract_checks: hashCanonical(body.contract_checks) };
  const withHashes = { ...body, hashes };
  return JSON.stringify({ ...withHashes, bundle_hash: hashCanonical(withHashes) });
}
const withKey = (key: string): string => {
  const bundle = JSON.parse(ENGINE1) as Record<string, any>;
  bundle.impact_runs[0].assessment_detail.wide = { [key]: 1 };
  return reseal(bundle);
};
const codeOf = (text: string): string => {
  try {
    verifyBundle(text, { maxBytes: LIMIT });
    return "ACCEPTED";
  } catch (error) {
    return error instanceof BundleError ? error.code : String(error);
  }
};
const units = ["pwd: a|", "pwd: 1]", "x://:b@", "?token:\n", "Cookie:a\n", "pw=abcdef ", "password: a ", "secret=ab|", "sid=abcdef&", "token:a,"];
const repeated = (unit: string, length: number): string => unit.repeat(Math.ceil(length / unit.length)).slice(0, length);

describe("R8 (bundle-bounds.ts:61): a key is refused when its redacted form exceeds the cap, whatever its length", () => {
  it("control: the genuine bundle and a long key that redaction does not grow are accepted", () => {
    expect(codeOf(ENGINE1)).toBe("ACCEPTED");
    expect(codeOf(withKey("k".repeat(CAP)))).toBe("ACCEPTED");
    expect(codeOf(withKey(repeated("pwd: a|", 140)))).toBe("ACCEPTED");
  });

  it.each([
    ["`pwd: a|` x 142, 994 characters (redacted 2,122)", repeated("pwd: a|", 994)],
    ["`pwd: a|` at 1,000 characters", repeated("pwd: a|", 1000)],
    ["`pwd: a|` at 1,001 characters", repeated("pwd: a|", 1001)],
    ["`x://:b@` x 142, 994 characters (redacted 2,272)", repeated("x://:b@", 994)],
    ["`?token:` and a line feed, 1,000 characters", repeated("?token:\n", 1000)],
    ["raw 2,000 characters of `pwd: a|`", repeated("pwd: a|", 2000)],
  ])("%s: BUNDLE_SCHEMA_INVALID at verification and at restore", async (_label, key) => {
    expect(redactSecrets(key).length, "the redacted key is over the cap (precondition)").toBeGreaterThan(CAP);
    const text = withKey(key);
    expect(codeOf(text)).toBe("BUNDLE_SCHEMA_INVALID");
    const h = await createHarness();
    try {
      await expect(restoreBundle(h.ctx, text)).rejects.toMatchObject({ code: "BUNDLE_SCHEMA_INVALID" });
    } finally {
      await h.close();
    }
  }, 120_000);

  it("property: verification accepts a key exactly when its redacted form is within the cap (10 units x 7 lengths around the boundaries and a sweep from 6 to 2,000)", () => {
    const lengths = [...new Set([6, 7, 13, 50, 100, 400, 700, 800, 900, 993, 994, 995, 1000, 1001, 1100, 1500, 1999, 2000, 2001, ...Array.from({ length: 40 }, (_, i) => 6 + i * 50)])];
    for (const unit of units) {
      for (const length of lengths) {
        const key = repeated(unit, length);
        const redacted = redactSecrets(key).length;
        const expected = key.length > CAP || redacted > CAP ? "BUNDLE_SCHEMA_INVALID" : "ACCEPTED";
        expect(codeOf(withKey(key)), `${JSON.stringify(unit)} at ${length} (redacted ${redacted})`).toBe(expected);
      }
    }
  }, 120_000);

  it("round trip: a key right under the cap after redaction verifies, restores, exports in the workspace bundle and in the run bundle, and the exports verify", async () => {
    // the longest run of `pwd: a|` whose redacted form is within the cap: at most 2,000 characters after redaction
    let length = 6;
    while (redactSecrets(repeated("pwd: a|", length + 7)).length <= CAP && length + 7 <= 1000) length += 7;
    const key = repeated("pwd: a|", length);
    expect(redactSecrets(key).length, "under the cap (precondition)").toBeLessThanOrEqual(CAP);
    expect(redactSecrets(key).length, "close to the cap (precondition)").toBeGreaterThan(CAP - 20);
    const text = withKey(key);
    expect(codeOf(text)).toBe("ACCEPTED");
    const h = await createHarness();
    try {
      const summary = await restoreBundle(h.ctx, text);
      const exported = (await buildBundle(h.db, { workspaceId: summary.workspace_id }, h.now())) as EvidenceBundle;
      expect(codeOf(serializeBundle(exported)), "the workspace export verifies").toBe("ACCEPTED");
      const runId = (exported.impact_runs[0] as { id: string }).id;
      const single = (await buildBundle(h.db, { workspaceId: summary.workspace_id, runId }, h.now())) as EvidenceBundle;
      expect(codeOf(serializeBundle(single)), "the run bundle verifies").toBe("ACCEPTED");
    } finally {
      await h.close();
    }
  }, 240_000);
});
