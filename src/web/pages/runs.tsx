import { type FormEvent, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { CHECK_STATE_NOTE } from "../../report/wording";
import { api, canImport, formatTime, idempotencyFor, type User } from "../api";
import { CoverageLimits, Empty, ErrorView, ExportControls, LoadState, Loading, PageHead, PagedFooter, RoleDenied, StatusBadge, UnknownsTable, VerdictBadge, VerdictBanner } from "../components";
import { GraphView, impactGraphModel } from "../graph";
import { usePaged, useResource } from "../hooks";
import type { CheckResult, Cycle, Finding, RunDetail, RunSummary, SnapshotSummary } from "../types";
import { HashText, ManifestInput, parseManifestText } from "./snapshots";

const POLL_MS = 2000;

// ---- list ----

export function RunsPage({ user }: { user: User }) {
  const [status, setStatus] = useState("");
  const paged = usePaged<RunSummary>("/impact-runs", { status });
  return (
    <>
      <PageHead title="Impact runs">
        <p className="lede">
          A run assesses a proposed manifest against the baseline. <strong>Complete</strong> means the computation finished; it is not a safety verdict. The verdict is the separate assessment.
        </p>
        {canImport(user.role) && (
          <p className="actions">
            <Link className="button" to="/runs/new">
              New impact run
            </Link>
          </p>
        )}
      </PageHead>
      <div className="field field-inline">
        <label htmlFor="status-filter">Status</label>
        <select id="status-filter" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All</option>
          <option value="queued">Queued</option>
          <option value="running">Running</option>
          <option value="complete">Complete</option>
          <option value="failed">Failed</option>
        </select>
      </div>
      {paged.status === "loading" && <Loading />}
      {paged.status === "error" && paged.error && <ErrorView error={paged.error} onRetry={paged.reload} />}
      {paged.status === "ready" && paged.items.length === 0 && (
        <Empty title={status ? `No ${status} runs` : "No impact runs yet"}>
          {canImport(user.role) ? (
            <p>
              <Link to="/runs/new">Start a run</Link> to see which known consumers a change can break.
            </p>
          ) : (
            <p>Runs appear here once an operator or admin requests them.</p>
          )}
        </Empty>
      )}
      {paged.status === "ready" && paged.items.length > 0 && (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Requested (UTC)</th>
                  <th>Status</th>
                  <th>Assessment</th>
                  <th>Proposed hash</th>
                  <th>Run</th>
                </tr>
              </thead>
              <tbody>
                {paged.items.map((r) => (
                  <tr key={r.id}>
                    <td>{formatTime(r.created_at)}</td>
                    <td>
                      <StatusBadge status={r.status} />
                    </td>
                    <td>
                      {r.rerun_required ? (
                        // An older engine's verdict (possibly a wrong "no known impact") is never shown as current in a list.
                        <strong role="status" title="This run was assessed by an older decision engine; its recorded verdict may differ today.">
                          Re-run required
                        </strong>
                      ) : (
                        <VerdictBadge value={r.assessment} />
                      )}
                    </td>
                    <td>
                      <HashText value={r.proposed_hash} />
                    </td>
                    <td>
                      <Link to={`/runs/${r.id}`}>Open</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <PagedFooter paged={paged} noun="runs" />
        </>
      )}
    </>
  );
}

// ---- create ----

interface RunReceipt {
  id: string;
  status: "queued";
}

export function NewRunPage({ user }: { user: User }) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const snapshots = usePaged<SnapshotSummary>("/snapshots", {}, 100);
  const [selected, setSelected] = useState(params.get("snapshot") ?? "");
  const [text, setText] = useState("");
  const [runChecks, setRunChecks] = useState(true);
  const [allowSuperseded, setAllowSuperseded] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const idem = useMemo(() => idempotencyFor(), []);

  // Default to the baseline (the newest snapshot) once the list has loaded, and whenever the chosen id is not in it.
  useEffect(() => {
    if (snapshots.items.length > 0 && !snapshots.items.some((s) => s.id === selected)) {
      setSelected((snapshots.items.find((s) => s.is_baseline) ?? snapshots.items[0])?.id ?? "");
    }
  }, [snapshots.items, selected]);

  if (!canImport(user.role)) return <RoleDenied what="requesting impact runs" />;
  const snapshot = snapshots.items.find((s) => s.id === selected);
  const superseded = snapshot !== undefined && !snapshot.is_baseline;

  const refreshBaseline = async () => {
    setError(null);
    idem.reset();
    try {
      const baseline = await api<{ snapshot: SnapshotSummary | null }>("GET", "/baseline");
      if (baseline.snapshot) setSelected(baseline.snapshot.id);
      snapshots.reload();
      setAllowSuperseded(false);
    } catch (e) {
      setError(e);
    }
  };

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    setError(null);
    /* v8 ignore next -- the effect above always selects a listed snapshot; this only satisfies the type checker */
    if (!snapshot) return;
    const parsed = parseManifestText(text);
    if (!parsed.ok) return setProblem(parsed.message);
    setProblem(null);
    const body = { snapshot_id: snapshot.id, proposed_manifest: parsed.value, expected_hash: snapshot.hash, run_checks: runChecks, allow_superseded: superseded && allowSuperseded };
    setBusy(true);
    try {
      const receipt = await api<RunReceipt>("POST", "/impact-runs", body, { idempotencyKey: idem.keyFor(JSON.stringify(body)) });
      idem.reset();
      navigate(`/runs/${receipt.id}`);
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };

  return (
    <>
      <PageHead title="New impact run">
        <p className="lede">
          Paste the proposed manifest. The run is assessed against the chosen snapshot and refused if that snapshot is no longer the baseline (409), so a stale view is never assessed as if it were current.
        </p>
      </PageHead>
      {snapshots.status === "loading" && <Loading />}
      {snapshots.status === "error" && snapshots.error && <ErrorView error={snapshots.error} onRetry={snapshots.reload} />}
      {snapshots.status === "ready" && snapshots.items.length === 0 && (
        <Empty title="No baseline to assess against">
          <p>
            <Link to="/snapshots/import">Import a snapshot</Link> first.
          </p>
        </Empty>
      )}
      {snapshots.status === "ready" && snapshots.items.length > 0 && (
        <form onSubmit={(e) => void submit(e)} aria-label="New impact run" className="stack-form">
          <div className="field">
            <label htmlFor="snapshot">Assess against snapshot</label>
            <select id="snapshot" value={selected} onChange={(e) => { setSelected(e.target.value); setAllowSuperseded(false); }}>
              {snapshots.items.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.revision} ({s.is_baseline ? "baseline" : "superseded"})
                </option>
              ))}
            </select>
            {snapshots.hasMore && <span className="muted">Only the newest 100 snapshots are listed.</span>}
            {snapshot && (
              <span className="muted">
                Expected hash sent with the request: <code>{snapshot.hash}</code>
              </span>
            )}
          </div>
          {superseded && (
            <div className="banner banner-warn" role="status" data-testid="superseded-note">
              This snapshot is not the current baseline. A run against it is refused unless you explicitly allow it.
              <label className="check">
                <input type="checkbox" checked={allowSuperseded} onChange={(e) => setAllowSuperseded(e.target.checked)} /> Assess against this older snapshot anyway
              </label>
            </div>
          )}
          <ManifestInput label="Proposed manifest (JSON)" name="proposed" value={text} onChange={setText} onProblem={setProblem} />
          <label className="check">
            <input type="checkbox" checked={runChecks} onChange={(e) => setRunChecks(e.target.checked)} /> Run the enabled live contract checks for changed nodes (read-only)
          </label>
          {problem && (
            <p className="banner banner-failed" role="alert" data-state="failed" data-status="client">
              {problem}
            </p>
          )}
          <button type="submit" disabled={busy}>
            {busy ? "Requesting…" : "Request impact run"}
          </button>
        </form>
      )}
      {error !== null && <ErrorView error={error} onReload={() => void refreshBaseline()} onRetry={() => void submit()} />}
    </>
  );
}

