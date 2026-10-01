import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, bundleUrl, exportUrl, formatTime, idempotencyFor, loadSession, manifestUrl, onUnauthorized, setCsrfToken, shortHash, signIn, signOut, withQuery } from "../../src/web/api";
import { edgesGraphModel, GraphView, impactGraphModel, MAX_GRAPH_NODES } from "../../src/web/graph";
import { toApiError, usePaged, useResource } from "../../src/web/hooks";
import type { EdgeRow, Finding } from "../../src/web/types";
import { apiError, mockAny, mockApi, page, resetWeb } from "./support";

afterEach(resetWeb);

describe("api client", () => {
  it("sends the CSRF token and idempotency key on mutations only, JSON content type only with a body, and same-origin credentials", async () => {
    setCsrfToken("csrf-1");
    const { fetchMock } = mockAny({ body: { ok: true } });
    await api("GET", "/things");
    await api("POST", "/things", { a: 1 }, { idempotencyKey: "ui-key-1" });
    await api("POST", "/nothing");
    const [get, post, bare] = fetchMock.mock.calls.map(([url, init]) => ({ url, init: init as RequestInit }));
    expect(get!.url).toBe("/api/v1/things");
    expect((get!.init.headers as Record<string, string>)["x-csrf-token"]).toBeUndefined();
    expect((get!.init.headers as Record<string, string>)["content-type"]).toBeUndefined();
    expect(get!.init.credentials).toBe("same-origin");
    expect(post!.init.headers).toMatchObject({ "x-csrf-token": "csrf-1", "idempotency-key": "ui-key-1", "content-type": "application/json" });
    expect(post!.init.body).toBe('{"a":1}');
    expect((bare!.init.headers as Record<string, string>)["content-type"]).toBeUndefined();
    expect(bare!.init.body).toBeUndefined();
  });

  it("maps an error envelope, a missing envelope, an unreadable body and a network failure", async () => {
    mockAny(apiError(422, "SCHEMA_INVALID", "bad", { details: { issues: [] }, headers: { "retry-after": "12" } }));
    const e1 = (await api("GET", "/x").catch((e: unknown) => e)) as ApiError;
    expect(e1).toBeInstanceOf(ApiError);
    expect([e1.status, e1.code, e1.message, e1.requestId, e1.retryAfterSeconds]).toEqual([422, "SCHEMA_INVALID", "bad", "req-test", 12]);
    expect(e1.details).toEqual({ issues: [] });
    mockAny({ status: 500, raw: "" });
    const e2 = (await api("GET", "/x").catch((e: unknown) => e)) as ApiError;
    expect([e2.status, e2.code, e2.message, e2.retryAfterSeconds]).toEqual([500, "ERROR", "HTTP 500", undefined]);
    mockAny({ status: 502, raw: "<html>bad gateway</html>" });
    const e3 = (await api("GET", "/x").catch((e: unknown) => e)) as ApiError;
    expect([e3.status, e3.code]).toEqual([502, "ERROR"]);
    mockAny({ status: 200, raw: "<html>" });
    const e4 = (await api("GET", "/x").catch((e: unknown) => e)) as ApiError;
    expect([e4.status, e4.code]).toEqual([200, "INVALID_RESPONSE"]);
    mockAny({ status: 400, body: { error: { code: 5, message: 7 } } });
    const e5 = (await api("GET", "/x").catch((e: unknown) => e)) as ApiError;
    expect([e5.code, e5.message]).toEqual(["ERROR", "HTTP 400"]);
    mockAny({ status: 400, body: null });
    expect(((await api("GET", "/x").catch((e: unknown) => e)) as ApiError).message).toBe("HTTP 400");
    mockAny("network");
    const e6 = (await api("GET", "/x").catch((e: unknown) => e)) as ApiError;
    expect([e6.status, e6.code]).toEqual([0, "NETWORK_ERROR"]);
    mockAny({ status: 200, raw: "" });
    expect(await api("GET", "/empty")).toBeNull();
  });

  it("a 401 from an authenticated call notifies the session listener; a failed login does not", async () => {
    const listener = vi.fn();
    onUnauthorized(listener);
    mockAny(apiError(401, "UNAUTHENTICATED", "no"));
    await api("GET", "/snapshots").catch(() => undefined);
    expect(listener).toHaveBeenCalledTimes(1);
    mockAny(apiError(401, "INVALID_CREDENTIALS", "no"));
    await api("POST", "/auth/login", {}).catch(() => undefined);
    expect(listener).toHaveBeenCalledTimes(1);
    onUnauthorized(null);
    await api("GET", "/snapshots").catch(() => undefined);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("loadSession, signIn and signOut keep the CSRF token in step with the session", async () => {
    const { calls } = mockApi({
      "GET /auth/session": { body: { user: { id: "u", email: "e", workspace_id: "w", workspace_name: "W", role: "viewer" }, csrf_token: "tok-a" } },
      "POST /auth/login": { body: { user: { id: "u", email: "e", workspace_id: "w", workspace_name: "W", role: "admin" }, csrf_token: "tok-b" } },
      "POST /auth/logout": { body: { ok: true } },
    });
    expect((await loadSession())?.role).toBe("viewer");
    expect((await signIn("a@example.test", "pw", "ws-1")).role).toBe("admin");
    expect(JSON.parse(calls.at(-1)!.body!)).toEqual({ email: "a@example.test", password: "pw", workspace_id: "ws-1" });
    await signIn("a@example.test", "pw");
    expect(JSON.parse(calls.at(-1)!.body!)).toEqual({ email: "a@example.test", password: "pw" });
    await signOut();
    expect(calls.at(-1)!.headers["x-csrf-token"]).toBe("tok-b");
    await api("POST", "/auth/logout");
    expect(calls.at(-1)!.headers["x-csrf-token"]).toBeUndefined();
    // Sign out clears the token even when the server call fails.
    setCsrfToken("still-set");
    mockAny(apiError(503, "NOT_READY", "down"));
    await signOut().catch(() => undefined);
    mockAny({ body: {} });
    await api("POST", "/x");
    expect((vi.mocked(fetch).mock.calls.at(-1)![1] as RequestInit).headers).not.toHaveProperty("x-csrf-token");
  });

  it("loadSession treats 401 as 'not signed in' and reports every other failure", async () => {
    mockAny(apiError(401, "UNAUTHENTICATED", "no"));
    expect(await loadSession()).toBeNull();
    mockAny(apiError(503, "NOT_READY", "down"));
    await expect(loadSession()).rejects.toMatchObject({ status: 503 });
  });

  it("formats queries, links, times and hashes", () => {
    expect(withQuery("/a", {})).toBe("/a");
    expect(withQuery("/a", { limit: 5, cursor: "x y", none: null, unset: undefined, blank: "" })).toBe("/a?limit=5&cursor=x%20y");
    expect(withQuery("/a?x=1", { y: 2 })).toBe("/a?x=1&y=2");
    expect(exportUrl("r 1", "html")).toBe("/api/v1/impact-runs/r%201/export?format=html");
    expect(bundleUrl("r1")).toBe("/api/v1/impact-runs/r1/bundle");
    expect(manifestUrl("s1")).toBe("/api/v1/snapshots/s1/manifest");
    expect(formatTime("2026-09-29T07:30:06.123Z")).toBe("2026-09-29 07:30:06Z");
    expect(formatTime(null)).toBe("—");
    expect(formatTime("")).toBe("—");
    expect(formatTime("not a date")).toBe("—");
    expect(shortHash("sha256:" + "a".repeat(64))).toBe("sha256:aaaaaaaaaaaa…");
    expect(shortHash("abcdef")).toBe("abcdef");
    expect(shortHash("x".repeat(30))).toBe("xxxxxxxxxxxx…");
    expect(shortHash("")).toBe("—");
    expect(shortHash(undefined)).toBe("—");
  });

  it("idempotency keys are stable for one body and change with the body, and match the API's allowed alphabet", () => {
    const idem = idempotencyFor();
    const a = idem.keyFor("body-1");
    expect(idem.keyFor("body-1")).toBe(a);
    const b = idem.keyFor("body-2");
    expect(b).not.toBe(a);
    idem.reset();
    expect(idem.keyFor("body-2")).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9._:-]{1,128}$/);
  });

  it("idempotency keys still work without crypto.randomUUID or getRandomValues", () => {
    const original = globalThis.crypto;
    const keys: string[] = [];
    for (const fake of [{ getRandomValues: (a: Uint8Array) => a.fill(7) }, {}, undefined]) {
      Object.defineProperty(globalThis, "crypto", { value: fake, configurable: true });
      keys.push(idempotencyFor().keyFor("b"));
    }
    Object.defineProperty(globalThis, "crypto", { value: original, configurable: true });
    for (const k of keys) expect(k).toMatch(/^ui-[0-9a-f]{32}$/);
    expect(keys[0]).toBe(`ui-${"07".repeat(16)}`);
  });
});

