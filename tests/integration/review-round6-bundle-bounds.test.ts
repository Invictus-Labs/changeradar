import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hashCanonical } from "../../src/domain/canonical.js";
import { redactSecrets } from "../../src/domain/redaction.js";
import { BundleError, buildBundle, serializeBundle, verifyBundle, type EvidenceBundle } from "../../src/services/evidence.js";
import { restoreBundle } from "../../src/services/restore.js";
import { createHarness, getRun } from "../helpers/harness.js";

/**
 * Review round 6 (logic P2 bundle-bounds.ts:25, security P1/P2 redaction-forms.ts:68 and restore.ts:84): verification names what
 * restore would refuse (an unpaired surrogate in any text, as well as a NUL), and an object KEY longer than the text cap is
 * refused: restore cuts every string VALUE but a key has nothing to be cut to, and the redactor reads a key in full on every
 * view. A key of exactly the cap is kept, and a run that carries one is served within a bound (the redactor is linear in it).
 */

const here = dirname(fileURLToPath(import.meta.url));
const ENGINE1 = readFileSync(resolve(here, "../fixtures/upgrade/engine1-bundle.json"), "utf8").replace(/\b([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12})\b/g, "$1-$2-$3-$4-$5");
const LIMIT = 64 * 1024 * 1024;
const CAP = 2000;
const HIGH = String.fromCharCode(0xd83d);
const LOW = String.fromCharCode(0xde00);

function reseal(bundle: Record<string, any>): string {
  const { bundle_hash: _drop, hashes: _h, stale_runs: _s, ...body } = bundle;
  const hashes = { snapshots: hashCanonical(body.snapshots), impact_runs: hashCanonical(body.impact_runs), contract_checks: hashCanonical(body.contract_checks) };
  const withHashes = { ...body, hashes };
  return JSON.stringify({ ...withHashes, bundle_hash: hashCanonical(withHashes) });
}
const fresh = (): Record<string, any> => JSON.parse(ENGINE1) as Record<string, any>;
const checkRow = (over: Record<string, unknown> = {}) => ({
  key: "chk.r6", node_id: "contract.invoice", url: "http://localhost:9/ok", method: "GET", timeout_ms: 1000, retries: 0, expect_status: 200, required_fields: [], credential_alias: null, enabled: false,
  created_at: "2026-09-29T00:00:00.000Z", disabled_at: "2026-09-29T00:00:00.000Z", ...over,
});
const codeOf = (text: string): string => {
  try {
    verifyBundle(text, { maxBytes: LIMIT });
    return "ACCEPTED";
  } catch (error) {
    return error instanceof BundleError ? error.code : String(error);
  }
};