// ---- detail ----

export function RunDetailPage({ user }: { user: User }) {
  const { id = "" } = useParams();
  const [state, reload] = useResource<RunDetail>(`/impact-runs/${encodeURIComponent(id)}`, (run) => (run.status === "queued" || run.status === "running" ? POLL_MS : null));
  return (
    <LoadState state={state} onRetry={reload} label="Loading run">
      {(run) => <RunView run={run} user={user} />}
    </LoadState>
  );
}

function RunView({ run, user }: { run: RunDetail; user: User }) {
  const finished = run.status === "complete" || run.status === "failed";
  const complete = run.status === "complete";
  const coverageFirst = run.assessment === "INCOMPLETE" || run.assessment === "NO_KNOWN_IMPACT";
  // An older engine's counts, statements and lists are history, and are shown as such (the same wording as the HTML export).
  const stale = complete && run.engine?.rerun_required === true;
  const coverage = complete ? <CoverageLimits coverage={run.coverage} stale={stale} /> : null;
  const unknowns = complete ? <UnknownsTable unknowns={run.unknowns} total={run.totals.unknowns} stale={stale} /> : null;
  const findings = complete ? <FindingsPanel run={run} /> : null;
  return (
    <>
      <PageHead title="Impact run">
        <p className="crumb">
          <Link to="/runs">Impact runs</Link> / <code>{run.id}</code>
        </p>
      </PageHead>
      <VerdictBanner run={run} />
      {run.engine?.rerun_required && (
        <p className="state-note" role="alert">
          {run.engine.note ?? "Assessed by an older decision engine: re-run required."}
        </p>
      )}
      {!finished &&<p className="state-note" role="status">This page refreshes while the run is {run.status}.</p>}
      <section className="panel" aria-label="Run facts">
        <dl className="kv">
          <dt>Status</dt>
          <dd>
            <StatusBadge status={run.status} /> <span className="muted">describes computation, not safety</span>
          </dd>
          <dt>Baseline snapshot</dt>
          <dd>
            <Link to={`/snapshots/${run.snapshot_id}`}>{run.snapshot_id}</Link> (baseline version {run.baseline_version})
          </dd>
          {run.allow_superseded && (
            <>
              <dt>Note</dt>
              <dd>Assessed against a snapshot that was no longer the workspace baseline, on explicit request.</dd>
            </>
          )}
          <dt>Baseline hash</dt>
          <dd>
            <code>{run.baseline_hash}</code>
          </dd>
          <dt>Proposed hash</dt>
          <dd>
            <code>{run.proposed_hash}</code>
          </dd>
          <dt>Requested</dt>
          <dd>{formatTime(run.created_at)}</dd>
          <dt>Finished</dt>
          <dd>{formatTime(run.finished_at)}</dd>
          {run.summary && (
            <>
              <dt>Changes{stale ? " (older engine)" : ""}</dt>
              <dd>{run.summary.changes}</dd>
              <dt>Findings{stale ? " (older engine)" : ""}</dt>
              <dd>
                {run.summary.findings} ({run.summary.direct_findings} direct, {run.summary.transitive_findings} transitive)
              </dd>
              <dt>Unknowns{stale ? " (older engine)" : ""}</dt>
              <dd>{run.summary.unknowns}</dd>
            </>
          )}
        </dl>
      </section>
      {coverageFirst ? (
        <>
          {coverage}
          {unknowns}
          {findings}
        </>
      ) : (
        <>
          {findings}
          {unknowns}
          {coverage}
        </>
      )}
      {complete && run.cycles.length > 0 && <CyclesList cycles={run.cycles} />}
      {complete && run.changes.length > 0 && <ChangesTable run={run} />}
      {run.checks.length > 0 && <ChecksTable checks={run.checks} />}
      <ExportControls runId={run.id} role={user.role} finished={finished} />
    </>
  );
}

