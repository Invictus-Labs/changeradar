import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, type Role } from "../../src/web/api";
import { ErrorView, PagedFooter } from "../../src/web/components";
import { AdminPage, ChecksPage, EventsPage } from "../../src/web/pages/admin";
import { ImportSnapshotPage, SnapshotDetailPage, SnapshotsPage } from "../../src/web/pages/snapshots";
import { NewRunPage, RunDetailPage, RunsPage } from "../../src/web/pages/runs";
import type { PagedState } from "../../src/web/hooks";
import { apiError, mockAny, mockApi, page, renderPage, resetWeb, users } from "./support";

afterEach(resetWeb);

const alertOf = async () => screen.findByRole("alert");

// ---- shared fixtures ----

const H = (c: string) => `sha256:${c.repeat(64)}`;
const snapshot = (id: string, revision: string, isBaseline: boolean) => ({
  id,
  revision,
  hash: H(isBaseline ? "a" : "b"),
  document_hash: H("d"),
  node_count: 3,
  edge_count: 2,
  baseline_version: 2,
  is_baseline: isBaseline,
  imported_at: "2026-09-29T00:00:00.000Z",
  warnings: [],
});
const runDetail = (over: Record<string, unknown> = {}) => ({
  id: "run-1",
  snapshot_id: "snap-1",
  status: "complete",
  assessment: "AFFECTED",
  baseline_hash: H("a"),
  proposed_hash: H("b"),
  baseline_version: 2,
  allow_superseded: false,
  created_at: "2026-09-29T00:00:00.000Z",
  started_at: "2026-09-29T00:00:01.000Z",
  finished_at: "2026-09-29T00:00:02.000Z",
  error: null,
  summary: { changes: 1, findings: 1, direct_findings: 1, transitive_findings: 0, unknowns: 0, known_impact: true },
  coverage: { scope: "declared_manifests_only", nodes_examined: 2, edges_examined: 1, consumers_found: 1, known: ["one consumer"], limits: [{ code: "MANIFEST_DECLARED_ONLY", message: "declared only" }] },
  cycles: [],
  changes: [],
  unknowns: [],
  checks: [],
  totals: { findings: 1, unknowns: 0 },
  truncated: { findings: false, unknowns: false },
  ...over,
});
const finding = (n: number, over: Record<string, unknown> = {}) => ({
  id: `fnd_${String(n).padStart(20, "0")}`,
  origin_id: "contract.x",
  consumer_id: `job.c${n}`,
  consumer_kind: "job",
  consumer_owner: "team-a",
  severity: "high",
  direct: true,
  depth: 1,
  path: ["contract.x", `job.c${n}`],
  hops: [{ relation: "consumes", source_file: "m.yaml", source_line: n }],
  change_ids: [],
  reason: "because",
  ...over,
});

const CASES: [number, string, string][] = [
  [401, "UNAUTHENTICATED", "denied"],
  [403, "FORBIDDEN", "denied"],
  [404, "NOT_FOUND", "denied"],
  [409, "STALE_BASELINE", "failed"],
  [413, "PAYLOAD_TOO_LARGE", "failed"],
  [422, "SCHEMA_INVALID", "failed"],
  [429, "RATE_LIMITED", "failed"],
  [503, "NOT_READY", "failed"],
];