describe("hooks", () => {
  it("toApiError wraps anything that is not already an ApiError", () => {
    const e = new ApiError(404, "NOT_FOUND", "x");
    expect(toApiError(e)).toBe(e);
    expect(toApiError(new Error("boom")).message).toBe("boom");
    expect(toApiError("text").message).toBe("Unexpected error");
    expect(toApiError(new Error("boom")).code).toBe("UNEXPECTED");
  });

  it("useResource loads, polls while the callback says so, stops when it says null, and reloads on demand", async () => {
    let n = 0;
    mockAny(() => ({ body: { n: (n += 1) } }));
    const { result, unmount } = renderHook(() => useResource<{ n: number }>("/thing", (d) => (d.n < 3 ? 5 : null)));
    expect(result.current[0].status).toBe("loading");
    await waitFor(() => expect(result.current[0]).toEqual({ status: "ready", data: { n: 3 } }));
    await act(async () => new Promise((r) => setTimeout(r, 40)));
    expect(n).toBe(3);
    act(() => result.current[1]());
    await waitFor(() => expect(n).toBe(4));
    unmount();
    await new Promise((r) => setTimeout(r, 20));
    expect(n).toBe(4);
  });

  it("useResource with no path loads nothing; an error stops polling and can be retried; a stale answer is ignored", async () => {
    const { fetchMock } = mockAny({ body: {} });
    const idle = renderHook(() => useResource<unknown>(null));
    expect(idle.result.current[0].status).toBe("loading");
    act(() => idle.result.current[1]());
    expect(fetchMock).not.toHaveBeenCalled();
    idle.unmount();
    let fail = true;
    mockAny(() => (fail ? apiError(503, "NOT_READY", "down") : { body: { ok: 1 } }));
    const { result } = renderHook(() => useResource<{ ok: number }>("/thing", () => 5));
    await waitFor(() => expect(result.current[0].status).toBe("error"));
    fail = false;
    act(() => result.current[1]());
    await waitFor(() => expect(result.current[0]).toEqual({ status: "ready", data: { ok: 1 } }));
    // A response that arrives after the path changed is dropped.
    let release: (() => void) | undefined;
    mockAny(async (call) => {
      if (call.path === "/slow") await new Promise<void>((r) => (release = r));
      return { body: { path: call.path } };
    });
    const swap = renderHook(({ path }) => useResource<{ path: string }>(path), { initialProps: { path: "/slow" } });
    swap.rerender({ path: "/fast" });
    await waitFor(() => expect(swap.result.current[0]).toEqual({ status: "ready", data: { path: "/fast" } }));
    release?.();
    await new Promise((r) => setTimeout(r, 20));
    expect(swap.result.current[0]).toEqual({ status: "ready", data: { path: "/fast" } });
  });

  it("usePaged loads a first page, follows the cursor, appends, reloads and ignores extra clicks", async () => {
    const { calls } = mockAny((call) => (call.path.includes("cursor=c1") ? page([3, 4]) : page([1, 2], "c1")));
    const { result } = renderHook(() => usePaged<number>("/nums", { kind: "odd" }, 2));
    expect(result.current.status).toBe("loading");
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(calls[0]!.path).toBe("/nums?kind=odd&limit=2");
    expect(result.current.items).toEqual([1, 2]);
    expect(result.current.hasMore).toBe(true);
    act(() => {
      result.current.loadMore();
      result.current.loadMore();
    });
    await waitFor(() => expect(result.current.items).toEqual([1, 2, 3, 4]));
    expect(calls.filter((c) => c.path.includes("cursor=c1"))).toHaveLength(1);
    expect(result.current.hasMore).toBe(false);
    act(() => result.current.loadMore());
    expect(calls).toHaveLength(2);
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.items).toEqual([1, 2]));
  });

  it("usePaged reports a failing first page and a failing further page separately, and does nothing without a path", async () => {
    mockAny(apiError(503, "NOT_READY", "down"));
    const first = renderHook(() => usePaged<number>("/nums"));
    await waitFor(() => expect(first.result.current.status).toBe("error"));
    expect(first.result.current.error?.status).toBe(503);
    first.unmount();
    mockAny((call) => (call.path.includes("cursor=") ? apiError(429, "RATE_LIMITED", "slow") : page([1], "c")));
    const later = renderHook(() => usePaged<number>("/nums"));
    await waitFor(() => expect(later.result.current.status).toBe("ready"));
    act(() => later.result.current.loadMore());
    await waitFor(() => expect(later.result.current.moreError?.status).toBe(429));
    expect(later.result.current.items).toEqual([1]);
    expect(later.result.current.hasMore).toBe(true);
    later.unmount();
    const { fetchMock } = mockAny({ body: {} });
    const none = renderHook(() => usePaged<number>(null));
    act(() => none.result.current.reload());
    act(() => none.result.current.loadMore());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(none.result.current.items).toEqual([]);
  });
});

