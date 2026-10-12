import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson, hashCanonical } from "../../src/domain/canonical.js";
import { BundleError, buildBundle, serializeBundle, verifyBundle, type EvidenceBundle } from "../../src/services/evidence.js";
import { buildGraph } from "../../src/services/graph.js";
import { restoreBundle } from "../../src/services/restore.js";
import { createHarness, count, type Harness } from "../helpers/harness.js";
import { baselineDoc, removeAmountDoc } from "../helpers/scenario.js";

/**
 * Review round 6 (security P2): a manifest that an earlier build ACCEPTED and the current validator rejects (a secret shape that was
 * not recognised then) must never leave the installation raw, and must never make the failure a mystery. Export, verify and restore
 * refuse fail-closed (BUNDLE_SNAPSHOT_MISMATCH, nothing written) and say where and by which rule, without a value; the manifest
 * download serves such a manifest redacted and names the stored document's hash; views redact; the stored row is never rewritten;
 * a workspace whose manifests all still validate is unaffected. The stored rows are append-only, so the legacy state is made by
 * INSERTING a snapshot row with the values the earlier build accepted (the validator cannot be asked to accept them). Fake secrets
 * are assembled at run time.
 */

const join = (...parts: string[]): string => parts.join("");
/** Values the widened validator now rejects (an earlier build stored them) and secret-shaped planted values; each must never come out. */
const PLANTED = {
  pin: "4821abc",
  otp: "9f3k2m1",
  session: "a1b2c3d4",
  dsn: "prod1a2b3c",
  token: `${join("gh", "p_")}${"Q9x".repeat(13)}`,
  header: `${join("Author", "ization")}: ${join("Bear", "er")} ${"Zk7".repeat(8)}`,
};
const LEGACY_OWNERS = [`on-call pin: ${PLANTED.pin}`, `sms otp: ${PLANTED.otp}`, `queue session_id: ${PLANTED.session}`, `primary dsn: ${PLANTED.dsn}`, `password=${PLANTED.token}`, PLANTED.header];
const ALL = Object.values(PLANTED);
const leaks = (text: string): string[] => ALL.filter((s) => text.includes(s));
const LIMIT = 64 * 1024 * 1024;

interface Setup {
  h: Harness;
  w: Awaited<ReturnType<Harness["workspace"]>>;
  snapshotId: string;
  runId: string;
  goodBundle: string;
  stored: { manifest: { nodes: { owner?: string }[] }; text: string; row: Record<string, unknown> };
}

/** A workspace with a snapshot and a finished run, and a valid bundle of it. */
async function workspace(): Promise<Setup> {
  const h = await createHarness();
  const w = await h.workspace("Legacy6");
  const snap = await h.importSnapshot(w.operator, baselineDoc(), { revision: "release-1" });
  expect(snap.status, JSON.stringify(snap.body)).toBe(201);
  const run = await h.requestRun(w.operator, { snapshot_id: snap.body.id, proposed_manifest: removeAmountDoc(), expected_hash: snap.body.hash, run_checks: false });
  await h.drain();
  const goodBundle = serializeBundle((await buildBundle(h.db, { workspaceId: w.id }, h.now())) as EvidenceBundle);
  const row = (await h.db.query<Record<string, unknown>>("SELECT * FROM snapshots WHERE id = $1", [snap.body.id])).rows[0] as Record<string, unknown>;
  return { h, w, snapshotId: snap.body.id as string, runId: run.body.id as string, goodBundle, stored: { manifest: JSON.parse(row.manifest as string), text: row.manifest as string, row } };
}

/** Insert another snapshot row that is a copy of the first with other stored values (the tables are append-only: no update). */
async function insertLegacy(s: Setup, over: { manifest?: unknown; revision?: string; warnings?: unknown[]; owners?: string[] }): Promise<string> {
  const id = randomUUID();
  const r = s.stored.row;
  await s.h.db.query(
    `INSERT INTO snapshots (id, workspace_id, schema_version, revision, manifest_hash, document_hash, manifest, node_count, edge_count, warnings, baseline_version, imported_at)
     VALUES ($1,$2,1,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)`,
    [id, r.workspace_id, over.revision ?? "release-legacy", r.manifest_hash, r.document_hash, over.manifest === undefined ? r.manifest : canonicalJson(over.manifest), r.node_count, r.edge_count, JSON.stringify(over.warnings ?? []), r.baseline_version, r.imported_at],
  );
  const nodes = (await s.h.db.query<Record<string, unknown>>("SELECT * FROM nodes WHERE snapshot_id = $1 ORDER BY id COLLATE \"C\"", [s.snapshotId])).rows;
  let i = 0;
  for (const n of nodes) {
    const owner = over.owners?.[i] ?? n.owner;
    i += 1;
    await s.h.db.query("INSERT INTO nodes (workspace_id, snapshot_id, id, kind, owner, version, placeholder, contract) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)", [n.workspace_id, id, n.id, n.kind, owner, n.version, n.placeholder, n.contract === null ? null : JSON.stringify(n.contract)]);
  }
  return id;
}

