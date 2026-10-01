import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assess } from "../../src/services/assess.js";
import { buildGraphFromJson } from "../../src/services/graph.js";
import { clock } from "../helpers/builders.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function firstJsonBlock(markdown: string): string {
  const match = /```json\n([\s\S]*?)\n```/.exec(markdown);
  if (!match) throw new Error("no json block");
  return match[1]!;
}

describe("documentation examples are real", () => {
  it("the example manifest in docs/MANIFEST.md is accepted by the validator", () => {
    const text = firstJsonBlock(readFileSync(resolve(root, "docs", "MANIFEST.md"), "utf8"));
    const result = buildGraphFromJson(text);
    if (!result.ok) throw new Error("docs example rejected: " + JSON.stringify(result.failure.issues));
    expect(result.graph.nodes).toHaveLength(4);
    expect(result.warnings).toEqual([]);
  });

  it("removing a required field from the documented example reaches the documented consumer", () => {
    const text = firstJsonBlock(readFileSync(resolve(root, "docs", "MANIFEST.md"), "utf8"));
    const baseline = buildGraphFromJson(text);
    const proposedDoc = JSON.parse(text) as { nodes: { id: string; contract?: { fields: { name: string }[] } }[] };
    const contract = proposedDoc.nodes.find((n) => n.id === "contract.invoice")!.contract!;
    contract.fields = contract.fields.filter((f) => f.name !== "amount");
    const proposed = buildGraphFromJson(JSON.stringify(proposedDoc));
    if (!baseline.ok || !proposed.ok) throw new Error("rejected");
    const result = assess({
      baseline: baseline.graph,
      proposed: proposed.graph,
      expected_hash: baseline.graph.hash,
      // The example's verified_at values are 2026-09-28; one day later they are still fresh.
      clock,
    });
    if (!result.ok) throw new Error("assess failed");
    expect(result.assessment.assessment).toBe("AFFECTED");
    expect(result.assessment.findings.map((f) => f.consumer_id)).toEqual(["job.export"]);
  });
});
