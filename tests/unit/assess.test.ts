import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../src/domain/canonical.js";
import { fixedClock } from "../../src/domain/clock.js";
import type { ContractCheckResult } from "../../src/domain/contract-checks.js";
import { InvalidExpectedHashError, StaleBaselineError } from "../../src/domain/errors.js";
import { assess, checkBaselineHash, type Assessment } from "../../src/services/assess.js";
import type { DependencyGraph } from "../../src/services/graph.js";
import { FRESH, NOW_ISO, STALE, billingManifest, build, clock, e, f, manifest, n } from "../helpers/builders.js";

type Doc = { nodes: Record<string, any>[]; edges: Record<string, any>[] };

function docWith(mutate: (doc: Doc) => void): Doc {
  const doc = billingManifest() as unknown as Doc;
  mutate(doc);
  return doc;
}

function run(
  baselineDoc: unknown,
  proposedDoc: unknown,
  extra: { config?: Record<string, number>; checks?: ContractCheckResult[]; clock?: ReturnType<typeof fixedClock> } = {},
): Assessment {
  const baseline = build(baselineDoc);
  const proposed = build(proposedDoc);
  const result = assess({
    baseline,
    proposed,
    expected_hash: baseline.hash,
    clock: extra.clock ?? clock,
    ...(extra.config ? { config: extra.config } : {}),
    ...(extra.checks ? { check_results: extra.checks } : {}),
  });
  if (!result.ok) throw new Error("assess failed: " + result.error.code);
  return result.assessment;
}

const removeField = (name: string) => (doc: Doc) => {
  doc.nodes[1]!.contract.fields = doc.nodes[1]!.contract.fields.filter((x: any) => x.name !== name);
};