const finding = (id: string, path: string[], over: Partial<Finding> = {}): Finding => ({
  id,
  origin_id: path[0]!,
  consumer_id: path.at(-1)!,
  consumer_kind: "job",
  consumer_owner: "team",
  severity: "high",
  direct: path.length === 2,
  depth: path.length - 1,
  path,
  hops: path.slice(1).map((to, i) => ({ relation: "consumes", from: path[i]!, to })),
  change_ids: [],
  reason: "r",
  ...over,
});

describe("graph model and drawing", () => {
  it("lays paths out one column per hop, merges shared nodes at their earliest column, and marks origins, consumers and cycles", () => {
    const model = impactGraphModel(
      [finding("f1", ["c", "a", "x"], { consumer_owner: null }), finding("f2", ["c", "a"], { direct: true }), finding("f3", ["c", "b"], { direct: true })],
      [{ id: "cyc_1", members: ["a", "b"] }],
    );
    const node = (id: string) => model.nodes.find((n) => n.id === id)!;
    expect(node("c")).toMatchObject({ col: 0, origin: true, consumer: false });
    expect(node("a")).toMatchObject({ col: 1, consumer: true, direct: true, inCycle: true });
    expect(node("x")).toMatchObject({ col: 2, consumer: true, owner: null, direct: false });
    expect(node("b")).toMatchObject({ col: 1, consumer: true, owner: "team" });
    expect(model.edges.map((e) => `${e.from}>${e.to}`).sort()).toEqual(["a>x", "c>a", "c>b"]);
    expect(model.drawn).toBe(3);
    expect(model.offered).toBe(3);
    expect(model.width).toBeGreaterThan(0);
    expect(model.height).toBeGreaterThan(0);
  });

  it("a node first seen mid-path that later ends another path becomes a consumer; an origin seen later mid-path stays an origin", () => {
    const model = impactGraphModel([finding("f1", ["c", "mid", "x"]), finding("f2", ["c", "mid"], { consumer_owner: "team-mid" }), finding("f3", ["q", "c"])]);
    expect(model.nodes.find((n) => n.id === "mid")).toMatchObject({ consumer: true, owner: "team-mid" });
    expect(model.nodes.find((n) => n.id === "c")).toMatchObject({ origin: true, col: 0 });
  });

  it("caps the drawing by node count but always draws the first finding, and says how many were drawn", () => {
    const many = Array.from({ length: 200 }, (_, i) => finding(`f${i}`, ["origin", `consumer-${i}`]));
    const model = impactGraphModel(many);
    expect(model.nodes.length).toBeLessThanOrEqual(MAX_GRAPH_NODES);
    expect(model.drawn).toBe(MAX_GRAPH_NODES - 1);
    expect(model.offered).toBe(200);
    const long = impactGraphModel([finding("f", Array.from({ length: 5 }, (_, i) => `node-${i}`))], [], 2);
    expect(long.drawn).toBe(1);
    expect(long.nodes).toHaveLength(5);
    expect(impactGraphModel([]).nodes).toEqual([]);
  });

  it("layers edges by the longest path, survives cycles and self loops, and caps the node count", () => {
    const rows: EdgeRow[] = [
      { source_id: "a", target_id: "b", relation: "consumes", source_file: "f", source_line: 1, verified_at: null },
      { source_id: "b", target_id: "c", relation: "consumes", source_file: "f", source_line: 1, verified_at: null },
      { source_id: "c", target_id: "a", relation: "consumes", source_file: "f", source_line: 1, verified_at: null },
      { source_id: "d", target_id: "d", relation: "consumes", source_file: "f", source_line: 1, verified_at: null },
      { source_id: "a", target_id: "c", relation: "requires", source_file: "f", source_line: 1, verified_at: null },
    ];
    const model = edgesGraphModel(rows, [{ id: "cyc_1", members: ["a", "b", "c"] }]);
    expect(model.nodes.map((n) => n.id).sort()).toEqual(["a", "b", "c", "d"]);
    expect(Math.max(...model.nodes.map((n) => n.col))).toBeLessThanOrEqual(6);
    expect(model.nodes.every((n) => (n.id === "d" ? !n.inCycle : n.inCycle))).toBe(true);
    const chain: EdgeRow[] = Array.from({ length: 100 }, (_, i) => ({ source_id: `n${i}`, target_id: `n${i + 1}`, relation: "consumes", source_file: "f", source_line: 1, verified_at: null }));
    const capped = edgesGraphModel(chain);
    expect(capped.nodes.length).toBeLessThanOrEqual(MAX_GRAPH_NODES);
    expect(capped.drawn).toBeLessThan(100);
    expect(capped.offered).toBe(100);
    expect(edgesGraphModel([]).nodes).toEqual([]);
    expect(Math.max(...capped.nodes.map((n) => n.col))).toBeLessThanOrEqual(6);
  });

  it("draws an accessible figure: title, description, a node per id with a tooltip title, and no drawing for nothing", () => {
    const model = impactGraphModel([finding("f1", ["origin-with-a-very-long-identifier-that-needs-truncating", "consumer-x"], { consumer_owner: "an-owner-with-a-long-name-here" })], []);
    const { container } = render(<GraphView model={model} title="Test graph" noun="findings" />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("role")).toBe("img");
    expect(svg.getAttribute("aria-labelledby")).toContain("-t");
    expect(svg.querySelector("title")?.textContent).toBe("Test graph");
    expect(container.querySelector('[role="region"]')?.getAttribute("tabindex")).toBe("0");
    const first = svg.querySelector('[data-node-id^="origin-with"]')!;
    expect(first.querySelector("title")?.textContent).toContain("origin-with-a-very-long-identifier-that-needs-truncating");
    expect(first.querySelector("text")?.textContent).toContain("…");
    expect(container.textContent).toMatch(/owner an-owner-…ame-here/);
    expect(container.querySelector("figcaption")?.textContent).toContain("Thick outline");
    cleanup();
    const partial = render(<GraphView model={{ ...model, drawn: 1, offered: 9 }} title="t" noun="edges" />);
    expect(partial.container.querySelector("figcaption")?.textContent).toContain("Drawing the first 1 of 9 edges");
    cleanup();
    render(<GraphView model={impactGraphModel([])} title="t" noun="edges" />);
    expect(screen.getByText("Nothing to draw yet.")).toBeTruthy();
  });
});
