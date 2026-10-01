import { createHash } from "node:crypto";
import { escapeHtml, redactIdentifier, safeReportText as logText } from "../domain/redaction.js";
import type { ReportRenderer, RunReport } from "../services/report.js";
import { CHECK_STATE_NOTE, FAILED_TEXT, isVerdict, PENDING_TEXT, REDACTION_NOTE, UNKNOWN_CODE_HELP, VERDICT_TEXT, type Verdict } from "./wording.js";

/**
 * The static impact report: one self-contained HTML document. No script, no external resource (no font,
 * image, stylesheet or link to anywhere), a strict Content-Security-Policy in a meta tag that allows only this
 * document's own style block by hash, escaped output only, and no time-dependent content, so the same
 * RunReport always renders to the same bytes. Every dynamic value goes through `escapeHtml` or
 * `safeReportText` (redact, then escape); finding ids are printed verbatim (escaped) so the HTML and the JSON
 * export list the same ids (AC-07). Registered as `ctx.reportRenderer` by `contextFromConfig`.
 */

// Palette: every text/background pair below is checked against WCAG AA (4.5:1) by tests/web/contrast.test.ts.
const REPORT_CSS = `
:root{color-scheme:light dark;--bg:#f6f7f9;--surface:#ffffff;--fg:#14171c;--muted:#465064;--line:#b9c0cc;--accent:#1a56b8;--bad-fg:#8f120c;--bad-bg:#fde8e6;--warn-fg:#5e3b00;--warn-bg:#fff0cf;--warn-bg2:#ffe6b0;--info-fg:#17476f;--info-bg:#e4eff8;--code-bg:#eceff4}
@media (prefers-color-scheme:dark){:root{--bg:#0f1217;--surface:#171b22;--fg:#e8ebf0;--muted:#a9b3c3;--line:#3a4250;--accent:#8ab4ff;--bad-fg:#ffb3ab;--bad-bg:#3d1a18;--warn-fg:#f7d488;--warn-bg:#33270a;--warn-bg2:#40310c;--info-fg:#a9d2f5;--info-bg:#132a3d;--code-bg:#232833}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;overflow-wrap:anywhere}
.skip{position:absolute;left:-9999px}
.skip:focus{left:8px;top:8px;background:var(--surface);color:var(--fg);padding:8px;border:2px solid var(--accent);z-index:2}
main{max-width:72rem;margin:0 auto;padding:16px 16px 48px}
h1{font-size:1.6rem;margin:.2rem 0 .3rem}
h2{font-size:1.2rem;margin:2rem 0 .6rem;border-bottom:1px solid var(--line);padding-bottom:.25rem}
p{margin:.4rem 0}
code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.88em;overflow-wrap:anywhere;word-break:break-word}
code{background:var(--code-bg);padding:.05rem .3rem;border-radius:4px}
.muted{color:var(--muted)}
.verdict{margin:1rem 0;padding:16px;border-radius:8px;border:4px solid var(--line);background:var(--surface)}
.verdict .label{display:block;font-size:1.5rem;font-weight:800;letter-spacing:.02em}
.verdict .headline{display:block;font-size:1.1rem;font-weight:700;margin-top:.15rem}
.verdict p{margin:.5rem 0 0}
.verdict-affected{border-style:solid;border-color:var(--bad-fg);background:var(--bad-bg);color:var(--bad-fg)}
.verdict-incomplete{border-style:dashed;border-color:var(--warn-fg);color:var(--warn-fg);background:repeating-linear-gradient(135deg,var(--warn-bg),var(--warn-bg) 12px,var(--warn-bg2) 12px,var(--warn-bg2) 24px)}
.verdict-noknown{border-style:dotted;border-width:3px;border-color:var(--info-fg);background:var(--info-bg);color:var(--info-fg)}
.verdict-pending{border-style:solid;border-width:2px}
.verdict-failed{border-style:double;border-color:var(--bad-fg);background:var(--bad-bg);color:var(--bad-fg)}
.verdict-stale{border-style:dashed;border-width:4px;border-color:var(--bad-fg);background:var(--warn-bg);color:var(--bad-fg)}
dl.facts{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:.25rem 1rem;margin:.5rem 0}
dl.facts dt{color:var(--muted)}
dl.facts dd{margin:0;overflow-wrap:anywhere}
.notice{border-left:4px solid var(--accent);padding:.4rem .8rem;background:var(--surface)}
ul.limits,ul.plain{padding-left:1.2rem;margin:.3rem 0}
table{width:100%;border-collapse:collapse;background:var(--surface);border:1px solid var(--line)}
th,td{text-align:left;padding:.5rem .6rem;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:.8rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
ol.path{margin:0;padding-left:1.4rem}
ol.path li{margin:.1rem 0}
.hop{color:var(--muted);font-size:.85em}
.sev{display:inline-block;padding:0 .5rem;border-radius:999px;font-weight:700;font-size:.8rem;border:2px solid var(--line)}
.sev-high{color:var(--bad-fg);background:var(--bad-bg);border-color:var(--bad-fg)}
.sev-medium{color:var(--warn-fg);background:var(--warn-bg);border-color:var(--warn-fg);border-style:dashed}
.empty{padding:1rem;border:1px dashed var(--line);background:var(--surface)}
footer{margin-top:2rem;color:var(--muted);font-size:.9rem}
@media (min-width:40.01em){
table.stack th,table.stack td{overflow-wrap:normal}
table.stack th{white-space:nowrap}
table.stack td:nth-child(3){min-width:10rem}
}
@media (max-width:40em){
table.stack thead{display:block;position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
table.stack,table.stack tbody,table.stack tr,table.stack td{display:block;width:100%}
table.stack tr{border-bottom:2px solid var(--line);padding:.3rem 0}
table.stack td{border-bottom:0;padding:.25rem .6rem}
table.stack td::before{content:attr(data-label);display:block;font-size:.75rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
dl.facts{grid-template-columns:minmax(0,1fr)}
dl.facts dd{margin-bottom:.4rem}
}
@media print{
:root{color-scheme:light}
body{background:#fff;color:#000;font-size:11pt}
main{max-width:none;padding:0}
.verdict,.verdict-affected,.verdict-incomplete,.verdict-noknown,.verdict-pending,.verdict-failed,.verdict-stale{background:#fff;color:#000;border-color:#000;-webkit-print-color-adjust:exact;print-color-adjust:exact}
table,th,td{background:#fff;color:#000;border-color:#000}
tr{break-inside:avoid}
h2{break-after:avoid}
.muted,.hop,th,footer{color:#000}
.skip{display:none}
}
`.trim();

