import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, getRun, type Harness, type TestWorkspace } from "../helpers/harness.js";
import { baselineDoc, removeAmountDoc } from "../helpers/scenario.js";

describe("smoke: import, assess, read", () => {
  let h: Harness;
  let ws: TestWorkspace;
  beforeAll(async () => {
    h = await createHarness();
    ws = await h.workspace("Smoke");
  });
  afterAll(async () => h.close());

  it("runs the whole path", async () => {
    const snap = await h.importSnapshot(ws.operator, baselineDoc());
    expect(snap.status, snap.text).toBe(201);
    const run = await h.requestRun(ws.operator, { snapshot_id: snap.body.id, proposed_manifest: removeAmountDoc(), expected_hash: snap.body.hash });
    expect(run.status, run.text).toBe(202);
    expect(run.body.status).toBe("queued");
    expect(await h.drain()).toBe(1);
    const done = await getRun(h, ws.viewer, run.body.id);
    expect(done.status).toBe("complete");
    expect(done.assessment).toBe("AFFECTED");
    expect(done.affected.map((a: any) => a.consumer_id)).toContain("job.export");
    const html = await h.api(ws.viewer, "GET", `/api/v1/impact-runs/${run.body.id}/export?format=html`);
    expect(html.status).toBe(200);
    expect(html.text).toContain(done.affected[0].id);
  });
});
