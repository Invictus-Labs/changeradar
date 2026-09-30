import { describe, expect, it } from "vitest";
import { htmlReportRenderer } from "../../src/report/html-report.js";
import { e, f, manifest, n } from "../helpers/builders.js";
import { createHarness, getRun, type Harness, type TestWorkspace } from "../helpers/harness.js";
import { baselineDoc, removeAmountDoc } from "../helpers/scenario.js";

/**
 * Review round 3 regression tests for the HTTP surface: numeric cursors, what a 422 echoes, the export and bundle
 * budgets, the bundle size limit, the run list marker for an older engine, the production HTML report, and the 503 of
 * the readiness gate. Literals that could look like credentials are assembled from fragments.
 */

const join = (...parts: string[]): string => parts.join("");
const TOKEN_CORE = "Zq8vK2mXp4Lw9RtY7nBcJd3fQ1aB2cD3eF4g";
const cursorOf = (parts: unknown[]): string => Buffer.from(JSON.stringify(parts), "utf8").toString("base64url");

async function seeded(h: Harness): Promise<{ w: TestWorkspace; runId: string; snapshot: { id: string; hash: string } }> {
  const w = await h.workspace("Api");
  const snap = await h.importSnapshot(w.operator, baselineDoc(), { revision: "release-1" });
  const run = await h.requestRun(w.operator, { snapshot_id: snap.body.id, proposed_manifest: removeAmountDoc(), expected_hash: snap.body.hash, run_checks: false });
  await h.drain();
  return { w, runId: run.body.id, snapshot: { id: snap.body.id, hash: snap.body.hash } };
}

describe("R3 P2 (impact.ts:398): a numeric cursor must be a non-negative safe integer (400, never 500)", () => {
  it("findings, events and audit cursors of 1.5, 1e30, 9e18 and -1 answer 400 INVALID_CURSOR; a valid position still pages", async () => {
    const h = await createHarness();
    try {
      const { w, runId } = await seeded(h);
      const urls = [`/api/v1/impact-runs/${runId}/findings`, "/api/v1/events", "/api/v1/audit"];
      for (const url of urls) {
        for (const bad of [[1.5], [1e30], [9e18], [-1]]) {
          const res = await h.api(w.admin, "GET", `${url}?cursor=${cursorOf(bad)}`);
          expect(res.status, `${url} ${JSON.stringify(bad)}: ${res.text.slice(0, 120)}`).toBe(400);
          expect(res.body.error.code).toBe("INVALID_CURSOR");
        }
      }
      const control = await h.api(w.admin, "GET", `/api/v1/impact-runs/${runId}/findings?cursor=${cursorOf([0])}`);
      expect(control.status).toBe(200);
    } finally {
      await h.close();
    }
  });
});

describe("R3 P2 (impact.ts:83): a 422 UNKNOWN_CHECK never echoes the submitted check keys", () => {
  it("reports a count and the positions instead of the values", async () => {
    const h = await createHarness();
    try {
      const { w, snapshot } = await seeded(h);
      const token = join("gh", "p_", TOKEN_CORE);
      const res = await h.api(w.operator, "POST", "/api/v1/impact-runs", { snapshot_id: snapshot.id, proposed_manifest: removeAmountDoc(), expected_hash: snapshot.hash, check_keys: ["chk.known-missing", token, "MARKZZQQ9"] });
      expect(res.status, res.text).toBe(422);
      expect(res.body.error.code).toBe("UNKNOWN_CHECK");
      expect(res.text).not.toContain(TOKEN_CORE);
      expect(res.text).not.toContain("MARKZZQQ9");
      expect(res.text).not.toContain("chk.known-missing");
      expect(res.body.error.details).toEqual({ count: 3, indexes: [0, 1, 2] });
    } finally {
      await h.close();
    }
  });
});