const CSS_HASH = `sha256-${createHash("sha256").update(REPORT_CSS).digest("base64")}`;
const CSP = `default-src 'none'; style-src '${CSS_HASH}'; base-uri 'none'; form-action 'none'`;

type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Rec) : {});
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const num = (value: unknown): string => (typeof value === "number" && Number.isFinite(value) ? String(value) : "unknown");
/**
 * Identifier cells (node ids, consumers, owners, path nodes, check keys): escaped, and redacted only at the strength
 * the manifest validator applied at import, so an accepted id is printed as it was imported and two different ids
 * never collapse into one display (MANIFEST.md, "Identifiers are never rewritten"). Explanations use `txt`.
 */
const safeReportText = (value: unknown): string => escapeHtml(redactIdentifier(value === null || value === undefined ? "" : String(value)));
/** Redacted (log strength), escaped text; `fallback` (already safe) stands in for a missing value. */
const txt = (value: unknown, fallback = "not recorded"): string => (value === null || value === undefined || value === "" ? fallback : logText(value));

/** A finished run assessed by an older decision engine: everything the report says about it is history, not a current answer. */
const isStale = (report: RunReport): boolean => report.run.status === "complete" && report.run.engine?.rerun_required === true;
/** Prefix for a statement that an older engine made and this build has not checked. */
const OLD = "As assessed by the older engine: ";

