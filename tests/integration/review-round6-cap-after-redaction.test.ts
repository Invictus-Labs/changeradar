import { describe, expect, it } from "vitest";
import { capLeaves, TEXT_CAP } from "../../src/domain/derived-text.js";
import { redactDeep } from "../../src/domain/redaction.js";
import { assess } from "../../src/services/assess.js";
import { buildBundle, serializeBundle, verifyBundle, type EvidenceBundle } from "../../src/services/evidence.js";
import { restoreBundle } from "../../src/services/restore.js";
import { build, clock, e, f, FRESH, manifest, n } from "../helpers/builders.js";
import { createHarness, getRun } from "../helpers/harness.js";

/**
 * Review round 6 (logic P1, assess.ts:240): the cap on a derived text is applied when the text is created, BEFORE export redacts it,
 * and redaction can lengthen a text (`api_key:abcdefgh` becomes `api_key:[REDACTED]`). The exported text was then longer than the
 * cap, a restore cut it, and verification refused every later export. Texts are now cut AFTER redaction (export), a cut never
 * splits a redaction marker, and verification compares under the same reading.
 */

const fields = (count: number): string[] => Array.from({ length: count }, (_, i) => `${String(i).padStart(3, "0")}${"x".repeat(121)}`);
const nodes = (contractId: string, declared: string[]) => [n(contractId, "contract", { owner: "team-c", fields: declared.map((name) => f(name)) }), n("svc.k", "service", { owner: "team-k" })];
/** A consumer edge that declares fields the contract lacks, into a contract whose id holds a credential word and a short value. */
const withBadEdge = (contractId: string, count: number, contractFields: string[]) =>
  manifest(nodes(contractId, contractFields), [e("svc.k", contractId, "consumes", { verified_at: FRESH, fields: fields(count) })]);
const IDS = ["ct/api_key:abcdefgh", "ct.password:abcdefgh", "a.secret:abcdef"];

describe("R6 (logic P1): a derived text that redaction lengthens still exports, verifies, restores and exports again", () => {
  it.each(IDS.flatMap((id) => [15, 16, 17].map((count) => [id, count] as const)))("contract id %s with %i unknown fields of 124 characters", async (id, count) => {
    const src = await createHarness();
    let text = "";
    let workspaceId = "";
    let runId = "";
    let message = "";
    try {
      const w = await src.workspace("Grow6");
      workspaceId = w.id;
      const snap = await src.importSnapshot(w.operator, withBadEdge(id, count, ["id", "amount"]), { revision: "release-1" });
      expect(snap.status, JSON.stringify(snap.body)).toBe(201);
      const run = await src.requestRun(w.operator, { snapshot_id: snap.body.id, proposed_manifest: withBadEdge(id, count, ["id"]), expected_hash: snap.body.hash, run_checks: false });
      runId = run.body.id;
      await src.drain();
      const view = await getRun(src, w.viewer, runId);
      message = (view.unknowns.find((u: any) => u.code === "EDGE_FIELD_NOT_IN_CONTRACT") as { message: string }).message;
      // The view redacts for display (the text may be a few characters over the cap there); the record itself is cut before that.
      expect(message.length, "the message is near the cap (control: the scenario reaches it)").toBeGreaterThan(1900);
      // the export (which verifies the exact bytes it writes) must succeed: this is the step that failed
      const built = buildBundle(src.db, { workspaceId }, src.now());
      expect(await built.then(() => "exported", (error: unknown) => `refused: ${String(error).slice(0, 160)}`), "the workspace export").toBe("exported");
      text = serializeBundle((await built) as EvidenceBundle);
      // The exported record is cut after redaction: no unknown message in the bundle is longer than the cap.
      const exported = (JSON.parse(text) as EvidenceBundle).impact_runs.flatMap((r) => (r.unknowns as { message: string }[]).map((u) => u.message.length));
      expect(exported.filter((length) => length > TEXT_CAP), "lengths of exported unknown messages over the cap").toEqual([]);
      expect(() => verifyBundle(text, { maxBytes: 64 * 1024 * 1024 })).not.toThrow();
      const runBundle = await src.api(w.operator, "GET", `/api/v1/impact-runs/${runId}/bundle`);
      expect(runBundle.status, "the run bundle answers 200, not 409").toBe(200);
    } finally {
      await src.close();
    }
    const dst = await createHarness();
    try {
      await restoreBundle(dst.ctx, text);
      const rebuilt = buildBundle(dst.db, { workspaceId }, dst.now());
      expect(await rebuilt.then(() => "exported", (error: unknown) => `refused: ${String(error).slice(0, 160)}`), "the export after the restore").toBe("exported");
      const again = serializeBundle((await rebuilt) as EvidenceBundle);
      expect(() => verifyBundle(again, { maxBytes: 64 * 1024 * 1024 })).not.toThrow();
      const bundle = JSON.parse(again) as EvidenceBundle;
      const stored = ((bundle.impact_runs[0] as { unknowns: { message: string }[] }).unknowns.find((u) => u.message.includes("declares field")) as { message: string }).message;
      expect(stored.length, "the restored text is within the cap").toBeLessThanOrEqual(TEXT_CAP);
    } finally {
      await dst.close();
    }
  }, 180_000);
});

describe("R6 (derived-text.ts): the cut after redaction is stable", () => {
  it("for 3,000 texts of 1,900 to 2,100 characters with credential words and short values, redact-then-cut is a fixed point and never splits a marker", () => {
    let seed = 12345;
    const next = (): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed / 4294967296;
    };
    const words = ["api_key:abcdefgh", "password:abcdefgh", "secret:abcdef", "token=abcdefgh", "field", "x".repeat(20), "plain words", "a", "svc.k -> ct.a"];
    const problems: string[] = [];
    for (let i = 0; i < 3000; i += 1) {
      const target = 1900 + Math.floor(next() * 200);
      let text = "";
      while (text.length < target) text += `${words[Math.floor(next() * words.length)] as string}${next() < 0.5 ? ", " : " "}`;
      const once = capLeaves(redactDeep([text])) as string[];
      const twice = capLeaves(redactDeep(once)) as string[];
      if (once[0] !== twice[0]) problems.push(`not stable at ${target}`);
      if ((once[0] as string).length > TEXT_CAP) problems.push(`over the cap at ${target}`);
      // a cut inside the marker leaves a proper prefix of it at the end (`[`, `[R`, ... `[REDACTE`), or a `[REDACT` that is not followed by `ED]`
      if (/\[(?:R(?:E(?:D(?:A(?:C(?:T(?:E)?)?)?)?)?)?)?$/.test(once[0] as string) || /\[REDACT(?!ED\])/.test(once[0] as string)) problems.push(`a split marker at ${target}`);
    }
    expect(problems.slice(0, 5)).toEqual([]);
  });

  it("the assessments themselves stay within the cap for the three ids (control: the derivation cap still applies)", () => {
    for (const id of IDS) {
      const b = build(withBadEdge(id, 16, ["id", "amount"]));
      const result = assess({ baseline: b, proposed: build(withBadEdge(id, 16, ["id"])), expected_hash: b.hash, clock });
      if (!result.ok) throw new Error("assess failed");
      const unknown = result.assessment.unknowns.find((u) => u.code === "EDGE_FIELD_NOT_IN_CONTRACT") as { message: string };
      expect(unknown.message.length).toBeLessThanOrEqual(TEXT_CAP);
    }
  });
});
