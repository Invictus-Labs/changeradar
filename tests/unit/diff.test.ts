import { describe, expect, it } from "vitest";
import { affectsLink, diffGraphs, traverseDependents, type Change } from "../../src/services/diff.js";
import { billingManifest, build, e, f, manifest, n } from "../helpers/builders.js";

type Doc = { nodes: Record<string, any>[]; edges: Record<string, any>[] };

function proposal(mutate: (doc: Doc) => void) {
  const doc = billingManifest() as unknown as Doc;
  mutate(doc);
  return build(doc);
}

const base = () => build(billingManifest());

function kinds(changes: Change[]): string[] {
  return changes.map((c) => c.kind);
}

describe("diffGraphs", () => {
  it("returns no changes for identical graphs", () => {
    expect(diffGraphs(base(), base())).toEqual([]);
  });

  it("detects a removed required field as a field-propagating change", () => {
    const changes = diffGraphs(
      base(),
      proposal((d) => {
        d.nodes[1]!.contract.fields = d.nodes[1]!.contract.fields.filter((x: any) => x.name !== "amount");
      }),
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      kind: "contract_field_removed",
      node_id: "contract.invoice",
      origin_id: "contract.invoice",
      field: "amount",
      propagation: "field",
      required_relevant: true,
      before: "number (required)",
    });
    expect(changes[0]!.id).toMatch(/^chg_[0-9a-f]{20}$/);
  });

  it("an optional field removal is field-propagating but not required-relevant", () => {
    const [change] = diffGraphs(
      base(),
      proposal((d) => {
        d.nodes[1]!.contract.fields = d.nodes[1]!.contract.fields.filter((x: any) => x.name !== "note");
      }),
    );
    expect(change).toMatchObject({ kind: "contract_field_removed", propagation: "field", required_relevant: false });
  });

  it("detects a type change and treats it as required-relevant when either side is required", () => {
    const [change] = diffGraphs(
      base(),
      proposal((d) => {
        d.nodes[1]!.contract.fields.find((x: any) => x.name === "amount").type = "string";
      }),
    );
    expect(change).toMatchObject({ kind: "contract_field_type_changed", before: "number", after: "string", required_relevant: true });
  });

  it("detects a requiredness change in either direction as propagating (review round 1: required -> optional too)", () => {
    const toRequired = diffGraphs(
      base(),
      proposal((d) => {
        d.nodes[1]!.contract.fields.find((x: any) => x.name === "note").required = true;
      }),
    );
    expect(toRequired[0]).toMatchObject({ kind: "contract_field_requirement_changed", propagation: "field", before: "optional", after: "required" });
    const toOptional = diffGraphs(
      base(),
      proposal((d) => {
        d.nodes[1]!.contract.fields.find((x: any) => x.name === "amount").required = false;
      }),
    );
    expect(toOptional[0]).toMatchObject({ kind: "contract_field_requirement_changed", propagation: "field", required_relevant: true });
  });

  it("detects added required fields as propagating and added optional fields as informational", () => {
    const required = diffGraphs(
      base(),
      proposal((d) => {
        d.nodes[1]!.contract.fields.push(f("currency"));
      }),
    );
    expect(required[0]).toMatchObject({ kind: "contract_field_added", propagation: "field", required_relevant: true });
    const optional = diffGraphs(
      base(),
      proposal((d) => {
        d.nodes[1]!.contract.fields.push(f("memo", "string", false));
      }),
    );
    expect(optional[0]).toMatchObject({ kind: "contract_field_added", propagation: "none" });
  });

  it.each([
    ["major bump", "2.0.0", "all"],
    ["major bump with prefix and prerelease", "v3.0.0-rc.1", "all"],
    ["minor bump", "1.1.0", "none"],
    ["patch bump", "1.0.9", "none"],
    ["downgrade within major", "1.0.0+build7", "none"],
    ["non semver", "next", "all"],
  ])("version change: %s", (_name, version, propagation) => {
    const [change] = diffGraphs(
      base(),
      proposal((d) => {
        d.nodes[1]!.version = version;
      }),
    );
    expect(change).toMatchObject({ kind: "node_version_changed", propagation, before: "1.0.0", after: version });
  });

  it("a baseline non-semver version that changes is treated as breaking", () => {
    const a = build(manifest([n("svc.a", "service", { version: "alpha" })], []));
    const b = build(manifest([n("svc.a", "service", { version: "1.0.0" })], []));
    expect(diffGraphs(a, b)[0]).toMatchObject({ propagation: "all" });
  });

  it("detects removed nodes and suppresses the edge removals that merely follow from them", () => {
    const changes = diffGraphs(
      base(),
      proposal((d) => {
        d.nodes = d.nodes.filter((x) => x.id !== "contract.invoice");
        d.edges = d.edges.filter((x) => x.source_id !== "contract.invoice" && x.target_id !== "contract.invoice");
      }),
    );
    expect(kinds(changes)).toEqual(["node_removed"]);
    expect(changes[0]).toMatchObject({ node_id: "contract.invoice", propagation: "all" });
  });

  it("detects added nodes and added edges as informational (edges attached to a new node are covered by node_added)", () => {
    const changes = diffGraphs(
      base(),
      proposal((d) => {
        d.nodes.push(n("svc.new", "service"));
        d.edges.push(e("svc.new", "contract.invoice", "consumes"));
        d.edges.push(e("svc.dashboard", "cred.smtp", "requires"));
      }),
    );
    expect(kinds(changes).sort()).toEqual(["edge_added", "node_added"]);
    expect(changes.find((c) => c.kind === "edge_added")!.edge).toEqual({ source_id: "svc.dashboard", target_id: "cred.smtp", relation: "requires" });
    expect(changes.every((c) => c.propagation === "none")).toBe(true);
  });

  it("a removed produces edge propagates from the produced node; a removed consumes edge does not", () => {
    const produces = diffGraphs(
      base(),
      proposal((d) => {
        d.edges = d.edges.filter((x) => !(x.source_id === "job.export" && x.relation === "produces"));
      }),
    );
    expect(produces[0]).toMatchObject({ kind: "edge_removed", node_id: "job.export", origin_id: "artifact.report", propagation: "all" });
    const consumes = diffGraphs(
      base(),
      proposal((d) => {
        d.edges = d.edges.filter((x) => !(x.source_id === "svc.mailer" && x.target_id === "contract.invoice"));
      }),
    );
    expect(consumes[0]).toMatchObject({ kind: "edge_removed", propagation: "none" });
  });

  it("edge metadata (verified_at, source line, fields) is not an edge identity change", () => {
    const changes = diffGraphs(
      base(),
      proposal((d) => {
        d.edges[1]!.verified_at = "2026-09-28T12:00:00Z";
        d.edges[1]!.source_line = 99;
      }),
    );
    expect(changes).toEqual([]);
  });

  it("detects kind, owner and placeholder changes", () => {
    const changes = diffGraphs(
      base(),
      proposal((d) => {
        d.nodes[2]!.kind = "service";
        d.nodes[3]!.owner = "team-new";
        d.nodes[4]!.placeholder = true;
      }),
    );
    expect(changes.map((c) => [c.node_id, c.kind, c.propagation])).toEqual([
      ["artifact.report", "node_owner_changed", "none"],
      ["job.export", "node_kind_changed", "all"],
      ["svc.dashboard", "node_placeholder_changed", "none"],
    ]);
  });

  it("detects a contract going from declared to undeclared and back", () => {
    const dropped = diffGraphs(
      base(),
      proposal((d) => {
        delete d.nodes[1]!.contract;
      }),
    );
    expect(dropped[0]).toMatchObject({ kind: "contract_declaration_changed", before: "declared", after: "undeclared", propagation: "none" });
    const declared = diffGraphs(dropped.length ? proposal((d) => delete d.nodes[1]!.contract) : base(), base());
    expect(declared[0]).toMatchObject({ before: "undeclared", after: "declared" });
  });

  it("orders changes deterministically and gives every change a unique stable id", () => {
    const mutate = (d: Doc) => {
      d.nodes[1]!.contract.fields = d.nodes[1]!.contract.fields.filter((x: any) => x.name !== "amount");
      d.nodes[1]!.version = "2.0.0";
      d.nodes.push(n("svc.new", "service"));
    };
    const a = diffGraphs(base(), proposal(mutate));
    const b = diffGraphs(base(), proposal(mutate));
    expect(a).toEqual(b);
    expect(new Set(a.map((c) => c.id)).size).toBe(a.length);
    expect(a.map((c) => c.node_id)).toEqual([...a.map((c) => c.node_id)].sort());
  });
});

