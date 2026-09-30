import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hashCanonical } from "../../src/domain/canonical.js";
import { boundText, capLeaves, COMPARE_BOUND, TEXT_CAP } from "../../src/domain/derived-text.js";
import { redactDeep } from "../../src/domain/redaction.js";
import { buildBundle, serializeBundle, verifyBundle, type EvidenceBundle } from "../../src/services/evidence.js";
import { restoreBundle } from "../../src/services/restore.js";
import { e, f, FRESH, manifest, n } from "../helpers/builders.js";
import { createHarness } from "../helpers/harness.js";

/**
 * Review round 7 (logic P1, evidence.ts:487): a run written by the round-5 base build holds an unknown message that was derived
 * UNCUT, redacted, and cut only by a restore. When the message is cut at 2,000 characters inside a short credential value
 * (`ct/api_key:abcdefgh`), the text cut BEFORE redaction and the text cut AFTER it differ, and verification refused a valid bundle
 * (BUNDLE_RUN_INCONSISTENT: `verify-bundle` and `restore` exit 2, an upgraded database could not export). Verification derives the
 * comparison text uncut and accepts a recorded text under any one reading (uncut, cut after redacting, cut before redacting).
 * The lengths below are the window of the report (legacy length 2,150 to 2,160): each of the three ids fails at these before the fix.
 */

const CASES: [string, number][] = [
  ["ct/api_key:abcdefgh", 36],
  ["ct/api_key:abcdefgh", 38],
  ["ct.password:abcdefgh", 34],
  ["ct.password:abcdefgh", 36],
  ["a.secret:abcdef", 42],
];
const names = (first: number): string[] => [`${"y".repeat(first)}`, ...Array.from({ length: 15 }, (_, i) => `${String(i).padStart(3, "0")}${"x".repeat(120)}`)];
const legacyFull = (id: string, declared: string[]): string =>
  `edge svc.k|consumes|${id} declares field(s) ${[...declared].sort().join(", ")} that contract ${id} does not have (a typo or a name left over from a rename), so what this consumer relies on is unknown; it is treated as relying on every required field`;
const nodes = (id: string, contractFields: string[]) => [n(id, "contract", { owner: "team-c", fields: contractFields.map((name) => f(name)) }), n("svc.k", "service", { owner: "team-k" })];
const withBadEdge = (id: string, declared: string[], contractFields: string[]) => manifest(nodes(id, contractFields), [e("svc.k", id, "consumes", { verified_at: FRESH, fields: declared })]);

function reseal(bundle: Record<string, any>): string {
  const { bundle_hash: _drop, hashes: _h, stale_runs: _s, ...body } = bundle;
  const hashes = { snapshots: hashCanonical(body.snapshots), impact_runs: hashCanonical(body.impact_runs), contract_checks: hashCanonical(body.contract_checks) };
  const withHashes = { ...body, hashes };
  return JSON.stringify({ ...withHashes, bundle_hash: hashCanonical(withHashes) });
}
const LIMITS = { maxBytes: 64 * 1024 * 1024 };

describe("R7 (logic P1, evidence.ts:487): a text written by an earlier build, cut inside a short credential value, still verifies, restores and exports", () => {
  it.each(CASES)("contract id %s, first unknown field of %i characters", async (id, first) => {
    const declared = names(first);
    const src = await createHarness();
    let base = "";
    try {
      const w = await src.workspace("Legacy7");
      const snap = await src.importSnapshot(w.operator, withBadEdge(id, declared, ["id", "amount"]), { revision: "release-1" });
      expect(snap.status, JSON.stringify(snap.body)).toBe(201);
      await src.requestRun(w.operator, { snapshot_id: snap.body.id, proposed_manifest: withBadEdge(id, declared, ["id"]), expected_hash: snap.body.hash, run_checks: false });
      await src.drain();
      const built = await buildBundle(src.db, { workspaceId: w.id }, src.now()).then(
        (bundle) => bundle,
        (error: unknown) => `refused: ${String(error).slice(0, 160)}`,
      );
      expect(typeof built, "this build exports (and verifies) its own run").toBe("object");
      base = serializeBundle(built as EvidenceBundle);
    } finally {
      await src.close();
    }
    const full = legacyFull(id, declared);
    expect(full.length, "the legacy message is inside the window of the report").toBeGreaterThan(2140);
    const forms: [string, string][] = [
      ["the round-4 form: uncut, redacted", redactDeep(full) as string],
      ["a restore's cut of that form (cut after redaction)", capLeaves(redactDeep(full)) as string],
      ["the round-5 form: cut before redaction", redactDeep(capLeaves(full)) as string],
    ];
    for (const [label, message] of forms) {
      const bundle = JSON.parse(base) as Record<string, any>;
      const unknown = bundle.impact_runs[0].unknowns.find((u: any) => u.code === "EDGE_FIELD_NOT_IN_CONTRACT");
      expect(unknown, "the base bundle names the unknown field edge").toBeDefined();
      unknown.message = message;
      const text = reseal(bundle);
      const verdict = (() => {
        try {
          verifyBundle(text, LIMITS);
          return "verifies";
        } catch (error) {
          return `refused: ${String((error as { code?: string }).code ?? error)}`;
        }
      })();
      expect(verdict, `${label}: verify-bundle`).toBe("verifies");
      const dst = await createHarness();
      try {
        const summary = await restoreBundle(dst.ctx, text).then((s) => s, (error: unknown) => ({ workspace_id: "", message: String(error) }));
        expect((summary as { message?: string }).message, `${label}: restore`).toBeUndefined();
        const again = await buildBundle(dst.db, { workspaceId: (summary as { workspace_id: string }).workspace_id }, dst.now()).then(
          (b) => "exported",
          (error: unknown) => `refused: ${String(error).slice(0, 120)}`,
        );
        expect(again, `${label}: the export after the restore`).toBe("exported");
      } finally {
        await dst.close();
      }
    }
  }, 240_000);
});