function verdictBlock(report: RunReport): string {
  const run = report.run;
  if (run.status === "failed") {
    const detail = run.error ? ` Error <code>${escapeHtml(run.error.code)}</code>: ${logText(run.error.detail)}` : "";
    return `<section class="verdict verdict-failed" aria-labelledby="verdict-label" data-verdict="FAILED"><span class="label" id="verdict-label">${FAILED_TEXT.label}</span><span class="headline">${FAILED_TEXT.headline}</span><p>${FAILED_TEXT.explanation}${detail}</p></section>`;
  }
  // A run assessed by an older decision engine never shows a verdict block that could be read as current: its recorded
  // verdict (possibly a wrong NO_KNOWN_IMPACT) is named only as something not to rely on.
  if (run.status === "complete" && run.engine?.rerun_required) {
    return `<section class="verdict verdict-stale" aria-labelledby="verdict-label" data-verdict="STALE_ENGINE"><span class="label" id="verdict-label">RE-RUN REQUIRED</span><span class="headline">Assessed by an older decision engine</span><p>${txt(run.engine.note, "This run was assessed by an older decision engine: request a new run.")}</p><p>Recorded verdict, do not rely on it: <code>${escapeHtml(run.recorded_assessment ?? "none")}</code>. Every count, coverage statement and list below is what that older engine recorded.</p></section>`;
  }
  const verdict: Verdict | null = isVerdict(run.assessment) ? run.assessment : null;
  if (run.status !== "complete" || verdict === null) {
    return `<section class="verdict verdict-pending" aria-labelledby="verdict-label" data-verdict="PENDING"><span class="label" id="verdict-label">${PENDING_TEXT.label}</span><span class="headline">${PENDING_TEXT.headline}</span><p>${PENDING_TEXT.explanation} Status: ${escapeHtml(run.status)}.</p></section>`;
  }
  const text = VERDICT_TEXT[verdict];
  const cls = verdict === "AFFECTED" ? "verdict-affected" : verdict === "INCOMPLETE" ? "verdict-incomplete" : "verdict-noknown";
  const summary = rec(report.summary);
  const extra =
    verdict === "INCOMPLETE" && summary.known_impact === true
      ? `<p><strong>Known impact was also found:</strong> ${num(summary.findings)} consumer${summary.findings === 1 ? "" : "s"} listed below can break. Incomplete never cancels a known break.</p>`
      : "";
  return `<section class="verdict ${cls}" aria-labelledby="verdict-label" data-verdict="${verdict}"><span class="label" id="verdict-label">${text.label}</span><span class="headline">${text.headline}</span><p>${text.explanation}</p>${extra}</section>`;
}

function facts(report: RunReport): string {
  const { run, snapshot } = report;
  const s = rec(report.summary);
  const rows: [string, string][] = [
    ["Run", `<code>${escapeHtml(run.id)}</code>`],
    ["Run status", `${escapeHtml(run.status)} <span class="muted">(describes computation, not safety)</span>`],
    ["Baseline snapshot", `${txt(snapshot.revision)} <code>${escapeHtml(snapshot.id)}</code>`],
    ["Baseline hash", `<code>${escapeHtml(run.baseline_hash)}</code>`],
    ["Proposed hash", `<code>${escapeHtml(run.proposed_hash)}</code>`],
    ["Baseline version", escapeHtml(run.baseline_version)],
    ["Created", `${escapeHtml(run.created_at)}`],
    ["Finished", txt(run.finished_at, "not finished")],
    [isStale(report) ? "Changes detected (older engine)" : "Changes detected", num(s.changes)],
    [isStale(report) ? "Findings (older engine)" : "Findings", `${num(s.findings)} (${num(s.direct_findings)} direct, ${num(s.transitive_findings)} transitive)`],
    [isStale(report) ? "Unknowns (older engine)" : "Unknowns", num(s.unknowns)],
    ["Report hash", `<code>${escapeHtml(report.report_hash)}</code>`],
  ];
  if (run.allow_superseded) rows.splice(6, 0, ["Note", "Assessed against a snapshot that was no longer the workspace baseline, on explicit request."]);
  return `<dl class="facts">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>`;
}

function coverage(report: RunReport): string {
  const c = rec(report.coverage);
  const limits = arr(c.limits).map(rec);
  const known = arr(c.known);
  if (report.coverage === null) return `<section aria-labelledby="coverage-h"><h2 id="coverage-h">Coverage limits</h2><p class="empty">No coverage statement is available because the run has no assessment. Nothing can be concluded from it.</p></section>`;
  const limitItems = limits
    .map((l) => {
      const ids = arr(l.node_ids).length > 0 ? ` <span class="hop">Nodes: ${arr(l.node_ids).map((n) => `<code>${safeReportText(n)}</code>`).join(", ")}</span>` : "";
      return `<li><code>${txt(l.code)}</code> ${isStale(report) ? OLD : ""}${txt(l.message)}${ids}</li>`;
    })
    .join("");
  const knownItems = known.map((k) => `<li>${isStale(report) ? OLD : ""}${txt(k)}</li>`).join("");
  return `<section aria-labelledby="coverage-h"><h2 id="coverage-h">Coverage limits${isStale(report) ? " (as recorded by the older engine)" : ""}</h2>
<p class="notice">Scope: <code>${txt(c.scope)}</code>. ChangeRadar reasons only about dependencies declared in the imported manifests and never infers that an undeclared dependency does not exist.</p>
<h3>What could not be known</h3><ul class="limits">${limitItems || "<li>No limits were recorded.</li>"}</ul>
<h3>What was known</h3><ul class="plain">${knownItems || "<li>Nothing was recorded.</li>"}</ul>
<p class="muted">${isStale(report) ? OLD : ""}Examined ${num(c.nodes_examined)} nodes and ${num(c.edges_examined)} edges; ${num(c.consumers_found)} consumers found.</p></section>`;
}

