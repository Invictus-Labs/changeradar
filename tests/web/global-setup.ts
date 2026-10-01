import net from "node:net";
import type { TestProject } from "vitest/node";
import { htmlReportRenderer } from "../../src/report/html-report.js";
import { defaultSettings } from "../../src/platform/context.js";
import { grantUser } from "../../src/services/auth.js";
import { startWorker } from "../../src/workers/worker.js";
import { billingManifest, e, f, manifest, n } from "../helpers/builders.js";
import { createHarness, PASSWORD, type Harness, type TestWorkspace } from "../helpers/harness.js";
import { addOptionalFieldDoc, fanOutManifest, removeAmountDoc, unverifiedEdgeDoc } from "../helpers/scenario.js";
import { HOSTILE } from "./hostile.js";


export interface SeededWorkspace {
  id: string;
  name: string;
  slug: string;
  /** Emails of the three roles. The password is the same for all of them (see `password`). */
  emails: { admin: string; operator: string; viewer: string };
  ids: Record<string, string>;
}

export interface SeedContext {
  baseUrl: string;
  password: string;
  /** A loopback port that is allowlisted for contract checks and has nothing listening on it. */
  closedPort: number;
  workspaces: Record<"main" | "empty" | "big" | "hostile" | "cycles" | "other" | "write" | "checks", SeededWorkspace>;
  /** Finding ids of the AFFECTED run in the main workspace, in report order. */
  affectedFindingIds: string[];
}

declare module "vitest" {
  export interface ProvidedContext {
    seed: SeedContext;
  }
}

const slugOf = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-");

