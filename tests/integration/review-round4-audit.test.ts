import { describe, expect, it } from "vitest";
import { createHarness, PASSWORD } from "../helpers/harness.js";
import { UUID_ZERO } from "../helpers/ids.js";
import { baselineDoc, removeAmountDoc } from "../helpers/scenario.js";

/**
 * Review round 4 (security P3, audit.ts): logins, logouts, evidence exports, bundle downloads and manifest downloads leave
 * an audit row (who, what, which resource). Nothing else about them is stored: no content, no address.
 */

describe("R4 P3 (audit.ts): access to evidence and sessions is audited", () => {
  it("login, manifest download, run export (json and html), bundle download and logout each add an audit row for the actor", async () => {
    const h = await createHarness();
    try {
      const w = await h.workspace("Audited");
      const snap = await h.importSnapshot(w.operator, baselineDoc(), { revision: "release-1" });
      const run = await h.requestRun(w.operator, { snapshot_id: snap.body.id, proposed_manifest: removeAmountDoc(), expected_hash: snap.body.hash, run_checks: false });
      await h.drain();
      const before = ((await h.api(w.admin, "GET", "/api/v1/audit?limit=100")).body.items as { action: string }[]).map((r) => r.action);
      expect(before).not.toContain("snapshot.manifest_downloaded");

      const login = await h.api(null, "POST", "/api/v1/auth/login", { email: w.operator.email, password: PASSWORD, workspace_id: w.id });
      expect(login.status, login.text).toBe(200);
      expect((await h.api(w.operator, "GET", `/api/v1/snapshots/${snap.body.id}/manifest`)).status).toBe(200);
      expect((await h.api(w.operator, "GET", `/api/v1/impact-runs/${run.body.id}/export?format=json`)).status).toBe(200);
      expect((await h.api(w.operator, "GET", `/api/v1/impact-runs/${run.body.id}/export?format=html`)).status).toBe(200);
      expect((await h.api(w.operator, "GET", `/api/v1/impact-runs/${run.body.id}/bundle`)).status).toBe(200);
      expect((await h.api(w.operator, "POST", "/api/v1/auth/logout", {})).status).toBe(200);

      const rows = (await h.api(w.admin, "GET", "/api/v1/audit?limit=100")).body.items as { action: string; actor_id: string | null; resource_type: string; resource_id: string; metadata: unknown }[];
      const has = (action: string, resourceId?: string) => rows.some((r) => r.action === action && r.actor_id === w.operator.userId && (resourceId === undefined || r.resource_id === resourceId));
      expect(has("auth.login")).toBe(true);
      expect(has("snapshot.manifest_downloaded", snap.body.id)).toBe(true);
      expect(has("impact_run.exported", run.body.id)).toBe(true);
      expect(has("impact_run.bundle_downloaded", run.body.id)).toBe(true);
      expect(has("auth.logout")).toBe(true);
      // Both export formats are recorded, and no content or address is.
      expect(rows.filter((r) => r.action === "impact_run.exported").map((r) => (r.metadata as { format: string }).format).sort()).toEqual(["html", "json"]);
      expect(JSON.stringify(rows)).not.toContain("127.0.0.1");
    } finally {
      await h.close();
    }
  }, 120_000);

  it("a refused request (a viewer asking for a bundle, an unknown run) leaves no row", async () => {
    const h = await createHarness();
    try {
      const w = await h.workspace("AuditedRefusals");
      const snap = await h.importSnapshot(w.operator, baselineDoc(), { revision: "release-1" });
      const run = await h.requestRun(w.operator, { snapshot_id: snap.body.id, proposed_manifest: removeAmountDoc(), expected_hash: snap.body.hash, run_checks: false });
      await h.drain();
      expect((await h.api(w.viewer, "GET", `/api/v1/impact-runs/${run.body.id}/bundle`)).status).toBe(403);
      expect((await h.api(w.operator, "GET", `/api/v1/impact-runs/${UUID_ZERO}/bundle`)).status).toBe(404);
      const rows = (await h.api(w.admin, "GET", "/api/v1/audit?limit=100")).body.items as { action: string }[];
      expect(rows.some((r) => r.action === "impact_run.bundle_downloaded")).toBe(false);
    } finally {
      await h.close();
    }
  }, 120_000);
});
