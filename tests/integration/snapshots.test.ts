import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildGraph } from "../../src/services/graph.js";
import { billingManifest, clone, e, manifest, n } from "../helpers/builders.js";
import { FAKE_AWS_KEY, FAKE_GITHUB_TOKEN } from "../helpers/fake-secrets.js";
import { count, createHarness, type Harness, type TestWorkspace } from "../helpers/harness.js";
import { baselineDoc } from "../helpers/scenario.js";
import { UUID_ZERO } from "../helpers/ids.js";

const tables = async (h: Harness) => ({
  snapshots: await count(h.db, "snapshots"),
  nodes: await count(h.db, "nodes"),
  edges: await count(h.db, "edges"),
  events: await count(h.db, "outbox_events"),
  audit: await count(h.db, "audit_events"),
  idem: await count(h.db, "idempotency_keys"),
});

describe("AC-01 POST /api/v1/snapshots", () => {
  let h: Harness;
  let ws: TestWorkspace;
  beforeAll(async () => {
    h = await createHarness();
    ws = await h.workspace("Snapshots");
  });
  afterAll(async () => h.close());

  it("returns 201 {id, hash, warnings} and persists nodes, edges and provenance", async () => {
    const res = await h.importSnapshot(ws.operator, baselineDoc(), { revision: "2026-09-29.1" });
    expect(res.status, res.text).toBe(201);
    expect(res.body).toMatchObject({ id: expect.stringMatching(/^[0-9a-f-]{36}$/), hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/), warnings: expect.any(Array), revision: "2026-09-29.1", is_baseline: true });
    expect(res.headers.location).toBe(`/api/v1/snapshots/${res.body.id}`);
    const expected = buildGraph(baselineDoc());
    if (!expected.ok) throw new Error("fixture");
    expect(res.body.hash).toBe(expected.graph.hash);
    expect(res.body.node_count).toBe(expected.graph.nodes.length);
    const rows = await h.db.query<{ n: number }>("SELECT count(*)::int AS n FROM nodes WHERE snapshot_id = $1", [res.body.id]);
    expect(rows.rows[0]?.n).toBe(expected.graph.nodes.length);
    const edge = await h.db.query<{ source_file: string; source_line: number; verified_at: Date | null; fields: unknown }>(
      "SELECT source_file, source_line, verified_at, fields FROM edges WHERE snapshot_id = $1 AND source_id = 'svc.mailer' AND target_id = 'contract.invoice'",
      [res.body.id],
    );
    expect(edge.rows[0]).toMatchObject({ source_file: "manifests/svc.mailer.yaml", source_line: 10, fields: ["invoice_id"] });
    expect(edge.rows[0]?.verified_at?.toISOString()).toBe("2026-09-28T00:00:00.000Z");
    const contract = await h.db.query<{ contract: { name: string }[] | null }>("SELECT contract FROM nodes WHERE snapshot_id = $1 AND id = 'svc.billing'", [res.body.id]);
    expect(contract.rows[0]?.contract).toBeNull();
  });

  it("surfaces warnings (cycles, missing owners) without rejecting", async () => {
    const doc = manifest(
      [n("svc.a", "service"), n("svc.b", "service", { owner: null })],
      [e("svc.a", "svc.b", "consumes"), e("svc.b", "svc.a", "consumes", { verified_at: null })],
    );
    const res = await h.importSnapshot(ws.operator, doc);
    expect(res.status).toBe(201);
    expect(res.body.warnings.map((w: { code: string }) => w.code)).toEqual(expect.arrayContaining(["CYCLE_DETECTED", "MISSING_OWNER", "UNVERIFIED_EDGE"]));
  });

  it("AC-03 identical content imports to the same graph hash; each import is kept as history and moves the baseline", async () => {
    const a = await h.importSnapshot(ws.operator, baselineDoc(), { revision: "same-a" });
    const b = await h.importSnapshot(ws.operator, clone(baselineDoc()), { revision: "same-b" });
    expect(a.body.hash).toBe(b.body.hash);
    expect(a.body.id).not.toBe(b.body.id);
    expect(a.body.document_hash).toBe(b.body.document_hash); // revision lives outside the manifest document
    const base = await h.api(ws.viewer, "GET", "/api/v1/baseline");
    expect(base.body.snapshot.id).toBe(b.body.id);
    expect(base.body.baseline_version).toBe(b.body.baseline_version);
    const old = await h.api(ws.viewer, "GET", `/api/v1/snapshots/${a.body.id}`);
    expect(old.body.is_baseline).toBe(false);
    expect(b.body.baseline_version).toBe(a.body.baseline_version + 1);
  });

  it("shuffled node and edge order imports to the same hash", async () => {
    const doc = baselineDoc() as { nodes: unknown[]; edges: unknown[] };
    const shuffled = { ...doc, nodes: [...doc.nodes].reverse(), edges: [...doc.edges].reverse() };
    const a = await h.importSnapshot(ws.operator, doc);
    const b = await h.importSnapshot(ws.operator, shuffled);
    expect(a.body.hash).toBe(b.body.hash);
  });

  it("reads back through GET snapshot, nodes and edges with cursor pagination and a cap of 100", async () => {
    const fan = manifest([n("contract.c", "contract", { fields: [{ name: "id", type: "string", required: true }] }), ...Array.from({ length: 130 }, (_, i) => n(`svc.s${String(i).padStart(3, "0")}`, "service"))], Array.from({ length: 130 }, (_, i) => e(`svc.s${String(i).padStart(3, "0")}`, "contract.c", "consumes")));
    const snap = await h.importSnapshot(ws.operator, fan);
    expect(snap.body.node_count).toBe(131);
    const detail = await h.api(ws.viewer, "GET", `/api/v1/snapshots/${snap.body.id}`);
    expect(detail.body).toMatchObject({ id: snap.body.id, hash: snap.body.hash, node_count: 131, edge_count: 130, is_baseline: expect.any(Boolean) });

    const first = await h.api(ws.viewer, "GET", `/api/v1/snapshots/${snap.body.id}/nodes?limit=100`);
    expect(first.body.items).toHaveLength(100);
    expect(first.body.next_cursor).toEqual(expect.any(String));
    const second = await h.api(ws.viewer, "GET", `/api/v1/snapshots/${snap.body.id}/nodes?limit=100&cursor=${first.body.next_cursor}`);
    expect(second.body.items).toHaveLength(31);
    expect(second.body.next_cursor).toBeNull();
    const ids = [...first.body.items, ...second.body.items].map((x: { id: string }) => x.id);
    expect(new Set(ids).size).toBe(131);
    expect([...ids].sort()).toEqual(ids);
    expect(first.body.items[0]).toMatchObject({ id: "contract.c", kind: "contract", contract: [{ name: "id", type: "string", required: true }] });

    const edges1 = await h.api(ws.viewer, "GET", `/api/v1/snapshots/${snap.body.id}/edges?limit=50`);
    const edges2 = await h.api(ws.viewer, "GET", `/api/v1/snapshots/${snap.body.id}/edges?limit=100&cursor=${edges1.body.next_cursor}`);
    expect(edges1.body.items).toHaveLength(50);
    expect(edges2.body.items).toHaveLength(80);
    expect(edges1.body.items[0]).toMatchObject({ relation: "consumes", source_line: 10, verified_at: "2026-09-28T00:00:00.000Z" });

    // Default page size is 50; snapshots list is newest first and paginated.
    const list = await h.api(ws.viewer, "GET", "/api/v1/snapshots?limit=2");
    expect(list.body.items).toHaveLength(2);
    expect(list.body.items[0].imported_at >= list.body.items[1].imported_at).toBe(true);
    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const page: { body: { items: { id: string }[]; next_cursor: string | null } } = await h.api(ws.viewer, "GET", `/api/v1/snapshots?limit=3${cursor ? `&cursor=${cursor}` : ""}`);
      for (const item of page.body.items) seen.add(item.id);
      cursor = page.body.next_cursor;
    } while (cursor);
    expect(seen.size).toBe(await count(h.db, "snapshots", "workspace_id = $1", [ws.id]));
  });

  it("caps list endpoints at 100 and rejects invalid limits and cursors with 400", async () => {
    for (const q of ["limit=101", "limit=0", "limit=-1", "limit=abc", "limit=1.5", "limit=1&limit=2"]) {
      const res = await h.api(ws.viewer, "GET", `/api/v1/snapshots?${q}`);
      expect(res.status, q).toBe(400);
      expect(res.body.error.code).toMatch(/INVALID_LIMIT|INVALID_QUERY/);
    }
    for (const cursor of ["not-a-cursor", Buffer.from('["x"]').toString("base64url"), Buffer.from('["2026-01-01T00:00:00Z","nope"]').toString("base64url"), "a".repeat(600)]) {
      const res = await h.api(ws.viewer, "GET", `/api/v1/snapshots?cursor=${cursor}`);
      expect(res.status, cursor.slice(0, 20)).toBe(400);
      expect(res.body.error.code).toBe("INVALID_CURSOR");
    }
    expect((await h.api(ws.viewer, "GET", "/api/v1/snapshots?limit=100")).status).toBe(200);
  });

  it("GET manifest returns the normalized manifest for operators", async () => {
    const snap = await h.importSnapshot(ws.operator, baselineDoc());
    const res = await h.api(ws.operator, "GET", `/api/v1/snapshots/${snap.body.id}/manifest`);
    expect(res.status).toBe(200);
    expect(res.body.schema_version).toBe(1);
    expect(res.body.nodes).toHaveLength(7);
    const rebuilt = buildGraph(res.body);
    expect(rebuilt.ok && rebuilt.graph.hash).toBe(snap.body.hash);
  });

  it("reports an empty baseline before any import", async () => {
    const empty = await createHarness();
    try {
      const w = await empty.workspace("Empty");
      const res = await empty.api(w.viewer, "GET", "/api/v1/baseline");
      expect(res.body).toEqual({ snapshot: null, baseline_version: 0 });
      expect((await empty.api(w.viewer, "GET", "/api/v1/snapshots")).body).toEqual({ items: [], next_cursor: null });
    } finally {
      await empty.close();
    }
  });
});