describe("R3 P2 (tests): the export and bundle budgets are exact, per user, and capped in flight", () => {
  it("the 13th export in a window is the first refusal; another user's budget is independent", async () => {
    const h = await createHarness();
    try {
      const { w, runId } = await seeded(h);
      const url = `/api/v1/impact-runs/${runId}/export?format=json`;
      const statuses: number[] = [];
      for (let i = 0; i < 13; i += 1) statuses.push((await h.api(w.operator, "GET", url)).status);
      expect(statuses.slice(0, 12)).toEqual(Array(12).fill(200));
      expect(statuses[12]).toBe(429);
      expect((await h.api(w.viewer, "GET", url)).status, "a second user has a budget of their own").toBe(200);
      expect((await h.api(w.operator, "GET", url)).status, "the first user is still refused").toBe(429);
    } finally {
      await h.close();
    }
  });

  it("bundles have a smaller budget of their own: the 5th is refused while exports still work", async () => {
    const h = await createHarness();
    try {
      const { w, runId } = await seeded(h);
      const statuses: number[] = [];
      for (let i = 0; i < 5; i += 1) statuses.push((await h.api(w.operator, "GET", `/api/v1/impact-runs/${runId}/bundle`)).status);
      expect(statuses).toEqual([200, 200, 200, 200, 429]);
      expect((await h.api(w.operator, "GET", `/api/v1/impact-runs/${runId}/export?format=json`)).status).toBe(200);
    } finally {
      await h.close();
    }
  });

  it("no more than two exports are built at the same moment: a burst of nine (three users, three each, well inside every budget) is partly refused with Retry-After 1", async () => {
    const h = await createHarness();
    try {
      const { w, runId } = await seeded(h);
      const users = [w.admin, w.operator, w.viewer];
      const results = await Promise.all(users.flatMap((user) => Array.from({ length: 3 }, () => h.api(user, "GET", `/api/v1/impact-runs/${runId}/export?format=json`))));
      const refused = results.filter((r) => r.status === 429);
      expect(results.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(2);
      expect(refused.length).toBeGreaterThanOrEqual(1);
      expect(refused[0]!.headers["retry-after"]).toBe("1");
    } finally {
      await h.close();
    }
  });
});

describe("R3 P2 (evidence.ts:268): a bundle above the installation's limit is a 413 with a code, before the expensive verification", () => {
  it("BUNDLE_TOO_LARGE at export", async () => {
    const h = await createHarness({ settings: { maxBundleBytes: 2000 } });
    try {
      const { w, runId } = await seeded(h);
      const res = await h.api(w.operator, "GET", `/api/v1/impact-runs/${runId}/bundle`);
      expect(res.status, res.text).toBe(413);
      expect(res.body.error.code).toBe("BUNDLE_TOO_LARGE");
    } finally {
      await h.close();
    }
  });
});

describe("R3 P1 (html-report.ts:121, impact.ts list): an older-engine run is marked in the list, and accepted ids print unchanged in the production report", () => {
  it("the run list flags a run from an older engine and only that run", async () => {
    const h = await createHarness();
    try {
      const { w, runId, snapshot } = await seeded(h);
      const second = await h.requestRun(w.operator, { snapshot_id: snapshot.id, proposed_manifest: removeAmountDoc(), expected_hash: snapshot.hash, run_checks: false });
      await h.drain();
      await h.db.query("ALTER TABLE impact_runs DISABLE TRIGGER impact_runs_protect");
      try {
        await h.db.query("UPDATE impact_runs SET assessment = assessment - 'engine_version' WHERE id = $1", [runId]);
      } finally {
        await h.db.query("ALTER TABLE impact_runs ENABLE TRIGGER impact_runs_protect");
      }
      const list = await h.api(w.viewer, "GET", "/api/v1/impact-runs");
      const flags = Object.fromEntries(list.body.items.map((r: any) => [r.id, r.rerun_required]));
      expect(flags).toEqual({ [runId]: true, [second.body.id]: false });
      const view = await getRun(h, w.viewer, runId);
      expect(view.engine.rerun_required).toBe(true);
    } finally {
      await h.close();
    }
  });

  it("the production HTML report prints two different accepted ids that log-strength redaction would have collapsed", async () => {
    const h = await createHarness();
    try {
      h.ctx.reportRenderer = htmlReportRenderer;
      const w = await h.workspace("Ids");
      const doc = (drop: boolean) =>
        manifest(
          [n("contract.c", "contract", { fields: [f("a"), ...(drop ? [] : [f("b")])] }), n("secret:aaaaaaaa", "service"), n("secret:bbbbbbbb", "service"), n("token:abcdefgh", "service")],
          [e("secret:aaaaaaaa", "contract.c", "consumes"), e("secret:bbbbbbbb", "contract.c", "consumes"), e("token:abcdefgh", "contract.c", "consumes")],
        );
      const snap = await h.importSnapshot(w.operator, doc(false), { revision: "release-1" });
      expect(snap.status, snap.text).toBe(201);
      const run = await h.requestRun(w.operator, { snapshot_id: snap.body.id, proposed_manifest: doc(true), expected_hash: snap.body.hash, run_checks: false });
      await h.drain();
      const html = await h.api(w.viewer, "GET", `/api/v1/impact-runs/${run.body.id}/export?format=html`);
      expect(html.status).toBe(200);
      for (const id of ["secret:aaaaaaaa", "secret:bbbbbbbb", "token:abcdefgh"]) expect(html.text, id).toContain(id);
    } finally {
      await h.close();
    }
  });
});

describe("R3 P3 (server.ts:143): the readiness gate's 503 carries Retry-After on every route", () => {
  it("a route other than health answers 503 NOT_READY with retry-after 5", async () => {
    const h = await createHarness();
    try {
      const { w } = await seeded(h);
      h.ctx.readiness = { ok: false, reason: "migration_failed" };
      const res = await h.api(w.viewer, "GET", "/api/v1/snapshots");
      expect(res.status).toBe(503);
      expect(res.headers["retry-after"]).toBe("5");
    } finally {
      await h.close();
    }
  });
});
