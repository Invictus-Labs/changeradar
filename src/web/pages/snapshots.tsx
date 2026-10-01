import { type ChangeEvent, type FormEvent, type ReactNode, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, canImport, formatTime, idempotencyFor, manifestUrl, shortHash, type User } from "../api";
import { Empty, ErrorView, LoadState, Loading, PageHead, PagedFooter, RoleDenied } from "../components";
import { edgesGraphModel, GraphView } from "../graph";
import { usePaged, useResource } from "../hooks";
import type { EdgeRow, NodeRow, SnapshotSummary, SnapshotWarning } from "../types";

const MANIFEST_LIMIT_BYTES = 25 * 1024 * 1024;

export function HashText({ value }: { value: string }) {
  return (
    <code className="hash" title={value}>
      {shortHash(value)}
    </code>
  );
}

export function SnapshotsPage({ user }: { user: User }) {
  const paged = usePaged<SnapshotSummary>("/snapshots");
  return (
    <>
      <PageHead title="Snapshots">
        <p className="lede">
          A snapshot is an immutable, hashed import of your dependency manifests. The most recent one is the workspace baseline that proposed changes are assessed against.
        </p>
        {canImport(user.role) && (
          <p className="actions">
            <Link className="button" to="/snapshots/import">
              Import a snapshot
            </Link>
          </p>
        )}
      </PageHead>
      {paged.status === "loading" && <Loading />}
      {paged.status === "error" && paged.error && <ErrorView error={paged.error} onRetry={paged.reload} />}
      {paged.status === "ready" && paged.items.length === 0 && (
        <Empty title="No snapshots yet">
          {canImport(user.role) ? (
            <p>
              Import a manifest to create the first baseline. <Link to="/snapshots/import">Import a snapshot</Link>.
            </p>
          ) : (
            <p>Ask an operator or admin to import a manifest. Your role reads results only.</p>
          )}
        </Empty>
      )}
      {paged.status === "ready" && paged.items.length > 0 && (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Revision</th>
                  <th>Graph hash</th>
                  <th>Nodes</th>
                  <th>Edges</th>
                  <th>Imported (UTC)</th>
                  <th>Role in workspace</th>
                </tr>
              </thead>
              <tbody>
                {paged.items.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <Link to={`/snapshots/${s.id}`}>{s.revision}</Link>
                    </td>
                    <td>
                      <HashText value={s.hash} />
                    </td>
                    <td>{s.node_count}</td>
                    <td>{s.edge_count}</td>
                    <td>{formatTime(s.imported_at)}</td>
                    <td>{s.is_baseline ? <span className="badge badge-neutral">baseline</span> : <span className="muted">superseded</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <PagedFooter paged={paged} noun="snapshots" />
        </>
      )}
    </>
  );
}

// ---- import ----

/** Manifest text area with a file picker. Reads the file in the browser; nothing is sent until the form is submitted. */
export function ManifestInput({ label, value, onChange, onProblem, name }: { label: string; value: string; onChange: (text: string) => void; onProblem: (message: string | null) => void; name: string }) {
  const input = useRef<HTMLInputElement>(null);
  const pick = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > MANIFEST_LIMIT_BYTES) {
      onProblem("That file is larger than 25 MB, the manifest size limit. Nothing was loaded.");
      if (input.current) input.current.value = "";
      return;
    }
    onProblem(null);
    onChange(await file.text());
  };
  return (
    <div className="field">
      <label htmlFor={`${name}-text`}>{label}</label>
      <textarea id={`${name}-text`} name={name} rows={12} spellCheck={false} value={value} onChange={(e) => onChange(e.target.value)} placeholder='{"schema_version": 1, "revision": "…", "nodes": [], "edges": []}' />
      <label htmlFor={`${name}-file`} className="file-label">
        Or load a JSON file
      </label>
      <input id={`${name}-file`} ref={input} type="file" accept="application/json,.json" onChange={(e) => void pick(e)} />
    </div>
  );
}

/** Parse the text box as a JSON object; the reason is written for a person, never the raw parser message alone. */
export function parseManifestText(text: string): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  if (text.trim() === "") return { ok: false, message: "Paste a manifest or load a JSON file first." };
  if (text.length > MANIFEST_LIMIT_BYTES) return { ok: false, message: "The manifest is larger than 25 MB, the size limit." };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { ok: false, message: `The manifest is not valid JSON (${(error as Error).message}).` };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, message: "The manifest must be a JSON object." };
  return { ok: true, value: value as Record<string, unknown> };
}

