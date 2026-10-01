import { cleanup, render } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { inject, vi } from "vitest";
import { onUnauthorized, setCsrfToken, type Role, type User } from "../../src/web/api";
import { App } from "../../src/web/app";
import type { SeedContext, SeededWorkspace } from "./global-setup";

export interface Call {
  method: string;
  /** Path as the browser code requested it, for example `/api/v1/snapshots?limit=50`. */
  path: string;
  headers: Record<string, string>;
  body: string | undefined;
}

export const users: Record<Role, User> = {
  admin: { id: "u-admin", email: "admin@example.test", workspace_id: "w-1", workspace_name: "Demo", role: "admin" },
  operator: { id: "u-operator", email: "operator@example.test", workspace_id: "w-1", workspace_name: "Demo", role: "operator" },
  viewer: { id: "u-viewer", email: "viewer@example.test", workspace_id: "w-1", workspace_name: "Demo", role: "viewer" },
};

/** Reset everything a test may have changed: DOM, fetch stub, CSRF token, session listener, storage, theme. */
export function resetWeb(): void {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  setCsrfToken(null);
  onUnauthorized(null);
  try {
    localStorage.clear();
  } catch {
    // ignore
  }
  document.documentElement.removeAttribute("data-theme");
  delete (window as unknown as { __pwned?: unknown }).__pwned;
}

// ---- real API: the seeded server started by global-setup, reached over HTTP with a real cookie jar ----

const nativeFetch = globalThis.fetch.bind(globalThis);

export interface RealApi {
  calls: Call[];
  workspace(name: keyof SeedContext["workspaces"]): SeededWorkspace;
  /** Sign in through the API (sets the cookie jar) so the app finds a session on load. */
  signIn(email: string, workspaceId?: string): Promise<void>;
  /** Forget the session cookie without telling the server (simulates expiry on the browser side). */
  dropCookie(): void;
  /** Direct call with the current session, for assertions about server state. */
  raw(method: string, path: string, body?: unknown, csrf?: string): Promise<{ status: number; body: any; text: string }>;
}

export function useRealApi(): RealApi {
  const seed = inject("seed");
  let cookie = "";
  const calls: Call[] = [];
  const wrapper = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const path = typeof input === "string" ? input : input instanceof URL ? input.pathname + input.search : input.url;
    const headers = new Headers(init.headers);
    if (cookie) headers.set("cookie", cookie);
    calls.push({ method: init.method ?? "GET", path, headers: Object.fromEntries(headers.entries()), body: typeof init.body === "string" ? init.body : undefined });
    const response = await nativeFetch(`${seed.baseUrl}${path}`, { ...init, headers, redirect: "manual" });
    const set = response.headers.get("set-cookie");
    if (set) {
      const pair = set.split(";")[0] ?? "";
      cookie = pair.endsWith("=") ? "" : pair;
    }
    return response;
  };
  vi.stubGlobal("fetch", wrapper);
  let csrf = "";
  return {
    calls,
    workspace: (name) => seed.workspaces[name],
    async signIn(email, workspaceId) {
      const response = await wrapper("/api/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: seed.password, ...(workspaceId ? { workspace_id: workspaceId } : {}) }),
      });
      if (response.status !== 200) throw new Error(`test sign in failed: ${response.status}`);
      csrf = ((await response.json()) as { csrf_token: string }).csrf_token;
      calls.length = 0;
    },
    dropCookie() {
      cookie = "";
    },
    async raw(method, path, body, token) {
      const response = await wrapper(path, {
        method,
        headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(method === "GET" ? {} : { "x-csrf-token": token ?? csrf }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      return { status: response.status, body: parsed, text };
    },
  };
}

/** Sign in through the real API as `role` in workspace `key`, then render the whole app at `path`. */
export async function openAs(role: Role, key: keyof SeedContext["workspaces"], path: string) {
  const api = useRealApi();
  const w = api.workspace(key);
  await api.signIn(w.emails[role], w.id);
  return { api, w, ...renderApp(path) };
}

/** Render the whole app at a route. */
export function renderApp(path: string) {
  const Router = ({ children }: { children: ReactNode }) => <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>;
  return render(<App Router={Router} />);
}

/** Render one page element at a route pattern (for pages that read route params). */
export function renderPage(element: ReactElement, path: string, pattern = path.split("?")[0] as string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path={pattern} element={element} />
        <Route path="*" element={<p>navigated elsewhere</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

// ---- mocked API: only for the states a real server cannot be made to produce on demand (429, 503, 413, ...) ----

export interface Reply {
  status?: number;
  body?: unknown;
  raw?: string;
  headers?: Record<string, string>;
}
type ReplyOrFn = Reply | ((call: Call) => Reply | Promise<Reply>);

/** Route table keyed by "METHOD /path" (path without the /api/v1 prefix, query string included). Unlisted routes answer 404. */
export function mockApi(routes: Record<string, ReplyOrFn>) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const path = String(input).replace(/^\/api\/v1/, "");
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const call: Call = { method: init.method ?? "GET", path, headers, body: typeof init.body === "string" ? init.body : undefined };
    calls.push(call);
    const route = routes[`${call.method} ${path}`] ?? routes[`${call.method} ${path.split("?")[0]}`];
    if (!route) return new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "Not found", request_id: "req-unmocked" } }), { status: 404 });
    const reply = typeof route === "function" ? await route(call) : route;
    return new Response(reply.raw ?? JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200, headers: reply.headers ?? {} });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

export const apiError = (status: number, code: string, message: string, extra: { details?: unknown; headers?: Record<string, string> } = {}): Reply => ({
  status,
  body: { error: { code, message, request_id: "req-test", ...(extra.details === undefined ? {} : { details: extra.details }) } },
  ...(extra.headers ? { headers: extra.headers } : {}),
});

export const page = <T,>(items: T[], next: string | null = null) => ({ body: { items, next_cursor: next } });

/** Answer every request with the same reply (or a network failure), or with whatever the function returns per call. */
export function mockAny(reply: Reply | "network" | ((call: Call) => Reply | "network" | Promise<Reply | "network">)) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const call: Call = { method: init.method ?? "GET", path: String(input).replace(/^\/api\/v1/, ""), headers: Object.fromEntries(new Headers(init.headers).entries()), body: typeof init.body === "string" ? init.body : undefined };
    calls.push(call);
    const r = typeof reply === "function" ? await reply(call) : reply;
    if (r === "network") throw new TypeError("offline");
    return new Response(r.raw ?? JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: r.headers ?? {} });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}
