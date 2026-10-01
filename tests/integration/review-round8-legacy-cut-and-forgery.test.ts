import { describe, expect, it } from "vitest";
import { hashCanonical } from "../../src/domain/canonical.js";
import { TEXT_CAP } from "../../src/domain/derived-text.js";
import { buildBundle, serializeBundle, verifyBundle, type EvidenceBundle } from "../../src/services/evidence.js";
import { restoreBundle } from "../../src/services/restore.js";
import { e, f, manifest, n } from "../helpers/builders.js";
import { createHarness } from "../helpers/harness.js";

/**
 * Review round 8, second look (logic P1-A and P2 on the masked reading of a recorded text).
 *
 * P1-A: a bundle written by 435731e holds a message of more than 2,000 characters (a consumer edge that declares 17 unknown fields of 124 characters) in which the old
 * redactor hid only the first id. verify-bundle and restore accepted it; the restore CUT the text at 2,000, and the workspace could then never export again (the masked
 * reading anchored the end of the record at the end of the derivation, which the cut record does not reach). A record that is a cut of the derivation is a masked PREFIX of it.
 *
 * P2: the masked reading applied to every string of the recorded unknowns, detail and finding reasons, so a resealed bundle with `[REDACTED]` in a code, an id, an edge, a hash,
 * the assessment or a whole message verified. It applies to the free text members only, and a marker must stand behind a credential-shaped word.
 */

const LIMITS = { maxBytes: 64 * 1024 * 1024 };
const FIELDS = Array.from({ length: 17 }, (_, i) => `${String(i).padStart(3, "0")}${"x".repeat(121)}`);
const SOURCE = "credentials:gateway";
const TARGET = "token:proxy";

const graph = (edgeFields: string[], contractFields: string[]) =>
  manifest([n(TARGET, "contract", { owner: "team-c", fields: contractFields.map((name) => f(name)) }), n(SOURCE, "service", { owner: "team-k" })], [e(SOURCE, TARGET, "consumes", { fields: edgeFields, verified_at: null })]);

function reseal(bundle: Record<string, any>): string {
  const { bundle_hash: _drop, hashes: _h, stale_runs: _s, ...body } = bundle;
  const hashes = { snapshots: hashCanonical(body.snapshots), impact_runs: hashCanonical(body.impact_runs), contract_checks: hashCanonical(body.contract_checks) };
  const withHashes = { ...body, hashes };
  return JSON.stringify({ ...withHashes, bundle_hash: hashCanonical(withHashes) });
}
const verdictOf = (text: string): string => {
  try {
    verifyBundle(text, LIMITS);
    return "verifies";
  } catch (error) {
    return `refused: ${String((error as { code?: string }).code ?? error)}`;
  }
};

async function freshBundle(label: string, edgeBefore: string[], edgeAfter: string[], contractBefore: string[] = ["id", "amount"], contractAfter: string[] = contractBefore): Promise<string> {
  const src = await createHarness();
  try {
    const w = await src.workspace(label);
    const snap = await src.importSnapshot(w.operator, graph(edgeBefore, contractBefore), { revision: "release-1" });
    expect(snap.status, JSON.stringify(snap.body)).toBe(201);
    await src.requestRun(w.operator, { snapshot_id: snap.body.id, proposed_manifest: graph(edgeAfter, contractAfter), expected_hash: snap.body.hash, run_checks: false });
    await src.drain();
    return serializeBundle((await buildBundle(src.db, { workspaceId: w.id }, src.now())) as EvidenceBundle);
  } finally {
    await src.close();
  }
}