describe("affectsLink", () => {
  const graph = base();
  const linkTo = (id: string) => graph.dependentsOf("contract.invoice").find((l) => l.to === id)!;
  const change = (patch: Partial<Change>): Change => ({
    id: "chg_x",
    kind: "contract_field_removed",
    node_id: "contract.invoice",
    origin_id: "contract.invoice",
    field: "amount",
    edge: null,
    before: null,
    after: null,
    propagation: "field",
    required_relevant: true,
    description: "d",
    ...patch,
  });

  it("propagation none never affects, all always affects", () => {
    expect(affectsLink(change({ propagation: "none" }), linkTo("job.export"))).toBe(false);
    expect(affectsLink(change({ propagation: "all" }), linkTo("svc.mailer"))).toBe(true);
  });

  it("an undeclared consumer is affected by required-relevant field changes only", () => {
    expect(affectsLink(change({ required_relevant: true }), linkTo("job.export"))).toBe(true);
    expect(affectsLink(change({ required_relevant: false }), linkTo("job.export"))).toBe(false);
  });

  it("a declared consumer is affected only when its field list contains the field", () => {
    expect(affectsLink(change({ field: "amount" }), linkTo("svc.mailer"))).toBe(false);
    expect(affectsLink(change({ field: "invoice_id" }), linkTo("svc.mailer"))).toBe(true);
    expect(affectsLink(change({ field: "note", required_relevant: false }), linkTo("svc.mailer"))).toBe(false);
  });

  it("a field change without a field name falls back to required relevance", () => {
    expect(affectsLink(change({ field: null }), linkTo("svc.mailer"))).toBe(true);
  });
});