describe("AC-02 propagation to direct and transitive consumers", () => {
  it("removing a required field yields direct AND transitive consumers with ordered paths and owners", () => {
    const a = run(billingManifest(), docWith(removeField("amount")));
    expect(a.assessment).toBe("AFFECTED");
    expect(a.unknowns).toEqual([]);
    expect(a.findings.map((x) => [x.consumer_id, x.depth, x.direct, x.severity, x.consumer_owner])).toEqual([
      ["job.export", 1, true, "high", "team-data"],
      ["artifact.report", 2, false, "medium", "team-data"],
      ["svc.dashboard", 3, false, "medium", "team-web"],
    ]);
    const dashboard = a.findings.find((x) => x.consumer_id === "svc.dashboard")!;
    expect(dashboard.path).toEqual(["contract.invoice", "job.export", "artifact.report", "svc.dashboard"]);
    expect(dashboard.hops.map((h) => `${h.from}>${h.to}`)).toEqual([
      "contract.invoice>job.export",
      "job.export>artifact.report",
      "artifact.report>svc.dashboard",
    ]);
    expect(dashboard.hops[0]).toMatchObject({ source_file: "manifests/job.export.yaml", source_line: 10 });
    expect(dashboard.reason).toContain("Transitive dependent of contract.invoice (3 hops)");
    expect(dashboard.reason).toContain("required field amount was removed from contract contract.invoice");
    expect(a.summary).toEqual({ changes: 1, findings: 3, direct_findings: 1, transitive_findings: 2, unknowns: 0, known_impact: true });
  });

  it("a consumer that declared other fields is not affected by this removal, one that declared it is", () => {
    const amount = run(billingManifest(), docWith(removeField("amount")));
    expect(amount.findings.map((x) => x.consumer_id)).not.toContain("svc.mailer");
    const invoiceId = run(billingManifest(), docWith(removeField("invoice_id")));
    expect(invoiceId.findings.filter((x) => x.direct).map((x) => x.consumer_id)).toEqual(["job.export", "svc.mailer"]);
  });

  it("an optional field removal only reaches consumers that declared that field", () => {
    const undeclared = run(billingManifest(), docWith(removeField("note")));
    expect(undeclared.assessment).toBe("NO_KNOWN_IMPACT");
    const declared = run(
      billingManifest((_nodes, edges) => (edges[4]!.fields = ["invoice_id", "note"])),
      docWith((d) => {
        d.edges[4]!.fields = ["invoice_id", "note"];
        removeField("note")(d);
      }),
    );
    expect(declared.findings.map((x) => x.consumer_id)).toEqual(["svc.mailer"]);
  });

  it("a type change and a newly required field reach consumers", () => {
    const typeChange = run(
      billingManifest(),
      docWith((d) => (d.nodes[1]!.contract.fields.find((x: any) => x.name === "amount").type = "string")),
    );
    expect(typeChange.findings[0]).toMatchObject({ consumer_id: "job.export", direct: true });
    const required = run(
      billingManifest(),
      docWith((d) => d.nodes[1]!.contract.fields.push(f("currency"))),
    );
    expect(required.findings[0]).toMatchObject({ consumer_id: "job.export" });
  });

  it("a major version bump reaches every dependent, a minor bump reaches none", () => {
    const major = run(billingManifest(), docWith((d) => (d.nodes[1]!.version = "2.0.0")));
    expect(major.findings.filter((x) => x.direct).map((x) => x.consumer_id)).toEqual(["job.export", "svc.mailer"]);
    const minor = run(billingManifest(), docWith((d) => (d.nodes[1]!.version = "1.4.0")));
    expect(minor.assessment).toBe("NO_KNOWN_IMPACT");
    expect(minor.coverage.limits.map((l) => l.code)).toContain("INFORMATIONAL_CHANGES_ONLY");
  });

  it("removing a node reaches its consumers (baseline graph is authoritative for known consumers)", () => {
    const a = run(
      billingManifest(),
      docWith((d) => {
        d.nodes = d.nodes.filter((x) => x.id !== "contract.invoice");
        d.edges = d.edges.filter((x) => x.source_id !== "contract.invoice" && x.target_id !== "contract.invoice");
      }),
    );
    expect(a.assessment).toBe("AFFECTED");
    expect(a.findings.map((x) => x.consumer_id)).toEqual(["job.export", "svc.mailer", "artifact.report", "svc.dashboard"]);
  });

  it("losing a producer reaches the consumers of what it produced", () => {
    const a = run(
      billingManifest(),
      docWith((d) => (d.edges = d.edges.filter((x) => !(x.source_id === "job.export" && x.relation === "produces")))),
    );
    expect(a.findings.map((x) => [x.origin_id, x.consumer_id])).toEqual([["artifact.report", "svc.dashboard"]]);
  });

  it("rotating or removing a credential alias reaches the services that require it", () => {
    const a = run(billingManifest(), docWith((d) => (d.nodes.find((x) => x.id === "cred.smtp")!.version = "2.0.0")));
    expect(a.findings.map((x) => [x.origin_id, x.consumer_id, x.direct])).toEqual([["cred.smtp", "svc.mailer", true]]);
  });

  it("several origins produce separate findings for the same consumer", () => {
    const a = run(
      billingManifest(),
      docWith((d) => {
        removeField("amount")(d);
        d.nodes.find((x) => x.id === "artifact.report")!.version = "2.0.0";
      }),
    );
    expect(a.findings.filter((x) => x.consumer_id === "svc.dashboard").map((x) => x.origin_id).sort()).toEqual(["artifact.report", "contract.invoice"]);
  });

  it("findings sort by severity, depth, consumer then origin", () => {
    const a = run(billingManifest(), docWith((d) => (d.nodes[1]!.version = "2.0.0")));
    expect(a.findings.map((x) => x.severity)).toEqual(["high", "high", "medium", "medium"]);
    expect(a.findings.map((x) => x.depth)).toEqual([1, 1, 2, 3]);
  });

  it("records the causing change ids on each finding", () => {
    const a = run(
      billingManifest(),
      docWith((d) => {
        removeField("amount")(d);
        d.nodes[1]!.contract.fields.find((x: any) => x.name === "invoice_id").type = "integer";
      }),
    );
    const direct = a.findings.filter((x) => x.direct);
    const byConsumer = Object.fromEntries(direct.map((x) => [x.consumer_id, x.change_ids.length]));
    // job.export is undeclared: hit by both. svc.mailer declared invoice_id only: hit by the type change alone.
    expect(byConsumer).toEqual({ "job.export": 2, "svc.mailer": 1 });
  });
});

