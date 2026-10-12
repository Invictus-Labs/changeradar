import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hashCanonical } from "../../src/domain/canonical.js";
import { buildBundle, serializeBundle, verifyBundle, type EvidenceBundle } from "../../src/services/evidence.js";
import { restoreBundle } from "../../src/services/restore.js";
import { e, f, FRESH, manifest, n } from "../helpers/builders.js";
import { createHarness } from "../helpers/harness.js";

/**
 * Review round 8 (logic P1, evidence.ts:537): a bundle written by 435731e or 201e614 did not verify or restore when a message of the run held TWO ids of the
 * form `<credential word>:<value>` (`edge auth:issuer|consumes|token:service was never verified`): those builds hid the first value only
 * (`edge auth:[REDACTED] was never verified`), this one hides both (`edge auth:[REDACTED]token:[REDACTED] was never verified`), and neither redacting
 * the recorded text again nor the derived text gives the other. A third reading compares by MASKED EQUALITY: the visible fragments of the recorded text must appear,
 * literally and in order, in the derived text, and every marker stands for a non-empty span of it. The recorded forms below are what the two builds wrote (captured
 * from their redactors: the text of `redactSecrets` of the derived message in each tree).
 */

const PAIRS: [string, string, string, string][] = [
  // [source id, target id, what 435731e and 201e614 wrote for "edge <source>|consumes|<target> was never verified", what this build writes]
  ["auth:issuer", "token:service", "edge auth:[REDACTED] was never verified", "edge auth:[REDACTED]token:[REDACTED] was never verified"],
  ["api_key:abcdefgh", "password:abcdefgh", "edge api_key:[REDACTED] was never verified", "edge api_key:[REDACTED]password:[REDACTED] was never verified"],
  ["secret:abcdef", "token:abcdefgh", "edge secret:[REDACTED] was never verified", "edge secret:[REDACTED]token:[REDACTED] was never verified"],
];

// the consumer `source` reads the field `id` of the contract `target` over an edge that was never verified; the proposal drops that field
const withEdge = (source: string, target: string, contractFields: string[]) =>
  manifest([n(target, "contract", { owner: "team-c", fields: contractFields.map((name) => f(name)) }), n(source, "service", { owner: "team-k" })], [e(source, target, "consumes", { fields: ["id"], verified_at: null })]);

function reseal(bundle: Record<string, any>): string {
  const { bundle_hash: _drop, hashes: _h, stale_runs: _s, ...body } = bundle;
  const hashes = { snapshots: hashCanonical(body.snapshots), impact_runs: hashCanonical(body.impact_runs), contract_checks: hashCanonical(body.contract_checks) };
  const withHashes = { ...body, hashes };
  return JSON.stringify({ ...withHashes, bundle_hash: hashCanonical(withHashes) });
}
const LIMITS = { maxBytes: 64 * 1024 * 1024 };
const verdictOf = (text: string): string => {
  try {
    verifyBundle(text, LIMITS);
    return "verifies";
  } catch (error) {
    return `refused: ${String((error as { code?: string }).code ?? error)}`;
  }
};

/** Every string inside a JSON value with `from` replaced by `to` (the recorded message lives in the unknowns and in the assessment detail). */
const replaceEverywhere = (value: unknown, from: string, to: string): unknown => {
  if (typeof value === "string") return value.split(from).join(to);
  if (Array.isArray(value)) return value.map((item) => replaceEverywhere(item, from, to));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceEverywhere(item, from, to)]));
  return value;
};

