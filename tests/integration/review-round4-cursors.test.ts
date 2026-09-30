import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "../../src/platform/cursor.js";
import { isDataException } from "../../src/platform/errors.js";
import { createHarness } from "../helpers/harness.js";
import { baselineDoc, removeAmountDoc } from "../helpers/scenario.js";
import { UUID_ZERO } from "../helpers/ids.js";

/**
 * Review round 4 (logic P2, cursor.ts:16): the round-3 cursor check was incomplete. An integer of 2^31 or more overflows the
 * `position` column, and a timestamp that only `Date.parse` accepts (2026-02-31, a bare year, an expanded year, a negative
 * year) fails the SQL cast: both answered 500. A run cursor with a bad uuid answered 404. All are 400 INVALID_CURSOR.
 */

const b64 = (parts: unknown[]): string => Buffer.from(JSON.stringify(parts), "utf8").toString("base64url");
/** What decodeCursor answers, as a value: the parts, or REJECTED (so a wrong answer fails by assertion, not by a thrown error). */
const decode = (cursor: string, shape: unknown[]): unknown => {
  try {
    return decodeCursor(cursor, shape as never);
  } catch (error) {
    return (error as Error).message === "cursor is not valid" ? "REJECTED" : `THREW ${(error as Error).message}`;
  }
};

describe("R4 P2 (cursor.ts): decodeCursor validates every part strictly", () => {
  it("an int4 position, an ISO timestamp with a real calendar date, and a uuid", () => {
    expect(decode(encodeCursor([5]), ["int4"])).toEqual([5]);
    expect(decode(encodeCursor([2147483647]), ["int4"])).toEqual([2147483647]);
    for (const bad of [2147483648, 3000000000, Number.MAX_SAFE_INTEGER]) expect(decode(b64([bad]), ["int4"]), String(bad)).toBe("REJECTED");
    const ok = "2026-01-31T10:20:30.123Z";
    expect(decode(b64([ok, UUID_ZERO]), ["iso", "uuid"])).toEqual([ok, UUID_ZERO]);
    expect(decode(b64(["2026-01-31T10:20:30Z", UUID_ZERO]), ["iso", "uuid"])).toEqual(["2026-01-31T10:20:30Z", UUID_ZERO]);
    for (const bad of ["2026-02-31T00:00:00Z", "2026", "+275760-09-13T00:00:00.000Z", "-000001-01-01T00:00:00Z", "2026-13-01T00:00:00Z", "2026-01-01 00:00:00", "2026-01-01T24:00:00Z", "0000-01-01T00:00:00Z", "2026-01-01T00:00:00+01:00"]) {
      expect(decode(b64([bad, UUID_ZERO]), ["iso", "uuid"]), bad).toBe("REJECTED");
    }
    expect(decode(b64([ok, "not-a-uuid"]), ["iso", "uuid"])).toBe("REJECTED");
  });

  it("isDataException recognises SQLSTATE class 22 and nothing else", () => {
    for (const code of ["22003", "22007", "22008", "22P02", "22001"]) expect(isDataException({ code }), code).toBe(true);
    for (const code of ["23505", "42P01", "08006", "57014", "P0001", "", undefined]) expect(isDataException({ code }), String(code)).toBe(false);
    expect(isDataException(new Error("x"))).toBe(false);
    expect(isDataException(null)).toBe(false);
  });
});

describe("R4 P2 (server.ts): a database data exception (SQLSTATE class 22) is the client's mistake, a 400 and never a 500", () => {
  it("answers 400 INVALID_CURSOR when a cursor was sent and 400 INVALID_REQUEST otherwise, and a connection error stays a 503", async () => {
    const h = await createHarness();
    try {
      const w = await h.workspace("DataException");
      const snap = await h.importSnapshot(w.operator, baselineDoc(), { revision: "release-1" });
      const run = await h.requestRun(w.operator, { snapshot_id: snap.body.id, proposed_manifest: removeAmountDoc(), expected_hash: snap.body.hash, run_checks: false });
      await h.drain();
      const db = h.ctx.db as unknown as { query: (sql: string, params?: unknown[]) => Promise<unknown> };
      const original = db.query.bind(db);
      let code = "22003";
      db.query = async (sql: string, params?: unknown[]) => {
        if (/FROM findings/.test(sql) && /position >/.test(sql)) throw Object.assign(new Error("simulated database error"), { code });
        return original(sql, params);
      };
      try {
        const findings = `/api/v1/impact-runs/${run.body.id}/findings`;
        const withCursor = await h.api(w.viewer, "GET", `${findings}?cursor=${b64([0])}`);
        expect(withCursor.status, withCursor.text).toBe(400);
        expect(withCursor.body.error.code).toBe("INVALID_CURSOR");
        code = "22P02";
        const another = await h.api(w.viewer, "GET", `${findings}?cursor=${b64([1])}`);
        expect(another.status).toBe(400);
        code = "08006";
        const outage = await h.api(w.viewer, "GET", `${findings}?cursor=${b64([2])}`);
        expect(outage.status, "a lost connection is an outage (503), not a data exception").toBe(503);
        code = "XX000";
        const defect = await h.api(w.viewer, "GET", `${findings}?cursor=${b64([3])}`);
        expect(defect.status, "anything else is still a 500").toBe(500);
      } finally {
        db.query = original;
      }
    } finally {
      await h.close();
    }
  }, 120_000);
});

describe("R4 P2 (impact.ts, snapshots.ts): a malformed cursor is a 400 INVALID_CURSOR on every paged route", () => {
  it("findings, runs and snapshots answer 400 for the shapes the reviewers found, and still page for a valid cursor", async () => {
    const h = await createHarness();
    try {
      const w = await h.workspace("Cursors");
      const snap = await h.importSnapshot(w.operator, baselineDoc(), { revision: "release-1" });
      const run = await h.requestRun(w.operator, { snapshot_id: snap.body.id, proposed_manifest: removeAmountDoc(), expected_hash: snap.body.hash, run_checks: false });
      await h.drain();
      const status = async (path: string, cursor: unknown[]): Promise<number> => (await h.api(w.viewer, "GET", `${path}${path.includes("?") ? "&" : "?"}cursor=${b64(cursor)}`)).status;
      const findings = `/api/v1/impact-runs/${run.body.id}/findings`;
      for (const position of [3_000_000_000, 2_147_483_648, Number.MAX_SAFE_INTEGER]) expect(await status(findings, [position]), `findings ${position}`).toBe(400);
      for (const path of ["/api/v1/impact-runs", "/api/v1/snapshots"]) {
        for (const ts of ["2026-02-31T00:00:00Z", "2026", "+275760-09-13T00:00:00.000Z", "-000001-01-01T00:00:00Z"]) expect(await status(path, [ts, UUID_ZERO]), `${path} ${ts}`).toBe(400);
        expect(await status(path, ["2026-01-01T00:00:00.000Z", "not-a-uuid"]), `${path} bad uuid`).toBe(400);
      }
      const bad = await h.api(w.viewer, "GET", `/api/v1/impact-runs?cursor=${b64(["2026-01-01T00:00:00.000Z", "not-a-uuid"])}`);
      expect(bad.body.error.code).toBe("INVALID_CURSOR");
      // Controls: a cursor this server produced still works, and position 0 pages from the start.
      expect(await status(findings, [0])).toBe(200);
      const first = await h.api(w.viewer, "GET", "/api/v1/snapshots?limit=1");
      expect(first.status).toBe(200);
    } finally {
      await h.close();
    }
  }, 120_000);
});