describe("AC-03 cycles and determinism in assessments", () => {
  const cyclic = () =>
    manifest(
      ["a", "b", "c"].map((x) => n(`svc.${x}`, "service")).concat([n("contract.c", "contract", { fields: [f("x"), f("y")] })]),
      [
        e("svc.a", "contract.c", "consumes"),
        e("svc.b", "svc.a", "consumes"),
        e("svc.c", "svc.b", "consumes"),
        e("svc.a", "svc.c", "consumes"),
      ],
    );

  it("terminates on a cycle, reports each consumer once and reports the cycle", () => {
    const proposed = clone(cyclic());
    (proposed.nodes as any[])[3].contract.fields = [f("x")];
    const a = run(cyclic(), proposed);
    expect(a.findings.map((x) => [x.consumer_id, x.depth])).toEqual([
      ["svc.a", 1],
      ["svc.b", 2],
      ["svc.c", 3],
    ]);
    expect(a.cycles.map((c) => c.members)).toEqual([["svc.a", "svc.b", "svc.c"]]);
  });

  it("identical inputs give byte identical assessments (same hash, same sorted findings)", () => {
    const doc = docWith(removeField("amount"));
    const first = run(billingManifest(), doc);
    const second = run(billingManifest(), doc);
    expect(canonicalJson(first)).toBe(canonicalJson(second));
    expect(first.baseline_hash).toBe(second.baseline_hash);
  });

  it("shuffled input order gives the same finding ids in the same order", () => {
    const shuffledBaseline = billingManifest() as unknown as Doc;
    shuffledBaseline.nodes.reverse();
    shuffledBaseline.edges.reverse();
    const proposedDoc = docWith(removeField("amount"));
    const reordered = clone(proposedDoc);
    reordered.nodes.reverse();
    reordered.edges.reverse();
    const a = run(billingManifest(), proposedDoc);
    const b = run(shuffledBaseline, reordered);
    expect(b.findings.map((x) => x.id)).toEqual(a.findings.map((x) => x.id));
    expect(b.baseline_hash).toBe(a.baseline_hash);
    expect(b.proposed_hash).toBe(a.proposed_hash);
  });
});

