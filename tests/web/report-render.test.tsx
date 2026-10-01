import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { htmlReportRenderer, REPORT_CSP, REPORT_STYLE, renderReportHtml } from "../../src/report/html-report.js";
import type { RunReport } from "../../src/services/report.js";
import { ALL_FAKE_SECRETS, SECRET_CORES } from "../helpers/fake-secrets.js";
import { baseReport, FINDING_DIRECT, FINDING_TRANSITIVE, hostileReport, incompleteReport, noImpactReport, withRun } from "./fixtures.js";
import { UUID_ONES, UUID_TWOS } from "../helpers/ids.js";
import { HOSTILE } from "./hostile.js";

const parse = (html: string) => new DOMParser().parseFromString(html, "text/html");
const golden = (name: string) => join(dirname(fileURLToPath(import.meta.url)), "golden", name);

describe("static HTML report: structure and self-containment (AC-07, AC-09)", () => {
  const html = renderReportHtml(baseReport());
  const doc = parse(html);

  it("is one complete document with a language, viewport and a title naming the run", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(doc.documentElement.getAttribute("lang")).toBe("en");
    expect(doc.querySelector('meta[name="viewport"]')?.getAttribute("content")).toContain("width=device-width");
    expect(doc.title).toBe(`ChangeRadar impact report ${UUID_ONES}`);
    expect(doc.querySelector("h1")?.textContent).toBe("Impact report");
  });

  it("has no script, no external resource, no link, no inline event handler and no style attribute", () => {
    expect(doc.querySelectorAll("script, link, img, iframe, object, embed, form, audio, video, source, base")).toHaveLength(0);
    for (const el of Array.from(doc.querySelectorAll("*"))) {
      for (const attr of Array.from(el.attributes)) {
        expect(attr.name.startsWith("on"), `${el.tagName} ${attr.name}`).toBe(false);
        expect(attr.name, el.tagName).not.toBe("style");
        expect(attr.name, el.tagName).not.toBe("src");
      }
    }
    // The only href is the in-page skip link.
    const hrefs = Array.from(doc.querySelectorAll("[href]")).map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["#findings"]);
    // No url() or @import in the stylesheet: nothing can be fetched.
    expect(REPORT_STYLE).not.toMatch(/url\(|@import|@font-face/);
    expect(html).not.toMatch(/https?:\/\//);
  });

  it("carries a strict content security policy that allows only its own style block, by hash", () => {
    const meta = doc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content");
    expect(meta).toBe(REPORT_CSP);
    expect(REPORT_CSP).toContain("default-src 'none'");
    expect(REPORT_CSP).not.toContain("unsafe-inline");
    expect(REPORT_CSP).not.toContain("script-src");
    const style = doc.querySelector("style")?.textContent ?? "";
    const expected = `sha256-${createHash("sha256").update(style).digest("base64")}`;
    expect(REPORT_CSP).toContain(`style-src '${expected}'`);
    expect(doc.querySelectorAll("style")).toHaveLength(1);
  });

  it("supports light and dark, a 375px layout, keyboard skipping and print", () => {
    expect(REPORT_STYLE).toContain("color-scheme:light dark");
    expect(REPORT_STYLE).toContain("@media (prefers-color-scheme:dark)");
    expect(REPORT_STYLE).toContain("@media (max-width:40em)");
    expect(REPORT_STYLE).toContain("@media print");
    expect(REPORT_STYLE).toContain("data-label");
    // Found in a real 375px browser check: long hashes must wrap, and a stacked table's hidden header must not widen the page.
    expect(REPORT_STYLE).toContain("overflow-wrap:anywhere");
    expect(REPORT_STYLE).toContain("table.stack thead{display:block;position:absolute");
    expect(doc.querySelector(".skip")?.textContent).toContain("Skip");
    // Every table cell has a stacking label for narrow screens.
    for (const td of Array.from(doc.querySelectorAll("table.stack td"))) expect(td.getAttribute("data-label"), td.outerHTML).toBeTruthy();
  });

  it("prints every finding id verbatim, in order, with owner, ordered path and provenance", () => {
    const rows = Array.from(doc.querySelectorAll("tr[data-finding-id]"));
    expect(rows.map((r) => r.getAttribute("data-finding-id"))).toEqual([FINDING_DIRECT, FINDING_TRANSITIVE]);
    expect(html).toContain(`<code>${FINDING_DIRECT}</code>`);
    const first = rows[0]!;
    expect(first.textContent).toContain("team-data");
    expect(first.querySelectorAll("ol.path li")).toHaveLength(2);
    expect(first.textContent).toContain("consumes via manifests/job.export.yaml:10");
    const second = rows[1]!;
    expect(Array.from(second.querySelectorAll("ol.path li code")).map((c) => c.textContent)).toEqual(["contract.invoice", "job.export", "svc.dashboard"]);
    // A missing owner is stated, never blank.
    expect(second.textContent).toContain("owner unknown");
    expect(second.textContent).toContain("MEDIUM (transitive)");
  });

  it("registers as a ReportRenderer and renders identically through it", () => {
    expect(htmlReportRenderer.render(baseReport())).toBe(html);
  });
});