describe("ErrorView: denied and failed states", () => {
  const view = (error: unknown, extra: { onRetry?: () => void; onReload?: () => void } = {}) => render(<ErrorView error={error} {...extra} />);

  it("401, 403 and 404 are 'denied' with fixed wording that ignores the server message", () => {
    for (const [status, code, title] of [[401, "UNAUTHENTICATED", "Sign in required"], [403, "FORBIDDEN", "Not permitted"], [404, "NOT_FOUND", "Not found"]] as const) {
      const { unmount } = view(new ApiError(status, code, "SECRET-INTERNAL-DETAIL other-workspace object 123", "req-1"));
      const alert = screen.getByRole("alert");
      expect(alert.getAttribute("data-state")).toBe("denied");
      expect(alert.getAttribute("data-status")).toBe(String(status));
      expect(alert.textContent).toContain(title);
      expect(alert.textContent).not.toContain("SECRET-INTERNAL-DETAIL");
      expect(alert.textContent).toContain("req-1");
      unmount();
    }
    const a = view(new ApiError(404, "NOT_FOUND", "x")).container.textContent;
    const b = view(new ApiError(404, "NOT_FOUND", "a totally different message")).container.textContent;
    expect(a).toBe(b);
  });

  it("a failed sign in says nothing about which part was wrong", () => {
    view(new ApiError(401, "INVALID_CREDENTIALS", "no such account"));
    expect(screen.getByRole("alert").textContent).toContain("The email, password or workspace is not correct");
    expect(screen.getByRole("alert").textContent).not.toContain("no such account");
  });

  it("409 stale baseline names the current baseline and offers to use it; other conflicts show their message", () => {
    const reload = vi.fn();
    view(new ApiError(409, "STALE_BASELINE", "moved", "r", { current_baseline_snapshot_id: "snap-new", baseline_version: 5 }), { onReload: reload });
    expect(screen.getByRole("alert").textContent).toContain("The baseline changed");
    expect(screen.getByRole("alert").textContent).toContain("snap-new");
    fireEvent.click(screen.getByRole("button", { name: "Use the current baseline" }));
    expect(reload).toHaveBeenCalled();
    resetWeb();
    view(new ApiError(409, "IDEMPOTENCY_CONFLICT", "x"));
    expect(screen.getByRole("alert").textContent).toContain("Conflicting duplicate request");
    resetWeb();
    view(new ApiError(409, "CHECK_EXISTS", "a check with that key exists"));
    expect(screen.getByRole("alert").textContent).toContain("a check with that key exists");
  });

  it("413, 400 and unexpected errors are failed states; 422 lists issues with pointers, caps them and shows the reason", () => {
    view(new ApiError(413, "TOO_MANY_NODES", "too many"));
    expect(screen.getByRole("alert").textContent).toContain("Too large");
    resetWeb();
    view(new ApiError(400, "MALFORMED_JSON", "not json"));
    expect(screen.getByRole("alert").textContent).toContain("Invalid request. not json");
    resetWeb();
    view(new Error("boom"));
    expect(screen.getByRole("alert").getAttribute("data-status")).toBe("0");
    expect(screen.getByRole("alert").textContent).toContain("boom");
    resetWeb();
    view(new ApiError(500, "INTERNAL", "Internal error"));
    expect(screen.getByRole("alert").textContent).toContain("Something went wrong");
    resetWeb();
    const issues = Array.from({ length: 25 }, (_, i) => ({ path: `/nodes/${i}`, code: "SCHEMA_INVALID", message: `problem ${i}` }));
    view(new ApiError(422, "SCHEMA_INVALID", "invalid", "r", { issues, total_issues: 40, reason: "HOST_NOT_ALLOWED" }));
    const alert = screen.getByRole("alert");
    expect(alert.querySelectorAll("li")).toHaveLength(21);
    expect(alert.textContent).toContain("/nodes/0");
    expect(alert.textContent).toContain("and 20 more");
    expect(alert.textContent).toContain("Reason: HOST_NOT_ALLOWED");
    resetWeb();
    view(new ApiError(422, "SCHEMA_INVALID", "invalid", "r", { issues: [{ message: "bare" }] }));
    expect(screen.getByRole("alert").querySelectorAll("li")).toHaveLength(1);
  });

  it("429 disables Retry for the Retry-After seconds, then allows it; 503 and network failures can be retried at once", async () => {
    const retry = vi.fn();
    view(new ApiError(429, "RATE_LIMITED", "slow", "r", undefined, 1), { onRetry: retry });
    const button = screen.getByRole("button", { name: /Retry in 1s/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await waitFor(() => expect((screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement).disabled).toBe(false), { timeout: 4000 });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledTimes(1);
    resetWeb();
    const again = vi.fn();
    view(new ApiError(503, "NOT_READY", "starting"), { onRetry: again });
    expect(screen.getByRole("alert").textContent).toContain("Service unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(again).toHaveBeenCalled();
    resetWeb();
    view(new ApiError(0, "NETWORK_ERROR", "cannot reach"), { onRetry: retry });
    expect(screen.getByRole("alert").textContent).toContain("Cannot reach ChangeRadar");
    // A denied state never offers Retry.
    resetWeb();
    view(new ApiError(403, "FORBIDDEN", "x"), { onRetry: retry });
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("PagedFooter shows a further-page failure with retry and a plain end-of-list note", () => {
    const paged = { items: [1, 2], hasMore: true, loadingMore: false, moreError: new ApiError(503, "NOT_READY", "x"), loadMore: vi.fn() } as unknown as PagedState<number>;
    const { rerender } = render(<PagedFooter paged={paged} noun="things" />);
    expect(screen.getByRole("alert").textContent).toContain("Service unavailable");
    expect(screen.getByRole("button", { name: "Load more things" })).toBeTruthy();
    rerender(<PagedFooter paged={{ ...paged, moreError: null, loadingMore: true } as PagedState<number>} noun="things" />);
    expect((screen.getByRole("button", { name: "Loading…" }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<PagedFooter paged={{ ...paged, moreError: null, hasMore: false } as PagedState<number>} noun="things" />);
    expect(screen.getByText("All 2 things loaded.")).toBeTruthy();
    rerender(<PagedFooter paged={{ ...paged, moreError: null, hasMore: false, items: [] } as PagedState<number>} noun="things" />);
    expect(screen.queryByText(/loaded\./)).toBeNull();
  });
});

interface PageCase {
  name: string;
  role: Role;
  path: string;
  pattern?: string;
  element: (role: Role) => ReactElement;
  /** Heading that must render even when the data fails. */
  head?: string;
}
const PAGES: PageCase[] = [
  { name: "snapshots", role: "operator", path: "/snapshots", element: (r) => <SnapshotsPage user={users[r]} /> },
  { name: "snapshot detail", role: "operator", path: "/snapshots/abc", pattern: "/snapshots/:id", element: (r) => <SnapshotDetailPage user={users[r]} /> },
  { name: "impact runs", role: "operator", path: "/runs", element: (r) => <RunsPage user={users[r]} /> },
  { name: "new run", role: "operator", path: "/runs/new", element: (r) => <NewRunPage user={users[r]} /> },
  { name: "run detail", role: "viewer", path: "/runs/abc", pattern: "/runs/:id", element: (r) => <RunDetailPage user={users[r]} /> },
  { name: "checks", role: "operator", path: "/checks", element: (r) => <ChecksPage user={users[r]} /> },
  { name: "events", role: "operator", path: "/events", element: (r) => <EventsPage user={users[r]} /> },
  { name: "administration", role: "admin", path: "/admin", element: (r) => <AdminPage user={users[r]} /> },
];

describe.each(PAGES)("$name: loading, empty, denied and failed states (AC-07)", (p) => {
  const open = () => renderPage(p.element(p.role), p.path, p.pattern);

  it("shows a loading state while the data is on its way", async () => {
    mockAny(() => new Promise(() => undefined));
    open();
    expect((await screen.findAllByRole("status")).length).toBeGreaterThan(0);
    expect(document.querySelector('[data-state="loading"]')).toBeTruthy();
  });

  it.each(CASES)("status %i (%s) is a %s state that never leaks and never loops", async (status, code, kind) => {
    const { calls } = mockAny(apiError(status, code, "server message that must not decide the wording", { headers: status === 429 ? { "retry-after": "7" } : {} }));
    open();
    // The administration page loads three independent panels, so it shows one failed state for each.
    const alerts = await screen.findAllByRole("alert");
    expect(alerts.length).toBe(p.name === "administration" ? 3 : 1);
    for (const alert of alerts) {
      expect(alert.getAttribute("data-status")).toBe(String(status));
      expect(alert.getAttribute("data-state")).toBe(kind);
      expect(alert.textContent).toContain("req-test");
      if (kind === "denied") expect(alert.textContent).not.toContain("server message that must not decide");
    }
    // The failed request is not retried automatically (no request storm).
    const before = calls.length;
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.length).toBe(before);
  });

  it("shows a failed state for a network error", async () => {
    mockAny("network");
    open();
    const alerts = await screen.findAllByRole("alert");
    for (const alert of alerts) {
      expect(alert.getAttribute("data-status")).toBe("0");
      expect(alert.textContent).toContain("Cannot reach ChangeRadar");
    }
  });
});

describe("empty states", () => {
  const empty = () => mockAny({ body: { items: [], next_cursor: null } });

  it("snapshots, runs, checks, events and administration lists say what is missing and what to do", async () => {
    empty();
    renderPage(<SnapshotsPage user={users.operator} />, "/snapshots");
    expect(await screen.findByText("No snapshots yet")).toBeTruthy();
    resetWeb();
    empty();
    renderPage(<RunsPage user={users.viewer} />, "/runs");
    expect(await screen.findByText("No impact runs yet")).toBeTruthy();
    resetWeb();
    empty();
    renderPage(<ChecksPage user={users.admin} />, "/checks");
    expect(await screen.findByText("No contract checks configured")).toBeTruthy();
    expect(screen.getByText("Create one below.")).toBeTruthy();
    resetWeb();
    empty();
    renderPage(<EventsPage user={users.operator} />, "/events");
    expect(await screen.findByText("No events yet")).toBeTruthy();
    resetWeb();
    mockApi({ "GET /members?limit=100": page([]), "GET /audit?limit=100": page([]), "GET /settings": { body: { limits: { max_manifest_bytes: 1, max_nodes: 2, max_edges: 3 }, rate_limit: {}, checks: { allowed_hosts: [], allow_private_network: false, max_timeout_ms: 1, max_body_bytes: 1, max_redirects: 1 }, event_sink_configured: true, retention: { evidenceDays: 1, deletionHours: 2, backupExpiryDays: 3, enforced: true, note: "n" } } } });
    renderPage(<AdminPage user={users.admin} />, "/admin");
    expect(await screen.findByText("No members")).toBeTruthy();
    expect(await screen.findByText("No audit records yet")).toBeTruthy();
    expect(await screen.findByText(/empty: no live check can run/)).toBeTruthy();
    expect(screen.getByText(/configured$/)).toBeTruthy();
    expect(screen.getByText("Enforced.")).toBeTruthy();
  });

  it("an empty snapshot has no nodes or edges to show, and a run with no findings states its limits", async () => {
    mockApi({ "GET /snapshots/abc": { body: snapshot("abc", "empty-one", true) }, "GET /snapshots/abc/nodes?limit=100": page([]), "GET /snapshots/abc/edges?limit=100": page([]) });
    renderPage(<SnapshotDetailPage user={users.viewer} />, "/snapshots/abc", "/snapshots/:id");
    await screen.findByText("Snapshot empty-one");
    fireEvent.click(screen.getByRole("button", { name: "Nodes" }));
    expect(await screen.findByText("No nodes in this snapshot")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edges and graph" }));
    expect(await screen.findByText("No edges in this snapshot")).toBeTruthy();
  });

  it("the new-run page tells an empty workspace to import first", async () => {
    empty();
    renderPage(<NewRunPage user={users.operator} />, "/runs/new");
    expect(await screen.findByText("No baseline to assess against")).toBeTruthy();
  });
});

describe("run detail: states and polling", () => {
  const route = (over: Record<string, unknown>, findings: unknown[] = [finding(1)], next: string | null = null) => ({
    "GET /impact-runs/run-1": { body: runDetail(over) },
    "GET /impact-runs/run-1/findings?limit=100": page(findings, next),
  });
  const open = (role: Role = "viewer") => renderPage(<RunDetailPage user={users[role]} />, "/runs/run-1", "/runs/:id");

  it("follows a run from queued through running to complete and stops polling once it is terminal", async () => {
    let n = 0;
    const { calls } = mockAny((call) => {
      if (call.path.startsWith("/impact-runs/run-1/findings")) return page([finding(1)]);
      n += 1;
      return { body: runDetail(n === 1 ? { status: "queued", assessment: null, summary: null, coverage: null, finished_at: null } : n === 2 ? { status: "running", assessment: null, summary: null, coverage: null } : {}) };
    });
    open();
    const pending = await screen.findByText("PENDING");
    expect(pending.closest("section")?.getAttribute("data-verdict")).toBe("PENDING");
    expect(screen.getByText(/refreshes while the run is queued/)).toBeTruthy();
    expect(screen.queryByTestId("findings")).toBeNull();
    expect(screen.getByText(/Exports describe the finished run/)).toBeTruthy();
    await screen.findByText(/refreshes while the run is running/, {}, { timeout: 8000 });
    const verdict = await screen.findByText("AFFECTED", { selector: ".verdict-label" }, { timeout: 8000 });
    expect(verdict.closest("section")?.getAttribute("data-verdict")).toBe("AFFECTED");
    const runFetches = () => calls.filter((c) => c.path === "/impact-runs/run-1").length;
    expect(runFetches()).toBe(3);
    await new Promise((r) => setTimeout(r, 2500));
    expect(runFetches()).toBe(3);
  }, 30_000);

  it("a failed run shows no verdict, the error code with its plain-language reason, and no findings", async () => {
    for (const [code, help] of [["WORKER_EXHAUSTED", "kept failing"], ["INTEGRITY_FAILURE", "no longer matches"], ["TOO_MANY_CHECKS", "More contract checks"], ["RESTORED_UNFINISHED", "unfinished when a backup"], ["SOMETHING_NEW", ""]] as const) {
      mockApi(route({ status: "failed", assessment: null, summary: null, coverage: null, error: { code, detail: "detail text" } }));
      open();
      const banner = await screen.findByText("RUN FAILED");
      expect(banner.closest("section")?.getAttribute("data-verdict")).toBe("FAILED");
      const text = banner.closest("section")!.textContent!;
      expect(text).toContain(code);
      expect(text).toContain("detail text");
      expect(text).toContain("No verdict was produced");
      if (help) expect(text).toContain(help);
      expect(screen.queryByText("AFFECTED")).toBeNull();
      expect(screen.queryByTestId("findings")).toBeNull();
      resetWeb();
    }
    mockApi(route({ status: "failed", assessment: null, error: null }));
    open();
    expect(await screen.findByText("RUN FAILED")).toBeTruthy();
    // A finished run, even a failed one, can be exported.
    expect(screen.queryByText(/Exports describe the finished run/)).toBeNull();
  });

  it("a complete run whose assessment is missing is treated as pending, never as a pass", async () => {
    mockApi(route({ assessment: null, coverage: null }));
    open();
    expect((await screen.findByText("PENDING")).closest("section")?.getAttribute("data-verdict")).toBe("PENDING");
  });

  it("a missing coverage statement on a finished run says so instead of inventing limits", async () => {
    mockApi(route({ coverage: null }));
    open();
    expect(await screen.findByText(/No coverage statement exists/)).toBeTruthy();
  });

  it("INCOMPLETE without a known break says so; unknowns beyond the first page point at the JSON export", async () => {
    const unknowns = [
      { id: "unk_1", code: "MISSING_OWNER", node_id: "svc.a", edge: null, message: "no owner" },
      { id: "unk_2", code: "MYSTERY", node_id: null, edge: { source_id: "a", target_id: "b", relation: "consumes" }, message: "edge unknown" },
      { id: "unk_3", code: "OTHER", node_id: null, edge: null, message: "somewhere" },
    ];
    mockApi(route({ assessment: "INCOMPLETE", summary: { changes: 1, findings: 0, direct_findings: 0, transitive_findings: 0, unknowns: 250, known_impact: false }, unknowns, totals: { findings: 0, unknowns: 250 }, truncated: { findings: false, unknowns: true } }, []));
    open();
    const banner = await screen.findByText("INCOMPLETE", { selector: ".verdict-label" });
    expect(banner.closest("section")?.textContent).not.toContain("Known impact was also found");
    const table = await screen.findByTestId("unknowns");
    expect(table.textContent).toContain("Unknowns (250)");
    expect(table.textContent).toContain("Showing the first 3 of 250 unknowns");
    expect(table.textContent).toContain("a consumes");
    expect(table.textContent).toContain("not specific to one node");
    expect(await screen.findByText(/that does not mean nothing is affected/)).toBeTruthy();
  });

  it("a single known break is worded in the singular, and the verdict banner offers the count", async () => {
    mockApi(route({ assessment: "INCOMPLETE", summary: { changes: 1, findings: 1, direct_findings: 1, transitive_findings: 0, unknowns: 1, known_impact: true } }));
    open();
    expect((await screen.findByText(/Known impact was also found/)).parentElement?.textContent).toContain("1 consumer can break");
  });

  it("shows cycles, changes, contract checks in every state, the superseded note and the unknown owner marker", async () => {
    mockApi(
      route(
        {
          allow_superseded: true,
          cycles: [{ id: "cyc_1", members: ["a", "b"] }],
          changes: [{ id: "chg_1", kind: "node_removed", node_id: "a", description: "removed a" }, { id: "chg_2", kind: "x", node_id: "b", description: "d", propagation: "all" }],
          checks: [
            { check_key: "ok", node_id: "n", state: "PASSED", attempts: 1, detail: null, error_code: null, started_at: "t", finished_at: "t" },
            { check_key: "bad", node_id: "n", state: "UNKNOWN", attempts: null, detail: "restart", error_code: null, started_at: "t", finished_at: null },
            { check_key: "odd", node_id: "n", state: "SOMETHING", attempts: 2, detail: "?", error_code: null, started_at: "t", finished_at: null },
          ],
        },
        [finding(1, { consumer_owner: null, severity: "medium", direct: false, depth: 3, path: ["contract.x", "a", "job.c1"], hops: [{ relation: "consumes", source_file: "m", source_line: 1 }] })],
      ),
    );
    open("operator");
    await screen.findByTestId("cycles");
    expect(screen.getByText(/no longer the workspace baseline/)).toBeTruthy();
    expect(screen.getByText("Detected changes (2)")).toBeTruthy();
    const checks = screen.getByTestId("checks");
    expect(within(checks).getByText("PASSED").className).toContain("badge-neutral");
    expect(within(checks).getByText("UNKNOWN").className).toContain("badge-warn");
    expect(checks.textContent).toContain("outcome cannot be known");
    expect((await screen.findAllByText("owner unknown")).length).toBeGreaterThan(0);
    expect(screen.getByText(/MEDIUM transitive \(depth 3\)/)).toBeTruthy();
    expect(screen.getByText(/in a dependency cycle/, { exact: false })).toBeTruthy;
  });

  it("findings that cannot load are a failed state with retry; a later page that fails keeps the first page", async () => {
    let fail = true;
    mockAny((call) => {
      if (call.path === "/impact-runs/run-1") return { body: runDetail({ totals: { findings: 150, unknowns: 0 } }) };
      if (call.path.includes("cursor=c2")) return apiError(503, "NOT_READY", "later page down");
      if (fail) return apiError(503, "NOT_READY", "down");
      return page([finding(1)], "c2");
    });
    open();
    const findings = await screen.findByTestId("findings");
    const alert = await within(findings).findByRole("alert");
    expect(alert.getAttribute("data-status")).toBe("503");
    fail = false;
    fireEvent.click(within(findings).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(findings.querySelectorAll("tr[data-finding-id]").length).toBe(1));
    fireEvent.click(screen.getByRole("button", { name: "Load more findings" }));
    await waitFor(() => expect(within(findings).getByRole("alert").getAttribute("data-status")).toBe("503"));
    expect(findings.querySelectorAll("tr[data-finding-id]").length).toBe(1);
  });

  // Round 2 (logic P2, evidence.ts:385): a run assessed by an older engine says so.
  it("a run assessed by an older engine shows the re-run note; a current one shows none", async () => {
    mockApi(route({ engine: { version: 1, current: 2, rerun_required: true, note: "assessed by an older decision engine (version 1, this build is 2): re-run required, the verdict below may differ today" } }));
    renderPage(<RunDetailPage user={users.viewer} />, "/runs/run-1", "/runs/:id");
    const note = await screen.findByText(/assessed by an older decision engine/);
    expect(note.getAttribute("role")).toBe("alert");
    expect(note.textContent).toContain("re-run required");
  });

  // Round 4 (logic P2): an older engine's verdict is never shown as a current one on the run page.
  const stale = { assessment: null, recorded_assessment: "NO_KNOWN_IMPACT", engine: { version: 1, current: 3, rerun_required: true, note: "assessed by an older decision engine (version 1, this build is 3): re-run required; the recorded verdict is history and must not be read as a current answer" } };

  it("a run from an older engine gets a RE-RUN REQUIRED banner, never a verdict banner, and names the recorded verdict only as history", async () => {
    mockApi(route(stale, []));
    renderPage(<RunDetailPage user={users.viewer} />, "/runs/run-1", "/runs/:id");
    const banner = await screen.findByText("RE-RUN REQUIRED");
    const section = banner.closest("section") as HTMLElement;
    expect(section.getAttribute("data-verdict")).toBe("STALE_ENGINE");
    expect(section.getAttribute("role")).toBe("alert");
    expect(section.textContent).toContain("NO_KNOWN_IMPACT");
    expect(section.textContent).toContain("history");
    expect(document.querySelector('[data-verdict="NO_KNOWN_IMPACT"]')).toBeNull();
    expect(document.querySelector('[data-verdict="PENDING"]')).toBeNull();
  });

  it("the findings panel of such a run does not say that no declared consumer is affected", async () => {
    mockApi(route(stale, []));
    renderPage(<RunDetailPage user={users.viewer} />, "/runs/run-1", "/runs/:id");
    const panel = await screen.findByTestId("findings");
    await waitFor(() => expect(panel.textContent).toContain("As assessed by the older engine"));
    expect(document.body.textContent).not.toContain("No declared consumer is affected");
  });

  it("control: a current run keeps its verdict banner", async () => {
    mockApi(route({ assessment: "NO_KNOWN_IMPACT", recorded_assessment: null, engine: { version: 3, current: 3, rerun_required: false } }, []));
    renderPage(<RunDetailPage user={users.viewer} />, "/runs/run-1", "/runs/:id");
    await screen.findByTestId("findings");
    expect(document.querySelector('[data-verdict="NO_KNOWN_IMPACT"]')).not.toBeNull();
    expect(document.querySelector('[data-verdict="STALE_ENGINE"]')).toBeNull();
  });

  it("control: a current engine stamp shows no note", async () => {
    mockApi(route({ engine: { version: 2, current: 2, rerun_required: false } }));
    renderPage(<RunDetailPage user={users.viewer} />, "/runs/run-1", "/runs/:id");
    await screen.findByTestId("findings");
    expect(screen.queryByText(/older decision engine/)).toBeNull();
  });
});

describe("the run list marks a run from an older engine (round 3)", () => {
  const summary = (id: string, over: Record<string, unknown> = {}) => ({
    id, status: "complete", assessment: "NO_KNOWN_IMPACT", proposed_hash: "sha256:" + "a".repeat(64), created_at: "2026-01-01T00:00:00.000Z", rerun_required: false, ...over,
  });

  it("shows 'Re-run required' instead of the recorded verdict for that run only", async () => {
    mockApi({ "GET /impact-runs?limit=50": page([summary("run-old", { rerun_required: true }), summary("run-new")]) });
    renderPage(<RunsPage user={users.viewer} />, "/runs");
    const rows = (await screen.findAllByRole("row")).slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("Re-run required");
    expect(rows[0]!.textContent).not.toContain("NO KNOWN IMPACT");
    expect(rows[0]!.querySelector("[role=status]")).not.toBeNull();
    expect(rows[1]!.textContent).not.toContain("Re-run required");
    expect(rows[1]!.textContent).toContain("NO KNOWN IMPACT");
  });

  it("an older API that does not send the flag shows the verdict as before", async () => {
    const { rerun_required: _omit, ...legacy } = summary("run-legacy");
    mockApi({ "GET /impact-runs?limit=50": page([legacy]) });
    renderPage(<RunsPage user={users.viewer} />, "/runs");
    const rows = (await screen.findAllByRole("row")).slice(1);
    expect(rows[0]!.textContent).not.toContain("Re-run required");
    expect(rows[0]!.textContent).toContain("NO KNOWN IMPACT");
  });
});

describe("import and new-run forms: every failure the API can answer, with the same idempotency key on retry", () => {
  const fill = (revision = "r1", text = '{"nodes":[],"edges":[]}') => {
    fireEvent.change(screen.getByLabelText("Revision label"), { target: { value: revision } });
    fireEvent.change(screen.getByLabelText(/Manifest \(JSON\)/), { target: { value: text } });
    fireEvent.submit(screen.getByRole("form", { name: "Import snapshot" }));
  };

  it.each([[413, "PAYLOAD_TOO_LARGE"], [422, "SCHEMA_INVALID"], [429, "RATE_LIMITED"], [503, "NOT_READY"], [409, "IDEMPOTENCY_CONFLICT"], [403, "FORBIDDEN"]])("import answered %i is shown, keeps the form, and creates no receipt", async (status, code) => {
    mockAny(apiError(status, code, "no", { headers: status === 429 ? { "retry-after": "3" } : {} }));
    renderPage(<ImportSnapshotPage user={users.operator} />, "/snapshots/import");
    fill();
    const alert = await alertOf();
    expect(alert.getAttribute("data-status")).toBe(String(status));
    expect(screen.queryByTestId("import-receipt")).toBeNull();
    expect((screen.getByLabelText("Revision label") as HTMLInputElement).value).toBe("r1");
    expect((screen.getByRole("button", { name: "Import snapshot" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("re-sending the same body after a 503 reuses the Idempotency-Key; a changed body gets a new one", async () => {
    let n = 0;
    const { calls } = mockAny(() => {
      n += 1;
      return n === 1 ? apiError(503, "NOT_READY", "down") : { status: 201, body: { ...snapshot("s1", "r1", true), warnings: [{ code: "MISSING_OWNER", message: "no owner", count: 2, sample_ids: ["a", "b"] }] } };
    });
    renderPage(<ImportSnapshotPage user={users.operator} />, "/snapshots/import");
    fill();
    await alertOf();
    fireEvent.submit(screen.getByRole("form", { name: "Import snapshot" }));
    await screen.findByTestId("import-receipt");
    const keys = calls.filter((c) => c.method === "POST").map((c) => c.headers["idempotency-key"]);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(screen.getByText(/MISSING_OWNER/)).toBeTruthy();
    // After success the key is forgotten; the next import gets a fresh one.
    fill("r2", '{"nodes":[],"edges":[{"x":1}]}');
    await waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(3));
    const third = calls.filter((c) => c.method === "POST")[2]!.headers["idempotency-key"];
    expect(third).not.toBe(keys[0]);
  });

  it("the warning list handles a receipt with none", async () => {
    mockAny({ status: 201, body: { ...snapshot("s1", "r1", true), warnings: [] } });
    renderPage(<ImportSnapshotPage user={users.admin} />, "/snapshots/import");
    fill();
    expect((await screen.findByTestId("import-receipt")).textContent).toContain("No warnings.");
  });

  it("new run: rate limiting, unknown-baseline recovery and a failing baseline reload are all shown", async () => {
    const snaps = [snapshot("s-old", "old", false), snapshot("s-new", "new", true)];
    let baselineFails = true;
    const { calls } = mockAny((call) => {
      if (call.method === "GET" && call.path.startsWith("/snapshots")) return page(snaps);
      if (call.path === "/baseline") return baselineFails ? apiError(503, "NOT_READY", "down") : { body: { snapshot: snaps[1] } };
      return apiError(409, "STALE_BASELINE", "moved", { details: { current_baseline_snapshot_id: "s-new", baseline_version: 3 } });
    });
    renderPage(<NewRunPage user={users.operator} />, "/runs/new?snapshot=s-old");
    const select = (await screen.findByLabelText("Assess against snapshot")) as HTMLSelectElement;
    expect(select.value).toBe("s-old");
    expect(screen.getByTestId("superseded-note")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Proposed manifest/), { target: { value: "{}" } });
    fireEvent.submit(screen.getByRole("form", { name: "New impact run" }));
    await waitFor(() => expect(screen.getByRole("alert").getAttribute("data-code")).toBe("STALE_BASELINE"));
    const post = JSON.parse(calls.find((c) => c.method === "POST")!.body!) as Record<string, unknown>;
    expect(post).toMatchObject({ snapshot_id: "s-old", expected_hash: H("b"), allow_superseded: false });
    // Reloading the baseline fails first: the failure is shown, nothing is selected by guesswork.
    fireEvent.click(screen.getByRole("button", { name: "Use the current baseline" }));
    await waitFor(() => expect(screen.getByRole("alert").getAttribute("data-status")).toBe("503"));
    expect((screen.getByLabelText("Assess against snapshot") as HTMLSelectElement).value).toBe("s-old");
    // Retry re-sends the request (refused again as stale). The user asked to reload, so the request gets a fresh key.
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(2));
    await waitFor(() => expect(screen.getByRole("alert").getAttribute("data-code")).toBe("STALE_BASELINE"));
    baselineFails = false;
    fireEvent.click(screen.getByRole("button", { name: "Use the current baseline" }));
    await waitFor(() => expect((screen.getByLabelText("Assess against snapshot") as HTMLSelectElement).value).toBe("s-new"));
    // Choosing another snapshot clears the opt-in; the checks box toggles run_checks.
    fireEvent.change(screen.getByLabelText("Assess against snapshot"), { target: { value: "s-old" } });
    expect(screen.getByTestId("superseded-note")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Assess against snapshot"), { target: { value: "s-new" } });
    expect(screen.queryByTestId("superseded-note")).toBeNull();
    fireEvent.click(screen.getByLabelText(/Run the enabled live contract checks/));
    expect((screen.getByLabelText(/Run the enabled live contract checks/) as HTMLInputElement).checked).toBe(false);
  });

  it("new run: with no baseline flag the first snapshot is selected, and more than 100 snapshots are mentioned", async () => {
    mockAny((call) => (call.path.startsWith("/snapshots") ? page([snapshot("s-1", "one", false)], "more") : { body: {} }));
    renderPage(<NewRunPage user={users.operator} />, "/runs/new");
    const select = (await screen.findByLabelText("Assess against snapshot")) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("s-1"));
    expect(screen.getByText(/newest 100 snapshots/)).toBeTruthy();
  });

  it("new run: a run that is accepted moves to its page (202 receipt)", async () => {
    mockAny((call) => {
      if (call.method === "POST") return { status: 202, body: { id: "run-9", status: "queued" } };
      return call.path.startsWith("/snapshots") ? page([snapshot("s-new", "new", true)]) : { body: {} };
    });
    renderPage(<NewRunPage user={users.admin} />, "/runs/new", "/runs/new");
    await screen.findByLabelText("Assess against snapshot");
    await waitFor(() => expect((screen.getByLabelText("Assess against snapshot") as HTMLSelectElement).value).toBe("s-new"));
    fireEvent.change(screen.getByLabelText(/Proposed manifest/), { target: { value: "{}" } });
    fireEvent.submit(screen.getByRole("form", { name: "New impact run" }));
    expect(await screen.findByText("navigated elsewhere")).toBeTruthy();
  });

  it("new run: an id in the link that is not in the list falls back to the baseline instead of a blank choice", async () => {
    mockAny((call) => (call.path.startsWith("/snapshots") ? page([snapshot("s-1", "one", true)]) : { body: {} }));
    renderPage(<NewRunPage user={users.operator} />, "/runs/new?snapshot=not-listed");
    const select = (await screen.findByLabelText("Assess against snapshot")) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("s-1"));
  });
});

describe("checks and administration: failures of individual actions", () => {
  const check = (over: Record<string, unknown> = {}) => ({ id: "c1", key: "k1", node_id: "n1", url: "http://localhost/x", method: "GET", timeout_ms: 1000, retries: 1, expect_status: 200, required_fields: [], credential_alias: null, credential_configured: false, enabled: true, created_at: "t", disabled_at: null, ...over });

  it("a failing disable is shown and leaves the list alone; a credential alias without a stored value is called out", async () => {
    mockApi({
      "GET /contract-checks?limit=50": page([check({ credential_alias: "cred.x" }), check({ id: "c2", key: "k2", credential_alias: "cred.y", credential_configured: true }), check({ id: "c3", key: "k3", enabled: false, disabled_at: "2026-09-29T00:00:00Z" })]),
      "POST /contract-checks/c1/disable": apiError(503, "NOT_READY", "down"),
    });
    renderPage(<ChecksPage user={users.admin} />, "/checks");
    fireEvent.click(await screen.findByRole("button", { name: "Disable k1" }));
    expect((await alertOf()).getAttribute("data-status")).toBe("503");
    expect(screen.getByText(/has no stored value/)).toBeTruthy();
    expect(screen.getByText(/alias cred.y \(configured\)/)).toBeTruthy();
    expect(screen.getByText(/disabled 2026-09-29/)).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /Disable/ })).toHaveLength(2);
  });

  it("creating a check reports the API's 409 and clears nothing; empty and valid optional fields are handled", async () => {
    const { calls } = mockAny((call) => (call.method === "POST" ? apiError(409, "CHECK_EXISTS", "a check with this key exists") : page([])));
    renderPage(<ChecksPage user={users.admin} />, "/checks");
    await screen.findByText("No contract checks configured");
    for (const [label, value] of [["Key", "k"], ["Node id", "n"], ["URL", "http://localhost/x"], ["Credential alias (optional)", "cred.x"]] as const) fireEvent.change(screen.getByLabelText(label), { target: { value } });
    fireEvent.change(screen.getByLabelText(/Required response fields/), { target: { value: "id:string\n\namount" } });
    fireEvent.submit(screen.getByRole("form", { name: "New contract check" }));
    expect((await alertOf()).textContent).toContain("a check with this key exists");
    const body = JSON.parse(calls.find((c) => c.method === "POST")!.body!) as Record<string, unknown>;
    expect(body).toMatchObject({ key: "k", credential_alias: "cred.x", required_fields: [{ name: "id", type: "string" }, { name: "amount", type: "string" }], method: "GET", timeout_ms: 5000 });
  });

  it("each administration panel fails on its own and can be retried", async () => {
    let membersUp = false;
    mockApi({
      "GET /members?limit=100": () => (membersUp ? page([{ user_id: "u1", email: "a@example.test", role: "admin" }]) : apiError(503, "NOT_READY", "down")),
      "GET /settings": apiError(403, "FORBIDDEN", "no"),
      "GET /audit?limit=100": page([{ seq: 1, actor_type: "user", actor_id: null, action: "x.y", resource_type: "t", resource_id: "r", created_at: "2026-09-29T00:00:00Z", metadata: null }, { seq: 2, actor_type: "user", actor_id: "u1", action: "z", resource_type: "t", resource_id: "r2", created_at: "2026-09-29T00:00:00Z", metadata: { a: 1 } }]),
    });
    renderPage(<AdminPage user={users.admin} />, "/admin");
    await screen.findByText("x.y");
    const alerts = await screen.findAllByRole("alert");
    expect(alerts.map((a) => a.getAttribute("data-status")).sort()).toEqual(["403", "503"]);
    membersUp = true;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("a@example.test")).toBeTruthy();
  });

  it("a viewer or operator reaches no administration and a viewer no events or checks, and no request is made", async () => {
    const { calls } = mockAny({ body: {} });
    renderPage(<AdminPage user={users.operator} />, "/admin");
    expect((await alertOf()).getAttribute("data-status")).toBe("403");
    resetWeb();
    const second = mockAny({ body: {} });
    renderPage(<EventsPage user={users.viewer} />, "/events");
    expect((await alertOf()).getAttribute("data-status")).toBe("403");
    resetWeb();
    const third = mockAny({ body: {} });
    renderPage(<ChecksPage user={users.viewer} />, "/checks");
    expect((await alertOf()).getAttribute("data-status")).toBe("403");
    expect(calls.length + second.calls.length + third.calls.length).toBe(0);
  });
});

describe("snapshot detail: further pages", () => {
  it("a node page that fails to load more keeps what was loaded; edges beyond the drawing cap say the drawing is partial", async () => {
    const nodes = Array.from({ length: 2 }, (_, i) => ({ id: `svc.n${i}`, kind: "service", owner: i ? null : "team", version: "1", placeholder: i === 1 }));
    const edges = Array.from({ length: 70 }, (_, i) => ({ source_id: `n${i}`, target_id: `n${i + 1}`, relation: "consumes", source_file: "f", source_line: 1, verified_at: null }));
    mockAny((call) => {
      if (call.path === "/snapshots/abc") return { body: { ...snapshot("abc", "big", true), edge_count: 500, warnings: [{ code: "W", message: "m", count: 1, sample_ids: [] }] } };
      if (call.path.includes("/nodes") && call.path.includes("cursor=")) return apiError(503, "NOT_READY", "down");
      if (call.path.includes("/nodes")) return page(nodes, "next");
      return page(edges, "more-edges");
    });
    renderPage(<SnapshotDetailPage user={users.operator} />, "/snapshots/abc", "/snapshots/:id");
    await screen.findByText("Snapshot big");
    fireEvent.click(screen.getByRole("button", { name: "Nodes" }));
    await screen.findByText("svc.n0");
    expect(screen.getByText("placeholder")).toBeTruthy();
    expect(screen.getByText("owner unknown")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load more nodes" }));
    await waitFor(() => expect(screen.getByRole("alert").getAttribute("data-status")).toBe("503"));
    expect(screen.getByText("svc.n1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edges and graph" }));
    const graph = await screen.findByTestId("graph");
    expect(graph.textContent).toMatch(/Drawing the first \d+ of 70 edges/);
    expect(screen.getByText(/previews the 70 loaded of 500 edges/)).toBeTruthy();
  });
});
