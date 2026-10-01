import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DEMO_MARKER } from "../../src/commands/demo.js";
import { demoFixturePath, loadDemoFixture } from "../../src/commands/demo-fixture.js";
import { KEEP_RUNNING, runCli, type Io } from "../../src/commands/run.js";
import { buildGraph } from "../../src/services/graph.js";

const scratch: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "changeradar-demo-"));
  scratch.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as net.AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });

async function demo(args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (m) => out.push(m), err: (m) => err.push(m), stdin: async () => "" };
  let stop: (() => Promise<void>) | undefined;
  const code = await runCli(["demo", ...args], {}, io, { onServer: (s) => (stop = s) });
  return { code, out: out.join("\n"), err: err.join("\n"), stop: async () => stop?.() };
}

describe("demo fixture", () => {
  it("replaces every freshness token with the same instant one day before the clock, and is otherwise byte identical", () => {
    const clock = new Date("2026-09-29T00:00:00Z");
    const a = loadDemoFixture(clock);
    const b = loadDemoFixture(new Date("2026-09-29T00:00:00.900Z"));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const text = JSON.stringify(a);
    expect(text).not.toContain("@FRESH@");
    expect(text).toContain('"verified_at":"2026-09-28T00:00:00Z"');
    expect(readFileSync(demoFixturePath(), "utf8")).toContain("@FRESH@");
    expect(a.fixture_version).toBe(1);
  });

  it("carries opaque synthetic ids only: no UUID literal, no email, no personal path", () => {
    const raw = readFileSync(demoFixturePath(), "utf8");
    expect(raw).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(raw).not.toMatch(/@[a-z0-9-]+\.[a-z]{2,}/i);
    expect(raw).not.toMatch(/\/(Users|home)\//);
  });
});

describe("changeradar sample-manifests", () => {
  it("writes owner-only synthetic manifests that the domain accepts, never overwrites, and needs no configuration", async () => {
    const dir = join(tempDir(), "samples");
    const out: string[] = [];
    const err: string[] = [];
    const io: Io = { out: (m) => out.push(m), err: (m) => err.push(m), stdin: async () => "" };
    expect(await runCli(["sample-manifests", "--out", dir], {}, io)).toBe(0);
    expect(out.join("\n")).toContain("baseline.json");
    for (const name of ["baseline.json", "baseline-with-unverified-edge.json", "proposal-breaking-removal.json", "proposal-no-known-impact.json", "snapshot-request.json"]) {
      const file = join(dir, name);
      expect(statSync(file).mode & 0o777, name).toBe(0o600);
      const doc = JSON.parse(readFileSync(file, "utf8"));
      const manifest = name === "snapshot-request.json" ? doc.manifest : doc;
      const built = buildGraph(manifest);
      expect(built.ok, name).toBe(true);
    }
    expect(JSON.parse(readFileSync(join(dir, "snapshot-request.json"), "utf8")).schema_version).toBe(1);
    expect(await runCli(["sample-manifests", "--out", dir], {}, io)).toBe(73); // exclusive create: nothing is overwritten
    expect(err.join("\n")).toMatch(/already exists/);
    expect(await runCli(["sample-manifests"], {}, io)).toBe(1);
  });
});

describe("changeradar demo (synthetic, account free, standalone)", () => {
  it("bootstraps users with one-time passwords, seeds three verdicts, serves on loopback and refuses to overwrite a previous demo", async () => {
    const dir = join(tempDir(), "demo");
    const port = await freePort();
    const first = await demo(["--dir", dir, "--port", String(port)]);
    try {
      expect(first.code, first.err).toBe(KEEP_RUNNING);
      expect(first.out).toContain(`http://localhost:${port}/`);
      expect(first.out).toContain("no account");
      const admin = /administrator\s+(\S+)\s+password \(shown once\): (\S+)/.exec(first.out);
      const viewer = /viewer\s+(\S+)\s+password \(shown once\): (\S+)/.exec(first.out);
      expect(admin?.[2]?.length).toBeGreaterThanOrEqual(12);
      expect(viewer?.[2]?.length).toBeGreaterThanOrEqual(12);
      expect(admin?.[2]).not.toBe(viewer?.[2]);
      const urls = Object.fromEntries([...first.out.matchAll(/(AFFECTED|NO_KNOWN_IMPACT|INCOMPLETE)\s+(http:\/\/localhost:\d+\/runs\/([0-9a-f-]{36}))/g)].map((m) => [m[1], m[3]]));
      expect(Object.keys(urls).sort()).toEqual(["AFFECTED", "INCOMPLETE", "NO_KNOWN_IMPACT"]);

      const login = async (email: string, password: string) => {
        const res = await fetch(`http://127.0.0.1:${port}/api/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
        return { status: res.status, cookie: (res.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "", body: (await res.json()) as any };
      };
      const asAdmin = await login(admin![1]!, admin![2]!);
      expect(asAdmin.status).toBe(200);
      expect(asAdmin.body.user.role).toBe("admin");
      expect((await login(viewer![1]!, viewer![2]!)).body.user.role).toBe("viewer");
      expect((await login(admin![1]!, "not-the-password-0000")).status).toBe(401);

      const get = async (path: string) => (await fetch(`http://127.0.0.1:${port}/api/v1${path}`, { headers: { cookie: asAdmin.cookie } })).json() as Promise<any>;
      const affected = await get(`/impact-runs/${urls.AFFECTED}`);
      const expected = loadDemoFixture(new Date()).expected;
      const exp = expected.breaking_removal_against_baseline as unknown as { direct_consumers: string[]; transitive_consumers: string[]; not_affected: string[] };
      expect(affected.assessment).toBe("AFFECTED");
      expect(affected.affected.filter((f: any) => f.direct).map((f: any) => f.consumer_id).sort()).toEqual([...exp.direct_consumers].sort());
      expect(affected.affected.filter((f: any) => !f.direct).map((f: any) => f.consumer_id).sort()).toEqual([...exp.transitive_consumers].sort());
      expect(affected.affected.map((f: any) => f.consumer_id)).not.toContain(exp.not_affected[0]);
      expect(affected.affected.every((f: any) => typeof f.consumer_owner === "string")).toBe(true);
      expect((await get(`/impact-runs/${urls.NO_KNOWN_IMPACT}`)).assessment).toBe("NO_KNOWN_IMPACT");
      const incomplete = await get(`/impact-runs/${urls.INCOMPLETE}`);
      expect(incomplete.assessment).toBe("INCOMPLETE");
      expect(incomplete.unknowns.length).toBeGreaterThan(0);
      expect(incomplete.affected.length).toBeGreaterThan(0);

      // The egress allowlist is empty: the demo can make no outbound request.
      const settings = await get("/settings");
      expect(settings.checks.allowed_hosts).toEqual([]);
      expect(settings.checks.allow_private_network).toBe(false);
      expect(settings.event_sink_configured).toBe(false);

      expect(existsSync(join(dir, DEMO_MARKER))).toBe(true);
      expect(statSync(dir).mode & 0o077).toBe(0);
    } finally {
      await first.stop();
    }

    // A previous demo is never overwritten silently: its one-time passwords cannot be shown again.
    const again = await demo(["--dir", dir, "--port", String(port)]);
    expect(again.code).toBe(1);
    expect(again.err).toContain("--reset");

    const reset = await demo(["--dir", dir, "--port", String(port), "--reset"]);
    try {
      expect(reset.code, reset.err).toBe(KEEP_RUNNING);
      expect(/administrator\s+\S+\s+password \(shown once\): (\S+)/.exec(reset.out)?.[1]).not.toBe(/administrator\s+\S+\s+password \(shown once\): (\S+)/.exec(first.out)?.[1]);
    } finally {
      await reset.stop();
    }
  }, 120_000);

  it("refuses a directory that is not a demo directory and an invalid port, and never deletes anything it did not create", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, "precious"));
    writeFileSync(join(dir, "precious", "file.txt"), "keep me");
    const refused = await demo(["--dir", dir, "--reset"]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("not a ChangeRadar demo directory");
    expect(readFileSync(join(dir, "precious", "file.txt"), "utf8")).toBe("keep me");
    for (const port of ["0", "70000", "abc"]) expect((await demo(["--dir", join(dir, "new"), "--port", port])).code).toBe(64);
  });

  it("fails clearly and closes everything when the port is already taken", async () => {
    const busy = net.createServer();
    await new Promise<void>((resolve) => busy.listen(0, "127.0.0.1", resolve));
    const port = (busy.address() as net.AddressInfo).port;
    try {
      const result = await demo(["--dir", join(tempDir(), "demo"), "--port", String(port)]);
      expect(result.code).toBe(1);
      expect(result.err).toMatch(/EADDRINUSE|address already in use/i);
    } finally {
      busy.close();
    }
  }, 60_000);
});
