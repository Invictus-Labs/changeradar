import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { runDemo } from "../../src/commands/demo.js";
import { openDatabase } from "../../src/db/index.js";

// A switch the mocked bootstrap module reads, so one test can make the schema step fail while every other test in the
// file gets the real implementation.
const control = vi.hoisted(() => ({ failSchema: false }));
vi.mock("../../src/api/bootstrap.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/api/bootstrap.js")>();
  return { ...real, prepareSchema: (...args: Parameters<typeof real.prepareSchema>) => (control.failSchema ? Promise.resolve({ ready: false, error: "simulated migration failure" }) : real.prepareSchema(...args)) };
});

const scratch: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "changeradar-demo-fail-"));
  scratch.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  control.failSchema = false;
});

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as net.AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });

/** True when nothing is listening on the port any more (the demo closed its server after failing). */
const portIsFree = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (m: string) => out.push(m), err: (m: string) => err.push(m) }, out, err };
}

/** Replace fetch for calls to the demo server: `override` may answer a call itself, otherwise the real fetch runs. */
function interceptFetch(override: (url: string, init?: RequestInit) => Response | undefined) {
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => override(String(input), init) ?? real(input, init));
}

describe("demo refuses to lie and cleans up after itself", () => {
  it("a schema that cannot be prepared stops the demo before anything is served, and the data directory can be reopened", async () => {
    control.failSchema = true;
    const dir = join(tempDir(), "demo");
    const c = capture();
    await expect(runDemo({ dir, port: await freePort(), reset: false, webRoot: null }, c.io, () => undefined)).rejects.toThrow("simulated migration failure");
    control.failSchema = false;
    const db = await openDatabase(`pglite:${join(dir, "db")}`); // the failed demo released its lock
    await db.close();
  });

  it("without a built web UI it still serves the API, says so, and shuts down cleanly", async () => {
    const dir = join(tempDir(), "demo");
    const port = await freePort();
    const c = capture();
    let stop: (() => Promise<void>) | undefined;
    await runDemo({ dir, port, reset: false, webRoot: null }, c.io, (s) => (stop = s));
    try {
      expect(c.err.join("\n")).toContain("web UI not found");
      expect((await fetch(`http://127.0.0.1:${port}/api/v1/health/ready`)).status).toBe(200);
    } finally {
      await stop?.();
    }
    expect(await portIsFree(port)).toBe(true);
  });

  it("a seeding call that fails aborts the demo with the reason, closes the server and frees the port", async () => {
    const port = await freePort();
    interceptFetch((url) => (url.endsWith("/auth/login") ? new Response(JSON.stringify({ error: { code: "BOOM" } }), { status: 500 }) : undefined));
    const c = capture();
    await expect(runDemo({ dir: join(tempDir(), "demo"), port, reset: false, webRoot: null }, c.io, () => undefined)).rejects.toThrow(/demo seeding failed at login: HTTP 500/);
    vi.restoreAllMocks();
    expect(await portIsFree(port)).toBe(true);
    expect(c.out.join("\n")).not.toContain("password (shown once)"); // nothing is announced for a demo that did not come up
  });

  it("a run whose verdict differs from the fixture is never presented: the demo aborts", async () => {
    const port = await freePort();
    const real = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const response = await real(input, init);
      if (/\/impact-runs\/[0-9a-f-]{36}$/.test(String(input)) && (init?.method ?? "GET") === "GET") {
        const run = (await response.clone().json()) as { status: string };
        if (run.status === "complete") return new Response(JSON.stringify({ ...run, assessment: "NO_KNOWN_IMPACT" }), { status: 200 });
      }
      return response;
    });
    await expect(runDemo({ dir: join(tempDir(), "demo"), port, reset: false, webRoot: null }, capture().io, () => undefined)).rejects.toThrow(/expected AFFECTED/);
    vi.restoreAllMocks();
    expect(await portIsFree(port)).toBe(true);
  });

  it("a run that never finishes is reported instead of waited on forever", async () => {
    const port = await freePort();
    interceptFetch((url, init) => (/\/impact-runs\/[0-9a-f-]{36}$/.test(url) && (init?.method ?? "GET") === "GET" ? new Response(JSON.stringify({ status: "queued", assessment: null }), { status: 200 }) : undefined));
    await expect(runDemo({ dir: join(tempDir(), "demo"), port, reset: false, webRoot: null, pollMs: 1 }, capture().io, () => undefined)).rejects.toThrow(/did not finish in time/);
    vi.restoreAllMocks();
    expect(await portIsFree(port)).toBe(true);
  });
});

describe("the embedded database adapter releases its lock when opening fails", () => {
  it("a data directory that cannot be opened (a file is in the way) leaves no lock behind", async () => {
    const dir = tempDir();
    const blocker = join(dir, "db");
    writeFileSync(blocker, "not a directory");
    await expect(openDatabase(`pglite:${blocker}`)).rejects.toBeTruthy();
    expect(existsSync(`${blocker}.lock`)).toBe(false);
  });
});
