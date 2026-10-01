import { describe, expect, it } from "vitest";
import { renderReportHtml } from "../../src/report/html-report.js";
import { impactGraphModel } from "../../src/web/graph.js";
import type { Finding } from "../../src/web/types.js";
import { baseReport } from "./fixtures.js";

/**
 * Review round 1: a very long path is stored with only its first and last hops (`path_omitted_hops`). The graph, the
 * findings table and the static report must say so instead of drawing the join as if it were one hop.
 */

const hop = (from: string, to: string) => ({ from, to, relation: "consumes", source_id: to, target_id: from, source_file: "manifests/x.yaml", source_line: 1 });

/** origin o, kept hops o>a and (elided) ... >b>c: the join between a and b is 7 hops long. */
const elided = (): Finding => ({
  id: "fnd_00000000000000000001",
  origin_id: "o",
  consumer_id: "c",
  consumer_kind: "service",
  consumer_owner: "team-x",
  severity: "medium",
  direct: false,
  depth: 10,
  path: ["o", "a", "b", "c"],
  hops: [hop("o", "a"), hop("z", "b"), hop("b", "c")],
  path_omitted_hops: 7,
  change_ids: [],
  reason: "test",
});

describe("elided paths are shown as elided", () => {
  it("the impact graph labels the join edge with the number of omitted hops and the others with their relation", () => {
    const model = impactGraphModel([elided()]);
    const labels = Object.fromEntries(model.edges.map((e) => [`${e.from}>${e.to}`, e.label]));
    expect(labels["a>b"]).toBe("… 7 hops omitted");
    expect(labels["o>a"]).toBe("consumes");
    expect(labels["b>c"]).toBe("consumes");
  });

  it("a whole path is drawn with relation labels only (control)", () => {
    const whole: Finding = { ...elided(), path: ["o", "a", "b"], hops: [hop("o", "a"), hop("a", "b")], depth: 2 };
    delete (whole as { path_omitted_hops?: number }).path_omitted_hops;
    const model = impactGraphModel([whole]);
    expect(model.edges.map((e) => e.label)).toEqual(["consumes", "consumes"]);
  });

  it("the static report says how many hops were left out and keeps every kept node", () => {
    const report = baseReport();
    const finding = { ...report.findings[0]!, path: ["o", "a", "b", "c"], hops: [hop("o", "a"), hop("z", "b"), hop("b", "c")], path_omitted_hops: 7 };
    const html = renderReportHtml({ ...report, findings: [finding] } as never);
    expect(html).toContain("… 7 hops not shown …");
    for (const node of ["o", "a", "b", "c"]) expect(html).toContain(`<code>${node}</code>`);
  });

  it("a whole path prints no omission note", () => {
    expect(renderReportHtml(baseReport())).not.toContain("hops not shown");
  });
});
