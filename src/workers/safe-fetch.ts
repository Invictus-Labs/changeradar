import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import { type EgressPolicy, type HostResolver, systemResolver, vetDestination } from "./ssrf.js";

export type FetchErrorCode = "TIMEOUT" | "ABORTED" | "BODY_TOO_LARGE" | "TOO_MANY_REDIRECTS" | "BAD_REDIRECT" | "NETWORK";

export class FetchError extends Error {
  constructor(
    readonly code: FetchErrorCode,
    message: string,
    /** true when the TCP connection could not be established at all (nothing was sent): the next address may be tried. */
    readonly connectFailed = false,
  ) {
    super(message);
    this.name = "FetchError";
  }
}

export interface SafeRequestOptions {
  method: "GET" | "HEAD" | "POST";
  /** JSON request body, POST only. */
  body?: Buffer;
  policy: EgressPolicy;
  resolver?: HostResolver | undefined;
  /** Wall clock limit for the whole exchange including redirects. */
  timeoutMs: number;
  signal?: AbortSignal;
  maxBodyBytes: number;
  maxRedirects: number;
  /** Sent on the first hop and on same-origin redirects only; dropped when a redirect changes origin. */
  authorization?: string | undefined;
}

/** Read-only options: contract checks can never be typed into a mutating request. */
export type SafeFetchOptions = Omit<SafeRequestOptions, "method" | "body"> & { method: "GET" | "HEAD" };

export interface SafeFetchResponse {
  status: number;
  contentType: string | null;
  body: Buffer;
  finalUrl: string;
  redirects: number;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** Connection level errors after which no byte of the request reached the server. */
const CONNECT_ERROR_CODES = new Set(["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "EADDRNOTAVAIL"]);
const MAX_ADDRESSES_TRIED = 4;

/**
 * Read-only HTTP client for contract checks. Only GET and HEAD, no request body, no cookies, no
 * credentials in URLs. Every hop (including redirects) is vetted against the egress allowlist and DNS
 * result, then connected to the vetted IP address. The response body is capped while it streams.
 */
export function safeFetch(startUrl: string, options: SafeFetchOptions): Promise<SafeFetchResponse> {
  return safeRequest(startUrl, options);
}

/** Same guards for the optional event delivery POST. A POST is never redirected (maxRedirects is forced to 0). */
export function safePost(startUrl: string, body: Buffer, options: Omit<SafeRequestOptions, "method" | "body">): Promise<SafeFetchResponse> {
  return safeRequest(startUrl, { ...options, method: "POST", body, maxRedirects: 0 });
}

async function safeRequest(startUrl: string, options: SafeRequestOptions): Promise<SafeFetchResponse> {
  const resolver = options.resolver ?? systemResolver;
  const deadline = Date.now() + options.timeoutMs;
  let current = startUrl;
  // The origin the credential was configured for: the FIRST hop. Comparing with the previous hop instead would send
  // it to a third origin after a cross-origin redirect followed by a same-origin one (A -> B -> B).
  let originalOrigin: string | null = null;
  for (let hop = 0; hop <= options.maxRedirects; hop += 1) {
    const vetted = await vetDestination(current, options.policy, resolver);
    originalOrigin ??= vetted.url.origin;
    const sameOrigin = vetted.url.origin === originalOrigin;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new FetchError("TIMEOUT", "request timed out");
    let response: RawResponse | undefined;
    let connectError: unknown;
    for (const address of vetted.addresses.slice(0, MAX_ADDRESSES_TRIED)) {
      try {
        response = await requestOnce(vetted.url, address, options, Math.max(1, deadline - Date.now()), sameOrigin ? options.authorization : undefined);
        break;
      } catch (error) {
        if (error instanceof FetchError && error.connectFailed) {
          connectError = error;
          continue; // nothing was sent to this address: try the next vetted one
        }
        throw error;
      }
    }
    if (!response) throw connectError;
    if (REDIRECT_STATUSES.has(response.status)) {
      if (!response.location) throw new FetchError("BAD_REDIRECT", "redirect without a Location header");
      if (hop === options.maxRedirects) throw new FetchError("TOO_MANY_REDIRECTS", "too many redirects");
      try {
        current = new URL(response.location, vetted.url).toString();
      } catch {
        throw new FetchError("BAD_REDIRECT", "redirect Location is not a valid URL");
      }
      continue;
    }
    return { status: response.status, contentType: response.contentType, body: response.body, finalUrl: vetted.url.toString(), redirects: hop };
  }
  /* c8 ignore next */
  throw new FetchError("TOO_MANY_REDIRECTS", "too many redirects");
}

/**
 * A `lookup` function that ignores DNS entirely and always answers with the vetted address. Passing it to the
 * request pins the connection: a second DNS answer between the check and the connect cannot change the target.
 * The host name is still used for the Host header and TLS server name. Handles both calling conventions of
 * node's lookup (single address, or `all: true` array).
 */
export function pinnedLookup(address: { address: string; family: 4 | 6 }): LookupFunction {
  return (_host, lookupOptions, callback) => {
    if (lookupOptions.all) {
      (callback as unknown as (err: null, addrs: { address: string; family: number }[]) => void)(null, [{ address: address.address, family: address.family }]);
    } else {
      callback(null, address.address, address.family);
    }
  };
}

interface RawResponse {
  status: number;
  contentType: string | null;
  location: string | null;
  body: Buffer;
}

function requestOnce(
  url: URL,
  address: { address: string; family: 4 | 6 },
  options: SafeRequestOptions,
  timeoutMs: number,
  authorization: string | undefined,
): Promise<RawResponse> {
  return new Promise<RawResponse>((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const pinned = pinnedLookup(address);
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname.replace(/^\[|\]$/g, ""),
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: options.method,
        agent: false,
        lookup: pinned,
        headers: {
          accept: "application/json, */*;q=0.1",
          "user-agent": "changeradar-check/1",
          ...(options.body ? { "content-type": "application/json", "content-length": String(options.body.length) } : {}),
          ...(authorization ? { authorization } : {}),
        },
      },
      (res) => {
        const declared = Number(res.headers["content-length"]);
        if (Number.isFinite(declared) && declared > options.maxBodyBytes) {
          req.destroy();
          finish(() => reject(new FetchError("BODY_TOO_LARGE", "response body exceeds the size limit")));
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > options.maxBodyBytes) {
            req.destroy();
            finish(() => reject(new FetchError("BODY_TOO_LARGE", "response body exceeds the size limit")));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () =>
          finish(() =>
            resolve({
              status: res.statusCode ?? 0,
              contentType: typeof res.headers["content-type"] === "string" ? res.headers["content-type"] : null,
              location: typeof res.headers.location === "string" ? res.headers.location : null,
              body: Buffer.concat(chunks),
            }),
          ),
        );
        res.on("error", () => finish(() => reject(new FetchError("NETWORK", "response stream failed"))));
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      finish(() => reject(new FetchError("TIMEOUT", "request timed out")));
    }, timeoutMs);
    const onAbort = (): void => {
      req.destroy();
      finish(() => reject(new FetchError("ABORTED", "request aborted")));
    };
    // Connection errors carry no useful secret-free detail beyond a class of failure. The handler is attached
    // first so an abort (which destroys the request and emits an error) can never surface as unhandled.
    req.on("error", (error: NodeJS.ErrnoException) =>
      finish(() => reject(new FetchError("NETWORK", `connection failed (${error.code ?? "error"})`, CONNECT_ERROR_CODES.has(error.code ?? "")))),
    );
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });
    req.end(options.body);
  });
}