export function WarningList({ warnings }: { warnings: SnapshotWarning[] }) {
  if (!Array.isArray(warnings) || warnings.length === 0) return <p className="muted">No warnings.</p>;
  return (
    <ul className="warnings">
      {warnings.map((w) => (
        <li key={w.code}>
          <code>{w.code}</code> {w.message} ({w.count})
          {w.sample_ids.length > 0 && (
            <span className="hop">
              {" "}
              e.g. {w.sample_ids.slice(0, 5).map((id) => <code key={id}>{id} </code>)}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

interface ImportReceipt extends SnapshotSummary {
  warnings: SnapshotWarning[];
}

export function ImportSnapshotPage({ user }: { user: User }) {
  const [revision, setRevision] = useState("");
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<ImportReceipt | null>(null);
  const idem = useMemo(() => idempotencyFor(), []);
  if (!canImport(user.role)) return <RoleDenied what="importing snapshots" />;

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    setError(null);
    setReceipt(null);
    if (revision.trim() === "") return setProblem("Enter a revision label for this snapshot.");
    const parsed = parseManifestText(text);
    if (!parsed.ok) return setProblem(parsed.message);
    setProblem(null);
    const body = { schema_version: 1, revision: revision.trim(), manifest: parsed.value };
    setBusy(true);
    try {
      setReceipt(await api<ImportReceipt>("POST", "/snapshots", body, { idempotencyKey: idem.keyFor(JSON.stringify(body)) }));
      idem.reset();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHead title="Import a snapshot">
        <p className="lede">
          Validation completes before anything is stored: a manifest with a dangling edge, an unsupported schema version or a secret-looking value is rejected whole and leaves nothing behind. Manifests hold credential aliases only, never secret values.
        </p>
      </PageHead>
      <form onSubmit={(e) => void submit(e)} aria-label="Import snapshot" className="stack-form">
        <div className="field">
          <label htmlFor="revision">Revision label</label>
          <input id="revision" name="revision" value={revision} onChange={(e) => setRevision(e.target.value)} maxLength={200} placeholder="2026-09-29.1" />
        </div>
        <ManifestInput label="Manifest (JSON)" name="manifest" value={text} onChange={setText} onProblem={setProblem} />
        {problem && (
          <p className="banner banner-failed" role="alert" data-state="failed" data-status="client">
            {problem}
          </p>
        )}
        <button type="submit" disabled={busy}>
          {busy ? "Importing…" : "Import snapshot"}
        </button>
      </form>
      {error !== null && <ErrorView error={error} onRetry={() => void submit()} />}
      {receipt && (
        <section className="panel" aria-label="Import receipt" data-testid="import-receipt">
          <h2>Snapshot imported</h2>
          <p>It is now the workspace baseline.</p>
          <dl className="kv">
            <dt>Snapshot</dt>
            <dd>
              <Link to={`/snapshots/${receipt.id}`}>{receipt.id}</Link>
            </dd>
            <dt>Graph hash</dt>
            <dd>
              <code>{receipt.hash}</code>
            </dd>
            <dt>Nodes and edges</dt>
            <dd>
              {receipt.node_count} nodes, {receipt.edge_count} edges
            </dd>
          </dl>
          <h3>Warnings</h3>
          <WarningList warnings={receipt.warnings} />
          <p className="actions">
            <Link className="button" to={`/runs/new?snapshot=${receipt.id}`}>
              Assess a proposed change
            </Link>
          </p>
        </section>
      )}
    </>
  );
}

// ---- detail ----

type Tab = "overview" | "nodes" | "edges";

export function SnapshotDetailPage({ user }: { user: User }) {
  const { id = "" } = useParams();
  const [state, reload] = useResource<SnapshotSummary>(`/snapshots/${encodeURIComponent(id)}`);
  const [tab, setTab] = useState<Tab>("overview");
  return (
    <LoadState state={state} onRetry={reload}>
      {(snapshot) => (
        <>
          <PageHead title={`Snapshot ${snapshot.revision}`}>
            <p className="crumb">
              <Link to="/snapshots">Snapshots</Link> / <code>{snapshot.id}</code>
            </p>
            {canImport(user.role) && (
              <p className="actions">
                <Link className="button" to={`/runs/new?snapshot=${snapshot.id}`}>
                  Assess a proposed change
                </Link>
                <a className="button button-secondary" href={manifestUrl(snapshot.id)} download={`changeradar-snapshot-${snapshot.id}.json`}>
                  Download normalized manifest
                </a>
              </p>
            )}
          </PageHead>
          <div className="tabs" role="group" aria-label="Snapshot sections">
            {(["overview", "nodes", "edges"] as Tab[]).map((t) => (
              <button key={t} type="button" aria-pressed={tab === t} onClick={() => setTab(t)}>
                {t === "edges" ? "Edges and graph" : t[0]?.toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
          {tab === "overview" && (
            <section className="panel" aria-label="Snapshot overview">
              <dl className="kv">
                <dt>Role in workspace</dt>
                <dd>{snapshot.is_baseline ? "baseline (used for new assessments)" : "superseded by a newer baseline"}</dd>
                <dt>Imported</dt>
                <dd>{formatTime(snapshot.imported_at)}</dd>
                <dt>Graph hash</dt>
                <dd>
                  <code>{snapshot.hash}</code>
                </dd>
                <dt>Document hash</dt>
                <dd>
                  <code>{snapshot.document_hash}</code>
                </dd>
                <dt>Size</dt>
                <dd>
                  {snapshot.node_count} nodes, {snapshot.edge_count} edges
                </dd>
              </dl>
              <h2>Warnings from import</h2>
              <WarningList warnings={snapshot.warnings} />
            </section>
          )}
          {tab === "nodes" && <NodesPanel snapshotId={snapshot.id} />}
          {tab === "edges" && <EdgesPanel snapshotId={snapshot.id} total={snapshot.edge_count} />}
        </>
      )}
    </LoadState>
  );
}

function Filter({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }): ReactNode {
  return (
    <div className="field field-inline">
      <label htmlFor="filter">{label}</label>
      <input id="filter" type="search" value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

function NodesPanel({ snapshotId }: { snapshotId: string }) {
  const paged = usePaged<NodeRow>(`/snapshots/${snapshotId}/nodes`, {}, 100);
  const [filter, setFilter] = useState("");
  const rows = paged.items.filter((n) => `${n.id} ${n.owner ?? ""} ${n.kind}`.toLowerCase().includes(filter.toLowerCase()));
  if (paged.status === "loading") return <Loading />;
  if (paged.status === "error" && paged.error) return <ErrorView error={paged.error} onRetry={paged.reload} />;
  if (paged.items.length === 0) return <Empty title="No nodes in this snapshot" />;
  return (
    <>
      <Filter value={filter} onChange={setFilter} label="Filter loaded nodes" />
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Node</th>
              <th>Kind</th>
              <th>Owner</th>
              <th>Version</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((n) => (
              <tr key={n.id}>
                <td>
                  <code>{n.id}</code> {n.placeholder && <span className="badge badge-warn">placeholder</span>}
                </td>
                <td>{n.kind}</td>
                <td>{n.owner ?? <strong>owner unknown</strong>}</td>
                <td>{n.version}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={4}>No loaded node matches the filter.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <PagedFooter paged={paged} noun="nodes" />
    </>
  );
}

function EdgesPanel({ snapshotId, total }: { snapshotId: string; total: number }) {
  const paged = usePaged<EdgeRow>(`/snapshots/${snapshotId}/edges`, {}, 100);
  const [filter, setFilter] = useState("");
  const model = useMemo(() => edgesGraphModel(paged.items), [paged.items]);
  const rows = paged.items.filter((e) => `${e.source_id} ${e.target_id} ${e.relation}`.toLowerCase().includes(filter.toLowerCase()));
  if (paged.status === "loading") return <Loading />;
  if (paged.status === "error" && paged.error) return <ErrorView error={paged.error} onRetry={paged.reload} />;
  if (paged.items.length === 0) return <Empty title="No edges in this snapshot" />;
  return (
    <>
      <p className="note">
        The drawing previews the {paged.items.length} loaded of {total} edges. It is capped in size; the table below pages through all of them.
      </p>
      <GraphView model={model} title="Dependency edges of this snapshot" noun="edges" />
      <Filter value={filter} onChange={setFilter} label="Filter loaded edges" />
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>From (depends)</th>
              <th>Relation</th>
              <th>To</th>
              <th>Declared in</th>
              <th>Verified (UTC)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <tr key={`${e.source_id}|${e.target_id}|${e.relation}`}>
                <td>
                  <code>{e.source_id}</code>
                </td>
                <td>{e.relation}</td>
                <td>
                  <code>{e.target_id}</code>
                </td>
                <td>
                  <code>
                    {e.source_file}:{e.source_line}
                  </code>
                </td>
                <td>{e.verified_at ? formatTime(e.verified_at) : <strong>never verified</strong>}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5}>No loaded edge matches the filter.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <PagedFooter paged={paged} noun="edges" />
    </>
  );
}
