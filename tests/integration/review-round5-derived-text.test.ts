import { describe, expect, it } from "vitest";
import { hashCanonical } from "../../src/domain/canonical.js";
import { TEXT_CAP } from "../../src/domain/derived-text.js";
import { assess } from "../../src/services/assess.js";
import { buildBundle, serializeBundle, verifyBundle, type EvidenceBundle } from "../../src/services/evidence.js";
import { restoreBundle } from "../../src/services/restore.js";
import { build, clock, e, f, FRESH, manifest, n } from "../helpers/builders.js";
import { createHarness, getRun } from "../helpers/harness.js";

/**
 * Review round 5 (logic P1, restore.ts:106): every string DERIVED by the decision engine is bounded, so a restore (which cuts
 * every stored string to 2,000 characters) can never change what verification re-derives. Before the fix an
 * EDGE_FIELD_NOT_IN_CONTRACT message that named 40 unknown fields of 124 characters was 5,267 characters: export, verify and
 * restore succeeded, and every later export of the restored installation was refused (BUNDLE_RUN_INCONSISTENT).
 */

const CAP = 2000;
/** 40 field names of 124 characters that the contract does not have (a contract that renamed all of its fields). */
const UNKNOWN_FIELDS = Array.from({ length: 40 }, (_, i) => `${String(i).padStart(3, "0")}${"x".repeat(121)}`);

const contractNodes = (fields: string[]) => [n("contract.c", "contract", { owner: "team-c", fields: fields.map((name) => f(name)) }), n("svc.k", "service", { owner: "team-k" })];
/** The baseline: the consumer's EXISTING edge declares fields that the contract does not have. */
const baselineWithBadEdge = () => manifest(contractNodes(["id", "amount"]), [e("svc.k", "contract.c", "consumes", { verified_at: FRESH, fields: UNKNOWN_FIELDS })]);
/** The proposal removes a required field, so the first hop is examined and the unusable declaration is reported. */
const removeAmount = () => manifest(contractNodes(["id"]), [e("svc.k", "contract.c", "consumes", { verified_at: FRESH, fields: UNKNOWN_FIELDS })]);
/** The proposal INTRODUCES the edge with the bad declaration (the second place that builds the message). */
const introducesBadEdge = () => manifest(contractNodes(["id", "amount"]), [e("svc.k", "contract.c", "consumes", { verified_at: FRESH, fields: UNKNOWN_FIELDS })]);
const baselineWithoutEdge = () => manifest(contractNodes(["id", "amount"]), []);

function reseal(bundle: Record<string, any>): string {
  const { bundle_hash: _drop, hashes: _h, stale_runs: _s, ...body } = bundle;
  const hashes = { snapshots: hashCanonical(body.snapshots), impact_runs: hashCanonical(body.impact_runs), contract_checks: hashCanonical(body.contract_checks) };
  const withHashes = { ...body, hashes };
  return JSON.stringify({ ...withHashes, bundle_hash: hashCanonical(withHashes) });
}

/** Every string leaf, at any depth. */
function leaves(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) leaves(item, out);
  else if (value !== null && typeof value === "object") for (const item of Object.values(value)) leaves(item, out);
  return out;
}

function assessOf(base: Record<string, unknown>, proposal: Record<string, unknown>) {
  const b = build(base);
  const result = assess({ baseline: b, proposed: build(proposal), expected_hash: b.hash, clock });
  if (!result.ok) throw new Error("assess failed");
  return result.assessment;
}