describe("static HTML report: the three verdicts and the pending and failed states are unmistakably different", () => {
  const verdictOf = (report: RunReport) => parse(renderReportHtml(report)).querySelector("section.verdict");

  it("AFFECTED, INCOMPLETE and NO_KNOWN_IMPACT use different labels, classes and border treatments; none says safe", () => {
    const affected = verdictOf(baseReport())!;
    const incomplete = verdictOf(incompleteReport())!;
    const none = verdictOf(noImpactReport())!;
    expect(affected.getAttribute("data-verdict")).toBe("AFFECTED");
    expect(incomplete.getAttribute("data-verdict")).toBe("INCOMPLETE");
    expect(none.getAttribute("data-verdict")).toBe("NO_KNOWN_IMPACT");
    expect(new Set([affected.className, incomplete.className, none.className]).size).toBe(3);
    expect(affected.textContent).toContain("Known consumers can break");
    expect(incomplete.textContent).toContain("Impact cannot be ruled out");
    expect(incomplete.textContent).toContain("not a safe result");
    expect(none.textContent).toContain("No declared consumer is affected");
    expect(none.textContent).toContain("does not prove that nothing else depends");
    // Border styles differ (solid / dashed / dotted) so the meaning survives greyscale and colour blindness.
    expect(REPORT_STYLE).toMatch(/\.verdict-affected\{[^}]*border-style:solid/);
    expect(REPORT_STYLE).toMatch(/\.verdict-incomplete\{[^}]*border-style:dashed/);
    expect(REPORT_STYLE).toMatch(/\.verdict-noknown\{[^}]*border-style:dotted/);
    // No verdict is ever styled green or worded as a pass.
    expect(REPORT_STYLE).not.toMatch(/green|success/i);
    for (const el of [affected, incomplete, none]) expect(el.textContent).not.toMatch(/\b(all clear|passed|no risk|is safe)\b/i);
  });

  it("INCOMPLETE and NO_KNOWN_IMPACT always show coverage limits; INCOMPLETE lists every unknown with its explanation", () => {
    for (const report of [incompleteReport(), noImpactReport()]) {
      const doc = parse(renderReportHtml(report));
      const limits = doc.querySelector('section[aria-labelledby="coverage-h"]')!;
      expect(limits.textContent).toContain("Coverage limits");
      expect(limits.textContent).toContain("MANIFEST_DECLARED_ONLY");
      expect(limits.textContent).toContain("never infers that an undeclared dependency does not exist");
    }
    const incomplete = parse(renderReportHtml(incompleteReport()));
    const unknownRows = Array.from(incomplete.querySelectorAll("tr[data-unknown-id]"));
    expect(unknownRows.map((r) => r.getAttribute("data-unknown-id"))).toEqual(["unk_aaaaaaaaaaaaaaaaaaaa", "unk_bbbbbbbbbbbbbbbbbbbb"]);
    expect(unknownRows[0]!.textContent).toContain("A dependency edge has never been verified");
    expect(unknownRows[0]!.textContent).toContain("job.export");
    expect(incomplete.body.textContent).toContain("Known impact was also found");
    expect(incomplete.body.textContent).toContain("TIMED_OUT");
    expect(incomplete.body.textContent).toContain("Counted as an unknown");
  });

  it("an empty NO_KNOWN_IMPACT says nothing is declared to be affected within the limits, not that nothing is", () => {
    const doc = parse(renderReportHtml(noImpactReport()));
    expect(doc.querySelectorAll("tr[data-finding-id]")).toHaveLength(0);
    expect(doc.querySelector("#findings")?.parentElement?.textContent).toContain("within the coverage limits above");
    expect(doc.body.textContent).toContain("No unknowns were recorded");
    expect(doc.body.textContent).toContain("Nodes: contract.invoice");
  });

  it("an INCOMPLETE run with no listed findings warns that this does not mean nothing is affected", () => {
    const doc = parse(renderReportHtml(withRun({ assessment: "INCOMPLETE" }, { findings: [], summary: { changes: 1, findings: 0, direct_findings: 0, transitive_findings: 0, unknowns: 1, known_impact: false } as never })));
    expect(doc.body.textContent).toContain("that does not mean nothing is affected");
  });

  it("pending and failed runs show no verdict and no invented coverage", () => {
    const pending = parse(renderReportHtml(withRun({ status: "running", assessment: null }, { findings: [], coverage: null as never, summary: null as never })));
    expect(pending.querySelector("section.verdict")?.getAttribute("data-verdict")).toBe("PENDING");
    expect(pending.body.textContent).toContain("No verdict yet");
    expect(pending.body.textContent).toContain("No coverage statement is available");
    expect(pending.body.textContent).toContain("no assessment");
    const failed = parse(renderReportHtml(withRun({ status: "failed", assessment: null, error: { code: "WORKER_EXHAUSTED", detail: "gave up after 3 attempts" } }, { findings: [], coverage: null as never })));
    expect(failed.querySelector("section.verdict")?.getAttribute("data-verdict")).toBe("FAILED");
    expect(failed.body.textContent).toContain("No verdict was produced");
    expect(failed.body.textContent).toContain("WORKER_EXHAUSTED");
    expect(failed.body.textContent).toContain("gave up after 3 attempts");
    const failedNoDetail = parse(renderReportHtml(withRun({ status: "failed", assessment: null, error: null })));
    expect(failedNoDetail.querySelector("section.verdict")?.getAttribute("data-verdict")).toBe("FAILED");
  });

  it("reports cycles, changes and the superseded-baseline note when they exist", () => {
    const report = withRun({ allow_superseded: true }, { cycles: [{ id: "cyc_1234", members: ["svc.a", "svc.b"] }] as never });
    const doc = parse(renderReportHtml(report));
    expect(doc.body.textContent).toContain("Dependency cycles (1)");
    expect(doc.body.textContent).toContain("cyc_1234");
    expect(doc.body.textContent).toContain("Detected changes (1)");
    expect(doc.body.textContent).toContain("no longer the workspace baseline");
    // Sections that have nothing to say are omitted rather than shown empty.
    const plain = parse(renderReportHtml(withRun({}, { cycles: [], changes: [] as never })));
    expect(plain.body.textContent).not.toContain("Dependency cycles");
    expect(plain.body.textContent).not.toContain("Detected changes");
    expect(plain.body.textContent).not.toContain("Live contract checks");
  });

  it("tolerates a sparse report (missing optional members) without throwing", () => {
    const sparse = { ...baseReport(), summary: null, coverage: {}, cycles: null, changes: null, unknowns: [{}], findings: [], checks: [{ check_key: "k", node_id: "n", state: "MYSTERY", attempts: null, detail: null }] } as unknown as RunReport;
    const html = renderReportHtml(sparse);
    expect(html).toContain("MYSTERY");
    expect(html).toContain("unknown");
  });
});