function findingsEmptyText(run: RunDetail): string {
  if (run.engine?.rerun_required) return "As assessed by the older engine, no consumer was listed. That is not a current answer: request a new run before concluding anything.";
  return run.assessment === "INCOMPLETE"
    ? "No consumer is listed, but this run is INCOMPLETE: that does not mean nothing is affected. See the unknowns."
    : "No declared consumer is affected by the detected changes (within the coverage limits).";
}

function FindingsPanel({ run }: { run: RunDetail }) {
  const paged = usePaged<Finding>(`/impact-runs/${run.id}/findings`, {}, 100);
  const [filter, setFilter] = useState("");
  const cycleNodes = useMemo(() => new Set(run.cycles.flatMap((c) => c.members)), [run.cycles]);
  const model = useMemo(() => impactGraphModel(paged.items, run.cycles), [paged.items, run.cycles]);
  const rows = paged.items.filter((f) => `${f.id} ${f.consumer_id} ${f.consumer_owner ?? "owner unknown"} ${f.origin_id}`.toLowerCase().includes(filter.toLowerCase()));
  return (
    <section aria-labelledby="findings-h" data-testid="findings">
      <h2 id="findings-h">Affected consumers{run.engine?.rerun_required ? " as listed by the older engine" : ""} ({run.totals.findings})</h2>
      {paged.status === "loading" && <Loading label="Loading findings" />}
      {paged.status === "error" && paged.error && <ErrorView error={paged.error} onRetry={paged.reload} />}
      {paged.status === "ready" && paged.items.length === 0 && <p className="empty-inline">{findingsEmptyText(run)}</p>}
      {paged.status === "ready" && paged.items.length > 0 && (
        <>
          <GraphView model={model} title="Impact paths from changed items to affected consumers" noun="findings" />
          <div className="field field-inline">
            <label htmlFor="finding-filter">Filter loaded findings</label>
            <input id="finding-filter" type="search" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </div>
          <div className="table-wrap">
            <table className="table stack findings">
              <thead>
                <tr>
                  <th>Finding ID</th>
                  <th>Severity</th>
                  <th>Consumer</th>
                  <th>Owner</th>
                  <th>Path (source to consumer)</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((f) => (
                  <tr key={f.id} data-finding-id={f.id}>
                    <td data-label="Finding ID">
                      <code>{f.id}</code>
                    </td>
                    <td data-label="Severity">
                      <span className={`badge badge-sev-${f.severity}`}>{f.severity === "high" ? "HIGH direct" : `MEDIUM transitive (depth ${f.depth})`}</span>
                    </td>
                    <td data-label="Consumer">
                      <code>{f.consumer_id}</code>
                      <div className="hop">
                        {f.consumer_kind}
                        {cycleNodes.has(f.consumer_id) ? " · ↻ in a dependency cycle" : ""}
                      </div>
                    </td>
                    <td data-label="Owner">{f.consumer_owner ? f.consumer_owner : <strong className="owner-unknown">owner unknown</strong>}</td>
                    <td data-label="Path (source to consumer)">
                      <ol className="path">
                        {f.path.map((node, index) => {
                          const hop = f.hops[index - 1];
                          const previous = f.hops[index - 2];
                          // A very long path keeps only its first and last hops; mark where the middle was left out.
                          const gap = hop !== undefined && previous !== undefined && hop.from !== previous.to;
                          return (
                            <li key={`${node}-${index}`}>
                              {gap && (
                                <span className="hop" data-testid="path-omitted">
                                  … {f.path_omitted_hops ?? "more"} hops not shown …{" "}
                                </span>
                              )}
                              <code>{node}</code>
                              {hop && (
                                <span className="hop">
                                  {" "}
                                  {hop.relation} via {hop.source_file}:{hop.source_line}
                                </span>
                              )}
                            </li>
                          );
                        })}
                      </ol>
                    </td>
                    <td data-label="Reason">{f.reason}</td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={6}>No loaded finding matches the filter.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <PagedFooter paged={paged} noun="findings" />
        </>
      )}
    </section>
  );
}

function CyclesList({ cycles }: { cycles: Cycle[] }) {
  return (
    <section aria-labelledby="cycles-h" data-testid="cycles">
      <h2 id="cycles-h">Dependency cycles ({cycles.length})</h2>
      <p className="note">Cycles are supported and reported once; they are never traversed twice.</p>
      <ul className="plain">
        {cycles.map((c) => (
          <li key={c.id}>
            <code>{c.id}</code>: {c.members.map((m) => <code key={m}>{m} </code>)}
          </li>
        ))}
      </ul>
    </section>
  );
}

function ChangesTable({ run }: { run: RunDetail }) {
  return (
    <section aria-labelledby="changes-h">
      <h2 id="changes-h">Detected changes ({run.changes.length})</h2>
      <div className="table-wrap">
        <table className="table stack">
          <thead>
            <tr>
              <th>Change ID</th>
              <th>Kind</th>
              <th>Node</th>
              <th>Effect</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
            {run.changes.map((c) => (
              <tr key={c.id}>
                <td data-label="Change ID">
                  <code>{c.id}</code>
                </td>
                <td data-label="Kind">
                  <code>{c.kind}</code>
                </td>
                <td data-label="Node">
                  <code>{c.node_id}</code>
                </td>
                <td data-label="Effect">{c.propagation ?? "—"}</td>
                <td data-label="Description">{c.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ChecksTable({ checks }: { checks: CheckResult[] }) {
  return (
    <section aria-labelledby="checks-h" data-testid="checks">
      <h2 id="checks-h">Live contract checks ({checks.length})</h2>
      <p className="note">Read-only checks. Anything other than PASSED is an unknown and forces INCOMPLETE.</p>
      <div className="table-wrap">
        <table className="table stack">
          <thead>
            <tr>
              <th>Check</th>
              <th>Node</th>
              <th>State</th>
              <th>Attempts</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {checks.map((c) => (
              <tr key={c.check_key}>
                <td data-label="Check">
                  <code>{c.check_key}</code>
                </td>
                <td data-label="Node">
                  <code>{c.node_id}</code>
                </td>
                <td data-label="State">
                  <span className={`badge ${c.state === "PASSED" ? "badge-neutral" : "badge-warn"}`} data-check-state={c.state}>
                    {c.state}
                  </span>
                </td>
                <td data-label="Attempts">{c.attempts ?? "—"}</td>
                <td data-label="Detail">
                  {c.detail ?? "none"}
                  <div className="hop">{CHECK_STATE_NOTE[c.state] ?? ""}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