/**
 * Starts the REAL ChangeRadar API (Fastify on an embedded PostgreSQL, the real job worker, the real HTML report
 * renderer) on a random loopback port and seeds synthetic workspaces. The web tests talk to it over HTTP with
 * real cookies and CSRF tokens: nothing in API-backed rendering is a route mock.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  // A loopback port with nothing listening: a contract check aimed at it fails for real (connection refused).
  const closedPort = await new Promise<number>((resolve) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as net.AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
  // Loopback is allowlisted (test-only setting) so an admin can create a contract check through the UI; a check aimed
  // at a closed port then fails for real, and the run must end INCOMPLETE rather than passed.
  const h: Harness = await createHarness({ settings: { checks: { ...defaultSettings.checks, allowedHosts: [`localhost:${closedPort}`], allowPrivateNetwork: true } } });
  h.ctx.reportRenderer = htmlReportRenderer;

  const seedWorkspace = async (name: string): Promise<{ ws: TestWorkspace; out: SeededWorkspace }> => {
    const ws = await h.workspace(name);
    const slug = slugOf(name);
    return { ws, out: { id: ws.id, name, slug, emails: { admin: ws.admin.email, operator: ws.operator.email, viewer: ws.viewer.email }, ids: {} } };
  };

  const importAs = async (ws: TestWorkspace, doc: Record<string, unknown>, revision: string) => {
    const res = await h.importSnapshot(ws.operator, doc, { revision });
    if (res.status !== 201) throw new Error(`seed import failed ${res.status} ${res.text}`);
    return res.body as { id: string; hash: string };
  };
  const runAs = async (ws: TestWorkspace, snap: { id: string; hash: string }, proposed: Record<string, unknown>) => {
    const res = await h.requestRun(ws.operator, { snapshot_id: snap.id, proposed_manifest: proposed, expected_hash: snap.hash });
    if (res.status !== 202) throw new Error(`seed run failed ${res.status} ${res.text}`);
    await h.drain();
    return (res.body as { id: string }).id;
  };

  // ---- main: AFFECTED, NO_KNOWN_IMPACT, then a baseline move and an INCOMPLETE run ----
  const main = await seedWorkspace("UI Main");
  const s1 = await importAs(main.ws, billingManifest(), "2026-09-28.1");
  main.out.ids.snapshotOld = s1.id;
  main.out.ids.hashOld = s1.hash;
  main.out.ids.runAffected = await runAs(main.ws, s1, removeAmountDoc());
  main.out.ids.runNoImpact = await runAs(main.ws, s1, addOptionalFieldDoc());
  const s2 = await importAs(main.ws, unverifiedEdgeDoc(), "2026-09-29.1");
  main.out.ids.snapshot = s2.id;
  main.out.ids.hash = s2.hash;
  main.out.ids.runIncomplete = await runAs(main.ws, s2, removeAmountDoc());

  // ---- empty: a workspace with nothing in it; the same admin also belongs to main (workspace selection) ----
  const empty = await seedWorkspace("UI Empty");
  await h.db.transaction((tx) => grantUser(tx, { workspaceId: empty.ws.id, email: main.ws.admin.email, password: PASSWORD, role: "admin", at: h.now() }));

  // ---- big: hundreds of consumers, more than one page of findings ----
  const big = await seedWorkspace("UI Big");
  const bigSnap = await importAs(big.ws, fanOutManifest(250), "big.1");
  big.out.ids.snapshot = bigSnap.id;
  big.out.ids.runBig = await runAs(big.ws, bigSnap, fanOutManifest(250, { dropAmount: true }));

  // ---- hostile: markup and script payloads in every free-text field ----
  const hostile = await seedWorkspace("UI Hostile");
  const hostileNodes = [
    n("svc.producer", "service", { owner: HOSTILE.owner, version: HOSTILE.version }),
    n("contract.thing", "contract", { owner: HOSTILE.owner, version: HOSTILE.version, fields: [f("id"), f("amount", "number")] }),
    n("job.consumer", "job", { owner: HOSTILE.owner, version: HOSTILE.version }),
  ];
  const hostileEdges = [e("svc.producer", "contract.thing", "produces", { file: HOSTILE.file }), e("job.consumer", "contract.thing", "consumes", { file: HOSTILE.file })];
  const hostileSnap = await importAs(hostile.ws, manifest(hostileNodes, hostileEdges), HOSTILE.revision);
  const hostileProposal = manifest(
    hostileNodes.map((node, index) => (index === 1 ? n("contract.thing", "contract", { owner: HOSTILE.owner, version: HOSTILE.version, fields: [f("id")] }) : node)),
    hostileEdges,
  );
  hostile.out.ids.snapshot = hostileSnap.id;
  hostile.out.ids.runHostile = await runAs(hostile.ws, hostileSnap, hostileProposal);

  // ---- cycles: two services that consume each other, and a contract one of them uses ----
  const cycles = await seedWorkspace("UI Cycles");
  const cycleNodes = [n("svc.a", "service", { owner: "team-a" }), n("svc.b", "service", { owner: "team-b" }), n("contract.c", "contract", { owner: "team-c", fields: [f("id"), f("amount", "number")] })];
  const cycleEdges = [e("svc.a", "svc.b", "consumes"), e("svc.b", "svc.a", "consumes"), e("svc.a", "contract.c", "consumes")];
  const cycleSnap = await importAs(cycles.ws, manifest(cycleNodes, cycleEdges), "cycles.1");
  const cycleProposal = manifest([cycleNodes[0]!, cycleNodes[1]!, n("contract.c", "contract", { owner: "team-c", fields: [f("id")] })], cycleEdges);
  cycles.out.ids.snapshot = cycleSnap.id;
  cycles.out.ids.runCycle = await runAs(cycles.ws, cycleSnap, cycleProposal);

  // ---- other: a second workspace whose ids the main users must not be able to see ----
  const other = await seedWorkspace("UI Other");
  const otherSnap = await importAs(other.ws, billingManifest(), "other.1");
  other.out.ids.snapshot = otherSnap.id;
  other.out.ids.hash = otherSnap.hash;
  other.out.ids.runOther = await runAs(other.ws, otherSnap, removeAmountDoc());

  // ---- write: a workspace the write-path tests mutate ----
  const write = await seedWorkspace("UI Write");
  const writeSnap = await importAs(write.ws, billingManifest(), "write.1");
  write.out.ids.snapshot = writeSnap.id;
  write.out.ids.hash = writeSnap.hash;

  // ---- checks: a workspace whose admin creates a live contract check through the UI ----
  const checks = await seedWorkspace("UI Checks");
  const checksSnap = await importAs(checks.ws, billingManifest(), "checks.1");
  checks.out.ids.snapshot = checksSnap.id;
  checks.out.ids.hash = checksSnap.hash;

  const affected = await h.api(main.ws.viewer, "GET", `/api/v1/impact-runs/${main.out.ids.runAffected}/findings?limit=100`);
  const affectedFindingIds = (affected.body.items as { id: string }[]).map((x) => x.id);

  // The real worker keeps running so runs requested through the UI move from queued to complete on their own.
  const stopWorker = startWorker(h.ctx, { intervalMs: 100 });
  const address = await h.app.listen({ host: "127.0.0.1", port: 0 });

  project.provide("seed", {
    baseUrl: address,
    password: PASSWORD,
    closedPort,
    workspaces: { main: main.out, empty: empty.out, big: big.out, hostile: hostile.out, cycles: cycles.out, other: other.out, write: write.out, checks: checks.out },
    affectedFindingIds,
  });

  return async () => {
    await stopWorker();
    await h.close();
  };
}