describe("R8 (logic P1): a bundle written by 435731e or 201e614 with two credential-shaped ids in one message verifies, restores, exports and verifies again", () => {
  it.each(PAIRS)("ids %s and %s", async (source, target, legacy, fresh) => {
    const src = await createHarness();
    let base = "";
    try {
      const w = await src.workspace("Legacy8");
      const snap = await src.importSnapshot(w.operator, withEdge(source, target, ["id", "amount"]), { revision: "release-1" });
      expect(snap.status, JSON.stringify(snap.body)).toBe(201);
      await src.requestRun(w.operator, { snapshot_id: snap.body.id, proposed_manifest: withEdge(source, target, ["amount"]), expected_hash: snap.body.hash, run_checks: false });
      await src.drain();
      base = serializeBundle((await buildBundle(src.db, { workspaceId: w.id }, src.now())) as EvidenceBundle);
    } finally {
      await src.close();
    }
    expect(verdictOf(base), "the bundle this build writes (control)").toBe("verifies");
    expect(base.includes(fresh), `the bundle holds the message as this build writes it: ${fresh}; its unknowns: ${JSON.stringify((JSON.parse(base) as { impact_runs: { unknowns: unknown }[] }).impact_runs[0]?.unknowns).slice(0, 600)}`).toBe(true);

    const bundle = replaceEverywhere(JSON.parse(base), fresh, legacy) as Record<string, any>;
    const text = reseal(bundle);
    expect(text.includes(legacy) && !text.includes(fresh), "the forged bundle carries the legacy form only").toBe(true);
    expect(verdictOf(text), "verify-bundle of the legacy form").toBe("verifies");

    const dst = await createHarness();
    try {
      const summary = await restoreBundle(dst.ctx, text).then((s) => s, (error: unknown) => ({ workspace_id: "", message: String(error) }));
      expect((summary as { message?: string }).message, "restore of the legacy form").toBeUndefined();
      const again = await buildBundle(dst.db, { workspaceId: (summary as { workspace_id: string }).workspace_id }, dst.now()).then(
        (b) => b,
        (error: unknown) => `refused: ${String(error).slice(0, 120)}`,
      );
      expect(typeof again, "the workspace export after the restore").toBe("object");
      expect(verdictOf(serializeBundle(again as EvidenceBundle)), "the re-exported bundle verifies").toBe("verifies");
    } finally {
      await dst.close();
    }
  }, 240_000);

  it("a bundle that SHOWS text the derived message lacks, or hides more or less than a marker can, is refused (negative controls)", async () => {
    const [source, target, legacy, fresh] = PAIRS[0] as (typeof PAIRS)[number];
    const src = await createHarness();
    let base = "";
    try {
      const w = await src.workspace("Negative8");
      const snap = await src.importSnapshot(w.operator, withEdge(source, target, ["id", "amount"]), { revision: "release-1" });
      await src.requestRun(w.operator, { snapshot_id: snap.body.id, proposed_manifest: withEdge(source, target, ["amount"]), expected_hash: snap.body.hash, run_checks: false });
      await src.drain();
      base = serializeBundle((await buildBundle(src.db, { workspaceId: w.id }, src.now())) as EvidenceBundle);
    } finally {
      await src.close();
    }
    const forged = (message: string): string => reseal(replaceEverywhere(JSON.parse(base), fresh, message) as Record<string, any>);
    const refused = [
      ["a fragment out of order", "edge auth:[REDACTED] never verified was"],
      ["a visible character that the derived text lacks", "edge auth:[REDACTED]! was never verified"],
      ["an unanchored start", "x edge auth:[REDACTED] was never verified"],
      ["an unanchored end", "edge auth:[REDACTED] was never"],
      ["an extra visible tail", "edge auth:[REDACTED] was never verified twice"],
      ["the fragments of another text", "edge token:[REDACTED] was never verified"],
    ] as const;
    for (const [label, message] of refused) expect(verdictOf(forged(message)), label).toBe("refused: BUNDLE_RUN_INCONSISTENT");
    // and the two forms that are genuine still verify
    expect(verdictOf(forged(legacy)), "the legacy form").toBe("verifies");
    expect(verdictOf(forged(fresh)), "the current form").toBe("verifies");
    // the files stay out of the repository
    const dir = mkdtempSync(join(tmpdir(), "changeradar-r8-"));
    try {
      writeFileSync(join(dir, "legacy.json"), forged(legacy));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 240_000);
});
