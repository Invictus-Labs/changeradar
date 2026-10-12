import { type ReactNode, useEffect, useState } from "react";
import { FAILED_TEXT, isVerdict, PENDING_TEXT, RUN_ERROR_HELP, UNKNOWN_CODE_HELP, VERDICT_TEXT, type Verdict } from "../report/wording";
import { ApiError, exportUrl, bundleUrl, type Role, canImport } from "./api";
import type { Loadable, PagedState } from "./hooks";
import { toApiError } from "./hooks";
import type { Coverage, RunDetail, Unknown } from "./types";

// ---- status and verdict badges ----

const STATUS_TONE: Record<string, string> = { queued: "muted", running: "muted", complete: "neutral", failed: "bad" };

/** Run status. `complete` is a neutral badge on purpose: it describes computation, never safety. */
export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`badge badge-${STATUS_TONE[status] ?? "muted"}`} data-status={status}>
      {status}
    </span>
  );
}

const VERDICT_GLYPH: Record<Verdict, string> = { AFFECTED: "▲", INCOMPLETE: "◇", NO_KNOWN_IMPACT: "○" };
const VERDICT_CLASS: Record<Verdict, string> = { AFFECTED: "affected", INCOMPLETE: "incomplete", NO_KNOWN_IMPACT: "noknown" };

/** Verdict as a compact badge: glyph, wording and border style differ per verdict, never colour alone. */
export function VerdictBadge({ value }: { value: string | null }) {
  if (!isVerdict(value)) return <span className="muted">—</span>;
  return (
    <span className={`badge badge-verdict badge-${VERDICT_CLASS[value]}`} data-verdict={value}>
      <span aria-hidden="true">{VERDICT_GLYPH[value]} </span>
      {VERDICT_TEXT[value].label}
    </span>
  );
}

export function RoleBadge({ role }: { role: Role }) {
  return <span className="badge badge-muted" data-role={role}>{role}</span>;
}

/** The verdict block at the top of a run: three distinct treatments, plus pending and failed. */
export function VerdictBanner({ run }: { run: RunDetail }) {
  if (run.status === "failed") {
    const help = run.error ? (RUN_ERROR_HELP[run.error.code] ?? "") : "";
    return (
      <section className="verdict verdict-failed" data-verdict="FAILED" aria-labelledby="verdict-label">
        <span className="verdict-label" id="verdict-label">{FAILED_TEXT.label}</span>
        <span className="verdict-headline">{FAILED_TEXT.headline}</span>
        <p>{FAILED_TEXT.explanation}</p>
        {run.error && (
          <p>
            Error <code>{run.error.code}</code>. {help} {run.error.detail}
          </p>
        )}
      </section>
    );
  }
  // A run assessed by an older decision engine has no current verdict: the banner says so and names the recorded verdict only
  // as history, so an old NO_KNOWN_IMPACT can never be read as a safe answer.
  if (run.status === "complete" && run.engine?.rerun_required) {
    return (
      <section className="verdict verdict-stale" data-verdict="STALE_ENGINE" aria-labelledby="verdict-label" role="alert">
        <span className="verdict-label" id="verdict-label">RE-RUN REQUIRED</span>
        <span className="verdict-headline">Assessed by an older decision engine</span>
        <p>
          The recorded verdict is history and does not describe today's rules: <code>{run.recorded_assessment ?? "none"}</code>. Request a new run before relying on
          anything on this page.
        </p>
      </section>
    );
  }
  if (run.status !== "complete" || !isVerdict(run.assessment)) {
    return (
      <section className="verdict verdict-pending" data-verdict="PENDING" aria-labelledby="verdict-label" role="status">
        <span className="verdict-label" id="verdict-label">{PENDING_TEXT.label}</span>
        <span className="verdict-headline">{PENDING_TEXT.headline}</span>
        <p>
          {PENDING_TEXT.explanation} Status: {run.status}.
        </p>
      </section>
    );
  }
  const verdict = run.assessment;
  const text = VERDICT_TEXT[verdict];
  return (
    <section className={`verdict verdict-${VERDICT_CLASS[verdict]}`} data-verdict={verdict} aria-labelledby="verdict-label">
      <span className="verdict-label" id="verdict-label">
        <span aria-hidden="true">{VERDICT_GLYPH[verdict]} </span>
        {text.label}
      </span>
      <span className="verdict-headline">{text.headline}</span>
      <p>{text.explanation}</p>
      {verdict === "INCOMPLETE" && run.summary?.known_impact && (
        <p>
          <strong>Known impact was also found:</strong> {run.summary.findings} consumer{run.summary.findings === 1 ? "" : "s"} can break. Incomplete never
          cancels a known break.
        </p>
      )}
    </section>
  );
}