describe("R7 (logic P1, evidence.ts:487): an installation upgraded in place, whose database holds a text written by an earlier build, exports again", () => {
  it.each([["ct/api_key:abcdefgh", 36], ["a.secret:abcdef", 42]] as [string, number][])("contract id %s, first unknown field of %i characters: the workspace export and the run bundle, for each legacy form", async (id, first) => {
    const declared = names(first);
    const full = legacyFull(id, declared);
    const forms: [string, string][] = [
      ["uncut and redacted (round 4 and before)", redactDeep(full) as string],
      ["cut after redaction (a restore of that)", capLeaves(redactDeep(full)) as string],
      ["cut before redaction (round 5)", redactDeep(capLeaves(full)) as string],
    ];
    for (const [label, message] of forms) {
      const h = await createHarness();
      try {
        const w = await h.workspace("InPlace7");
        const snap = await h.importSnapshot(w.operator, withBadEdge(id, declared, ["id", "amount"]), { revision: "release-1" });
        const run = await h.requestRun(w.operator, { snapshot_id: snap.body.id, proposed_manifest: withBadEdge(id, declared, ["id"]), expected_hash: snap.body.hash, run_checks: false });
        await h.drain();
        // The database of the earlier build: the unknown message of the run is what that build stored.
        const row = await h.db.query<{ unknowns: { code: string; message: string }[] }>("SELECT unknowns FROM impact_runs WHERE id = $1", [run.body.id]);
        const unknowns = (row.rows[0] as { unknowns: { code: string; message: string }[] }).unknowns.map((u) => (u.code === "EDGE_FIELD_NOT_IN_CONTRACT" ? { ...u, message } : u));
        // (the trigger that keeps a COMPLETE run terminal is off for this one statement: the earlier build wrote the text before the trigger stood guard)
        await h.db.query("SET session_replication_role = replica");
        await h.db.query("UPDATE impact_runs SET unknowns = $1::jsonb WHERE id = $2", [JSON.stringify(unknowns), run.body.id]);
        await h.db.query("SET session_replication_role = DEFAULT");
        const built = await buildBundle(h.db, { workspaceId: w.id }, h.now()).then(() => "exported", (error: unknown) => `refused: ${String(error).slice(0, 140)}`);
        expect(built, `${label}: the workspace export`).toBe("exported");
        const bundle = await h.api(w.operator, "GET", `/api/v1/impact-runs/${run.body.id}/bundle`);
        expect(bundle.status, `${label}: the run bundle (${bundle.text.slice(0, 120)})`).toBe(200);
      } finally {
        await h.close();
      }
    }
  }, 300_000);
});