describe("static HTML report: hostile strings render as text and secrets are redacted (AC-09)", () => {
  const html = renderReportHtml(hostileReport());
  const doc = parse(html);

  it("no payload becomes an element or an attribute: only escaped text", () => {
    expect(doc.querySelectorAll("script, img, svg")).toHaveLength(0);
    for (const el of Array.from(doc.querySelectorAll("*"))) for (const attr of Array.from(el.attributes)) expect(attr.name.startsWith("on"), attr.name).toBe(false);
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>window");
    expect(html).not.toContain("<svg/onload");
    expect(html).toContain("&lt;img src=x onerror=&quot;window.__pwned=1&quot;&gt;");
    expect((window as unknown as { __pwned?: unknown }).__pwned).toBeUndefined();
  });

  it("the payloads are visible as literal text in every field they were planted in", () => {
    const text = doc.body.textContent ?? "";
    expect(text).toContain(HOSTILE.owner);
    expect(text).toContain(HOSTILE.version);
    expect(text).toContain(HOSTILE.file);
    expect(doc.title).toContain("ChangeRadar impact report");
    // Escaped exactly once: an ampersand entity in the source is shown as the literal characters &amp;.
    expect(html).toContain("&amp;amp;");
    const row = doc.querySelector("tr[data-finding-id]")!;
    expect(row.querySelector("td[data-label='Consumer'] code")?.textContent).toBe(HOSTILE.owner);
    expect(row.getAttribute("data-finding-id")).toBe(FINDING_DIRECT);
  });

  it("a hostile finding id cannot break out of the attribute or the cell", () => {
    const report = baseReport();
    report.findings[0]!.id = `fnd_"><script>window.__pwned=1</script>`;
    const out = renderReportHtml(report);
    expect(parse(out).querySelectorAll("script")).toHaveLength(0);
    expect(parse(out).querySelector("tr[data-finding-id]")?.getAttribute("data-finding-id")).toBe(`fnd_"><script>window.__pwned=1</script>`);
  });

  it("planted secrets in any text field are replaced before they reach the HTML", () => {
    const report = baseReport();
    const secretText = ALL_FAKE_SECRETS.join(" | ");
    report.findings[0]!.reason = secretText;
    report.findings[0]!.consumer_owner = secretText;
    (report.unknowns as unknown[]).push({ id: "unk_1", code: "X", node_id: null, edge: null, message: secretText });
    report.checks = [{ check_key: "c", node_id: "n", state: "ERROR", attempts: 1, detail: secretText, error_code: null, attempt_log: [], started_at: "2026-09-29T00:00:00.000Z", finished_at: null }];
    const out = renderReportHtml(report);
    for (const core of SECRET_CORES) expect(out, core).not.toContain(core);
    expect(out).toContain("[REDACTED]");
  });
});