describe("R5 P1 (assess.ts:316, :429): no derived string is longer than the restore cap", () => {
  it("both places that list unknown field names (a baseline edge, an edge the proposal introduces) stay within 2,000 characters", () => {
    const existing = assessOf(baselineWithBadEdge(), removeAmount());
    const introduced = assessOf(baselineWithoutEdge(), introducesBadEdge());
    for (const [label, a] of [["existing edge", existing], ["introduced edge", introduced]] as const) {
      const unknown = a.unknowns.find((u) => u.code === "EDGE_FIELD_NOT_IN_CONTRACT");
      expect(unknown, label).toBeDefined();
      // The lengths of the strings over the cap (an empty list is the answer), not a count that a reader could mistake for a status.
      expect(leaves(a).map((s) => s.length).filter((length) => length > CAP), `${label}: lengths of the strings over ${CAP}`).toEqual([]);
      expect((unknown as { message: string }).message.length, label).toBeLessThanOrEqual(CAP);
      // The start of the message still names the edge and the first unknown field: the reader learns what to look at.
      expect((unknown as { message: string }).message).toContain("svc.k");
      expect((unknown as { message: string }).message).toContain(UNKNOWN_FIELDS[0] as string);
    }
  });

  it("a finding reason and a change description built from the longest allowed ids stay within the cap", () => {
    const longId = (prefix: string) => `${prefix}.${"a".repeat(120)}`;
    const owner = "o".repeat(256);
    const nodes = [n(longId("contract"), "contract", { owner, fields: [f("id"), f("amount")] }), n(longId("svc"), "service", { owner })];
    const edges = [e(longId("svc"), longId("contract"), "consumes", { verified_at: FRESH })];
    const a = assessOf(manifest(nodes, edges), manifest([n(longId("contract"), "contract", { owner, fields: [f("id")] }), nodes[1] as Record<string, unknown>], edges));
    expect(a.findings.length).toBeGreaterThan(0);
    expect(leaves(a).filter((s) => s.length > CAP)).toEqual([]);
  });

  it("a finding reason that quotes many changes is cut to the cap (the default quotes three; a caller may raise the bound)", () => {
    // 60 required fields of 100 characters are removed: each quoted description is about 130 characters, so 60 of them are far over the cap.
    const names = Array.from({ length: 60 }, (_, i) => `${String(i).padStart(2, "0")}${"f".repeat(98)}`);
    const nodes = (fields: string[]) => [n("contract.c", "contract", { owner: "team-c", fields: fields.map((name) => f(name)) }), n("svc.k", "service", { owner: "team-k" })];
    const edges = [e("svc.k", "contract.c", "consumes", { verified_at: FRESH })];
    const b = build(manifest(nodes(["keep", ...names]), edges));
    const result = assess({ baseline: b, proposed: build(manifest(nodes(["keep"]), edges)), expected_hash: b.hash, clock, config: { max_reason_changes: 60, max_change_ids: 60 } });
    if (!result.ok) throw new Error("assess failed");
    const reasons = result.assessment.findings.map((finding) => finding.reason);
    expect(reasons.length).toBeGreaterThan(0);
    // Control: the cap really cut something (the reason is exactly the cap; uncut it would be about 8,000 characters).
    expect(reasons.map((reason) => reason.length)).toEqual(reasons.map(() => CAP));
    expect(reasons.every((reason) => reason.startsWith("Direct dependent of contract.c (1 hop): "))).toBe(true);
    expect(leaves(result.assessment).map((s) => s.length).filter((length) => length > CAP)).toEqual([]);
  });

  it("the derivation cap and the restore cap are one constant", () => {
    expect(TEXT_CAP).toBe(CAP);
  });
});

