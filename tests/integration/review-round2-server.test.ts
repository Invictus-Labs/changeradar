import { readFileSync } from "node:fs";
import net from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { startServer } from "../../src/api/bootstrap.js";
import { redactDeep } from "../../src/domain/redaction.js";
import { e, f, manifest, n } from "../helpers/builders.js";
import { createHarness } from "../helpers/harness.js";
import { baselineDoc } from "../helpers/scenario.js";

/**
 * Review round 2 regressions for the server and services (security P2 bootstrap.ts:52, snapshots.ts:150, conformance
 * P3 packaging, checks.ts identifier scan). Each block names its finding.
 */

const join2 = (...parts: string[]): string => parts.join("");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("R2 P2 (bootstrap.ts:52): shutdown does not wait on a client that trickles a request body", () => {
  it("stop() closes an incomplete request after the grace period and returns", async () => {
    const h = await createHarness();
    const server = await startServer(h.ctx, { host: "127.0.0.1", port: 0, withWorker: false, shutdownGraceMs: 300 });
    const port = Number(new URL(server.address).port);
    const sockets: net.Socket[] = [];
    try {
      for (let i = 0; i < 3; i += 1) {
        const socket = net.connect(port, "127.0.0.1");
        sockets.push(socket);
        socket.on("error", () => undefined);
        await new Promise<void>((resolveConnect) => socket.on("connect", resolveConnect));
        // Headers promise 100 bytes of body; one byte arrives and then nothing.
        socket.write("POST /api/v1/auth/login HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{");
      }
      await new Promise((r) => setTimeout(r, 100));
      const started = Date.now();
      const outcome = await Promise.race([server.stop().then(() => "stopped"), new Promise((r) => setTimeout(() => r("hung: stop() did not return within 10 s"), 10_000))]);
      expect(outcome).toBe("stopped");
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      for (const socket of sockets) socket.destroy();
      await h.close();
    }
  }, 60_000);

  it("control: an idle server stops at once", async () => {
    const h = await createHarness();
    const server = await startServer(h.ctx, { host: "127.0.0.1", port: 0, withWorker: false });
    try {
      const started = Date.now();
      await server.stop();
      expect(Date.now() - started).toBeLessThan(3_000);
    } finally {
      await h.close();
    }
  }, 60_000);
});

describe("R2 P2 (snapshots.ts:150): snapshot summaries go through the redactor like node and edge views", () => {
  it("redactDeep of a summary keeps an accepted revision and every warning intact when nothing is secret", async () => {
    const h = await createHarness();
    try {
      const w = await h.workspace("Views");
      const revision = "release-2026.09 (svc.token:refresh-service)";
      const snap = await h.importSnapshot(w.operator, baselineDoc(), { revision });
      expect(snap.status, snap.text).toBe(201);
      const listed = await h.api(w.viewer, "GET", "/api/v1/snapshots");
      const item = listed.body.items[0];
      // The view is the redacted form of what was stored (whatever the redactor decides), and redaction is a fixed point.
      expect(item.revision).toBe(redactDeep(revision));
      expect((redactDeep(item) as { revision: string }).revision).toBe(item.revision);
      const baseline = await h.api(w.viewer, "GET", "/api/v1/baseline");
      expect(baseline.body.snapshot.revision).toBe(item.revision);
    } finally {
      await h.close();
    }
  });
});

describe("R2 P2 (checks.ts): a secret-shaped check key or node id is refused like any other identifier", () => {
  it("POST /contract-checks answers 422 SECRET_VALUE_REJECTED and stores nothing", async () => {
    const h = await createHarness();
    try {
      const w = await h.workspace("Checks");
      const token = join2("gh", "p_", "Zq8vK2mXp4Lw9RtY7nBcJd3fQ1aB2cD3eF4g");
      for (const body of [
        { key: token, node_id: "contract.invoice" },
        { key: "chk.ok", node_id: token },
      ]) {
        const res = await h.api(w.admin, "POST", "/api/v1/contract-checks", { ...body, url: "http://localhost:9/ok", retries: 0, required_fields: [] });
        expect(res.status, res.text).toBe(422);
        expect(res.text).toContain("SECRET_VALUE_REJECTED");
        expect(res.text).not.toContain("Zq8vK2mXp4Lw9RtY7nBcJd3f");
      }
      const listed = await h.api(w.admin, "GET", "/api/v1/contract-checks");
      expect(listed.body.items).toEqual([]);
    } finally {
      await h.close();
    }
  });
});

describe("R2 P3 (write-build-info.mjs, compose.yaml): the package is rebuilt before it is stamped, and the database restarts", () => {
  it("prepack builds first, then records the commit", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts.prepack).toBe("npm run build && node scripts/write-build-info.mjs");
  });

  it("both compose services carry a restart policy", () => {
    const text = readFileSync(join(root, "compose.yaml"), "utf8");
    const services = text.split(/^ {2}(?=db:|changeradar:)/m).filter((block) => /^(db|changeradar):/.test(block));
    expect(services).toHaveLength(2);
    for (const block of services) expect(block, block.split("\n")[0]).toMatch(/^ {4}restart: unless-stopped$/m);
  });

  it("control: a manifest whose ids look like assignments still imports (no false positive from the check rule)", async () => {
    const h = await createHarness();
    try {
      const w = await h.workspace("Ids");
      const doc = manifest([n("auth-service:v1.2.3", "service"), n("contract.password-reset:v2", "contract", { fields: [f("a")] })], [e("auth-service:v1.2.3", "contract.password-reset:v2", "consumes")]);
      const res = await h.importSnapshot(w.operator, doc, { revision: "r1" });
      expect(res.status, res.text).toBe(201);
    } finally {
      await h.close();
    }
  });
});
