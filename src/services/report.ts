import { hashCanonical } from "../domain/canonical.js";
import { escapeHtml, redactDeep, safeReportText } from "../domain/redaction.js";
import type { Ctx } from "../platform/context.js";
import { notFound } from "../platform/errors.js";
import { isUuid } from "../platform/ids.js";
import { type Principal, requireRole } from "./auth.js";
import { type CheckResultView, type FindingView, type ImpactRunView, type RunEngine, apiStatus, currentAssessment, engineOf, loadChecks, recordedAssessment } from "./impact.js";

export const REPORT_SCHEMA_VERSION = 1;
export const REPORT_FORMAT = "changeradar-run-report";

/**
 * The single, redacted document behind every export of one impact run. The JSON export is this object; an
 * HTML renderer receives exactly this object, so both carry the same finding ids (`findings[].id`, content
 * derived, never minted per export) and the same `report_hash`.
 */
export interface RunReport {
  schema_version: 1;
  format: typeof REPORT_FORMAT;
  run: {
    id: string;
    snapshot_id: string;
    status: ImpactRunView["status"];
    /** Null while unfinished and for a run assessed by an older engine (its old verdict is `recorded_assessment`). */
    assessment: ImpactRunView["assessment"];
    /** The verdict an older engine recorded, only when `engine.rerun_required`; history, never a current answer. */
    recorded_assessment: ImpactRunView["recorded_assessment"];
    baseline_hash: string;
    proposed_hash: string;
    baseline_version: number;
    allow_superseded: boolean;
    created_at: string;
    started_at: string | null;
    finished_at: string | null;
    error: { code: string; detail: string } | null;
    /** Which decision engine assessed the run; `rerun_required` when it was an older one. */
    engine: RunEngine;
  };
  snapshot: { id: string; revision: string; hash: string; imported_at: string };
  summary: unknown;
  coverage: unknown;
  cycles: unknown;
  changes: unknown;
  findings: FindingView[];
  unknowns: unknown[];
  checks: CheckResultView[];
  /** sha256 over the canonical JSON of every other member. */
  report_hash: string;
}

/**
 * Contract for the HTML report (implemented in src/report/html-report.ts). It must
 * return one complete, standalone HTML document, must escape every dynamic value (see `escapeHtml`), and must
 * print each `findings[].id` verbatim. A built-in safe renderer is used until a template is registered.
 */
export interface ReportRenderer {
  render(report: RunReport): string;
}

interface RunReportRow {
  id: string;
  snapshot_id: string;
  status: "QUEUED" | "RUNNING" | "COMPLETE" | "FAILED";
  verdict: RunReport["run"]["assessment"];
  baseline_hash: string;
  proposed_hash: string;
  baseline_version: number;
  allow_superseded: boolean;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  error_code: string | null;
  error_detail: string | null;
  assessment: Record<string, unknown> | null;
  unknowns: unknown[];
  revision: string;
  snapshot_hash: string;
  imported_at: Date;
}