describe("AC-04 unknowns force INCOMPLETE", () => {
  const change = docWith(removeField("amount"));

  it("SEEDED NEGATIVE CONTROL: the identical scenario is AFFECTED when known and INCOMPLETE once a consumer contract is stale", () => {
    expect(run(billingManifest(), change).assessment).toBe("AFFECTED");
    const staleBaseline = billingManifest((_n, edges) => (edges[1]!.verified_at = STALE));
    const staleProposed = docWith((d) => {
      removeField("amount")(d);
      d.edges[1]!.verified_at = STALE;
    });
    const a = run(staleBaseline, staleProposed);
    expect(a.assessment).toBe("INCOMPLETE");
    expect(a.unknowns.map((u) => u.code)).toEqual(["STALE_CONTRACT"]);
    expect(a.unknowns[0]!.edge).toEqual({ source_id: "job.export", target_id: "contract.invoice", relation: "consumes" });
    // Findings stay visible: INCOMPLETE never hides a real, known break.
    expect(a.summary.known_impact).toBe(true);
    expect(a.findings).toHaveLength(3);
  });

  it("a consumer without an owner forces INCOMPLETE", () => {
    const withoutOwner = (d: Doc) => (d.nodes.find((x) => x.id === "job.export")!.owner = null);
    const a = run(docWith(withoutOwner), docWith((d) => (withoutOwner(d), removeField("amount")(d))));
    expect(a.assessment).toBe("INCOMPLETE");
    expect(a.unknowns).toMatchObject([{ code: "MISSING_OWNER", node_id: "job.export" }]);
  });

  it("a changed node without an owner forces INCOMPLETE even when it has no consumers", () => {
    const noOwner = (d: Doc) => (d.nodes.find((x) => x.id === "svc.dashboard")!.owner = null);
    const a = run(docWith(noOwner), docWith((d) => (noOwner(d), (d.nodes.find((x) => x.id === "svc.dashboard")!.version = "2.0.0"))));
    expect(a.assessment).toBe("INCOMPLETE");
    expect(a.unknowns[0]).toMatchObject({ code: "MISSING_OWNER", node_id: "svc.dashboard" });
    expect(a.findings).toEqual([]);
  });

  it("an unverified consumer contract (verified_at null) forces INCOMPLETE", () => {
    const unverified = (d: Doc) => (d.edges[1]!.verified_at = null);
    const a = run(docWith(unverified), docWith((d) => (unverified(d), removeField("amount")(d))));
    expect(a.assessment).toBe("INCOMPLETE");
    expect(a.unknowns[0]).toMatchObject({ code: "UNVERIFIED_CONTRACT" });
  });

  it("a placeholder consumer (unimported manifest) forces INCOMPLETE", () => {
    const placeholder = (d: Doc) => (d.nodes.find((x) => x.id === "svc.dashboard")!.placeholder = true);
    const a = run(docWith(placeholder), docWith((d) => (placeholder(d), removeField("amount")(d))));
    expect(a.assessment).toBe("INCOMPLETE");
    expect(a.unknowns.map((u) => u.code)).toContain("PLACEHOLDER_NODE");
  });

  it("staleness is judged against the injected UTC clock with an exclusive boundary at max age", () => {
    const at = (verified: string) => {
      const base = billingManifest((_n, edges) => (edges[1]!.verified_at = verified));
      const prop = docWith((d) => (removeField("amount")(d), (d.edges[1]!.verified_at = verified)));
      return run(base, prop).assessment;
    };
    // Default max age is 30 days; NOW is 2026-09-29T00:00:00Z.
    expect(at("2026-08-30T00:00:00Z")).toBe("AFFECTED"); // exactly 30 days old: still fresh
    expect(at("2026-08-29T23:59:59Z")).toBe("INCOMPLETE"); // one second older: stale
  });

  it("the max age is configurable and the clock is injectable", () => {
    const base = billingManifest();
    const prop = docWith(removeField("amount"));
    // FRESH is exactly one day before NOW.
    expect(run(base, prop, { config: { max_contract_age_ms: 86_400_000 } }).assessment).toBe("AFFECTED");
    expect(run(base, prop, { config: { max_contract_age_ms: 86_399_999 } }).assessment).toBe("INCOMPLETE");
    // Same data, a clock ten days later: the once-fresh contract is now aged 11 days but under 30 => fresh; 40 days later => stale.
    expect(run(base, prop, { clock: fixedClock("2026-10-09T00:00:00Z") }).assessment).toBe("AFFECTED");
    expect(run(base, prop, { clock: fixedClock("2026-11-08T00:00:00Z") }).assessment).toBe("INCOMPLETE");
  });

  it("a verified_at in the future beyond the skew allowance is unknown, within it is accepted", () => {
    const at = (verified: string) => {
      const base = billingManifest((_n, edges) => (edges[1]!.verified_at = verified));
      const prop = docWith((d) => (removeField("amount")(d), (d.edges[1]!.verified_at = verified)));
      return run(base, prop);
    };
    expect(at("2026-09-29T00:05:00Z").assessment).toBe("AFFECTED");
    const future = at("2026-09-29T00:05:01Z");
    expect(future.assessment).toBe("INCOMPLETE");
    expect(future.unknowns[0]!.code).toBe("FUTURE_VERIFIED_AT");
  });

  it("stale or missing data OFF the examined paths does not force INCOMPLETE", () => {
    const offPath = (d: Doc) => {
      d.edges.find((x) => x.source_id === "svc.mailer" && x.target_id === "cred.smtp")!.verified_at = STALE;
      d.nodes.find((x) => x.id === "svc.billing")!.owner = null;
    };
    const a = run(docWith(offPath), docWith((d) => (offPath(d), removeField("amount")(d))));
    expect(a.assessment).toBe("AFFECTED");
    expect(a.coverage.limits.map((l) => l.code)).toContain("BASELINE_HAS_GAPS");
  });

  it("an undeclared contract that changes is unknown (field level impact cannot be computed)", () => {
    const undeclared = (d: Doc) => delete d.nodes[1]!.contract;
    const a = run(
      docWith(undeclared),
      docWith((d) => (undeclared(d), (d.nodes[1]!.version = "1.1.0"))),
    );
    expect(a.assessment).toBe("INCOMPLETE");
    expect(a.unknowns[0]).toMatchObject({ code: "UNDECLARED_CONTRACT", node_id: "contract.invoice" });
    const dropped = run(billingManifest(), docWith(undeclared));
    expect(dropped.assessment).toBe("INCOMPLETE");
  });

  it("dedupes an unknown reached through several paths", () => {
    const noOwner = (d: Doc) => (d.nodes.find((x) => x.id === "job.export")!.owner = null);
    const proposedDoc = docWith((d) => (noOwner(d), (d.nodes[1]!.version = "2.0.0")));
    const a = run(docWith(noOwner), proposedDoc);
    expect(a.unknowns.filter((u) => u.code === "MISSING_OWNER")).toHaveLength(1);
  });
});

