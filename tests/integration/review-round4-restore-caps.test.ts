import { describe, expect, it } from "vitest";
import { hashCanonical } from "../../src/domain/canonical.js";
import { buildBundle, serializeBundle, type EvidenceBundle } from "../../src/services/evidence.js";
import { restoreBundle } from "../../src/services/restore.js";
import { defaultSettings } from "../../src/platform/context.js";
import { createHarness } from "../helpers/harness.js";
import { baselineDoc, removeAmountDoc } from "../helpers/scenario.js";

/**
 * Review round 4 (tests P2 H34/H35/H38/V23, security P3 restore.ts:85): every string that a restore turns into live state is
 * cut to 2,000 characters, one assertion per site: check definitions and results, unknowns, assessment detail, check keys,
 * finding text, expected hash, and the contract check definitions. (Runs carry an older engine stamp in the crafted bundle,
 * so what is not derived from the manifests is accepted on its hashes, exactly as documented.)
 */

function reseal(bundle: Record<string, any>): string {
  const { bundle_hash: _drop, hashes: _h, stale_runs: _s, ...body } = bundle;
  const hashes = { snapshots: hashCanonical(body.snapshots), impact_runs: hashCanonical(body.impact_runs), contract_checks: hashCanonical(body.contract_checks) };
  const withHashes = { ...body, hashes };
  return JSON.stringify({ ...withHashes, bundle_hash: hashCanonical(withHashes) });
}

const long = "n".repeat(5000);

describe("R4 P2/P3 (restore.ts): every stored string is capped at 2,000 characters", () => {
  it("check definition and result, unknowns, assessment detail, check keys, finding text, expected hash and contract check text", async () => {
    const src = await createHarness({ settings: { checks: { ...defaultSettings.checks, allowedHosts: ["localhost:9"] } } });
    let text = "";
    let workspaceId = "";
    try {
      const w = await src.workspace("Caps4");
      workspaceId = w.id;
      await src.api(w.admin, "POST", "/api/v1/contract-checks", { key: "chk.caps", node_id: "contract.invoice", url: "http://localhost:9/ok", retries: 0, required_fields: [{ name: "invoice_id", type: "string" }] });
      const snap = await src.importSnapshot(w.operator, baselineDoc(), { revision: "release-1" });
      await src.requestRun(w.operator, { snapshot_id: snap.body.id, proposed_manifest: removeAmountDoc(), expected_hash: snap.body.hash, run_checks: false });
      await src.drain();
      const crafted = JSON.parse(serializeBundle((await buildBundle(src.db, { workspaceId }, src.now())) as EvidenceBundle)) as Record<string, any>;
      const run = crafted.impact_runs[0];
      delete run.assessment_detail.engine_version; // an older stamp: not re-derived, protected by its hashes only
      run.assessment_detail.long_detail = long;
      run.unknowns = [...run.unknowns, { id: "u-long", code: "STALE_CONTRACT", message: long, node_id: "svc.a" }];
      run.check_keys = [long];
      run.expected_hash = long;
      run.findings[0].reason = long;
      run.checks = [{ check_key: long, node_id: long, state: "PASSED", definition: { url: long }, result: { detail: long }, started_at: run.created_at, finished_at: run.created_at }];
      crafted.contract_checks[0].url = long;
      crafted.contract_checks[0].key = long;
      crafted.contract_checks[0].node_id = long;
      crafted.contract_checks[0].credential_alias = null;
      crafted.contract_checks[0].required_fields = [{ name: long, type: "string" }];
      text = reseal(crafted);
    } finally {
      await src.close();
    }
    const dst = await createHarness();
    try {
      await restoreBundle(dst.ctx, text);
      const one = async (sql: string): Promise<string> => ((await dst.db.query<{ v: string }>(sql)).rows[0] as { v: string }).v;
      expect((await one("SELECT definition->>'url' AS v FROM check_results")).length, "check definition").toBe(2000);
      expect((await one("SELECT result->>'detail' AS v FROM check_results")).length, "check result").toBe(2000);
      expect((await one("SELECT check_key AS v FROM check_results")).length, "run check key").toBe(2000);
      expect((await one("SELECT node_id AS v FROM check_results")).length, "run check node").toBe(2000);
      expect((await one("SELECT (SELECT max(length(e->>'message')) FROM jsonb_array_elements(unknowns) e)::text AS v FROM impact_runs")), "unknown text").toBe("2000");
      expect((await one("SELECT length(assessment->>'long_detail')::text AS v FROM impact_runs")), "assessment detail").toBe("2000");
      expect((await one("SELECT length(check_keys->>0)::text AS v FROM impact_runs")), "check_keys").toBe("2000");
      expect((await one("SELECT length(expected_hash)::text AS v FROM impact_runs")), "expected_hash").toBe("2000");
      expect((await one("SELECT max(length(reason))::text AS v FROM findings")), "finding reason").toBe("2000");
      expect((await one("SELECT length(url)::text AS v FROM contract_checks")), "contract check url").toBe("2000");
      expect((await one("SELECT length(check_key)::text AS v FROM contract_checks")), "contract check key").toBe("2000");
      expect((await one("SELECT length(node_id)::text AS v FROM contract_checks")), "contract check node").toBe("2000");
      expect((await one("SELECT length(required_fields->0->>'name')::text AS v FROM contract_checks")), "contract check field name").toBe("2000");
    } finally {
      await dst.close();
    }
  }, 120_000);
});