describe("AC-01 atomic rejection: a rejected manifest leaves no state at all", () => {
  let h: Harness;
  let ws: TestWorkspace;
  beforeAll(async () => {
    h = await createHarness({ settings: { maxNodes: 50, maxEdges: 60, maxManifestBytes: 200_000 } });
    ws = await h.workspace("Atomic");
  });
  afterAll(async () => h.close());

  async function expectRejected(body: unknown, status: number, code: string, opts: { raw?: string } = {}) {
    const before = await tables(h);
    const res = opts.raw !== undefined ? await h.api(ws.operator, "POST", "/api/v1/snapshots", undefined, { raw: opts.raw }) : await h.api(ws.operator, "POST", "/api/v1/snapshots", body);
    expect(res.status, res.text.slice(0, 300)).toBe(status);
    expect(res.body.error).toMatchObject({ code, message: expect.any(String), request_id: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(res.headers["x-request-id"]).toBe(res.body.error.request_id);
    expect(await tables(h)).toEqual(before);
    return res;
  }
  const withBody = (m: unknown) => ({ schema_version: 1, revision: "r", manifest: m });

  it("dangling edge -> 422 DANGLING_EDGE with issues, zero rows anywhere (seeded negative control)", async () => {
    const doc = billingManifest((_nodes, edges) => edges.push(e("svc.dashboard", "svc.ghost", "consumes")));
    const res = await expectRejected(withBody(doc), 422, "DANGLING_EDGE");
    expect(res.body.error.details.issues[0]).toMatchObject({ code: "DANGLING_EDGE" });
    // The same manifest without the planted edge imports: the control proves the check is what rejects it.
    expect((await h.importSnapshot(ws.operator, baselineDoc())).status).toBe(201);
  });

  it("unsupported schema versions (body and manifest) -> 422 UNSUPPORTED_SCHEMA_VERSION", async () => {
    await expectRejected({ schema_version: 2, revision: "r", manifest: baselineDoc() }, 422, "UNSUPPORTED_SCHEMA_VERSION");
    await expectRejected(withBody({ ...baselineDoc(), schema_version: 2 }), 422, "UNSUPPORTED_SCHEMA_VERSION");
    await expectRejected(withBody({ ...baselineDoc(), schema_version: 0 }), 422, "UNSUPPORTED_SCHEMA_VERSION");
  });

  it("envelope violations -> 422 SCHEMA_INVALID", async () => {
    await expectRejected([], 422, "SCHEMA_INVALID");
    await expectRejected({ revision: "r", manifest: baselineDoc() }, 422, "SCHEMA_INVALID");
    await expectRejected({ schema_version: "1", revision: "r", manifest: baselineDoc() }, 422, "SCHEMA_INVALID");
    await expectRejected({ schema_version: 1, revision: "", manifest: baselineDoc() }, 422, "SCHEMA_INVALID");
    await expectRejected({ schema_version: 1, revision: "bad\nrevision", manifest: baselineDoc() }, 422, "SCHEMA_INVALID");
    await expectRejected({ schema_version: 1, revision: "r", manifest: [] }, 422, "SCHEMA_INVALID");
    await expectRejected({ schema_version: 1, revision: "r", manifest: baselineDoc(), extra: true }, 422, "SCHEMA_INVALID");
    await expectRejected(withBody({ ...baselineDoc(), surprise: 1 }), 422, "SCHEMA_INVALID");
  });

  it("malformed JSON -> 400 and wrong content type -> 400", async () => {
    await expectRejected(undefined, 400, "MALFORMED_JSON", { raw: '{"schema_version": 1, "manifest": ' });
    const res = await h.app.inject({ method: "POST", url: "/api/v1/snapshots", headers: { cookie: ws.operator.cookie, "x-csrf-token": ws.operator.csrf, "content-type": "text/plain" }, payload: "hello" });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe("BAD_REQUEST");
  });

  it("planted secrets are rejected with 422 and never echoed back or stored", async () => {
    const before = await tables(h);
    for (const secret of [FAKE_AWS_KEY, FAKE_GITHUB_TOKEN]) {
      const doc = billingManifest((nodes) => {
        (nodes[0] as { owner: string }).owner = `team ${secret}`;
      });
      const res = await h.api(ws.operator, "POST", "/api/v1/snapshots", withBody(doc));
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe("SECRET_VALUE_REJECTED");
      expect(res.text).not.toContain(secret);
    }
    const revision = await h.api(ws.operator, "POST", "/api/v1/snapshots", { schema_version: 1, revision: FAKE_AWS_KEY, manifest: baselineDoc() });
    expect(revision.status).toBe(422);
    expect(revision.text).not.toContain(FAKE_AWS_KEY);
    expect(await tables(h)).toEqual(before);
  });

  it("AC-09 limits are enforced before any work: too many nodes/edges -> 413, oversized body -> 413", async () => {
    const before = await tables(h);
    const many = manifest(Array.from({ length: 51 }, (_, i) => n(`svc.n${i}`, "service")), []);
    const nodes = await h.api(ws.operator, "POST", "/api/v1/snapshots", withBody(many));
    expect(nodes.status).toBe(413);
    expect(nodes.body.error.code).toBe("TOO_MANY_NODES");
    const edgesDoc = manifest([n("svc.a", "service"), n("svc.b", "service")], Array.from({ length: 61 }, () => e("svc.a", "svc.b", "consumes")));
    const edges = await h.api(ws.operator, "POST", "/api/v1/snapshots", withBody(edgesDoc));
    expect(edges.status).toBe(413);
    expect(edges.body.error.code).toBe("TOO_MANY_EDGES");
    // Body limit = maxManifestBytes + envelope slack; a body above it never reaches the handler.
    const huge = JSON.stringify({ schema_version: 1, revision: "r", manifest: { ...baselineDoc(), padding: "x".repeat(300_000) } });
    const big = await h.api(ws.operator, "POST", "/api/v1/snapshots", undefined, { raw: huge });
    expect(big.status).toBe(413);
    expect(big.body.error.code).toBe("PAYLOAD_TOO_LARGE");
    expect(await tables(h)).toEqual(before);
  });

  it("a manifest just over the byte limit inside the envelope slack is refused precisely (413)", async () => {
    const pad = (length: number) => withBody({ ...baselineDoc(), padding: "x".repeat(length) });
    const baseSize = JSON.stringify((pad(0) as { manifest: unknown }).manifest).length;
    // 199_990 bytes of manifest fits the 200_000 limit but not strictly-valid schema (unknown property) -> 422, not 413.
    const fits = await h.api(ws.operator, "POST", "/api/v1/snapshots", pad(199_900 - baseSize));
    expect(fits.status).toBe(422);
    const over = await h.api(ws.operator, "POST", "/api/v1/snapshots", pad(200_100 - baseSize));
    expect(over.status).toBe(413);
    expect(over.body.error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("small endpoints have a small body limit", async () => {
    const res = await h.app.inject({ method: "POST", url: "/api/v1/auth/login", headers: { "content-type": "application/json" }, payload: JSON.stringify({ email: "a@b.test", password: "x".repeat(70_000) }) });
    expect(res.statusCode).toBe(413);
    expect(JSON.parse(res.body).error.code).toBe("PAYLOAD_TOO_LARGE");
  });
});

describe("snapshot lookups", () => {
  it("unknown and malformed ids are 404 with the standard envelope", async () => {
    const h = await createHarness();
    try {
      const w = await h.workspace("Lookups");
      for (const id of [UUID_ZERO, "not-a-uuid", "1"]) {
        for (const suffix of ["", "/manifest", "/nodes", "/edges"]) {
          const res = await h.api(w.admin, "GET", `/api/v1/snapshots/${id}${suffix}`);
          expect(res.status, `${id}${suffix}`).toBe(404);
          expect(res.body.error.code).toBe("NOT_FOUND");
        }
      }
    } finally {
      await h.close();
    }
  });
});