describe("R7 (logic P2-b, evidence.ts): verification of a hash-consistent bundle with one hostile text is bounded, and the text is refused", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const probe = resolve(root, "tests/helpers/verify-probe.ts");
  const children = (file: string): { outcome: string; ms: number } => {
    const run = spawnSync(process.execPath, ["--import", "tsx", probe, file], { encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024, cwd: root });
    expect(run.status, `the child finished (a call that never returns is a failed assertion): ${run.stderr.slice(-200)}`).toBe(0);
    return JSON.parse(run.stdout.trim().split("\n").pop() as string);
  };

  it("a recorded unknown message of 100 KB, 300 KB and 1 MB of a redactor-hostile shape is refused as BUNDLE_RUN_INCONSISTENT within a fixed time, not prefix-compared", async () => {
    const src = await createHarness();
    let base = "";
    try {
      const w = await src.workspace("Hostile7");
      const snap = await src.importSnapshot(w.operator, withBadEdge("ct/api_key:abcdefgh", names(36), ["id", "amount"]), { revision: "release-1" });
      await src.requestRun(w.operator, { snapshot_id: snap.body.id, proposed_manifest: withBadEdge("ct/api_key:abcdefgh", names(36), ["id"]), expected_hash: snap.body.hash, run_checks: false });
      await src.drain();
      base = serializeBundle((await buildBundle(src.db, { workspaceId: w.id }, src.now())) as EvidenceBundle);
    } finally {
      await src.close();
    }
    const dir = mkdtempSync(join(tmpdir(), "cr-r7-hostile-"));
    try {
      for (const size of [100_000, 300_000, 1_000_000]) {
        const bundle = JSON.parse(base) as Record<string, any>;
        const unknown = bundle.impact_runs[0].unknowns.find((u: any) => u.code === "EDGE_FIELD_NOT_IN_CONTRACT");
        unknown.message = "value=".repeat(Math.ceil(size / 6));
        const file = join(dir, `hostile-${size}.json`);
        writeFileSync(file, reseal(bundle));
        const result = children(file);
        expect(result.outcome, `${size} characters`).toBe("BUNDLE_RUN_INCONSISTENT");
        expect(result.ms, `${size} characters: milliseconds spent`).toBeLessThan(2_500);
      }
      // control: the honest message of the same run, in a child, is accepted
      const honest = join(dir, "honest.json");
      writeFileSync(honest, base);
      expect(children(honest).outcome).toBe("ACCEPTED");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);

  it("a legacy text at the bound is compared; one character over the bound is refused (control for the refusal)", async () => {
    const src = await createHarness();
    let base = "";
    try {
      const w = await src.workspace("Bound7");
      const snap = await src.importSnapshot(w.operator, withBadEdge("ct.plain", names(36), ["id", "amount"]), { revision: "release-1" });
      await src.requestRun(w.operator, { snapshot_id: snap.body.id, proposed_manifest: withBadEdge("ct.plain", names(36), ["id"]), expected_hash: snap.body.hash, run_checks: false });
      await src.drain();
      base = serializeBundle((await buildBundle(src.db, { workspaceId: w.id }, src.now())) as EvidenceBundle);
    } finally {
      await src.close();
    }
    // The legacy text of an earlier build (uncut and redacted) followed by blanks: its first 2,000 characters are the derived text's.
    const legacy = redactDeep(legacyFull("ct.plain", names(36))) as string;
    const verdict = (length: number): string => {
      const bundle = JSON.parse(base) as Record<string, any>;
      const unknown = bundle.impact_runs[0].unknowns.find((u: any) => u.code === "EDGE_FIELD_NOT_IN_CONTRACT");
      unknown.message = `${legacy}${" ".repeat(length - legacy.length)}`;
      expect(unknown.message.length).toBe(length);
      try {
        verifyBundle(reseal(bundle), LIMITS);
        return "ACCEPTED";
      } catch (error) {
        return String((error as { code?: string }).code);
      }
    };
    expect(verdict(COMPARE_BOUND), "a text of exactly the bound is compared").toBe("ACCEPTED");
    expect(verdict(COMPARE_BOUND + 1), "one character over the bound is refused, not prefix-compared").toBe("BUNDLE_RUN_INCONSISTENT");
  }, 120_000);
});

describe("R7 (logic P2-a, derived-text.ts, bundle-bounds.ts): a cut never splits a surrogate pair", () => {
  it("a text of 1,999 characters and an astral character is cut before the pair, not through it", () => {
    const text = `${"a".repeat(1999)}\u{1F600}${"b"}`;
    const cutText = capLeaves(text) as string;
    expect(cutText.length).toBeLessThanOrEqual(TEXT_CAP);
    expect(/[\ud800-\udbff]$/.test(cutText), "no lone high surrogate at the end").toBe(false);
    expect(cutText).toBe("a".repeat(1999));
  });
  it("the same at the comparison bound", () => {
    const text = `${"a".repeat(COMPARE_BOUND - 1)}\u{1F600}`;
    expect(/[\ud800-\udbff]$/.test(boundText(text)), "no lone high surrogate at the end").toBe(false);
  });
});