describe("R6 (bundle-bounds.ts): an unpaired surrogate or an over-long object key is a bundle rejection at verification and at restore", () => {
  it("the genuine bundle is accepted (control)", () => {
    expect(codeOf(ENGINE1)).toBe("ACCEPTED");
  });

  it("a valid surrogate PAIR (an astral character) is accepted (control), and so is a key of exactly the cap", () => {
    const b = fresh();
    b.workspace.name = `ws ${HIGH}${LOW}`;
    b.impact_runs[0].assessment_detail.wide = { ["k".repeat(CAP)]: 1 };
    expect(codeOf(reseal(b))).toBe("ACCEPTED");
  });

  it("the values AT the bounds are accepted (control): hour 23, three retries, status 599, int4", () => {
    const b = fresh();
    b.impact_runs[0].created_at = "2026-09-29T23:59:59.000Z";
    b.impact_runs[0].baseline_version = 2_147_483_647;
    b.contract_checks = [checkRow({ retries: 3, expect_status: 599 })];
    expect(codeOf(reseal(b))).toBe("ACCEPTED");
  });

  const forgeries: [string, (b: Record<string, any>) => void][] = [
    ["a lone high surrogate in the workspace name", (b) => { b.workspace.name = `ws${HIGH}`; }],
    ["a lone low surrogate in the workspace name", (b) => { b.workspace.name = `${LOW}ws`; }],
    ["a lone high surrogate at the end of a run's assessment text", (b) => { b.impact_runs[0].assessment_detail.note = `text${HIGH}`; }],
    ["a lone low surrogate in a run event note", (b) => { b.impact_runs[0].events[0].note = `n${LOW}n`; }],
    ["a lone surrogate in an object KEY", (b) => { b.impact_runs[0].assessment_detail.odd = { [`key${HIGH}`]: 1 }; }],
    ["a run timestamp with the hour 24", (b) => { b.impact_runs[0].created_at = "2026-09-29T24:00:00.000Z"; }],
    ["a baseline version one above int4", (b) => { b.impact_runs[0].baseline_version = 2_147_483_648; }],
    ["a check with four retries", (b) => { b.contract_checks = [checkRow({ retries: 4 })]; }],
    ["a check with the expected status 600", (b) => { b.contract_checks = [checkRow({ expect_status: 600 })]; }],
    ["a check whose disabled_at is not a timestamp", (b) => { b.contract_checks = [checkRow({ disabled_at: "garbage" })]; }],
    ["a finding id of fnd_ and 21 hex digits", (b) => { const run = b.impact_runs.find((r: any) => r.findings.length > 0); run.findings[0].finding_key = `fnd_${"0".repeat(21)}`; }],
    ["a NUL inside an object KEY", (b) => { b.impact_runs[0].assessment_detail.odd = { [`k${String.fromCharCode(0)}`]: 1 }; }],
    ["an object key one character over the cap",(b) => { b.impact_runs[0].assessment_detail.wide = { ["k".repeat(CAP + 1)]: 1 }; }],
    // (round 7, a survivor of the mutation run) The rule is about the RAW length: restore cuts a value but a key has nothing to be cut to. A key that is over the cap
    // but that redaction shortens to within it is refused as well; the check that refuses a key which redaction LENGTHENS past the cap does not reach it.
    ["an object key over the cap that redaction shortens to below it", (b) => {
      const key = `${"k".repeat(1701)} password=Zx9Kq2Lm7Pw4Rt8Yv3Bn${"x".repeat(280)}`;
      expect(key.length, "the key is over the cap as written").toBeGreaterThan(CAP);
      expect(redactSecrets(key).length, "and within it once redacted").toBeLessThanOrEqual(CAP);
      b.impact_runs[0].assessment_detail.wide = { [key]: 1 };
    }],
    ["an object key of 262,150 characters (the stall of the review)", (b) => { b.impact_runs[0].assessment_detail.wide = { [`"${"password".repeat(32_769)}`]: 1 }; }],
  ];
  for (const [label, edit] of forgeries) {
    it(`${label}: BUNDLE_SCHEMA_INVALID at verification, and restore refuses it under the same code`, async () => {
      const bundle = fresh();
      edit(bundle);
      const text = reseal(bundle);
      expect(codeOf(text)).toBe("BUNDLE_SCHEMA_INVALID");
      const h = await createHarness();
      try {
        await expect(restoreBundle(h.ctx, text)).rejects.toMatchObject({ code: "BUNDLE_SCHEMA_INVALID" });
      } finally {
        await h.close();
      }
    }, 120_000);
  }
});

describe("R6 (redaction-forms.ts:68): a run that carries a key of the full cap is served within a bound", () => {
  it("run view, JSON export and run bundle of a restored run whose key is 2,000 characters of credential words each answer in under 3 seconds", async () => {
    const bundle = fresh();
    bundle.impact_runs[0].assessment_detail.hostile = { [`${"password".repeat(250)}`]: "|\n  x", [`"${"token".repeat(399)}`]: 1 };
    const text = reseal(bundle);
    expect(codeOf(text)).toBe("ACCEPTED");
    const h = await createHarness();
    try {
      await restoreBundle(h.ctx, text);
      const workspaceId = bundle.workspace.id as string;
      const runId = bundle.impact_runs[0].id as string;
      const viewer = await h.userIn(workspaceId, "viewer");
      const timed = async <T,>(work: () => Promise<T>): Promise<number> => {
        const t0 = Date.now();
        await work();
        return Date.now() - t0;
      };
      expect(await timed(() => getRun(h, viewer, runId)), "GET /impact-runs/{id} in ms").toBeLessThan(3000);
      expect(await timed(async () => serializeBundle((await buildBundle(h.db, { workspaceId }, h.now())) as EvidenceBundle)), "workspace bundle in ms").toBeLessThan(3000);
      // Liveness stays responsive while several views of that run are in flight (the event loop is not stalled by the key).
      const latencies: number[] = [];
      const live = async (): Promise<void> => {
        for (let i = 0; i < 10; i += 1) {
          latencies.push(await timed(async () => expect((await h.api(null, "GET", "/api/v1/health/live")).status).toBe(200)));
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      };
      await Promise.all([live(), getRun(h, viewer, runId), getRun(h, viewer, runId), getRun(h, viewer, runId)]);
      expect(Math.max(...latencies), "slowest /health/live in ms during the views").toBeLessThan(1000);
    } finally {
      await h.close();
    }
  }, 120_000);
});