describe("AC-04 isolated change says NO_KNOWN_IMPACT with coverage limits", () => {
  it("a change with no declared consumers is NO_KNOWN_IMPACT and states what is not known", () => {
    const a = run(billingManifest(), docWith((d) => (d.nodes.find((x) => x.id === "svc.dashboard")!.version = "2.0.0")));
    expect(a.assessment).toBe("NO_KNOWN_IMPACT");
    const codes = a.coverage.limits.map((l) => l.code);
    expect(codes).toEqual(expect.arrayContaining(["MANIFEST_DECLARED_ONLY", "CONTRACT_SUBSET_ONLY", "RUNTIME_NOT_OBSERVED", "NO_AFFECTED_CONSUMERS_DECLARED"]));
    expect(a.coverage.limits.find((l) => l.code === "NO_AFFECTED_CONSUMERS_DECLARED")!.node_ids).toEqual(["svc.dashboard"]);
    expect(a.coverage.known.join("\n")).toContain("0 consumer(s) reached through declared edges");
    expect(a.coverage).toMatchObject({ scope: "declared_manifests_only", consumers_found: 0, origin_node_ids: ["svc.dashboard"] });
  });

  it("an identical proposal is NO_KNOWN_IMPACT with an explicit no-changes limit", () => {
    const a = run(billingManifest(), billingManifest());
    expect(a.assessment).toBe("NO_KNOWN_IMPACT");
    expect(a.changes).toEqual([]);
    expect(a.coverage.limits.map((l) => l.code)).toContain("NO_CHANGES_DETECTED");
  });

  it("purely informational changes are NO_KNOWN_IMPACT and say so", () => {
    const a = run(billingManifest(), docWith((d) => d.nodes.push(n("svc.new", "service"))));
    expect(a.assessment).toBe("NO_KNOWN_IMPACT");
    expect(a.coverage.limits.map((l) => l.code)).toContain("INFORMATIONAL_CHANGES_ONLY");
  });

  it("coverage records how much of the graph was examined", () => {
    const a = run(billingManifest(), docWith(removeField("amount")));
    expect(a.coverage).toMatchObject({
      baseline: { nodes: 7, edges: 6 },
      proposed: { nodes: 7, edges: 6 },
      changed_node_ids: ["contract.invoice"],
      origin_node_ids: ["contract.invoice"],
      nodes_examined: 4,
      // Three followed edges plus svc.mailer's edge, which excluded that consumer (it declares only invoice_id)
      // and is examined for the evidence behind the exclusion.
      edges_examined: 4,
      consumers_found: 3,
    });
  });
});

describe("AC-06 contract check results feed the verdict", () => {
  const result = (state: ContractCheckResult["state"]): ContractCheckResult => ({
    check_id: "chk.invoice",
    node_id: "contract.invoice",
    state,
    attempts: 1,
    started_at: NOW_ISO,
    finished_at: NOW_ISO,
    duration_ms: 0,
    detail: null,
    error_code: null,
    attempt_log: [],
  });

  it("PASSED adds no unknown", () => {
    const a = run(billingManifest(), docWith(removeField("amount")), { checks: [result("PASSED")] });
    expect(a.assessment).toBe("AFFECTED");
  });

  it("the same failing check reported twice yields one unknown, distinct checks yield distinct unknowns", () => {
    const failed = result("FAILED");
    const one = run(billingManifest(), billingManifest(), { checks: [failed, failed] });
    expect(one.unknowns).toHaveLength(1);
    const two = run(billingManifest(), billingManifest(), { checks: [failed, { ...failed, check_id: "chk.other" }] });
    expect(two.unknowns).toHaveLength(2);
    expect(new Set(two.unknowns.map((u) => u.id)).size).toBe(2);
  });

  it.each([
    ["FAILED", "CHECK_FAILED"],
    ["TIMED_OUT", "CHECK_TIMED_OUT"],
    ["ERROR", "CHECK_ERROR"],
    ["UNKNOWN", "CHECK_UNKNOWN"],
  ] as const)("%s becomes %s and forces INCOMPLETE, even for an otherwise safe change", (state, code) => {
    const a = run(billingManifest(), billingManifest(), { checks: [result(state)] });
    expect(a.assessment).toBe("INCOMPLETE");
    expect(a.unknowns).toMatchObject([{ code, node_id: "contract.invoice" }]);
  });
});

