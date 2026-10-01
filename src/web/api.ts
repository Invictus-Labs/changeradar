export type Role = "admin" | "operator" | "viewer";

export interface User {
  id: string;
  email: string;
  workspace_id: string;
  workspace_name: string;
  role: Role;
}

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

/** An API failure in the PRD envelope (`{error:{code,message,request_id}}`), or a transport failure (status 0). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
    readonly details?: unknown,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

let csrfToken: string | null = null;
let unauthorizedListener: (() => void) | null = null;

/** The app registers one listener: any 401 from an authenticated call drops the UI back to the sign in form. */
export function onUnauthorized(listener: (() => void) | null): void {
  unauthorizedListener = listener;
}

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export interface RequestOptions {
  /** Sent as `Idempotency-Key` on the mutations that accept one. */
  idempotencyKey?: string;
}

export async function api<T>(method: "GET" | "POST", path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  // Every non-GET request carries the CSRF token returned by login / GET /auth/session.
  if (method !== "GET" && csrfToken) headers["x-csrf-token"] = csrfToken;
  if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      method,
      headers,
      credentials: "same-origin",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiError(0, "NETWORK_ERROR", "The server could not be reached. Check that ChangeRadar is running, then retry.");
  }
  const text = await response.text();
  let data: unknown = null;
  let readable = true;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    readable = false;
  }
  if (!response.ok) {
    const envelope = (readable && typeof data === "object" && data !== null ? (data as { error?: Record<string, unknown> }).error : undefined) ?? {};
    const retry = Number(response.headers.get("retry-after"));
    const error = new ApiError(
      response.status,
      typeof envelope.code === "string" ? envelope.code : "ERROR",
      typeof envelope.message === "string" ? envelope.message : `HTTP ${response.status}`,
      typeof envelope.request_id === "string" ? envelope.request_id : undefined,
      envelope.details,
      Number.isFinite(retry) && retry > 0 ? retry : undefined,
    );
    if (response.status === 401 && path !== "/auth/login") unauthorizedListener?.();
    throw error;
  }
  if (!readable) throw new ApiError(response.status, "INVALID_RESPONSE", "The server returned an unreadable response");
  return data as T;
}

export async function loadSession(): Promise<User | null> {
  try {
    const session = await api<{ user: User; csrf_token: string }>("GET", "/auth/session");
    csrfToken = session.csrf_token;
    return session.user;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      csrfToken = null;
      return null;
    }
    throw error;
  }
}

export async function signIn(email: string, password: string, workspaceId?: string): Promise<User> {
  const result = await api<{ user: User; csrf_token: string }>("POST", "/auth/login", {
    email,
    password,
    ...(workspaceId ? { workspace_id: workspaceId } : {}),
  });
  csrfToken = result.csrf_token;
  return result.user;
}

export async function signOut(): Promise<void> {
  try {
    await api("POST", "/auth/logout");
  } finally {
    csrfToken = null;
  }
}

/** Append query parameters, skipping unset ones. */
export function withQuery(path: string, params: Record<string, string | number | null | undefined>): string {
  const query = Object.entries(params)
    .filter((entry): entry is [string, string | number] => entry[1] !== null && entry[1] !== undefined && entry[1] !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
  return query ? `${path}${path.includes("?") ? "&" : "?"}${query}` : path;
}

export const exportUrl = (runId: string, format: "json" | "html"): string => `/api/v1/impact-runs/${encodeURIComponent(runId)}/export?format=${format}`;
export const bundleUrl = (runId: string): string => `/api/v1/impact-runs/${encodeURIComponent(runId)}/bundle`;
export const manifestUrl = (snapshotId: string): string => `/api/v1/snapshots/${encodeURIComponent(snapshotId)}/manifest`;

/**
 * A fresh key per distinct request body, reused when the same body is sent again (a retry after a lost response
 * or a 5xx gets the original receipt instead of a duplicate). `reset` after success.
 */
export function idempotencyFor(): { keyFor(body: string): string; reset(): void } {
  let lastBody: string | null = null;
  let key: string | null = null;
  return {
    keyFor(body) {
      if (key === null || body !== lastBody) {
        lastBody = body;
        key = `ui-${randomId()}`;
      }
      return key;
    },
    reset() {
      lastBody = null;
      key = null;
    },
  };
}

function randomId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- small formatting helpers ----

/** UTC, stable across viewers: `2026-09-29 07:30:06Z`. */
export function formatTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return `${date.toISOString().slice(0, 19).replace("T", " ")}Z`;
}

/** `sha256:1234567890ab…` for display; the full value stays available in a title and in exports. */
export function shortHash(hash: string | null | undefined): string {
  if (!hash) return "—";
  const [algo, digest] = hash.includes(":") ? (hash.split(":") as [string, string]) : ["", hash];
  return digest.length > 14 ? `${algo ? `${algo}:` : ""}${digest.slice(0, 12)}…` : hash;
}

export const canImport = (role: Role): boolean => role === "operator" || role === "admin";
export const canReadOperational = canImport;
export const isAdmin = (role: Role): boolean => role === "admin";
