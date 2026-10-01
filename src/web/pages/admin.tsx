import { type FormEvent, useMemo, useState } from "react";
import { api, formatTime, idempotencyFor, isAdmin, canReadOperational, type User } from "../api";
import { Empty, ErrorView, LoadState, Loading, PageHead, PagedFooter, RoleBadge, RoleDenied } from "../components";
import { usePaged, useResource } from "../hooks";
import type { CheckDefinition } from "../types";

// ---- contract checks (operator and admin read; admin manages) ----

const FIELD_TYPES = ["string", "number", "integer", "boolean", "object", "array", "null"];

function parseRequiredFields(text: string): { ok: true; fields: { name: string; type: string }[] } | { ok: false; message: string } {
  const fields: { name: string; type: string }[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    const [name, type = "string"] = line.split(":").map((p) => p.trim());
    if (!name || !FIELD_TYPES.includes(type)) return { ok: false, message: `Required field "${line}" must look like name:type where type is one of ${FIELD_TYPES.join(", ")}.` };
    fields.push({ name, type });
  }
  return { ok: true, fields };
}

export function ChecksPage({ user }: { user: User }) {
  const paged = usePaged<CheckDefinition>(canReadOperational(user.role) ? "/contract-checks" : null);
  const [actionError, setActionError] = useState<unknown>(null);
  if (!canReadOperational(user.role)) return <RoleDenied what="reading contract checks" />;

  const disable = async (check: CheckDefinition) => {
    setActionError(null);
    try {
      await api("POST", `/contract-checks/${check.id}/disable`);
      paged.reload();
    } catch (e) {
      setActionError(e);
    }
  };

  return (
    <>
      <PageHead title="Contract checks">
        <p className="lede">
          Read-only checks against endpoints an admin allowed. They can only time out, fail or pass; a failed or timed-out check is an unknown that forces INCOMPLETE and is never shown as passed. Credential values are never stored here, only aliases.
        </p>
      </PageHead>
      {actionError !== null && <ErrorView error={actionError} />}
      {paged.status === "loading" && <Loading />}
      {paged.status === "error" && paged.error && <ErrorView error={paged.error} onRetry={paged.reload} />}
      {paged.status === "ready" && paged.items.length === 0 && (
        <Empty title="No contract checks configured">{isAdmin(user.role) ? <p>Create one below.</p> : <p>An admin can configure read-only checks.</p>}</Empty>
      )}
      {paged.status === "ready" && paged.items.length > 0 && (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Key</th>
                  <th>Node</th>
                  <th>Request</th>
                  <th>Limits</th>
                  <th>Credential</th>
                  <th>State</th>
                  {isAdmin(user.role) && <th>Manage</th>}
                </tr>
              </thead>
              <tbody>
                {paged.items.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <code>{c.key}</code>
                    </td>
                    <td>
                      <code>{c.node_id}</code>
                    </td>
                    <td>
                      {c.method} <code>{c.url}</code> expects {c.expect_status}
                    </td>
                    <td>
                      {c.timeout_ms} ms, {c.retries} retries
                    </td>
                    <td>{c.credential_alias ? (c.credential_configured ? `alias ${c.credential_alias} (configured)` : <strong>alias {c.credential_alias} has no stored value</strong>) : "none"}</td>
                    <td>{c.enabled ? "enabled" : `disabled ${formatTime(c.disabled_at)}`}</td>
                    {isAdmin(user.role) && (
                      <td>
                        {c.enabled ? (
                          <button type="button" className="button-secondary" onClick={() => void disable(c)}>
                            Disable {c.key}
                          </button>
                        ) : (
                          "—"
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <PagedFooter paged={paged} noun="checks" />
        </>
      )}
      {isAdmin(user.role) && <NewCheckForm onCreated={paged.reload} />}
    </>
  );
}

function NewCheckForm({ onCreated }: { onCreated: () => void }) {
  const [values, setValues] = useState({ key: "", node_id: "", url: "", method: "GET", timeout_ms: "5000", retries: "2", expect_status: "200", credential_alias: "", required: "" });
  const [problem, setProblem] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const idem = useMemo(() => idempotencyFor(), []);
  const set = (name: keyof typeof values) => (e: { target: { value: string } }) => setValues((v) => ({ ...v, [name]: e.target.value }));

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    setError(null);
    setCreated(null);
    if (!values.key.trim() || !values.node_id.trim() || !values.url.trim()) return setProblem("Key, node and URL are required.");
    const fields = parseRequiredFields(values.required);
    if (!fields.ok) return setProblem(fields.message);
    setProblem(null);
    const body = {
      key: values.key.trim(),
      node_id: values.node_id.trim(),
      url: values.url.trim(),
      method: values.method,
      timeout_ms: Number(values.timeout_ms),
      retries: Number(values.retries),
      expect_status: Number(values.expect_status),
      ...(values.credential_alias.trim() ? { credential_alias: values.credential_alias.trim() } : {}),
      ...(fields.fields.length > 0 ? { required_fields: fields.fields } : {}),
    };
    setBusy(true);
    try {
      await api("POST", "/contract-checks", body, { idempotencyKey: idem.keyFor(JSON.stringify(body)) });
      idem.reset();
      setCreated(body.key);
      onCreated();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel" aria-labelledby="new-check-h">
      <h2 id="new-check-h">Add a contract check</h2>
      <p className="muted">The URL must be on the operator egress allowlist. Values for the credential alias are set by the operator with the command line tool, never here.</p>
      <form onSubmit={(e) => void submit(e)} aria-label="New contract check" className="form-grid">
        <div className="field">
          <label htmlFor="check-key">Key</label>
          <input id="check-key" value={values.key} onChange={set("key")} />
        </div>
        <div className="field">
          <label htmlFor="check-node">Node id</label>
          <input id="check-node" value={values.node_id} onChange={set("node_id")} />
        </div>
        <div className="field">
          <label htmlFor="check-url">URL</label>
          <input id="check-url" value={values.url} onChange={set("url")} placeholder="http://localhost:9000/contract" />
        </div>
        <div className="field">
          <label htmlFor="check-method">Method</label>
          <select id="check-method" value={values.method} onChange={set("method")}>
            <option>GET</option>
            <option>HEAD</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="check-timeout">Timeout (ms)</label>
          <input id="check-timeout" inputMode="numeric" value={values.timeout_ms} onChange={set("timeout_ms")} />
        </div>
        <div className="field">
          <label htmlFor="check-retries">Retries (0 to 3)</label>
          <input id="check-retries" inputMode="numeric" value={values.retries} onChange={set("retries")} />
        </div>
        <div className="field">
          <label htmlFor="check-status">Expected status</label>
          <input id="check-status" inputMode="numeric" value={values.expect_status} onChange={set("expect_status")} />
        </div>
        <div className="field">
          <label htmlFor="check-alias">Credential alias (optional)</label>
          <input id="check-alias" value={values.credential_alias} onChange={set("credential_alias")} />
        </div>
        <div className="field wide">
          <label htmlFor="check-required">Required response fields, one per line as name:type (optional)</label>
          <textarea id="check-required" rows={3} value={values.required} onChange={set("required")} />
        </div>
        {problem && (
          <p className="banner banner-failed wide" role="alert" data-state="failed" data-status="client">
            {problem}
          </p>
        )}
        <div>
          <button type="submit" disabled={busy}>
            {busy ? "Saving…" : "Add check"}
          </button>
        </div>
      </form>
      {error !== null && <ErrorView error={error} onRetry={() => void submit()} />}
      {created && (
        <p role="status" className="state-note">
          Check <code>{created}</code> was added.
        </p>
      )}
    </section>
  );
}

// ---- admin: members, settings, audit ----

interface Member {
  user_id: string;
  email: string;
  role: User["role"];
}

interface Settings {
  limits: Record<string, number>;
  rate_limit: Record<string, number>;
  checks: { allowed_hosts: string[]; allow_private_network: boolean; max_timeout_ms: number; max_body_bytes: number; max_redirects: number };
  event_sink_configured: boolean;
  retention: { evidenceDays: number; deletionHours: number; backupExpiryDays: number; enforced: boolean; note: string };
}

interface AuditRecord {
  seq: number;
  actor_type: string;
  actor_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string;
  created_at: string;
  metadata: unknown;
}

export function AdminPage({ user }: { user: User }) {
  if (!isAdmin(user.role)) return <RoleDenied what="workspace administration" />;
  return (
    <>
      <PageHead title="Administration">
        <p className="lede">Members, effective settings and the audit trail of this workspace. Accounts are created with the command line tool; there is no registration page and no default password.</p>
      </PageHead>
      <MembersPanel />
      <SettingsPanel />
      <AuditPanel />
    </>
  );
}

function MembersPanel() {
  const paged = usePaged<Member>("/members", {}, 100);
  return (
    <section aria-labelledby="members-h">
      <h2 id="members-h">Members</h2>
      {paged.status === "loading" && <Loading />}
      {paged.status === "error" && paged.error && <ErrorView error={paged.error} onRetry={paged.reload} />}
      {paged.status === "ready" && paged.items.length === 0 && <Empty title="No members" />}
      {paged.status === "ready" && paged.items.length > 0 && (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Role</th>
                </tr>
              </thead>
              <tbody>
                {paged.items.map((m) => (
                  <tr key={m.user_id}>
                    <td>{m.email}</td>
                    <td>
                      <RoleBadge role={m.role} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <PagedFooter paged={paged} noun="members" />
        </>
      )}
    </section>
  );
}

function SettingsPanel() {
  const [state, reload] = useResource<Settings>("/settings");
  return (
    <section aria-labelledby="settings-h">
      <h2 id="settings-h">Effective settings</h2>
      <LoadState state={state} onRetry={reload}>
        {(s) => (
          <dl className="kv">
            <dt>Manifest limits</dt>
            <dd>
              {s.limits.max_manifest_bytes} bytes, {s.limits.max_nodes} nodes, {s.limits.max_edges} edges
            </dd>
            <dt>Egress allowlist</dt>
            <dd>{s.checks.allowed_hosts.length > 0 ? s.checks.allowed_hosts.map((h) => <code key={h}>{h} </code>) : "empty: no live check can run"}</dd>
            <dt>Event sink</dt>
            <dd>{s.event_sink_configured ? "configured" : "not configured (events are pull-only)"}</dd>
            <dt>Retention</dt>
            <dd>
              Proposed defaults: evidence {s.retention.evidenceDays} days, primary deletion within {s.retention.deletionHours} hours, backups expire within {s.retention.backupExpiryDays} days.{" "}
              <strong>{s.retention.enforced ? "Enforced." : "Not enforced automatically."}</strong> {s.retention.note}
            </dd>
          </dl>
        )}
      </LoadState>
    </section>
  );
}

function AuditPanel() {
  const paged = usePaged<AuditRecord>("/audit", {}, 100);
  return (
    <section aria-labelledby="audit-h">
      <h2 id="audit-h">Audit trail</h2>
      {paged.status === "loading" && <Loading />}
      {paged.status === "error" && paged.error && <ErrorView error={paged.error} onRetry={paged.reload} />}
      {paged.status === "ready" && paged.items.length === 0 && <Empty title="No audit records yet" />}
      {paged.status === "ready" && paged.items.length > 0 && (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>When (UTC)</th>
                  <th>Action</th>
                  <th>Actor</th>
                  <th>Resource</th>
                  <th>Metadata (redacted)</th>
                </tr>
              </thead>
              <tbody>
                {paged.items.map((a) => (
                  <tr key={a.seq}>
                    <td>{formatTime(a.created_at)}</td>
                    <td>
                      <code>{a.action}</code>
                    </td>
                    <td>
                      {a.actor_type} {a.actor_id ? <code>{a.actor_id}</code> : ""}
                    </td>
                    <td>
                      {a.resource_type} <code>{a.resource_id}</code>
                    </td>
                    <td>
                      <code>{JSON.stringify(a.metadata ?? {}).slice(0, 200)}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <PagedFooter paged={paged} noun="records" />
        </>
      )}
    </section>
  );
}

// ---- events (operator and admin) ----

interface EventRecord {
  seq: number;
  state: "pending" | "delivered";
  envelope: { event_id: string; event_type: string; resource_id: string; occurred_at: string; revision: string; evidence_ref: string };
}

export function EventsPage({ user }: { user: User }) {
  const paged = usePaged<EventRecord>(canReadOperational(user.role) ? "/events" : null, {}, 100);
  if (!canReadOperational(user.role)) return <RoleDenied what="reading the event feed" />;
  return (
    <>
      <PageHead title="Events">
        <p className="lede">
          Adapter events written in the same transaction as the change they announce. Delivery is at least once: consumers deduplicate on the event id.
        </p>
      </PageHead>
      {paged.status === "loading" && <Loading />}
      {paged.status === "error" && paged.error && <ErrorView error={paged.error} onRetry={paged.reload} />}
      {paged.status === "ready" && paged.items.length === 0 && <Empty title="No events yet" />}
      {paged.status === "ready" && paged.items.length > 0 && (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Seq</th>
                  <th>State</th>
                  <th>Event</th>
                  <th>Resource</th>
                  <th>Occurred (UTC)</th>
                </tr>
              </thead>
              <tbody>
                {paged.items.map((e) => (
                  <tr key={e.seq}>
                    <td>{e.seq}</td>
                    <td>{e.state}</td>
                    <td>
                      <code>{e.envelope.event_type}</code>
                      <div className="hop">
                        <code>{e.envelope.event_id}</code>
                      </div>
                    </td>
                    <td>
                      <code>{e.envelope.resource_id}</code>
                    </td>
                    <td>{formatTime(e.envelope.occurred_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <PagedFooter paged={paged} noun="events" />
        </>
      )}
    </>
  );
}
