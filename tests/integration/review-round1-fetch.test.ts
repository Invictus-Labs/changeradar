import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FetchError, safeFetch } from "../../src/workers/safe-fetch.js";

/**
 * Review round 1 P1 (security): a stored credential was sent to a different origin after a cross-origin redirect
 * followed by a same-origin one (safe-fetch.ts:67). Also P2: only the first resolved address was tried.
 */

interface Target {
  port: number;
  origin: string;
  seen: { path: string; authorization: string | undefined }[];
  close(): Promise<void>;
}

async function target(host: string, handler: (req: http.IncomingMessage, res: http.ServerResponse, self: { origin: string }) => void): Promise<Target> {
  const seen: Target["seen"] = [];
  const self = { origin: "" };
  const server = http.createServer((req, res) => {
    seen.push({ path: req.url ?? "", authorization: req.headers.authorization });
    handler(req, res, self);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  const port = (server.address() as AddressInfo).port;
  self.origin = `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
  return { port, origin: self.origin, seen, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

const SECRET = "Bearer synthetic-credential-value-1234";
const redirect = (res: http.ServerResponse, to: string) => {
  res.statusCode = 302;
  res.setHeader("location", to);
  res.end();
};

describe("R1 P1: the credential goes only to the origin it was configured for", () => {
  let a: Target;
  let b: Target;
  beforeAll(async () => {
    b = await target("127.0.0.1", (req, res, self) => {
      if (req.url === "/hop1") return redirect(res, `${self.origin}/hop2`);
      if (req.url === "/back") return redirect(res, `${a.origin}/final`);
      res.end("{}");
    });
    a = await target("127.0.0.1", (req, res, self) => {
      if (req.url === "/start") return redirect(res, `${b.origin}/hop1`);
      if (req.url === "/round-trip") return redirect(res, `${b.origin}/back`);
      if (req.url === "/same") return redirect(res, `${self.origin}/landed`);
      res.end("{}");
    });
  });
  afterAll(async () => {
    await a.close();
    await b.close();
  });

  const fetchFrom = (url: string) =>
    safeFetch(url, {
      method: "GET",
      policy: { allowedHosts: [`127.0.0.1:${a.port}`, `127.0.0.1:${b.port}`], allowPrivateNetwork: true },
      timeoutMs: 5000,
      maxBodyBytes: 1024,
      maxRedirects: 5,
      authorization: SECRET,
    });

  it("cross-origin redirect then same-origin redirect (A -> B -> B): the second hop on B carries NO credential", async () => {
    a.seen.length = 0;
    b.seen.length = 0;
    const response = await fetchFrom(`${a.origin}/start`);
    expect(response.status).toBe(200);
    expect(a.seen).toEqual([{ path: "/start", authorization: SECRET }]);
    expect(b.seen).toEqual([
      { path: "/hop1", authorization: undefined },
      { path: "/hop2", authorization: undefined },
    ]);
  });

  it("control: a same-origin redirect keeps the credential (the documented rule)", async () => {
    a.seen.length = 0;
    await fetchFrom(`${a.origin}/same`);
    expect(a.seen).toEqual([
      { path: "/same", authorization: SECRET },
      { path: "/landed", authorization: SECRET },
    ]);
  });

  it("a round trip A -> B -> A: B never sees it, and A (the configured origin) may see it again", async () => {
    a.seen.length = 0;
    b.seen.length = 0;
    await fetchFrom(`${a.origin}/round-trip`);
    expect(b.seen.every((hit) => hit.authorization === undefined)).toBe(true);
    expect(a.seen.at(-1)).toEqual({ path: "/final", authorization: SECRET });
  });

  it("no credential configured: nothing is ever sent", async () => {
    a.seen.length = 0;
    b.seen.length = 0;
    await safeFetch(`${a.origin}/start`, {
      method: "GET",
      policy: { allowedHosts: [`127.0.0.1:${a.port}`, `127.0.0.1:${b.port}`], allowPrivateNetwork: true },
      timeoutMs: 5000,
      maxBodyBytes: 1024,
      maxRedirects: 5,
    });
    expect([...a.seen, ...b.seen].every((hit) => hit.authorization === undefined)).toBe(true);
  });
});

describe("R1 P2: every vetted address is tried when a connection cannot be established (ssrf.ts:208)", () => {
  it("a dual stack name whose first address refuses the connection is served by the second", async () => {
    let v6: Target | null = null;
    try {
      v6 = await target("::1", (_req, res) => res.end("{}"));
    } catch {
      return; // no IPv6 loopback on this host: nothing to prove here
    }
    try {
      const response = await safeFetch(`http://dual.example.test:${v6.port}/x`, {
        method: "GET",
        policy: { allowedHosts: [`dual.example.test:${v6.port}`], allowPrivateNetwork: true },
        // 127.0.0.1 answers first but nothing listens there on this port; ::1 answers second.
        resolver: async () => [
          { address: "127.0.0.1", family: 4 },
          { address: "::1", family: 6 },
        ],
        timeoutMs: 5000,
        maxBodyBytes: 1024,
        maxRedirects: 0,
      });
      expect(response.status).toBe(200);
      expect(v6.seen).toHaveLength(1);
    } finally {
      await v6.close();
    }
  });

  it("when every address refuses, the failure is a visible NETWORK error", async () => {
    const closed = await target("127.0.0.1", (_req, res) => res.end("{}"));
    const { port } = closed;
    await closed.close();
    await expect(
      safeFetch(`http://gone.example.test:${port}/x`, {
        method: "GET",
        policy: { allowedHosts: [`gone.example.test:${port}`], allowPrivateNetwork: true },
        resolver: async () => [
          { address: "127.0.0.1", family: 4 },
          { address: "127.0.0.1", family: 4 },
        ],
        timeoutMs: 3000,
        maxBodyBytes: 1024,
        maxRedirects: 0,
      }),
    ).rejects.toMatchObject({ code: "NETWORK", connectFailed: true });
  });

  it("an error after the request was sent is never retried on another address", async () => {
    let hits = 0;
    const flaky = await target("127.0.0.1", (_req, res) => {
      hits += 1;
      res.destroy();
    });
    try {
      await expect(
        safeFetch(`http://flaky.example.test:${flaky.port}/x`, {
          method: "GET",
          policy: { allowedHosts: [`flaky.example.test:${flaky.port}`], allowPrivateNetwork: true },
          resolver: async () => [
            { address: "127.0.0.1", family: 4 },
            { address: "127.0.0.1", family: 4 },
          ],
          timeoutMs: 3000,
          maxBodyBytes: 1024,
          maxRedirects: 0,
        }),
      ).rejects.toBeInstanceOf(FetchError);
      expect(hits).toBe(1);
    } finally {
      await flaky.close();
    }
  });
});