// ---- coverage and unknowns: always visible, never collapsed ----

/**
 * Prefix for a statement that an older decision engine recorded and this build has not checked (the HTML export says the same).
 * A run assessed by an older engine has no current answer, so its coverage statements, counts and lists are shown as history.
 */
export const OLDER_ENGINE = "As assessed by the older engine: ";

export function CoverageLimits({ coverage, stale = false }: { coverage: Coverage | null; stale?: boolean }) {
  const old = stale ? OLDER_ENGINE : "";
  if (!coverage) {
    return (
      <section aria-labelledby="coverage-h" data-testid="coverage">
        <h2 id="coverage-h">Coverage limits</h2>
        <p className="empty-inline">No coverage statement exists because the run has no assessment. Nothing can be concluded from it.</p>
      </section>
    );
  }
  return (
    <section aria-labelledby="coverage-h" data-testid="coverage">
      <h2 id="coverage-h">Coverage limits{stale ? " (as recorded by the older engine)" : ""}</h2>
      <p className="note">
        Scope: <code>{coverage.scope}</code>. ChangeRadar reasons only about dependencies declared in the imported manifests and never infers that an
        undeclared dependency does not exist.
      </p>
      <h3>What could not be known</h3>
      <ul className="limits">
        {coverage.limits.length === 0 && <li>{old}No limits were recorded.</li>}
        {coverage.limits.map((limit) => (
          <li key={limit.code}>
            <code>{limit.code}</code> {old}{limit.message}
            {limit.node_ids && limit.node_ids.length > 0 && (
              <span className="hop"> Nodes: {limit.node_ids.map((id) => <code key={id}>{id} </code>)}</span>
            )}
          </li>
        ))}
      </ul>
      <h3>What was known</h3>
      <ul className="plain">
        {coverage.known.length === 0 && <li>{old}Nothing was recorded.</li>}
        {coverage.known.map((line) => (
          <li key={line}>{old}{line}</li>
        ))}
      </ul>
      <p className="muted">
        {old}Examined {coverage.nodes_examined ?? "unknown"} nodes and {coverage.edges_examined ?? "unknown"} edges; {coverage.consumers_found ?? "unknown"} consumers found.
      </p>
    </section>
  );
}

