import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/api/server.js";
import { createStaticHandler, SPA_CSP } from "../../src/api/static.js";
import { KEEP_RUNNING, resolveWebRoot, runCli, type Io } from "../../src/commands/run.js";
import { htmlReportRenderer } from "../../src/report/html-report.js";
import { contextFromConfig, loadConfig } from "../../src/platform/config.js";
import { createHarness, type Harness } from "../helpers/harness.js";

const scratch: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "changeradar-static-"));
  scratch.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** A web root shaped like `vite build` output, plus a file OUTSIDE the root that must never be served. */
function makeRoot(): { root: string; outside: string } {
  const base = tempDir();
  const root = join(base, "web");
  mkdirSync(join(root, "assets"), { recursive: true });
  writeFileSync(join(root, "index.html"), '<!doctype html><title>ChangeRadar test root</title><div id="root"></div>');
  writeFileSync(join(root, "assets", "app.js"), "export const ok = true;\n");
  writeFileSync(join(root, "assets", "app.css"), "body{}\n");
  const outside = join(base, "outside-secret.txt");
  writeFileSync(outside, "TOP-SECRET-OUTSIDE-ROOT");
  symlinkSync(outside, join(root, "assets", "link.txt"));
  return { root, outside };
}

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});

describe("static web UI serving (AC-07 support: the API server serves the built SPA)", () => {
  it("serves index.html at / and for application routes, with the SPA content security policy", async () => {
    const { root } = makeRoot();
    const app = await buildApp(h.ctx, { webRoot: root });
    for (const url of ["/", "/runs/9b2f", "/snapshots/import", "/assets"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
      expect(res.body).toContain("ChangeRadar test root");
      expect(res.headers["content-security-policy"]).toBe(SPA_CSP);
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["x-frame-options"]).toBe("DENY");
    }
    // The policy carries no inline allowance and no external origin.
    expect(SPA_CSP).not.toContain("unsafe-inline");
    expect(SPA_CSP).not.toMatch(/https?:/);
    expect(SPA_CSP).toContain("frame-ancestors 'none'");
    await app.close();
  });

  it("serves assets with their content types, answers HEAD without a body, and leaves missing assets to the JSON 404", async () => {
    const { root } = makeRoot();
    const app = await buildApp(h.ctx, { webRoot: root });
    const js = await app.inject({ method: "GET", url: "/assets/app.js" });
    expect(js.statusCode).toBe(200);
    expect(js.headers["content-type"]).toContain("text/javascript");
    expect(js.body).toContain("ok = true");
    expect((await app.inject({ method: "GET", url: "/assets/app.css" })).headers["content-type"]).toContain("text/css");
    const head = await app.inject({ method: "HEAD", url: "/assets/app.js" });
    expect(head.statusCode).toBe(200);
    expect(head.body).toBe("");
    const missing = await app.inject({ method: "GET", url: "/assets/nope.js" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("NOT_FOUND");
    expect(missing.headers["content-type"]).toContain("application/json");
    await app.close();
  });

  it("never serves anything outside the web root: traversal, encoded traversal, symlinks and null bytes", async () => {
    const { root } = makeRoot();
    const app = await buildApp(h.ctx, { webRoot: root });
    const attempts = ["/../outside-secret.txt", "/%2e%2e/outside-secret.txt", "/..%2foutside-secret.txt", "/assets/../../outside-secret.txt", "/assets/link.txt", "/%00"];
    for (const url of attempts) {
      const res = await app.inject({ method: "GET", url });
      expect(res.body, url).not.toContain("TOP-SECRET-OUTSIDE-ROOT");
      expect([200, 404], url).toContain(res.statusCode);
    }
    // The symlink escape and the null byte are refused outright; a malformed encoding never reaches the handler (400).
    expect((await app.inject({ method: "GET", url: "/assets/link.txt" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/%E0%A4%A" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/%00" })).statusCode).toBe(404);
    await app.close();
  });

  it("the handler itself refuses undecodable paths and does not answer other methods", async () => {
    const { root } = makeRoot();
    const handler = createStaticHandler(root);
    const reply = { header: () => reply, type: () => reply, send: async () => reply } as never;
    expect(await handler({ method: "GET", url: "/%E0%A4%A" } as never, reply)).toBe(false);
    expect(await handler({ method: "DELETE", url: "/" } as never, reply)).toBe(false);
    expect(await handler({ method: "GET", url: "/runs?x=1" } as never, reply)).toBe(true);
  });

  it("keeps the API 404 as JSON, ignores non-GET methods, and does not weaken API headers", async () => {
    const { root } = makeRoot();
    const app = await buildApp(h.ctx, { webRoot: root });
    const api = await app.inject({ method: "GET", url: "/api/v1/nothing-here" });
    expect(api.statusCode).toBe(404);
    expect(api.json().error.code).toBe("NOT_FOUND");
    expect(api.headers["content-security-policy"]).toBe("default-src 'none'; frame-ancestors 'none'");
    // A successful API answer keeps the strict policy too; only files from the web root get the SPA policy.
    const live = await app.inject({ method: "GET", url: "/api/v1/health/live" });
    expect(live.statusCode).toBe(200);
    expect(live.headers["content-type"]).toContain("application/json");
    expect(live.headers["content-security-policy"]).toBe("default-src 'none'; frame-ancestors 'none'");
    expect((await app.inject({ method: "GET", url: "/api" })).statusCode).toBe(404);
    // No API path ever falls back to index.html, whatever it looks like.
    for (const url of ["/api/v1", "/api/v1/", "/api/v1/runs/unknown", "/api/v2/anything"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.body, url).not.toContain("ChangeRadar test root");
      expect(res.headers["content-type"], url).toContain("application/json");
    }
    expect((await app.inject({ method: "POST", url: "/anything", payload: "{}", headers: { "content-type": "application/json" } })).statusCode).toBe(404);
    await app.close();
  });

  it("without a web root the server is API only: / is the JSON 404", async () => {
    const app = await buildApp(h.ctx);
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
    await app.close();
  });

  it("an empty web root (no index.html) falls through to the JSON 404 instead of erroring", async () => {
    const empty = tempDir();
    const app = await buildApp(h.ctx, { webRoot: empty });
    expect((await app.inject({ method: "GET", url: "/runs" })).statusCode).toBe(404);
    await app.close();
  });

  it("while the service is not ready the UI still loads, but every API route answers 503", async () => {
    const { root } = makeRoot();
    const ready = h.ctx.readiness;
    h.ctx.readiness = { ok: false, reason: "migration_failed" };
    try {
      const app = await buildApp(h.ctx, { webRoot: root });
      expect((await app.inject({ method: "GET", url: "/" })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/assets/app.js" })).statusCode).toBe(200);
      const api = await app.inject({ method: "GET", url: "/api/v1/snapshots" });
      expect(api.statusCode).toBe(503);
      expect(api.json().error.code).toBe("NOT_READY");
      expect((await app.inject({ method: "GET", url: "/api/v1/health/live" })).statusCode).toBe(200);
      await app.close();
      // Without a web root the gate still covers everything, as before.
      const bare = await buildApp(h.ctx);
      expect((await bare.inject({ method: "GET", url: "/" })).statusCode).toBe(503);
      await bare.close();
    } finally {
      h.ctx.readiness = ready;
    }
  });
});

describe("web root and report renderer wiring", () => {
  const capture = () => {
    const out: string[] = [];
    const err: string[] = [];
    const io: Io = { out: (m) => out.push(m), err: (m) => err.push(m), stdin: async () => "" };
    return { io, out, err };
  };
  const freePort = () =>
    new Promise<number>((resolve) => {
      const probe = net.createServer();
      probe.listen(0, "127.0.0.1", () => {
        const p = (probe.address() as net.AddressInfo).port;
        probe.close(() => resolve(p));
      });
    });
  const KEY = Buffer.alloc(32, 7).toString("base64");

  it("resolveWebRoot uses an explicit root that has index.html, and nothing for a missing one or a source run", () => {
    const { root } = makeRoot();
    expect(resolveWebRoot(root)).toBe(root);
    expect(resolveWebRoot(join(root, "does-not-exist"))).toBeNull();
    // Running from source (no dist/web next to the module) serves the API only, never raw src/web.
    expect(resolveWebRoot(null)).toBeNull();
  });

  it("loadConfig reads CHANGERADAR_WEB_ROOT and contextFromConfig registers the HTML report renderer", async () => {
    const env = { CHANGERADAR_DATABASE_URL: "pglite:memory", CHANGERADAR_ENCRYPTION_KEY: KEY };
    expect(loadConfig(env).webRoot).toBeNull();
    expect(loadConfig({ ...env, CHANGERADAR_WEB_ROOT: "  /srv/web  " }).webRoot).toBe("/srv/web");
    const ctx = await contextFromConfig(loadConfig(env));
    expect(ctx.reportRenderer).toBe(htmlReportRenderer);
    await ctx.db.close();
  });

  it("the serve command serves the built UI next to the API and says so when there is none", async () => {
    const { root } = makeRoot();
    const dir = tempDir();
    const env = { CHANGERADAR_DATABASE_URL: `pglite:${join(dir, "db")}`, CHANGERADAR_ENCRYPTION_KEY: KEY, CHANGERADAR_WEB_ROOT: root };

    const withUi = capture();
    const port = await freePort();
    let stop: (() => Promise<void>) | undefined;
    expect(await runCli(["serve", "--no-worker"], { ...env, CHANGERADAR_PORT: String(port) }, withUi.io, { onServer: (s) => (stop = s) })).toBe(KEEP_RUNNING);
    expect(withUi.err.join("\n")).not.toContain("web UI not found");
    const page = await fetch(`http://127.0.0.1:${port}/runs`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("ChangeRadar test root");
    expect((await fetch(`http://127.0.0.1:${port}/api/v1/health/ready`)).status).toBe(200);
    await stop!();

    const apiOnly = capture();
    const port2 = await freePort();
    let stop2: (() => Promise<void>) | undefined;
    const bare = { CHANGERADAR_DATABASE_URL: `pglite:${join(tempDir(), "db")}`, CHANGERADAR_ENCRYPTION_KEY: KEY, CHANGERADAR_PORT: String(port2), CHANGERADAR_WEB_ROOT: join(root, "missing") };
    expect(await runCli(["serve", "--no-worker"], bare, apiOnly.io, { onServer: (s) => (stop2 = s) })).toBe(KEEP_RUNNING);
    expect(apiOnly.err.join("\n")).toContain("web UI not found");
    expect((await fetch(`http://127.0.0.1:${port2}/`)).status).toBe(404);
    await stop2!();
  }, 60_000);
});