/** The manifest of the setup with the legacy owners written into its first nodes, and the JSON pointers of those owners. */
function legacyManifest(s: Setup): { manifest: unknown; paths: string[] } {
  const manifest = JSON.parse(s.stored.text) as { nodes: { owner?: string }[] };
  const paths: string[] = [];
  LEGACY_OWNERS.forEach((owner, i) => {
    if (manifest.nodes[i] === undefined) return;
    manifest.nodes[i].owner = owner;
    paths.push(`/nodes/${i}/owner`);
  });
  return { manifest, paths };
}

describe("R6 (security P2): manifests an earlier build accepted and the current validator rejects", () => {
  it("control: the legacy values are rejected by the current validator (at the owner locations), the good manifest is not", async () => {
    const s = await workspace();
    try {
      const { manifest, paths } = legacyManifest(s);
      expect(paths.length).toBeGreaterThanOrEqual(5);
      const built = buildGraph(manifest);
      expect(built.ok).toBe(false);
      if (!built.ok) expect(built.failure.issues.map((i) => i.path)).toEqual(paths);
      expect(buildGraph(baselineDoc()).ok).toBe(true);
      // `hooks webhook: a1b2c3d4e5` is neither rejected nor redacted (not a secret shape): it stays exportable, as documented.
      const webhook = JSON.parse(s.stored.text) as { nodes: { owner?: string }[] };
      (webhook.nodes[0] as { owner?: string }).owner = "hooks webhook: a1b2c3d4e5";
      expect(buildGraph(webhook).ok).toBe(true);
    } finally {
      await s.h.close();
    }
  }, 120_000);

  it("export refuses (BUNDLE_SNAPSHOT_MISMATCH), names the snapshot, the locations and the rule, repeats no value, and tells what to do", async () => {
    const s = await workspace();
    try {
      const { manifest, paths } = legacyManifest(s);
      const legacyId = await insertLegacy(s, { manifest, revision: "release-legacy" });
      const failure = await buildBundle(s.h.db, { workspaceId: s.w.id }, s.h.now()).then(
        () => null,
        (error: unknown) => error as BundleError,
      );
      expect(failure, "the export must refuse").not.toBeNull();
      expect(failure?.code).toBe("BUNDLE_SNAPSHOT_MISMATCH");
      const message = failure?.message ?? "";
      expect(message).toContain(legacyId);
      for (const path of paths.slice(0, 5)) expect(message, path).toContain(path);
      expect(message).toContain("SECRET_VALUE_REJECTED");
      expect(message).toContain("Nothing was written");
      expect(message).toMatch(/Re-import the source manifest through the current importer/);
      expect(leaks(message), "values in the refusal message").toEqual([]);
    } finally {
      await s.h.close();
    }
  }, 120_000);

  it("verify-bundle and restore refuse a bundle that carries such a manifest, with the same message and nothing written", async () => {
    const s = await workspace();
    try {
      const { manifest } = legacyManifest(s);
      const bundle = JSON.parse(s.goodBundle) as Record<string, any>;
      bundle.snapshots[0].manifest = manifest;
      const { bundle_hash: _b, hashes: _h, stale_runs: _s, ...body } = bundle;
      const hashes = { snapshots: hashCanonical(body.snapshots), impact_runs: hashCanonical(body.impact_runs), contract_checks: hashCanonical(body.contract_checks) };
      const withHashes = { ...body, hashes };
      const forged = JSON.stringify({ ...withHashes, bundle_hash: hashCanonical(withHashes) });
      let verifyMessage = "";
      try {
        verifyBundle(forged, { maxBytes: LIMIT });
      } catch (error) {
        expect((error as BundleError).code).toBe("BUNDLE_SNAPSHOT_MISMATCH");
        verifyMessage = (error as BundleError).message;
      }
      expect(verifyMessage).toContain(s.snapshotId);
      expect(verifyMessage).toContain("SECRET_VALUE_REJECTED");
      expect(leaks(verifyMessage)).toEqual([]);
      const other = await createHarness();
      try {
        await expect(restoreBundle(other.ctx, forged)).rejects.toMatchObject({ code: "BUNDLE_SNAPSHOT_MISMATCH" });
        expect(await count(other.db, "workspaces"), "nothing was written").toBe(0);
        expect(await count(other.db, "snapshots"), "nothing was written").toBe(0);
      } finally {
        await other.close();
      }
    } finally {
      await s.h.close();
    }
  }, 120_000);

  it("the manifest download serves such a manifest redacted with the stored hash in a header; a valid manifest is served verbatim; the row is untouched", async () => {
    const s = await workspace();
    try {
      const good = await s.h.api(s.w.operator, "GET", `/api/v1/snapshots/${s.snapshotId}/manifest`);
      expect(good.status).toBe(200);
      expect(good.headers["x-changeradar-manifest-redacted"]).toBeUndefined();
      const { manifest } = legacyManifest(s);
      const legacyId = await insertLegacy(s, { manifest });
      const before = (await s.h.db.query<{ manifest: string; document_hash: string }>("SELECT manifest, document_hash FROM snapshots WHERE id = $1", [legacyId])).rows[0] as { manifest: string; document_hash: string };
      for (const user of [s.w.operator, s.w.admin]) {
        const res = await s.h.api(user, "GET", `/api/v1/snapshots/${legacyId}/manifest`);
        expect(res.status).toBe(200);
        expect(leaks(res.text), "planted values in the downloaded manifest").toEqual([]);
        expect(res.text).toContain("[REDACTED]");
        expect(res.text).toContain("contract.invoice");
        expect(res.headers["x-changeradar-manifest-redacted"]).toBe(before.document_hash);
      }
      const after = (await s.h.db.query<{ manifest: string }>("SELECT manifest FROM snapshots WHERE id = $1", [legacyId])).rows[0] as { manifest: string };
      expect(after.manifest, "the stored row is what was stored").toBe(before.manifest);
      expect((await s.h.api(s.w.viewer, "GET", `/api/v1/snapshots/${legacyId}/manifest`)).status, "the viewer role cannot download a manifest").toBe(403);
    } finally {
      await s.h.close();
    }
  }, 120_000);

  it("views, run exports and the bundle of a workspace whose legacy values sit in the revision, the warnings and the node rows show none of the planted values", async () => {
    const s = await workspace();
    try {
      const legacyId = await insertLegacy(s, { revision: `release-${PLANTED.token}`, warnings: [{ code: "LEGACY", message: `note ${PLANTED.header}` }], owners: LEGACY_OWNERS });
      const outputs: string[] = [];
      for (const url of [`/api/v1/snapshots/${legacyId}`, `/api/v1/snapshots`, `/api/v1/snapshots/${legacyId}/nodes`, `/api/v1/snapshots/${legacyId}/edges`, `/api/v1/impact-runs/${s.runId}`, `/api/v1/impact-runs/${s.runId}/export?format=json`, `/api/v1/impact-runs/${s.runId}/export?format=html`, `/api/v1/impact-runs`]) {
        const res = await s.h.api(s.w.viewer, "GET", url);
        outputs.push(`${url} ${res.status} ${res.text}`);
      }
      expect(leaks(outputs.join("\n")), "planted values in views and exports").toEqual([]);
      // The manifest of this snapshot is valid (the planted values are in other fields), so the workspace bundle is produced, and it is redacted.
      const text = serializeBundle((await buildBundle(s.h.db, { workspaceId: s.w.id }, s.h.now())) as EvidenceBundle);
      expect(leaks(text), "planted values in the workspace bundle").toEqual([]);
      expect(() => verifyBundle(text, { maxBytes: LIMIT })).not.toThrow();
    } finally {
      await s.h.close();
    }
  }, 120_000);

  it("a workspace whose manifests all still validate exports, verifies and restores as before (control)", async () => {
    const s = await workspace();
    try {
      expect(() => verifyBundle(s.goodBundle, { maxBytes: LIMIT })).not.toThrow();
      const other = await createHarness();
      try {
        await restoreBundle(other.ctx, s.goodBundle);
        expect(await count(other.db, "snapshots")).toBe(1);
        const again = serializeBundle((await buildBundle(other.db, { workspaceId: s.w.id }, other.now())) as EvidenceBundle);
        expect(() => verifyBundle(again, { maxBytes: LIMIT })).not.toThrow();
      } finally {
        await other.close();
      }
    } finally {
      await s.h.close();
    }
  }, 120_000);
});
