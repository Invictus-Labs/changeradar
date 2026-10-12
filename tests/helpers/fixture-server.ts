import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * FIXTURE: a controlled local HTTP server standing in for an admin-configured contract endpoint. It is a real
 * server on a real socket (the check runner exercises its real HTTP path); it is not a mock of the runner and
 * it is never presented as a live provider. It records every request so tests can prove what was (not) sent.
 */
export interface FixtureRequest {
  method: string;
  url: string;
  authorization: string | undefined;
  host: string | undefined;
}

export interface Fixture {
  port: number;
  origin: string;
  requests: FixtureRequest[];
  hits(path: string): number;
  /** Per-path counters for the flaky route. */
  setSlowMs(ms: number): void;
  close(): Promise<void>;
}

export interface FixtureOptions {
  /** Where /redirect-elsewhere points. */
  redirectTo?: () => string;
  /** Expected bearer secret for /auth (checked verbatim). */
  bearer?: string;
  /** Called for every request before routing. */
  onRequest?: (req: FixtureRequest) => void;
}

export async function startFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const requests: FixtureRequest[] = [];
  let slowMs = 3000;
  const flaky = new Map<string, number>();
  const server = http.createServer((req, res) => {
    const record: FixtureRequest = { method: req.method ?? "", url: req.url ?? "", authorization: req.headers.authorization, host: req.headers.host };
    requests.push(record);
    options.onRequest?.(record);
    const path = (req.url ?? "").split("?")[0] as string;
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(req.method === "HEAD" ? undefined : JSON.stringify(body));
    };
    switch (path) {
      case "/ok":
        return json(200, { invoice_id: "inv-1", amount: 12.5, note: null, tags: [], meta: {} });
      case "/missing-field":
        return json(200, { invoice_id: "inv-1" });
      case "/wrong-type":
        return json(200, { invoice_id: 7, amount: "12.5" });
      case "/not-json":
        res.writeHead(200, { "content-type": "text/plain" });
        return res.end("hello");
      case "/array":
        return json(200, [1, 2, 3]);
      case "/server-error":
        return json(500, { error: "planted diagnostic" });
      case "/slow":
        setTimeout(() => json(200, { invoice_id: "late", amount: 1 }), slowMs);
        return;
      case "/hang":
        return; // never answers
      case "/flaky": {
        // Drops the connection on the first two calls, then answers.
        const n = (flaky.get(path) ?? 0) + 1;
        flaky.set(path, n);
        if (n <= 2) return void req.socket.destroy();
        return json(200, { invoice_id: "inv-1", amount: 3 });
      }
      case "/redirect-to-ok":
        res.writeHead(302, { location: "/ok" });
        return void res.end();
      case "/redirect-elsewhere":
        res.writeHead(302, { location: options.redirectTo?.() ?? "http://192.0.2.1/x" });
        return void res.end();
      case "/redirect-loop":
        res.writeHead(302, { location: "/redirect-loop" });
        return void res.end();
      case "/redirect-no-location":
        res.writeHead(302);
        return void res.end();
      case "/redirect-bad-location":
        res.writeHead(302, { location: "http://[::1" });
        return void res.end();
      case "/huge":
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(Buffer.alloc(3 * 1024 * 1024, 0x20));
      case "/huge-declared":
        res.writeHead(200, { "content-type": "application/json", "content-length": String(3 * 1024 * 1024) });
        return void res.end(Buffer.alloc(3 * 1024 * 1024, 0x20));
      case "/types":
        return json(200, { s: "text", n: 1.5, i: 3, b: true, nul: null, arr: [1], obj: { a: 1 } });
      case "/huge-chunked": {
        res.writeHead(200, { "content-type": "application/json" });
        const chunk = Buffer.alloc(64 * 1024, 0x20);
        let sent = 0;
        const pump = () => {
          while (sent < 4 * 1024 * 1024) {
            sent += chunk.length;
            if (!res.write(chunk)) return void res.once("drain", pump);
          }
          res.end();
        };
        return pump();
      }
      case "/auth":
        if (req.headers.authorization !== `Bearer ${options.bearer ?? ""}`) return json(401, { error: "unauthorized" });
        return json(200, { invoice_id: "inv-1", amount: 1 });
      default:
        return json(404, { error: "not found" });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    requests,
    hits: (path) => requests.filter((r) => r.url.split("?")[0] === path).length,
    setSlowMs: (ms) => {
      slowMs = ms;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