describe("AC-05 baseline hash semantics", () => {
  const baseline = build(billingManifest());
  const proposed = build(docWith(removeField("amount")));

  it("accepts the matching expected hash", () => {
    const r = assess({ baseline, proposed, expected_hash: baseline.hash, clock });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.assessment.baseline_hash).toBe(baseline.hash);
  });

  it("returns a typed StaleBaselineError (HTTP 409) and no assessment when the baseline moved", () => {
    const moved = build(docWith((d) => d.nodes.push(n("svc.concurrent", "service"))));
    const r = assess({ baseline: moved, proposed, expected_hash: baseline.hash, clock });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r).not.toHaveProperty("assessment");
    expect(r.error).toBeInstanceOf(StaleBaselineError);
    expect(r.error).toMatchObject({ code: "STALE_BASELINE", status: 409, expected_hash: baseline.hash, actual_hash: moved.hash });
  });

  it.each(["", "sha256:abc", "SHA256:" + "a".repeat(64), "sha256:" + "G".repeat(64), "md5:" + "a".repeat(32)])(
    "rejects malformed expected_hash %j with InvalidExpectedHashError (HTTP 422)",
    (bad) => {
      const r = assess({ baseline, proposed, expected_hash: bad, clock });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toBeInstanceOf(InvalidExpectedHashError);
        expect(r.error.status).toBe(422);
      }
    },
  );

  it("checkBaselineHash is a pure comparison", () => {
    expect(checkBaselineHash(baseline.hash, baseline.hash)).toBeNull();
    const other = "sha256:" + "0".repeat(64);
    expect(checkBaselineHash(baseline.hash, other)).toBeInstanceOf(StaleBaselineError);
    expect(checkBaselineHash(baseline.hash, "nope")).toBeInstanceOf(InvalidExpectedHashError);
  });

  it("a stale request does not evaluate anything (assess is pure and has no side effects on the graphs)", () => {
    const before = JSON.stringify(baseline.nodes);
    assess({ baseline, proposed, expected_hash: "sha256:" + "1".repeat(64), clock });
    expect(JSON.stringify(baseline.nodes)).toBe(before);
  });
});

describe("AC-07 stable finding ids", () => {
  const baseline = billingManifest();
  const proposed = docWith(removeField("amount"));

  it("finding and unknown ids are content derived: identical across runs, evaluation times and input order", () => {
    const a = run(baseline, proposed);
    const later = run(baseline, proposed, { clock: fixedClock("2026-09-30T12:00:00Z") });
    expect(later.findings.map((x) => x.id)).toEqual(a.findings.map((x) => x.id));
    expect(a.findings.every((x) => /^fnd_[0-9a-f]{20}$/.test(x.id))).toBe(true);
    expect(new Set(a.findings.map((x) => x.id)).size).toBe(a.findings.length);
  });

  it("ids change when the underlying finding changes", () => {
    const a = run(baseline, proposed);
    const b = run(baseline, docWith(removeField("invoice_id")));
    const shared = a.findings.map((x) => x.id).filter((id) => b.findings.some((y) => y.id === id));
    expect(shared).toEqual([]);
  });

  it("every finding id appears in the canonical JSON export exactly once", () => {
    const a = run(baseline, proposed);
    const exported = canonicalJson(a);
    for (const finding of a.findings) {
      expect(exported.split(finding.id)).toHaveLength(2);
    }
  });

  it("unknown ids are independent of the evaluation time", () => {
    const stale = billingManifest((_n, edges) => (edges[1]!.verified_at = STALE));
    const staleProposed = docWith((d) => {
      d.edges[1]!.verified_at = STALE;
      removeField("amount")(d);
    });
    const a = run(stale, staleProposed);
    const b = run(stale, staleProposed, { clock: fixedClock("2026-10-01T06:00:00Z") });
    expect(a.unknowns).toHaveLength(1);
    expect(b.unknowns.map((u) => u.id)).toEqual(a.unknowns.map((u) => u.id));
    expect(b.evaluated_at).not.toBe(a.evaluated_at);
  });
});

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export type { DependencyGraph };