describe("static HTML report: deterministic output (golden files)", () => {
  const cases: [string, () => RunReport][] = [
    ["report-affected.html", baseReport],
    ["report-incomplete.html", incompleteReport],
    ["report-no-known-impact.html", noImpactReport],
    ["report-hostile.html", hostileReport],
  ];

  it.each(cases)("%s: identical input gives identical bytes, and they match the committed golden file", (file, build) => {
    const first = renderReportHtml(build());
    expect(renderReportHtml(build())).toBe(first);
    expect(renderReportHtml(JSON.parse(JSON.stringify(build())))).toBe(first);
    // The synthetic ids are stored as placeholders so no UUID-shaped literal sits in the committed golden files.
    const stored = first.replaceAll(UUID_ONES, "{{RUN_ID}}").replaceAll(UUID_TWOS, "{{SNAPSHOT_ID}}");
    expect(stored).not.toContain(UUID_ONES);
    const path = golden(file);
    if (process.env.UPDATE_GOLDEN === "1") {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, stored);
    }
    expect(existsSync(path), `golden file ${file} missing; run with UPDATE_GOLDEN=1`).toBe(true);
    expect(stored).toBe(readFileSync(path, "utf8"));
  });

  it("contains no generation time and no random value: two renders far apart are byte identical", async () => {
    const a = renderReportHtml(baseReport());
    await new Promise((r) => setTimeout(r, 30));
    expect(renderReportHtml(baseReport())).toBe(a);
    expect(a).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?!\.000Z)/);
  });
});
