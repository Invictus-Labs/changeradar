import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { claimEvents } from "../../src/services/outbox.js";
import { createHarness } from "../helpers/harness.js";
import { baselineDoc } from "../helpers/scenario.js";

/**
 * Review round 7 (security P2-b, outbox.ts:36): the event envelope stored and served its `revision` as written, and audit rows kept
 * whatever an earlier build stored, although docs/MANIFEST.md says nothing that leaves the server is left unredacted. A plain-word
 * credential that the validator lets through (`rev authorization: ...`) or a value that an earlier build accepted and the current
 * one refuses (`release pin: 5533xyz`) was visible in GET /events and GET /audit and pushed to the event sink. Both are now redacted
 * with the log redactor when the row is written AND when it is served or claimed (a row already stored is not rewritten).
 */

const LEGACY = "5533xyz";
const PLAIN = "correcthorsebatterystaple";

describe("R7 (outbox.ts, audit.ts): events and audit rows leave the server redacted", () => {
  it("a stored envelope from an earlier build and a stored audit row are served, and claimed for the sink, without the value", async () => {
    const h = await createHarness();
    try {
      const w = await h.workspace("EventsRedacted");
      const eventId = randomUUID();
      const envelope = { schema_version: 1, event_id: eventId, source: "changeradar", resource_id: randomUUID(), event_type: "snapshot.imported", occurred_at: h.now().toISOString(), revision: `release pin: ${LEGACY}`, evidence_ref: `/api/v1/snapshots/x?token=${PLAIN}` };
      await h.db.query("INSERT INTO outbox_events (id, workspace_id, envelope, state, next_attempt_at, created_at) VALUES ($1,$2,$3::jsonb,'pending',$4,$4)", [eventId, w.id, JSON.stringify(envelope), h.now()]);
      await h.db.query(
        "INSERT INTO audit_events (id, workspace_id, actor_type, actor_id, action, resource_type, resource_id, created_at, redacted_metadata) VALUES ($1,$2,'system',NULL,'snapshot.imported','snapshot',$3,$4,$5::jsonb)",
        [randomUUID(), w.id, randomUUID(), h.now(), JSON.stringify({ revision: `release pin: ${LEGACY}`, note: `token=${PLAIN}` })],
      );
      const events = await h.api(w.operator, "GET", "/api/v1/events?limit=100");
      expect(events.status, events.text).toBe(200);
      expect(events.text.includes(LEGACY), "the legacy value in GET /events").toBe(false);
      expect(events.text.includes(PLAIN), "the plain-word value in GET /events").toBe(false);
      const audit = await h.api(w.admin, "GET", "/api/v1/audit?limit=100");
      expect(audit.status, audit.text).toBe(200);
      expect(audit.text.includes(LEGACY), "the legacy value in GET /audit").toBe(false);
      expect(audit.text.includes(PLAIN), "the plain-word value in GET /audit").toBe(false);
      const claimed = await claimEvents(h.db, { now: () => new Date(h.now().getTime() + 1000) }, 30, 50);
      expect(JSON.stringify(claimed).includes(LEGACY), "the legacy value pushed to the sink").toBe(false);
      expect(JSON.stringify(claimed).includes(PLAIN), "the plain-word value pushed to the sink").toBe(false);
      expect(claimed.some((c) => c.id === eventId), "control: the event was claimed").toBe(true);
    } finally {
      await h.close();
    }
  }, 120_000);

  it("an event announcing a snapshot whose revision holds a credential word is written redacted", async () => {
    const h = await createHarness();
    try {
      const w = await h.workspace("EventsWritten");
      const snap = await h.importSnapshot(w.operator, baselineDoc(), { revision: `rev authorization: ${PLAIN}` });
      const stored = await h.db.query<{ envelope: { revision: string } }>("SELECT envelope FROM outbox_events WHERE workspace_id = $1", [w.id]);
      if (snap.status === 201) {
        expect(JSON.stringify(stored.rows).includes(PLAIN), "the stored envelope").toBe(false);
        const events = await h.api(w.operator, "GET", "/api/v1/events?limit=100");
        expect(events.text.includes(PLAIN), "GET /events").toBe(false);
      } else {
        expect(snap.status, "the import refused the revision (also a valid way to keep it out of the events)").toBe(422);
      }
    } finally {
      await h.close();
    }
  }, 120_000);
});