describe("R8 B7 (logic P1-A): a legacy message that a restore cuts at the cap still exports", () => {
  it("17 fields of 124 characters behind two credential-shaped ids: verify, restore, export and verify again (the control with one credential id passes as well)", async () => {
    const base = await freshBundle("LegacyCut", ["id"], ["id", ...FIELDS]);
    expect(verdictOf(base), "the bundle this build writes (control)").toBe("verifies");
    const bundle = JSON.parse(base) as Record<string, any>;
    const unknown = (bundle.impact_runs[0].unknowns as { code: string; message: string }[]).find((u) => u.code === "EDGE_FIELD_NOT_IN_CONTRACT");
    expect(unknown, JSON.stringify(bundle.impact_runs[0].unknowns).slice(0, 400)).toBeDefined();
    // what 435731e wrote: the message UNCUT, the value of the first credential-shaped id swallowing the second (`gateway|consumes|token:proxy`)
    const legacy = `edge ${SOURCE.split(":")[0]}:[REDACTED] declares field(s) ${FIELDS.join(", ")} that the contract does not have, so what this consumer relies on is unknown`;
    expect(legacy.length, "longer than the cap, as the writer's message was").toBeGreaterThan(TEXT_CAP + 100);
    (unknown as { message: string }).message = legacy;
    const text = reseal(bundle);
    expect(verdictOf(text), "verify-bundle of the legacy form").toBe("verifies");

    const dst = await createHarness();
    try {
      const summary = await restoreBundle(dst.ctx, text).then((s) => s, (error: unknown) => ({ workspace_id: "", message: String(error) }));
      expect((summary as { message?: string }).message, "restore of the legacy form").toBeUndefined();
      const again = await buildBundle(dst.db, { workspaceId: (summary as { workspace_id: string }).workspace_id }, dst.now()).then(
        (b) => b,
        (error: unknown) => `refused: ${String(error).slice(0, 160)}`,
      );
      expect(typeof again, "the workspace export after the restore").toBe("object");
      const exported = serializeBundle(again as EvidenceBundle);
      expect(verdictOf(exported), "the re-exported bundle verifies").toBe("verifies");
      const restored = (JSON.parse(exported) as { impact_runs: { unknowns: { code: string; message: string }[] }[] }).impact_runs[0]?.unknowns.find((u) => u.code === "EDGE_FIELD_NOT_IN_CONTRACT");
      expect(restored?.message.length, "the restored text was cut at the cap").toBeLessThanOrEqual(TEXT_CAP);
      expect(restored?.message.length).toBeGreaterThan(TEXT_CAP - 70);
    } finally {
      await dst.close();
    }
  }, 240_000);

  it("a record that is cut does not match a derivation that lacks its text, and a record of another length keeps both anchors", async () => {
    const base = await freshBundle("LegacyCutNegative", ["id"], ["id", ...FIELDS]);
    const legacy = `edge credentials:[REDACTED] declares field(s) ${FIELDS.join(", ")} that the contract does not have, so what this consumer relies on is unknown`;
    const forged = (message: string): string => {
      const bundle = JSON.parse(base) as Record<string, any>;
      const unknown = (bundle.impact_runs[0].unknowns as { code: string; message: string }[]).find((u) => u.code === "EDGE_FIELD_NOT_IN_CONTRACT") as { message: string };
      unknown.message = message;
      return reseal(bundle);
    };
    // a genuine cut at the cap: a prefix of the legacy record
    const cutAt = (length: number): string => legacy.slice(0, length);
    expect(verdictOf(forged(cutAt(TEXT_CAP))), "a cut at the cap").toBe("verifies");
    expect(verdictOf(forged(cutAt(TEXT_CAP - 3))), "a cut three characters short (a surrogate half or part of a marker dropped)").toBe("verifies");
    // a text that shows what the derivation lacks is refused, at any length
    expect(verdictOf(forged(cutAt(TEXT_CAP - 1).replace("010xxxx", "010#xxx"))), "a changed character inside the record").toBe("refused: BUNDLE_RUN_INCONSISTENT");
    expect(verdictOf(forged(`${cutAt(TEXT_CAP - 1)}#`)), "a character that the derivation lacks at the end of the cut").toBe("refused: BUNDLE_RUN_INCONSISTENT");
    // shorter than the window of a cut: both anchors apply again, so a truncated record is refused
    expect(verdictOf(forged(cutAt(1500))), "a record of 1,500 characters is not a cut of this derivation").toBe("refused: BUNDLE_RUN_INCONSISTENT");
    expect(verdictOf(forged(cutAt(TEXT_CAP - 200))), "a record 200 short of the cap").toBe("refused: BUNDLE_RUN_INCONSISTENT");
    // a prefix is not a licence to reorder: two fragments out of order
    expect(verdictOf(forged(cutAt(TEXT_CAP).replace("declares field(s)", "field(s) declares"))), "a fragment out of order").toBe("refused: BUNDLE_RUN_INCONSISTENT");
  }, 240_000);
});