describe("R5 P1 (restore.ts:106): a workspace whose run carries a long derived message exports again after a restore", () => {
  it("export, verify, restore, export again, run bundle: every step succeeds and the unknown text is the same", async () => {
    const src = await createHarness();
    let text = "";
    let workspaceId = "";
    let runId = "";
    let before = "";
    try {
      const w = await src.workspace("Derived5");
      workspaceId = w.id;
      const snap = await src.importSnapshot(w.operator, baselineWithBadEdge(), { revision: "release-1" });
      const run = await src.requestRun(w.operator, { snapshot_id: snap.body.id, proposed_manifest: removeAmount(), expected_hash: snap.body.hash, run_checks: false });
      runId = run.body.id;
      await src.drain();
      const view = await getRun(src, w.viewer, runId);
      const unknown = view.unknowns.find((u: any) => u.code === "EDGE_FIELD_NOT_IN_CONTRACT");
      expect(unknown, "the source run records the unknown").toBeDefined();
      before = unknown.message;
      expect(before.length).toBeLessThanOrEqual(CAP);
      text = serializeBundle((await buildBundle(src.db, { workspaceId }, src.now())) as EvidenceBundle);
      expect(() => verifyBundle(text, { maxBytes: 64 * 1024 * 1024 })).not.toThrow();
    } finally {
      await src.close();
    }
    const dst = await createHarness();
    try {
      await restoreBundle(dst.ctx, text);
      const viewer = await dst.userIn(workspaceId, "viewer");
      const restored = await getRun(dst, viewer, runId);
      expect(restored.unknowns.find((u: any) => u.code === "EDGE_FIELD_NOT_IN_CONTRACT").message, "restored text is unchanged").toBe(before);
      // The step that failed before the fix: the restored installation exports and verifies again.
      // (Before the fix this export threw BundleError: the assertion reports the message instead of dying on the throw.)
      const attempt = await buildBundle(dst.db, { workspaceId }, dst.now()).then(
        (bundle) => ({ ok: true as const, bundle }),
        (error: unknown) => ({ ok: false as const, message: String(error) }),
      );
      expect(attempt.ok, attempt.ok ? "" : attempt.message).toBe(true);
      const again = serializeBundle((attempt.ok ? attempt.bundle : null) as EvidenceBundle);
      expect(() => verifyBundle(again, { maxBytes: 64 * 1024 * 1024 })).not.toThrow();
      const operator = await dst.userIn(workspaceId, "operator");
      const api = await dst.api(operator, "GET", `/api/v1/impact-runs/${runId}/bundle`);
      expect(api.status).toBe(200);
      expect(() => verifyBundle(JSON.stringify(api.body), { maxBytes: 64 * 1024 * 1024 })).not.toThrow();
    } finally {
      await dst.close();
    }
  }, 120_000);

  it("compatibility: a bundle written by an earlier build (the full, unbounded message, or one cut at 2,000 by a restore) still verifies", async () => {
    const src = await createHarness();
    let base = "";
    try {
      const w = await src.workspace("Legacy5");
      const snap = await src.importSnapshot(w.operator, baselineWithBadEdge(), { revision: "release-1" });
      await src.requestRun(w.operator, { snapshot_id: snap.body.id, proposed_manifest: removeAmount(), expected_hash: snap.body.hash, run_checks: false });
      await src.drain();
      base = serializeBundle((await buildBundle(src.db, { workspaceId: w.id }, src.now())) as EvidenceBundle);
    } finally {
      await src.close();
    }
    // The message an earlier build derived: the names were joined without a bound.
    const legacyFull = (edgeKey: string) => `edge ${edgeKey} declares field(s) ${UNKNOWN_FIELDS.join(", ")} that contract contract.c does not have (a typo or a name left over from a rename), so what this consumer relies on is unknown; it is treated as relying on every required field`;
    for (const form of ["full", "cut"] as const) {
      const bundle = JSON.parse(base) as Record<string, any>;
      const unknown = bundle.impact_runs[0].unknowns.find((u: any) => u.code === "EDGE_FIELD_NOT_IN_CONTRACT");
      const key = `svc.k|consumes|contract.c`;
      const full = legacyFull(key);
      expect(full.length, "the legacy message is over the cap").toBeGreaterThan(CAP);
      unknown.message = form === "full" ? full : full.slice(0, CAP);
      const text = reseal(bundle);
      expect(() => verifyBundle(text, { maxBytes: 64 * 1024 * 1024 }), `${form}: verifies`).not.toThrow();
      // ... and restores, and the restored workspace exports and verifies again under this build.
      const dst = await createHarness();
      try {
        const restoredRun = await restoreBundle(dst.ctx, text).then(
          (summary) => ({ ok: true as const, summary }),
          (error: unknown) => ({ ok: false as const, message: String(error) }),
        );
        expect(restoredRun.ok, `${form}: restores${restoredRun.ok ? "" : `: ${restoredRun.message}`}`).toBe(true);
        const summary = restoredRun.ok ? restoredRun.summary : { workspace_id: "" };
        const exportedAgain = await buildBundle(dst.db, { workspaceId: summary.workspace_id }, dst.now()).then(
          (bundle) => ({ ok: true as const, bundle }),
          (error: unknown) => ({ ok: false as const, message: String(error) }),
        );
        expect(exportedAgain.ok, `${form}: exports again after the restore${exportedAgain.ok ? "" : `: ${exportedAgain.message}`}`).toBe(true);
        const again = serializeBundle((exportedAgain.ok ? exportedAgain.bundle : null) as EvidenceBundle);
        expect(() => verifyBundle(again, { maxBytes: 64 * 1024 * 1024 }), `${form}: re-exports and verifies after the restore`).not.toThrow();
        const restored = (JSON.parse(again) as { impact_runs: { unknowns: { code: string; message: string }[] }[] }).impact_runs[0]?.unknowns.find((u) => u.code === "EDGE_FIELD_NOT_IN_CONTRACT");
        expect(restored?.message.length, `${form}: the stored message is within the cap`).toBeLessThanOrEqual(CAP);
      } finally {
        await dst.close();
      }
    }
  }, 240_000);
});
