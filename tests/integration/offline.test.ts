import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultSettings } from "../../src/platform/context.js";
import { buildBundle, serializeBundle } from "../../src/services/evidence.js";
import { restoreBundle } from "../../src/services/restore.js";
import { createHarness, getRun } from "../helpers/harness.js";
import { baselineDoc, removeAmountDoc } from "../helpers/scenario.js";

const isLocal = (host: unknown): boolean => host === undefined || host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "";

/**
 * AC-08 (server side): the deterministic core (import, run, export, bundle, restore) completes with every
 * outbound path denied. The only connection tolerated is the loopback link to the database when the suite runs
 * against a real PostgreSQL server; the embedded engine needs no socket at all.
 */
describe("AC-08 the server core completes with outbound access denied", () => {
  afterEach(() => vi.restoreAllMocks());

  function denyOutbound() {
    const attempts: string[] = [];
    const original = net.Socket.prototype.connect;
    vi.spyOn(net.Socket.prototype, "connect").mockImplementation(function (this: net.Socket, ...args: unknown[]) {
      const first = args[0] as { host?: string; path?: string; port?: number } | number | string | undefined;
      const host = typeof first === "object" && first !== null ? first.host : typeof args[1] === "string" ? args[1] : undefined;
      const unix = typeof first === "object" && first !== null && "path" in first && first.path !== undefined;
      if (!unix && !isLocal(host)) {
        attempts.push(`socket ${String(host)}`);
        throw new Error(`outbound denied: ${String(host)}`);
      }
      return (original as (...a: unknown[]) => net.Socket).apply(this, args);
    } as never);
    const deny = (name: string) => () => {
      attempts.push(name);
      throw new Error(`outbound denied: ${name}`);
    };
    vi.spyOn(dns, "lookup").mockImplementation(deny("dns.lookup") as never);
    vi.spyOn(dns.promises, "lookup").mockImplementation(deny("dns.promises.lookup") as never);
    vi.spyOn(http, "request").mockImplementation(deny("http.request"));
    vi.spyOn(https, "request").mockImplementation(deny("https.request"));
    vi.spyOn(http, "get").mockImplementation(deny("http.get"));
    vi.spyOn(tls, "connect").mockImplementation(deny("tls.connect"));
    vi.spyOn(globalThis, "fetch").mockImplementation(deny("fetch"));
    return attempts;
  }

  it("imports, assesses, exports, bundles and restores with zero outbound attempts", async () => {
    const attempts = denyOutbound();
    const h = await createHarness();
    const dst = await createHarness();
    try {
      const ws = await h.workspace("Offline");
      const snap = await h.importSnapshot(ws.operator, baselineDoc());
      expect(snap.status).toBe(201);
      const run = await h.requestRun(ws.operator, { snapshot_id: snap.body.id, proposed_manifest: removeAmountDoc(), expected_hash: snap.body.hash });
      await h.drain();
      const view = await getRun(h, ws.viewer, run.body.id);
      expect(view).toMatchObject({ status: "complete", assessment: "AFFECTED" });
      expect((await h.api(ws.viewer, "GET", `/api/v1/impact-runs/${run.body.id}/export?format=json`)).status).toBe(200);
      expect((await h.api(ws.viewer, "GET", `/api/v1/impact-runs/${run.body.id}/export?format=html`)).status).toBe(200);
      const bundle = await buildBundle(h.db, { workspaceId: ws.id }, h.now());
      const summary = await restoreBundle(dst.ctx, serializeBundle(bundle!));
      expect(summary.impact_runs).toBe(1);
      // Event delivery is off by default and adapters are disabled: nothing was contacted.
      expect((await h.api(ws.operator, "GET", "/api/v1/events")).status).toBe(200);
      expect(attempts).toEqual([]);
    } finally {
      await h.close();
      await dst.close();
    }
  });

  it("a live connector that cannot connect fails explicitly (ERROR, run INCOMPLETE), never as a pass", async () => {
    const attempts = denyOutbound();
    const h = await createHarness({
      // A resolver answer for an allowlisted public name; the connection itself is what the denial stops.
      resolver: async () => [{ address: "93.184.216.34", family: 4 }],
      settings: { checks: { ...defaultSettings.checks, allowedHosts: ["checks.example.test"], backoffBaseMs: 1 } },
    });
    try {
      const ws = await h.workspace("Disconnected");
      const created = await h.api(ws.admin, "POST", "/api/v1/contract-checks", { key: "chk.offline", node_id: "contract.invoice", url: "http://checks.example.test/invoice", retries: 1, timeout_ms: 500 });
      expect(created.status, created.text).toBe(201);
      const snap = await h.importSnapshot(ws.operator, baselineDoc());
      const run = await h.requestRun(ws.operator, { snapshot_id: snap.body.id, proposed_manifest: removeAmountDoc(), expected_hash: snap.body.hash });
      await h.drain();
      const view = await getRun(h, ws.viewer, run.body.id);
      expect(view.status).toBe("complete");
      expect(view.checks[0]).toMatchObject({ check_key: "chk.offline", state: "ERROR", attempts: 2 });
      expect(view.assessment).toBe("INCOMPLETE");
      expect(view.unknowns.map((u: any) => u.code)).toContain("CHECK_ERROR");
      expect(attempts.length).toBeGreaterThan(0); // the runner really tried, and the denial is what was reported
    } finally {
      await h.close();
    }
  });
});