describe("R8 B7 (logic P2): a resealed bundle that blanks a code, an id, an edge, a hash, the assessment or a whole text is refused", () => {
  it("every forgery of the recorded report is refused, and the genuine legacy form still verifies", async () => {
    const base = await freshBundle("Forgery", ["id"], ["id"], ["id", "amount"], ["amount"]);
    expect(verdictOf(base), "the bundle this build writes (control)").toBe("verifies");
    const M = "[REDACTED]";
    type Setter = (run: Record<string, any>) => void;
    const forgeries: [string, Setter][] = [
      ["unknown message := the marker", (run) => { run.unknowns[0].message = M; }],
      ["unknown message := two markers", (run) => { run.unknowns[0].message = `${M}${M}`; }],
      ["unknown message := `edge [REDACTED]` (a truncation)", (run) => { run.unknowns[0].message = `edge ${M}`; }],
      ["unknown code := the marker", (run) => { run.unknowns[0].code = M; }],
      ["unknown id := the marker", (run) => { run.unknowns[0].id = M; }],
      ["unknown node_id := the marker", (run) => { run.unknowns[0].node_id = M; }],
      ["unknown edge.source_id := the marker", (run) => { run.unknowns[0].edge = { ...run.unknowns[0].edge, source_id: M }; }],
      ["unknown edge.source_id := a marker behind a credential-shaped word (the shape is right, the member is not free text)", (run) => { run.unknowns[0].edge = { ...run.unknowns[0].edge, source_id: `${SOURCE.split(":")[0]}:${M}` }; }],
      ["finding reason := the marker", (run) => { run.findings[0].reason = M; }],
      ["detail.baseline_hash := the marker", (run) => { run.assessment_detail.baseline_hash = M; }],
      ["detail.coverage.limits[0].code := the marker", (run) => { run.assessment_detail.coverage.limits[0].code = M; }],
      ["detail.coverage.limits[0].message := the marker", (run) => { run.assessment_detail.coverage.limits[0].message = M; }],
      ["detail.assessment := the marker", (run) => { run.assessment_detail.assessment = M; }],
      ["detail.changes[0].description := the marker", (run) => { run.assessment_detail.changes[0].description = M; }],
      ["detail.changes[0].description := `x:[REDACTED]` (a marker behind a word, in a text that has none)", (run) => { run.assessment_detail.changes[0].description = `x:${M}`; }],
    ];
    for (const [label, apply] of forgeries) {
      const bundle = JSON.parse(base) as Record<string, any>;
      apply(bundle.impact_runs[0]);
      expect(verdictOf(reseal(bundle)), label).toBe("refused: BUNDLE_RUN_INCONSISTENT");
    }
  }, 240_000);

  it("the masked reading still applies to a finding reason: a marker that hides a value this redactor leaves readable verifies, and the same reason with a changed visible character does not", async () => {
    const base = await freshBundle("LegacyReason", ["id"], ["id"], ["id", "amount"], ["amount"]);
    const reasonOf = (bundle: Record<string, any>): string => bundle.impact_runs[0].findings[0].reason as string;
    const bundle = JSON.parse(base) as Record<string, any>;
    const reason = reasonOf(bundle);
    expect(reason.includes(TARGET), `the reason names the contract: ${reason}`).toBe(true);
    // a record in which a marker stands for the value of the credential-shaped id `token:proxy` (this redactor leaves that id readable, a stricter one hides it)
    bundle.impact_runs[0].findings[0].reason = reason.replace(TARGET, "token:[REDACTED]");
    expect(verdictOf(reseal(bundle)), "a finding reason in a masked form").toBe("verifies");
    const changed = JSON.parse(base) as Record<string, any>;
    changed.impact_runs[0].findings[0].reason = reason.replace(TARGET, "token:[REDACTED]").replace("Direct", "Indirect");
    expect(verdictOf(reseal(changed)), "a visible word that the derivation lacks").toBe("refused: BUNDLE_RUN_INCONSISTENT");
  }, 240_000);
});
