import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runContractCheck } from "../../src/domain/contract-checks.js";
import { assess } from "../../src/services/assess.js";
import { buildGraphFromJson } from "../../src/services/graph.js";
import { billingManifest, clock } from "../helpers/builders.js";

/**
 * AC-08 (domain part): with every outbound path denied, the deterministic core still imports,
 * diffs and assesses. Any attempt to reach the network fails the test loudly.
 */
describe("AC-08 the deterministic core completes with outbound access denied", () => {
  afterEach(() => vi.restoreAllMocks());

  it("imports, diffs, assesses and runs a check without touching the network", async () => {
    const attempts: string[] = [];
    const deny = (name: string) => () => {
      attempts.push(name);
      throw new Error(`outbound denied: ${name}`);
    };
    vi.spyOn(net.Socket.prototype, "connect").mockImplementation(deny("net.Socket.connect"));
    vi.spyOn(dns, "lookup").mockImplementation(deny("dns.lookup") as never);
    vi.spyOn(http, "request").mockImplementation(deny("http.request"));
    vi.spyOn(https, "request").mockImplementation(deny("https.request"));
    vi.spyOn(globalThis, "fetch").mockImplementation(deny("fetch"));

    const baselineDoc = billingManifest();
    const proposedDoc = billingManifest((nodes) => {
      const contract = nodes[1] as { contract: { fields: { name: string }[] } };
      contract.contract.fields = contract.contract.fields.filter((x) => x.name !== "amount");
    });
    const baseline = buildGraphFromJson(JSON.stringify(baselineDoc));
    const proposed = buildGraphFromJson(JSON.stringify(proposedDoc));
    if (!baseline.ok || !proposed.ok) throw new Error("rejected");

    // An in-process runner (no I/O) stands in for the stage B network runner.
    const check = await runContractCheck(
      { id: "chk.offline", node_id: "contract.invoice", description: "in-memory", timeout_ms: 500 },
      { read_only: true, run: async () => ({ state: "PASSED" }) },
      { clock },
    );
    const result = assess({ baseline: baseline.graph, proposed: proposed.graph, expected_hash: baseline.graph.hash, clock, check_results: [check] });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.assessment.assessment).toBe("AFFECTED");
    expect(attempts).toEqual([]);
  });
});