describe("traverseDependents", () => {
  it("returns direct and transitive dependents with ordered hops and provenance", () => {
    const t = traverseDependents(base(), "contract.invoice");
    expect(t.reached.map((r) => [r.node_id, r.depth])).toEqual([
      ["job.export", 1],
      ["svc.mailer", 1],
      ["artifact.report", 2],
      ["svc.dashboard", 3],
    ]);
    const dashboard = t.reached.find((r) => r.node_id === "svc.dashboard")!;
    expect(dashboard.hops.map((h) => [h.from, h.to, h.relation])).toEqual([
      ["contract.invoice", "job.export", "consumes"],
      ["job.export", "artifact.report", "produces"],
      ["artifact.report", "svc.dashboard", "consumes"],
    ]);
    expect(dashboard.hops[0]).toMatchObject({ source_id: "job.export", target_id: "contract.invoice", source_file: "manifests/job.export.yaml", source_line: 10 });
    expect(dashboard.hops).toHaveLength(dashboard.depth);
  });

  it("returns an empty traversal for an unknown origin or a node without dependents", () => {
    expect(traverseDependents(base(), "svc.ghost")).toEqual({ origin_id: "svc.ghost", reached: [], examined_edges: [], cycles: [], truncated: false });
    expect(traverseDependents(base(), "svc.dashboard").reached).toEqual([]);
  });

  it("respects the first hop filter for what is followed, but still examines the edges it rejected (review round 1 P0)", () => {
    const t = traverseDependents(base(), "contract.invoice", { acceptFirstHop: (l) => l.to === "svc.mailer" });
    expect(t.reached.map((r) => r.node_id)).toEqual(["svc.mailer"]);
    // job.export was excluded, but the evidence behind the exclusion is on its edge, so that edge is examined too.
    expect(t.examined_edges.map((x) => `${x.source_id}>${x.target_id}`)).toEqual(["job.export>contract.invoice", "svc.mailer>contract.invoice"]);
  });

  it("terminates on a cycle, visits every node once, and reports the cycle", () => {
    const graph = build(
      manifest(
        ["a", "b", "c"].map((x) => n(`svc.${x}`, "service")).concat([n("contract.c", "contract")]),
        [
          e("svc.a", "contract.c", "consumes"),
          e("svc.b", "svc.a", "consumes"),
          e("svc.c", "svc.b", "consumes"),
          e("svc.a", "svc.c", "consumes"),
        ],
      ),
    );
    const t = traverseDependents(graph, "contract.c");
    expect(t.reached.map((r) => [r.node_id, r.depth])).toEqual([
      ["svc.a", 1],
      ["svc.b", 2],
      ["svc.c", 3],
    ]);
    expect(t.cycles.map((c) => c.members)).toEqual([["svc.a", "svc.b", "svc.c"]]);
    // The edge that closes the loop was examined but not followed again.
    expect(t.examined_edges).toHaveLength(4);
  });

  it("never reports the origin as its own consumer even when it sits on a cycle", () => {
    const graph = build(
      manifest([n("svc.a", "service"), n("svc.b", "service")], [e("svc.b", "svc.a", "consumes"), e("svc.a", "svc.b", "consumes")]),
    );
    const t = traverseDependents(graph, "svc.a");
    expect(t.reached.map((r) => r.node_id)).toEqual(["svc.b"]);
    expect(t.cycles).toHaveLength(1);
  });

  it("breaks path ties deterministically (shortest path, then lexicographic order)", () => {
    const graph = build(
      manifest(
        ["o", "b", "c", "x"].map((id) => n(`svc.${id}`, "service")),
        [e("svc.c", "svc.o", "consumes"), e("svc.b", "svc.o", "consumes"), e("svc.x", "svc.c", "consumes"), e("svc.x", "svc.b", "consumes")],
      ),
    );
    const x = traverseDependents(graph, "svc.o").reached.find((r) => r.node_id === "svc.x")!;
    expect(x.hops.map((h) => h.to)).toEqual(["svc.b", "svc.x"]);
  });

  it("handles a self loop on the origin", () => {
    const graph = build(manifest([n("svc.a", "service")], [e("svc.a", "svc.a", "consumes")]));
    const t = traverseDependents(graph, "svc.a");
    expect(t.reached).toEqual([]);
    expect(t.cycles).toHaveLength(1);
  });
});