export function UnknownsTable({ unknowns, total, stale = false }: { unknowns: Unknown[]; total: number; stale?: boolean }) {
  return (
    <section aria-labelledby="unknowns-h" data-testid="unknowns">
      <h2 id="unknowns-h">Unknowns{stale ? " as recorded by the older engine" : ""} ({total})</h2>
      {unknowns.length === 0 ? (
        <p className="empty-inline">{stale ? `${OLDER_ENGINE}no unknowns were recorded for this run.` : "No unknowns were recorded for this run."}</p>
      ) : (
        <>
          <p className="note">Every unknown forces INCOMPLETE. An unknown is never treated as safe.</p>
          <div className="table-wrap">
            <table className="table stack">
              <thead>
                <tr>
                  <th>Unknown ID</th>
                  <th>Code</th>
                  <th>Where</th>
                  <th>Explanation</th>
                </tr>
              </thead>
              <tbody>
                {unknowns.map((u) => (
                  <tr key={u.id} data-unknown-id={u.id}>
                    <td data-label="Unknown ID"><code>{u.id}</code></td>
                    <td data-label="Code"><code>{u.code}</code></td>
                    <td data-label="Where">
                      {u.node_id ? (
                        <code>{u.node_id}</code>
                      ) : u.edge ? (
                        <>
                          <code>{u.edge.source_id}</code> {u.edge.relation} <code>{u.edge.target_id}</code>
                        </>
                      ) : (
                        "not specific to one node"
                      )}
                    </td>
                    <td data-label="Explanation">
                      {u.message}
                      {UNKNOWN_CODE_HELP[u.code] && <div className="hop">{UNKNOWN_CODE_HELP[u.code]}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {total > unknowns.length && (
            <p className="muted">
              Showing the first {unknowns.length} of {total} unknowns. The JSON export lists all of them.
            </p>
          )}
        </>
      )}
    </section>
  );
}

// ---- export controls ----

/** Evidence export. JSON and HTML reports are redacted and open to every role; the raw bundle is operator and admin only. */
export function ExportControls({ runId, role, finished }: { runId: string; role: Role; finished: boolean }) {
  return (
    <section aria-labelledby="export-h" data-testid="export-controls">
      <h2 id="export-h">Evidence export</h2>
      {!finished && <p className="muted">Exports describe the finished run; the verdict is not available yet.</p>}
      <p className="actions">
        <a className="button" href={exportUrl(runId, "json")} download={`changeradar-run-${runId}.json`}>
          Download JSON report
        </a>
        <a className="button" href={exportUrl(runId, "html")} target="_blank" rel="noopener noreferrer">
          Open HTML report
        </a>
        {canImport(role) && (
          <a className="button button-secondary" href={bundleUrl(runId)} download={`changeradar-run-${runId}-bundle.json`}>
            Download evidence bundle
          </a>
        )}
      </p>
      <p className="muted">
        The JSON and HTML reports are redacted and list the same finding IDs.
        {role === "viewer" ? " Your role reads redacted reports only." : " The evidence bundle restores into a clean installation with matching hashes."}
      </p>
    </section>
  );
}

// ---- states: loading, empty, denied, failed ----

export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <p className="state-note" role="status" data-state="loading">
      {label}…
    </p>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty" data-state="empty">
      <h3>{title}</h3>
      {children}
    </div>
  );
}

/** Render a Loadable: loading, failed (with retry) or the data. */
export function LoadState<T>({ state, onRetry, children, label }: { state: Loadable<T>; onRetry?: () => void; children: (data: T) => ReactNode; label?: string }) {
  if (state.status === "loading") return <Loading {...(label ? { label } : {})} />;
  if (state.status === "error") return <ErrorView error={state.error} {...(onRetry ? { onRetry } : {})} />;
  return <>{children(state.data)}</>;
}

/** Footer for cursor paginated lists. */
export function PagedFooter<T>({ paged, noun }: { paged: PagedState<T>; noun: string }) {
  return (
    <div className="pager">
      {paged.moreError && <ErrorView error={paged.moreError} onRetry={paged.loadMore} />}
      {paged.hasMore ? (
        <button type="button" className="button-secondary" onClick={paged.loadMore} disabled={paged.loadingMore}>
          {paged.loadingMore ? "Loading…" : `Load more ${noun}`}
        </button>
      ) : (
        paged.items.length > 0 && <span className="muted">All {paged.items.length} {noun} loaded.</span>
      )}
    </div>
  );
}

interface IssueLike {
  path?: unknown;
  code?: unknown;
  message?: unknown;
}

const ISSUE_CAP = 20;

const issuesOf = (error: ApiError): { issues: IssueLike[]; total: number } => {
  const details = error.details as { issues?: unknown; total_issues?: unknown } | undefined;
  const issues = Array.isArray(details?.issues) ? (details?.issues as IssueLike[]) : [];
  return { issues, total: typeof details?.total_issues === "number" ? details.total_issues : issues.length };
};

function RetryButton({ onRetry, waitSeconds }: { onRetry: () => void; waitSeconds?: number | undefined }) {
  const [left, setLeft] = useState(waitSeconds ?? 0);
  useEffect(() => {
    if (left <= 0) return;
    const timer = setTimeout(() => setLeft((n) => n - 1), 1000);
    return () => clearTimeout(timer);
  }, [left]);
  return (
    <button type="button" onClick={onRetry} disabled={left > 0}>
      {left > 0 ? `Retry in ${left}s` : "Retry"}
    </button>
  );
}

interface ErrorCopy {
  kind: "denied" | "failed";
  title: string;
  body: string;
  retry: boolean;
}

function copyFor(error: ApiError): ErrorCopy {
  switch (error.status) {
    case 401:
      // A failed login never says whether the account, the password or the workspace was wrong.
      if (error.code === "INVALID_CREDENTIALS") return { kind: "denied", title: "Sign in failed", body: "The email, password or workspace is not correct.", retry: false };
      return { kind: "denied", title: "Sign in required", body: "Your session has ended or is not valid. Sign in again to continue.", retry: false };
    case 403:
      return { kind: "denied", title: "Not permitted", body: "Your role in this workspace does not allow this. Ask a workspace admin if you need access.", retry: false };
    case 404:
      // Identical for a missing object and one in another workspace: the UI never reveals which.
      return { kind: "denied", title: "Not found", body: "This item does not exist, or you do not have access to it.", retry: false };
    case 409:
      if (error.code === "STALE_BASELINE") {
        return { kind: "failed", title: "The baseline changed", body: "Another snapshot became the workspace baseline after this one was read. Nothing was assessed.", retry: false };
      }
      if (error.code === "IDEMPOTENCY_CONFLICT") {
        return { kind: "failed", title: "Conflicting duplicate request", body: "An earlier request with the same key had different content. Review the form and submit again.", retry: false };
      }
      return { kind: "failed", title: "Conflict", body: error.message, retry: false };
    case 413:
      return { kind: "failed", title: "Too large", body: "The request is over a size limit (25 MB, 10,000 nodes or 50,000 edges by default). Reduce it and try again.", retry: false };
    case 422:
      return { kind: "failed", title: "Rejected", body: error.message, retry: false };
    case 429:
      return { kind: "failed", title: "Too many requests", body: "Slow down. Nothing was changed by the refused request.", retry: true };
    case 503:
      return { kind: "failed", title: "Service unavailable", body: "ChangeRadar is not ready or a dependency is unavailable. Nothing was changed. Retry in a moment.", retry: true };
    case 0:
      return { kind: "failed", title: "Cannot reach ChangeRadar", body: error.message, retry: true };
    case 400:
      return { kind: "failed", title: "Invalid request", body: error.message, retry: false };
    default:
      return { kind: "failed", title: "Something went wrong", body: error.message, retry: true };
  }
}

/**
 * The one place API failures are shown. Denied states (401, 403, 404) use fixed wording that never says whether
 * an object exists in another workspace; failed states (409, 413, 422, 429, 503 and transport errors) say what
 * happened and what to do next.
 */
export function ErrorView({ error, onRetry, onReload }: { error: unknown; onRetry?: (() => void) | undefined; onReload?: (() => void) | undefined }) {
  const api = toApiError(error);
  const copy = copyFor(api);
  const { issues, total } = api.status === 422 ? issuesOf(api) : { issues: [], total: 0 };
  const current = api.status === 409 && api.code === "STALE_BASELINE" ? (api.details as { current_baseline_snapshot_id?: unknown } | undefined)?.current_baseline_snapshot_id : undefined;
  return (
    <div className={`banner banner-${copy.kind === "denied" ? "denied" : "failed"}`} role="alert" data-state={copy.kind} data-status={api.status} data-code={api.code}>
      <strong>{copy.title}.</strong> {copy.body}
      {typeof current === "string" && (
        <span> The current baseline is snapshot <code>{current}</code>.</span>
      )}
      {typeof (api.details as { reason?: unknown } | undefined)?.reason === "string" && (
        <span> Reason: {(api.details as { reason: string }).reason}.</span>
      )}
      {issues.length > 0 && (
        <ul className="issues">
          {issues.slice(0, ISSUE_CAP).map((issue, index) => (
            <li key={index}>
              {typeof issue.path === "string" && <code>{issue.path}</code>} {typeof issue.code === "string" && <code>{issue.code}</code>} {String(issue.message ?? "")}
            </li>
          ))}
          {total > Math.min(issues.length, ISSUE_CAP) && <li>and {total - Math.min(issues.length, ISSUE_CAP)} more</li>}
        </ul>
      )}
      {(onRetry || onReload) && (
        <div className="actions">
          {onReload && api.code === "STALE_BASELINE" && (
            <button type="button" onClick={onReload}>
              Use the current baseline
            </button>
          )}
          {onRetry && copy.retry && <RetryButton onRetry={onRetry} waitSeconds={api.status === 429 ? api.retryAfterSeconds : undefined} />}
        </div>
      )}
      <div className="muted ref">
        <code>{api.code}</code>
        {api.requestId ? ` · Reference ${api.requestId}` : ""}
      </div>
    </div>
  );
}

/** Shown before any request is made when the role clearly cannot use a page (the API still enforces it). */
export function RoleDenied({ what }: { what: string }) {
  return (
    <div className="banner banner-denied" role="alert" data-state="denied" data-status="403">
      <strong>Not permitted.</strong> Your role in this workspace does not allow {what}. Ask a workspace admin if you need access.
    </div>
  );
}

export function PageHead({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="page-head">
      <h1>{title}</h1>
      {children}
    </div>
  );
}