function unknowns(report: RunReport): string {
  const list = report.unknowns.map(rec);
  if (list.length === 0) {
    // An older engine's empty list is history, not a current statement (see the stale block at the top of the report).
    return isStale(report)
      ? `<section aria-labelledby="unknowns-h"><h2 id="unknowns-h">Unknowns as recorded by the older engine (0)</h2><p class="empty">${OLD}no unknowns were recorded for this run.</p></section>`
      : `<section aria-labelledby="unknowns-h"><h2 id="unknowns-h">Unknowns (0)</h2><p class="empty">No unknowns were recorded for this run.</p></section>`;
  }
  const rows = list
    .map((u) => {
      const edge = rec(u.edge);
      const where = u.node_id ? `<code>${safeReportText(u.node_id)}</code>` : edge.source_id ? `<code>${safeReportText(edge.source_id)}</code> ${txt(edge.relation)} <code>${safeReportText(edge.target_id)}</code>` : "not specific to one node";
      const help = typeof u.code === "string" && UNKNOWN_CODE_HELP[u.code] ? `<br><span class="hop">${escapeHtml(UNKNOWN_CODE_HELP[u.code])}</span>` : "";
      return `<tr data-unknown-id="${escapeHtml(u.id)}"><td data-label="Unknown ID"><code>${escapeHtml(u.id)}</code></td><td data-label="Code"><code>${txt(u.code)}</code></td><td data-label="Where">${where}</td><td data-label="Explanation">${txt(u.message)}${help}</td></tr>`;
    })
    .join("");
  return `<section aria-labelledby="unknowns-h"><h2 id="unknowns-h">Unknowns${isStale(report) ? " as recorded by the older engine" : ""} (${list.length})</h2>
<p class="notice">Every unknown forces INCOMPLETE. An unknown is never treated as safe.</p>
<table class="stack"><thead><tr><th>Unknown ID</th><th>Code</th><th>Where</th><th>Explanation</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

function pathCell(f: RunReport["findings"][number]): string {
  const hops = arr(f.hops).map(rec);
  const items = f.path.map((node, index) => {
    const hop = hops[index - 1];
    const previous = hops[index - 2];
    // A very long path keeps only its first and last hops; say where the middle was left out.
    const gap = hop && previous && hop.from !== previous.to ? `<span class="hop">… ${num((f as { path_omitted_hops?: number }).path_omitted_hops)} hops not shown …</span> ` : "";
    const via = hop ? ` <span class="hop">${txt(hop.relation)} via ${txt(hop.source_file)}:${num(hop.source_line)}</span>` : "";
    return `<li>${gap}<code>${safeReportText(node)}</code>${via}</li>`;
  });
  return `<ol class="path">${items.join("")}</ol>`;
}

function findings(report: RunReport): string {
  const list = report.findings;
  let body: string;
  const stale = isStale(report);
  if (list.length === 0) {
    const verdict = report.run.assessment;
    body =
      report.run.status !== "complete"
        ? `<p class="empty">No findings are available because the run has no assessment.</p>`
        : stale
          ? `<p class="empty">${OLD}no consumer was listed. That is not a current answer: this run must be re-run before anything is concluded from it.</p>`
          : verdict === "INCOMPLETE"
          ? `<p class="empty">No consumer is listed, but this run is INCOMPLETE: that does not mean nothing is affected. See the unknowns.</p>`
          : `<p class="empty">No declared consumer is affected by the detected changes (within the coverage limits above).</p>`;
  } else {
    const rows = list
      .map(
        (f) =>
          `<tr id="finding-${escapeHtml(f.id)}" data-finding-id="${escapeHtml(f.id)}"><td data-label="Finding ID"><code>${escapeHtml(f.id)}</code></td><td data-label="Severity"><span class="sev sev-${f.severity === "high" ? "high" : "medium"}">${f.severity === "high" ? "HIGH (direct)" : "MEDIUM (transitive)"}</span></td><td data-label="Consumer"><code>${safeReportText(f.consumer_id)}</code><br><span class="hop">${txt(f.consumer_kind)}</span></td><td data-label="Owner">${f.consumer_owner ? safeReportText(f.consumer_owner) : "<strong>owner unknown</strong>"}</td><td data-label="Depth">${num(f.depth)}</td><td data-label="Path from changed item to consumer">${pathCell(f)}</td><td data-label="Reason">${txt(f.reason)}</td></tr>`,
      )
      .join("");
    body = `<table class="stack"><thead><tr><th>Finding ID</th><th>Severity</th><th>Consumer</th><th>Owner</th><th>Depth</th><th>Path (source to consumer)</th><th>Reason</th></tr></thead><tbody>${rows}</tbody></table>`;
  }
  const heading = stale ? `Affected consumers as listed by the older engine (${list.length})` : `Affected consumers (${list.length})`;
  return `<section aria-labelledby="findings"><h2 id="findings">${heading}</h2>${stale && list.length > 0 ? `<p class="notice">${OLD}the list below is history; re-run before relying on it.</p>` : ""}${body}</section>`;
}

function cycles(report: RunReport): string {
  const list = arr(report.cycles).map(rec);
  if (list.length === 0) return "";
  const items = list.map((c) => `<li><code>${escapeHtml(c.id)}</code>: ${arr(c.members).map((m) => `<code>${safeReportText(m)}</code>`).join(", ")}</li>`).join("");
  return `<section aria-labelledby="cycles-h"><h2 id="cycles-h">Dependency cycles (${list.length})</h2><p class="notice">Cycles are reported once and never traversed twice.</p><ul class="plain">${items}</ul></section>`;
}

function changes(report: RunReport): string {
  const list = arr(report.changes).map(rec);
  if (list.length === 0) return "";
  const rows = list
    .map(
      (c) =>
        `<tr><td data-label="Change ID"><code>${escapeHtml(c.id)}</code></td><td data-label="Kind"><code>${txt(c.kind)}</code></td><td data-label="Node"><code>${safeReportText(c.node_id)}</code></td><td data-label="Effect">${txt(c.propagation)}</td><td data-label="Description">${txt(c.description)}</td></tr>`,
    )
    .join("");
  return `<section aria-labelledby="changes-h"><h2 id="changes-h">Detected changes${isStale(report) ? " as recorded by the older engine" : ""} (${list.length})</h2><table class="stack"><thead><tr><th>Change ID</th><th>Kind</th><th>Node</th><th>Effect</th><th>Description</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

function checks(report: RunReport): string {
  if (report.checks.length === 0) return "";
  const rows = report.checks
    .map(
      (c) =>
        `<tr><td data-label="Check"><code>${safeReportText(c.check_key)}</code></td><td data-label="Node"><code>${safeReportText(c.node_id)}</code></td><td data-label="State"><strong>${escapeHtml(c.state)}</strong></td><td data-label="Attempts">${num(c.attempts)}</td><td data-label="Detail">${txt(c.detail, "none")}<br><span class="hop">${escapeHtml(CHECK_STATE_NOTE[c.state] ?? "")}</span></td></tr>`,
    )
    .join("");
  return `<section aria-labelledby="checks-h"><h2 id="checks-h">Live contract checks (${report.checks.length})</h2><p class="notice">Read-only checks. Anything other than PASSED is an unknown and forces INCOMPLETE.</p><table class="stack"><thead><tr><th>Check</th><th>Node</th><th>State</th><th>Attempts</th><th>Detail</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

/** Render the report for one impact run. Pure and deterministic: same input, same bytes. */
export function renderReportHtml(report: RunReport): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<title>ChangeRadar impact report ${escapeHtml(report.run.id)}</title>
<style>${REPORT_CSS}</style>
</head>
<body>
<a class="skip" href="#findings">Skip to affected consumers</a>
<main>
<header>
<h1>Impact report</h1>
<p class="muted">ChangeRadar assessment of a proposed manifest change against the imported baseline.</p>
</header>
${verdictBlock(report)}
${facts(report)}
${coverage(report)}
${unknowns(report)}
${findings(report)}
${cycles(report)}
${changes(report)}
${checks(report)}
<footer>
<p>${escapeHtml(REDACTION_NOTE)}</p>
<p>Format <code>${escapeHtml(report.format)}</code> version ${escapeHtml(report.schema_version)}. This document has no generation time; identical input gives identical output.</p>
</footer>
</main>
</body>
</html>
`;
}

export const htmlReportRenderer: ReportRenderer = { render: renderReportHtml };

/** Exposed for tests: the exact policy carried by the document. */
export const REPORT_CSP = CSP;
export const REPORT_STYLE = REPORT_CSS;