/** Assemble the redacted report for a run in the caller's workspace (404 otherwise). */
export async function buildRunReport(ctx: Ctx, principal: Principal, runId: string): Promise<RunReport> {
  requireRole(principal, "viewer");
  if (!isUuid(runId)) throw notFound();
  const found = await ctx.db.query<RunReportRow>(
    `SELECT r.id, r.snapshot_id, r.status, r.verdict, r.baseline_hash, r.proposed_hash, r.baseline_version, r.allow_superseded, r.created_at, r.started_at, r.finished_at,
            r.error_code, r.error_detail, r.assessment, r.unknowns, s.revision, s.manifest_hash AS snapshot_hash, s.imported_at
       FROM impact_runs r JOIN snapshots s ON s.workspace_id = r.workspace_id AND s.id = r.snapshot_id
      WHERE r.workspace_id = $1 AND r.id = $2`,
    [principal.workspaceId, runId],
  );
  const row = found.rows[0];
  if (!row) throw notFound();
  const findings = await ctx.db.query<{
    finding_key: string;
    origin_id: string;
    consumer_id: string;
    consumer_kind: string;
    consumer_owner: string | null;
    severity: "high" | "medium";
    direct: boolean;
    depth: number;
    path: string[];
    hops: unknown[];
    path_omitted_hops: number;
    change_ids: string[];
    change_ids_omitted: number;
    reason: string;
  }>(
    `SELECT finding_key, origin_id, consumer_id, consumer_kind, consumer_owner, severity, direct, depth, path, hops, path_omitted_hops, change_ids, change_ids_omitted, reason
       FROM findings WHERE workspace_id = $1 AND run_id = $2 ORDER BY position`,
    [principal.workspaceId, runId],
  );
  const detail = row.assessment ?? {};
  const engine = engineOf(row.assessment, row.status === "COMPLETE");
  const body = {
    schema_version: REPORT_SCHEMA_VERSION,
    format: REPORT_FORMAT,
    run: {
      id: row.id,
      snapshot_id: row.snapshot_id,
      status: apiStatus(row.status),
      assessment: currentAssessment(row.verdict, engine) as RunReport["run"]["assessment"],
      recorded_assessment: recordedAssessment(row.verdict, engine) as RunReport["run"]["recorded_assessment"],
      baseline_hash: row.baseline_hash,
      proposed_hash: row.proposed_hash,
      baseline_version: row.baseline_version,
      allow_superseded: row.allow_superseded,
      created_at: row.created_at.toISOString(),
      started_at: row.started_at ? row.started_at.toISOString() : null,
      finished_at: row.finished_at ? row.finished_at.toISOString() : null,
      error: row.error_code ? { code: row.error_code, detail: row.error_detail ?? "" } : null,
      engine,
    },
    snapshot: { id: row.snapshot_id, revision: row.revision, hash: row.snapshot_hash, imported_at: row.imported_at.toISOString() },
    summary: detail.summary ?? null,
    coverage: detail.coverage ?? null,
    cycles: detail.cycles ?? [],
    changes: detail.changes ?? [],
    findings: findings.rows.map((f) => ({
      id: f.finding_key,
      origin_id: f.origin_id,
      consumer_id: f.consumer_id,
      consumer_kind: f.consumer_kind,
      consumer_owner: f.consumer_owner,
      severity: f.severity,
      direct: f.direct,
      depth: f.depth,
      path: f.path,
      hops: f.hops,
      ...(f.path_omitted_hops > 0 ? { path_omitted_hops: f.path_omitted_hops } : {}),
      change_ids: f.change_ids,
      ...(f.change_ids_omitted > 0 ? { change_ids_omitted: f.change_ids_omitted } : {}),
      reason: f.reason,
    })),
    unknowns: Array.isArray(row.unknowns) ? row.unknowns : [],
    checks: await loadChecks(ctx.db, principal.workspaceId, runId),
  };
  // Redaction is applied to everything that leaves the process, then the hash covers the redacted form.
  const redacted = redactDeep(body) as Omit<RunReport, "report_hash">;
  return { ...redacted, report_hash: hashCanonical(redacted) };
}

const td = (value: unknown): string => `<td>${safeReportText(value)}</td>`;

/** Minimal built-in renderer: escaped, standalone, no script, no external resources. */
export const defaultReportRenderer: ReportRenderer = {
  render(report) {
    const rows = report.findings
      .map(
        (f) =>
          `<tr data-finding-id="${escapeHtml(f.id)}">${td(f.id)}${td(f.severity)}${td(f.consumer_id)}${td(f.consumer_owner ?? "unknown owner")}${td(f.path.join(" -> ") + (f.path_omitted_hops ? ` (${f.path_omitted_hops} hops omitted from the middle)` : ""))}${td(f.reason)}</tr>`,
      )
      .join("");
    const unknowns = (report.unknowns as { id?: unknown; code?: unknown; message?: unknown }[])
      .map((u) => `<li>${safeReportText(u.code)} ${safeReportText(u.id)}: ${safeReportText(u.message)}</li>`)
      .join("");
    const checks = report.checks.map((c) => `<li>${safeReportText(c.check_key)}: ${safeReportText(c.state)}${c.detail ? ` (${safeReportText(c.detail)})` : ""}</li>`).join("");
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>ChangeRadar impact report ${escapeHtml(report.run.id)}</title></head>
<body>
<h1>Impact report</h1>
<p>Run ${escapeHtml(report.run.id)}: status ${escapeHtml(report.run.status)}, assessment ${escapeHtml(report.run.assessment ?? (report.run.engine.rerun_required ? "withheld (older decision engine, re-run required)" : "not yet available"))}.
Complete describes computation only; it is not a safety verdict.</p>${report.run.engine.rerun_required ? `\n<p><strong>${escapeHtml(report.run.engine.note ?? "assessed by an older decision engine: re-run required")}</strong></p>` : ""}
<p>Baseline ${escapeHtml(report.run.baseline_hash)} (${escapeHtml(report.snapshot.revision)}), proposed ${escapeHtml(report.run.proposed_hash)}. Report hash ${escapeHtml(report.report_hash)}.</p>
<h2>Affected consumers (${report.findings.length})</h2>
<table><thead><tr><th>Finding</th><th>Severity</th><th>Consumer</th><th>Owner</th><th>Path</th><th>Reason</th></tr></thead><tbody>${rows}</tbody></table>
<h2>Unknowns (${report.unknowns.length})</h2><ul>${unknowns}</ul>
<h2>Live contract checks (${report.checks.length})</h2><ul>${checks}</ul>
</body></html>
`;
  },
};

export async function renderRunReportHtml(ctx: Ctx, principal: Principal, runId: string): Promise<{ report: RunReport; html: string }> {
  const report = await buildRunReport(ctx, principal, runId);
  return { report, html: (ctx.reportRenderer ?? defaultReportRenderer).render(report) };
}
