import { describe, expect, it, vi } from "vitest";
import { canonicalJson } from "../../src/domain/canonical.js";
import { DEFAULT_LIMITS } from "../../src/domain/limits.js";
import { buildGraph, buildGraphFromJson, exportManifest, parseManifestJson } from "../../src/services/graph.js";
import { FAKE_AWS_KEY, FAKE_BEARER, FAKE_URL_WITH_PASSWORD } from "../helpers/fake-secrets.js";
import { FRESH, billingManifest, build, clone, e, f, manifest, n, prng, shuffled } from "../helpers/builders.js";

function rejected(doc: unknown, limits?: Record<string, number>) {
  const result = buildGraph(doc, limits ? { limits } : undefined);
  if (result.ok) throw new Error("expected rejection");
  return result.failure;
}

describe("AC-01 import: accepted manifests", () => {
  it("accepts a valid manifest and keeps source provenance on every edge", () => {
    const graph = build(billingManifest());
    expect(graph.nodes.map((x) => x.id)).toEqual([
      "artifact.report",
      "contract.invoice",
      "cred.smtp",
      "job.export",
      "svc.billing",
      "svc.dashboard",
      "svc.mailer",
    ]);
    const edge = graph.getEdge({ source_id: "job.export", target_id: "contract.invoice", relation: "consumes" });
    expect(edge).toMatchObject({ source_file: "manifests/job.export.yaml", source_line: 10, verified_at: FRESH });
    expect(graph.provenance.source).toBe("synthetic-test");
    expect(graph.revision).toBe("rev-1");
    expect(graph.schema_version).toBe(1);
  });

  it("normalizes optional properties (owner, placeholder, contract, fields)", () => {
    const graph = build(
      manifest(
        [n("svc.a", "service", { owner: null }), n("contract.c", "contract", { fields: [f("z"), f("a")] })],
        [e("svc.a", "contract.c", "consumes", { fields: ["z", "a", "z"] })],
      ),
    );
    expect(graph.getNode("svc.a")).toMatchObject({ owner: null, placeholder: false, contract: null });
    expect(graph.getNode("contract.c")!.contract!.map((x) => x.name)).toEqual(["a", "z"]);
    expect(graph.edges[0]!.fields).toEqual(["a", "z"]);
  });

  it("accepts an empty graph", () => {
    const graph = build(manifest([], []));
    expect(graph.nodes).toHaveLength(0);
    expect(graph.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("accepts optional provenance and timestamp forms", () => {
    const graph = build(
      manifest([n("svc.a", "service")], [], {
        provenance: { source: "exporter", generator: "tool 1.2", generated_at: "2026-09-01T12:30:45.123Z" },
      }),
    );
    expect(graph.provenance).toEqual({ source: "exporter", generator: "tool 1.2", generated_at: "2026-09-01T12:30:45.123Z" });
  });
});

describe("AC-01 import: atomic rejection", () => {
  it("SEEDED NEGATIVE CONTROL: one planted dangling edge turns an accepted manifest into a rejection with no graph", () => {
    const good = billingManifest();
    expect(buildGraph(good).ok).toBe(true);

    const planted = clone(good) as { edges: Record<string, unknown>[] };
    planted.edges.push(e("svc.dashboard", "svc.missing", "consumes"));
    const result = buildGraph(planted);
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty("graph");
    if (result.ok) throw new Error("unreachable");
    expect(result.failure.code).toBe("DANGLING_EDGE");
    expect(result.failure.status).toBe(422);
    expect(result.failure.issues[0]).toMatchObject({ path: `/edges/${planted.edges.length - 1}/target_id` });
  });

  it("rejects a dangling source as well as a dangling target and reports both", () => {
    const failure = rejected(manifest([n("svc.a", "service")], [e("svc.ghost", "svc.other", "consumes")]));
    expect(failure.issues.map((i) => i.path)).toEqual(["/edges/0/source_id", "/edges/0/target_id"]);
    expect(failure.issues.every((i) => i.code === "DANGLING_EDGE")).toBe(true);
  });

  it("rejects duplicate node ids", () => {
    const failure = rejected(manifest([n("svc.a", "service"), n("svc.a", "job")], []));
    expect(failure.code).toBe("DUPLICATE_NODE_ID");
    expect(failure.issues[0]!.path).toBe("/nodes/1/id");
  });

  it("rejects duplicate edges (same source, target and relation)", () => {
    const failure = rejected(
      manifest([n("svc.a", "service"), n("svc.b", "service")], [e("svc.a", "svc.b", "consumes"), e("svc.a", "svc.b", "consumes")]),
    );
    expect(failure.code).toBe("DUPLICATE_EDGE");
  });

  it("allows the same pair with a different relation", () => {
    expect(
      buildGraph(manifest([n("svc.a", "service"), n("svc.b", "service")], [e("svc.a", "svc.b", "consumes"), e("svc.a", "svc.b", "requires")])).ok,
    ).toBe(true);
  });

  it("rejects duplicate contract fields", () => {
    const failure = rejected(manifest([n("contract.c", "contract", { fields: [f("a"), f("a", "number")] })], []));
    expect(failure.code).toBe("DUPLICATE_CONTRACT_FIELD");
  });

  it("rejects contract fields on a non-contract node", () => {
    const failure = rejected(manifest([n("svc.a", "service", { fields: [f("a")] })], []));
    expect(failure.code).toBe("CONTRACT_ON_NON_CONTRACT_NODE");
  });

  it("rejects edge fields when the target is not a contract", () => {
    const failure = rejected(
      manifest([n("svc.a", "service"), n("svc.b", "service")], [e("svc.a", "svc.b", "consumes", { fields: ["x"] })]),
    );
    expect(failure.code).toBe("EDGE_FIELDS_ON_NON_CONTRACT_TARGET");
  });

  it.each([2, 0, -1, 99])("rejects unsupported schema_version %i with UNSUPPORTED_SCHEMA_VERSION", (version) => {
    const failure = rejected(manifest([], [], { schema_version: version }));
    expect(failure.code).toBe("UNSUPPORTED_SCHEMA_VERSION");
    expect(failure.status).toBe(422);
  });

  it("reports an unsupported major version even when the rest of a future-shaped document would not parse", () => {
    const failure = rejected({ schema_version: 2, entities: [{ anything: true }] });
    expect(failure.code).toBe("UNSUPPORTED_SCHEMA_VERSION");
    expect(failure.issues).toHaveLength(1);
  });

  it.each([["1"], [1.5], [null], [true]])("rejects non-integer schema_version %j as SCHEMA_INVALID", (version) => {
    expect(rejected(manifest([], [], { schema_version: version })).code).toBe("SCHEMA_INVALID");
  });

  it("rejects a missing schema_version", () => {
    const doc = manifest([], []);
    delete doc.schema_version;
    expect(rejected(doc).code).toBe("SCHEMA_INVALID");
  });

  it.each([[null], [[]], ["text"], [42]])("rejects non-object manifest %j", (doc) => {
    expect(rejected(doc).code).toBe("SCHEMA_INVALID");
  });

  it("rejects unknown properties so typos never drop data", () => {
    const doc = manifest([{ ...n("svc.a", "service"), ownr: "typo" }], []);
    const failure = rejected(doc);
    expect(failure.code).toBe("SCHEMA_INVALID");
    expect(failure.issues[0]!.message).toBe("unrecognized properties are not allowed");
  });

  it("rejects a __proto__ property delivered through JSON.parse", () => {
    const result = buildGraphFromJson('{"schema_version":1,"revision":"r","provenance":{"source":"s"},"nodes":[],"edges":[],"__proto__":{"x":1}}');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe("SCHEMA_INVALID");
  });

  it.each([
    ["id with a space", { id: "svc a" }],
    ["id starting with punctuation", { id: "-svc" }],
    ["id longer than 255", { id: "a".repeat(256) }],
    ["unknown kind", { kind: "database" }],
    ["empty owner", { owner: "" }],
    ["control character in version", { version: "1.0\n0" }],
    ["missing version", { version: undefined }],
  ])("rejects a node with %s", (_name, patch) => {
    const node = { ...n("svc.a", "service"), ...patch };
    expect(rejected(manifest([node], [])).code).toBe("SCHEMA_INVALID");
  });

  it.each([
    ["source_line zero", { source_line: 0 }],
    ["fractional source_line", { source_line: 1.5 }],
    ["missing source_file", { source_file: undefined }],
    ["unknown relation", { relation: "calls" }],
    ["offset timestamp", { verified_at: "2026-09-01T00:00:00+00:00" }],
    ["timestamp without zone", { verified_at: "2026-09-01T00:00:00" }],
    ["impossible calendar date", { verified_at: "2026-02-31T00:00:00Z" }],
    ["impossible hour", { verified_at: "2026-02-01T25:00:00Z" }],
    ["bad field name", { fields: ["has space"] }],
  ])("rejects an edge with %s", (_name, patch) => {
    const edge = { ...e("svc.a", "contract.c", "consumes"), ...patch };
    const doc = manifest([n("svc.a", "service"), n("contract.c", "contract", { fields: [f("x")] })], [edge]);
    expect(rejected(doc).code).toBe("SCHEMA_INVALID");
  });

  it("accepts null verified_at as 'never verified'", () => {
    expect(
      buildGraph(manifest([n("svc.a", "service"), n("svc.b", "service")], [e("svc.a", "svc.b", "consumes", { verified_at: null })])).ok,
    ).toBe(true);
  });

  it("does not echo unknown property names or values in messages or paths", () => {
    const failure = rejected(manifest([{ ...n("svc.a", "service"), [FAKE_AWS_KEY]: "x" }], []));
    expect(JSON.stringify(failure)).not.toContain(FAKE_AWS_KEY);
  });

  it("caps reported issues at limits.max_issues while still counting all", () => {
    const edges = Array.from({ length: 30 }, (_, i) => e("svc.a", `svc.ghost${i}`, "consumes"));
    const failure = rejected(manifest([n("svc.a", "service")], edges), { max_issues: 10 });
    expect(failure.issues).toHaveLength(10);
    expect(failure.total_issues).toBe(30);
  });

  it("orders issues deterministically (precedence, then path)", () => {
    const doc = manifest(
      [n("svc.a", "service"), n("svc.a", "service")],
      [e("svc.a", "svc.zzz", "consumes"), e("svc.a", "svc.yyy", "consumes")],
    );
    const first = rejected(doc);
    const second = rejected(clone(doc));
    expect(first.issues).toEqual(second.issues);
    expect(first.issues.map((i) => i.code)).toEqual(["DUPLICATE_NODE_ID", "DANGLING_EDGE", "DANGLING_EDGE"]);
  });
});

describe("AC-09 secrets and limits are enforced before processing", () => {
  it.each([
    ["owner", (doc: any) => (doc.nodes[0].owner = FAKE_AWS_KEY)],
    ["version", (doc: any) => (doc.nodes[0].version = FAKE_BEARER)],
    ["source_file", (doc: any) => (doc.edges[0].source_file = FAKE_URL_WITH_PASSWORD)],
    ["revision", (doc: any) => (doc.revision = FAKE_AWS_KEY)],
    ["provenance", (doc: any) => (doc.provenance.generator = FAKE_BEARER)],
  ])("rejects a secret-looking value in %s and never echoes it", (_where, plant) => {
    const doc = billingManifest();
    plant(doc);
    const failure = rejected(doc);
    expect(failure.code).toBe("SECRET_VALUE_REJECTED");
    expect(JSON.stringify(failure)).not.toContain(FAKE_AWS_KEY);
    expect(JSON.stringify(failure)).not.toContain("plantedBearerToken");
    expect(JSON.stringify(failure)).not.toContain("plantedPass1234");
    expect(failure.issues[0]!.path.length).toBeGreaterThan(0);
  });

  it("accepts credential aliases that merely mention key or token words", () => {
    const graph = build(manifest([n("cred.payments.api-key", "credential_alias"), n("cred.token:prod-payments", "credential_alias")], []));
    expect(graph.nodes).toHaveLength(2);
  });

  it("defaults match the PRD: 10,000 nodes, 50,000 edges, 25 MB", () => {
    expect(DEFAULT_LIMITS).toMatchObject({ max_nodes: 10_000, max_edges: 50_000, max_manifest_bytes: 25 * 1024 * 1024 });
  });

  it("rejects too many nodes BEFORE validating any node (garbage items are never inspected)", () => {
    const doc = manifest(new Array(10_001).fill({ garbage: true }), []);
    const failure = rejected(doc);
    expect(failure.code).toBe("TOO_MANY_NODES");
    expect(failure.status).toBe(413);
    expect(failure.issues).toHaveLength(1);
  });

  it("rejects too many edges BEFORE validating any edge", () => {
    const doc = manifest([], new Array(50_001).fill({ garbage: true }));
    const failure = rejected(doc);
    expect(failure.code).toBe("TOO_MANY_EDGES");
    expect(failure.status).toBe(413);
  });

  it("reports both limits when both are exceeded", () => {
    const failure = rejected(manifest(new Array(3).fill(null), new Array(3).fill(null)), { max_nodes: 2, max_edges: 2 });
    expect(failure.issues.map((i) => i.code)).toEqual(["TOO_MANY_NODES", "TOO_MANY_EDGES"]);
  });

  it("boundary: exactly max_nodes nodes and max_edges edges are accepted, one more is rejected", () => {
    const limits = { max_nodes: 50, max_edges: 60 };
    const nodes = Array.from({ length: 50 }, (_, i) => n(`svc.n${i}`, "service"));
    const edges = Array.from({ length: 60 }, (_, i) => e(`svc.n${i % 50}`, `svc.n${(i * 7 + 1) % 50}`, i < 50 ? "consumes" : "requires"));
    expect(buildGraph(manifest(nodes, edges), { limits }).ok).toBe(true);
    const tooMany = [...nodes, n("svc.extra", "service")];
    expect(rejected(manifest(tooMany, edges), limits).code).toBe("TOO_MANY_NODES");
  });

  it("enforces the 25 MB payload limit before JSON.parse ever runs", () => {
    const parse = vi.spyOn(JSON, "parse");
    const oversize = "x".repeat(DEFAULT_LIMITS.max_manifest_bytes + 1);
    const result = buildGraphFromJson(oversize);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe("PAYLOAD_TOO_LARGE");
      expect(result.failure.status).toBe(413);
    }
    expect(parse).not.toHaveBeenCalled();
    parse.mockRestore();
  });

  it("counts bytes, not characters, for multi byte payloads", () => {
    const text = JSON.stringify({ pad: "é".repeat(10) });
    const bytes = Buffer.byteLength(text, "utf8");
    expect(text.length).toBeLessThan(bytes);
    const tooSmall = parseManifestJson(text, { limits: { max_manifest_bytes: bytes - 1 } });
    expect(tooSmall.ok).toBe(false);
    expect(parseManifestJson(text, { limits: { max_manifest_bytes: bytes } }).ok).toBe(true);
  });

  it("applies the byte limit to Uint8Array input and to already parsed objects", () => {
    const doc = billingManifest();
    const text = JSON.stringify(doc);
    const bytes = Buffer.byteLength(text, "utf8");
    expect(buildGraphFromJson(new TextEncoder().encode(text), { limits: { max_manifest_bytes: bytes } }).ok).toBe(true);
    const asBytes = buildGraphFromJson(new TextEncoder().encode(text), { limits: { max_manifest_bytes: bytes - 1 } });
    expect(asBytes.ok).toBe(false);
    const asObject = rejected(doc, { max_manifest_bytes: bytes - 1 });
    expect(asObject.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("rejects malformed JSON and invalid UTF-8 with MALFORMED_JSON (HTTP 400)", () => {
    for (const raw of ['{"schema_version":', "", "not json", new Uint8Array([0x7b, 0xff, 0xfe, 0x7d])]) {
      const result = buildGraphFromJson(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.failure.code).toBe("MALFORMED_JSON");
        expect(result.failure.status).toBe(400);
      }
    }
  });

  it("builds from raw JSON text end to end", () => {
    const result = buildGraphFromJson(JSON.stringify(billingManifest()));
    expect(result.ok).toBe(true);
  });

  it("rejects non serializable input instead of throwing", () => {
    const circular: Record<string, unknown> = { schema_version: 1 };
    circular.self = circular;
    expect(rejected(circular).code).toBe("SCHEMA_INVALID");
  });
});

describe("AC-03 determinism", () => {
  it("identical content produces the identical graph hash on repeated imports", () => {
    const hashes = new Set(Array.from({ length: 5 }, () => build(billingManifest()).hash));
    expect(hashes.size).toBe(1);
  });

  it("shuffled node, edge, contract field and edge field order produces the same hash", () => {
    const random = prng(42);
    const base = build(billingManifest());
    for (let i = 0; i < 10; i += 1) {
      const doc = billingManifest() as { nodes: Record<string, any>[]; edges: Record<string, any>[] };
      doc.nodes = shuffled(doc.nodes, random);
      doc.edges = shuffled(doc.edges, random);
      for (const node of doc.nodes) if (node.contract) node.contract.fields = shuffled(node.contract.fields, random);
      const graph = build(doc);
      expect(graph.hash).toBe(base.hash);
      expect(graph.manifest_hash).toBe(base.manifest_hash);
      expect(graph.nodes).toEqual(base.nodes);
      expect(graph.edges).toEqual(base.edges);
    }
  });

  it("revision and provenance change the manifest hash but not the graph hash", () => {
    const a = build(billingManifest());
    const b = build({ ...billingManifest(), revision: "rev-2", provenance: { source: "another" } });
    expect(b.hash).toBe(a.hash);
    expect(b.manifest_hash).not.toBe(a.manifest_hash);
  });

  it.each([
    ["a new node", (nodes: any[]) => nodes.push(n("svc.new", "service"))],
    ["a changed version", (nodes: any[]) => (nodes[0].version = "9.9.9")],
    ["a changed owner", (nodes: any[]) => (nodes[0].owner = "other-team")],
  ])("%s changes the graph hash", (_name, mutate) => {
    const before = build(billingManifest()).hash;
    const after = build(billingManifest((nodes) => mutate(nodes))).hash;
    expect(after).not.toBe(before);
  });

  it("a re-verified edge (new verified_at) changes the hash", () => {
    const before = build(billingManifest()).hash;
    const after = build(billingManifest((_nodes, edges) => (edges[1]!.verified_at = "2026-09-28T12:00:00Z"))).hash;
    expect(after).not.toBe(before);
  });

  it("owner absent and owner null hash identically", () => {
    const withNull = manifest([{ ...n("svc.a", "service"), owner: null }], []);
    const absent = manifest([(() => { const x = n("svc.a", "service"); delete x.owner; return x; })()], []);
    expect(build(withNull).hash).toBe(build(absent).hash);
  });

  it("dependentsOf lists dependents in a deterministic order", () => {
    const graph = build(billingManifest());
    expect(graph.dependentsOf("contract.invoice").map((l) => l.to)).toEqual(["job.export", "svc.mailer"]);
    expect(graph.dependentsOf("svc.billing").map((l) => l.to)).toEqual(["contract.invoice"]);
    expect(graph.dependentsOf("nobody")).toEqual([]);
  });

  it("impact direction: consumes and requires point from provider to dependent, produces from producer to product", () => {
    const graph = build(billingManifest());
    expect(graph.dependentsOf("cred.smtp").map((l) => l.to)).toEqual(["svc.mailer"]);
    expect(graph.dependentsOf("job.export").map((l) => l.to)).toEqual(["artifact.report"]);
  });

  it("graph objects are immutable", () => {
    const graph = build(billingManifest());
    expect(Object.isFrozen(graph.nodes)).toBe(true);
    expect(Object.isFrozen(graph.nodes[0])).toBe(true);
    expect(() => {
      (graph.nodes[0] as { id: string }).id = "hacked";
    }).toThrow(TypeError);
    expect(() => {
      (graph.edges as unknown[]).push({});
    }).toThrow(TypeError);
  });
});

describe("AC-03 cycles", () => {
  it("reports a self loop as a cycle", () => {
    const graph = build(manifest([n("svc.a", "service")], [e("svc.a", "svc.a", "consumes")]));
    expect(graph.cycles.map((c) => c.members)).toEqual([["svc.a"]]);
  });

  it("reports a two node cycle and a three node cycle with sorted members and stable ids", () => {
    const doc = manifest(
      ["a", "b", "c", "d", "e"].map((x) => n(`svc.${x}`, "service")),
      [
        e("svc.a", "svc.b", "consumes"),
        e("svc.b", "svc.a", "consumes"),
        e("svc.c", "svc.d", "consumes"),
        e("svc.d", "svc.e", "consumes"),
        e("svc.e", "svc.c", "consumes"),
      ],
    );
    const graph = build(doc);
    expect(graph.cycles.map((c) => c.members)).toEqual([
      ["svc.a", "svc.b"],
      ["svc.c", "svc.d", "svc.e"],
    ]);
    expect(build(clone(doc)).cycles.map((c) => c.id)).toEqual(graph.cycles.map((c) => c.id));
    expect(graph.cycleOf("svc.d")).toBe(graph.cycles[1]);
    expect(graph.cycleOf("svc.zzz")).toBeUndefined();
  });

  it("cycles are supported, not rejected, and surface as an aggregated warning", () => {
    const result = buildGraph(
      manifest([n("svc.a", "service"), n("svc.b", "service")], [e("svc.a", "svc.b", "consumes"), e("svc.b", "svc.a", "consumes")]),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings.find((w) => w.code === "CYCLE_DETECTED")).toMatchObject({ count: 1, sample_ids: ["svc.a,svc.b"] });
    }
  });

  it("reports no cycle for an acyclic graph", () => {
    expect(build(billingManifest()).cycles).toEqual([]);
  });

  it("handles a very long chain without recursion (no stack overflow)", () => {
    const count = 10_000;
    const nodes = Array.from({ length: count }, (_, i) => n(`svc.n${i}`, "service"));
    const edges = Array.from({ length: count - 1 }, (_, i) => e(`svc.n${i + 1}`, `svc.n${i}`, "consumes"));
    edges.push(e("svc.n0", `svc.n${count - 1}`, "consumes"));
    const graph = build(manifest(nodes, edges, {}));
    expect(graph.cycles).toHaveLength(1);
    expect(graph.cycles[0]!.members).toHaveLength(count);
  }, 60_000);
});

describe("warnings", () => {
  it("aggregates missing owners, placeholders and unverified edges with counts and sorted samples", () => {
    const result = buildGraph(
      manifest(
        [n("svc.b", "service", { owner: null }), n("svc.a", "service", { owner: null }), n("svc.p", "service", { placeholder: true })],
        [e("svc.a", "svc.b", "consumes", { verified_at: null })],
      ),
    );
    if (!result.ok) throw new Error("rejected");
    const byCode = Object.fromEntries(result.warnings.map((w) => [w.code, w]));
    expect(byCode.MISSING_OWNER).toMatchObject({ count: 2, sample_ids: ["svc.a", "svc.b"] });
    expect(byCode.PLACEHOLDER_NODE).toMatchObject({ count: 1, sample_ids: ["svc.p"] });
    expect(byCode.UNVERIFIED_EDGE).toMatchObject({ count: 1, sample_ids: ["svc.a|consumes|svc.b"] });
  });

  it("caps sample ids at 20 but keeps the full count", () => {
    const nodes = Array.from({ length: 45 }, (_, i) => n(`svc.n${String(i).padStart(2, "0")}`, "service", { owner: null }));
    const result = buildGraph(manifest(nodes, []));
    if (!result.ok) throw new Error("rejected");
    const w = result.warnings.find((x) => x.code === "MISSING_OWNER")!;
    expect(w.count).toBe(45);
    expect(w.sample_ids).toHaveLength(20);
  });

  it("flags edge fields that the target contract does not define", () => {
    const result = buildGraph(
      manifest(
        [n("svc.a", "service"), n("contract.c", "contract", { fields: [f("x")] }), n("contract.u", "contract")],
        [e("svc.a", "contract.c", "consumes", { fields: ["x", "gone"] }), e("svc.a", "contract.u", "consumes", { fields: ["q"] })],
      ),
    );
    if (!result.ok) throw new Error("rejected");
    expect(result.warnings.find((w) => w.code === "EDGE_FIELD_NOT_IN_CONTRACT")).toMatchObject({ count: 1 });
  });

  it("emits no warnings for a fully specified acyclic manifest", () => {
    const result = buildGraph(billingManifest());
    if (!result.ok) throw new Error("rejected");
    expect(result.warnings).toEqual([]);
  });
});

describe("AC-10 export and restore of a graph (domain part)", () => {
  it("exportManifest round trips: the restored graph has identical graph and manifest hashes", () => {
    const original = build(billingManifest());
    const text = canonicalJson(exportManifest(original));
    const restored = buildGraphFromJson(text);
    if (!restored.ok) throw new Error("restore rejected");
    expect(restored.graph.hash).toBe(original.hash);
    expect(restored.graph.manifest_hash).toBe(original.manifest_hash);
    expect(restored.graph.nodes).toEqual(original.nodes);
    expect(restored.graph.edges).toEqual(original.edges);
  });

  it("round trips nulls, placeholders and undeclared contracts", () => {
    const original = build(
      manifest(
        [n("svc.a", "service", { owner: null, placeholder: true }), n("contract.c", "contract")],
        [e("svc.a", "contract.c", "consumes", { verified_at: null })],
      ),
    );
    const restored = buildGraphFromJson(canonicalJson(exportManifest(original)));
    if (!restored.ok) throw new Error("restore rejected");
    expect(restored.graph.hash).toBe(original.hash);
  });

  it("SEEDED NEGATIVE CONTROL: a truncated export is rejected at every cut point and never yields a graph", () => {
    const text = canonicalJson(exportManifest(build(billingManifest())));
    let checked = 0;
    for (let cut = 0; cut < text.length; cut += 1) {
      const result = buildGraphFromJson(text.slice(0, cut));
      expect(result.ok, `cut at ${cut}`).toBe(false);
      checked += 1;
    }
    expect(checked).toBe(text.length);
    expect(buildGraphFromJson(text).ok).toBe(true);
  });

  it("a tampered export changes the hash (corruption is detectable by comparing against the recorded hash)", () => {
    const original = build(billingManifest());
    const tampered = canonicalJson(exportManifest(original)).replace('"version":"1.0.0"', '"version":"1.0.1"');
    const restored = buildGraphFromJson(tampered);
    if (!restored.ok) throw new Error("restore rejected");
    expect(restored.graph.hash).not.toBe(original.hash);
  });

  it("an export with an unsupported schema_version is rejected on restore", () => {
    const text = canonicalJson({ ...exportManifest(build(billingManifest())), schema_version: 2 });
    const result = buildGraphFromJson(text);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe("UNSUPPORTED_SCHEMA_VERSION");
  });
});
