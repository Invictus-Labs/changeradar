import { type Browser, type BrowserContext, expect, type Page, test } from "@playwright/test";
import { loadDemoFixture } from "../../src/commands/demo-fixture.js";
import { UUID_UNKNOWN } from "../helpers/ids.js";
import { HOSTILE } from "../web/hostile.js";
import { api, createStack, createUser, generatedPassword, login, type ServerProcess, type Session, type Stack, waitForRun } from "./support/stack.js";

/**
 * Browser end to end (real Chromium): the real compiled server, the real embedded database, the real job worker and
 * the real web UI. Nothing here mocks a route or the network. Test setup that is not the behavior under test (creating
 * users with the CLI, seeding the other workspace) uses the CLI and the HTTP API; every assertion about what a person
 * sees is made in the browser.
 *
 * "Zero console errors" is enforced as: no JavaScript exception, no CSP violation, no failed request except the
 * HTTP error statuses a test deliberately provokes (Chromium logs every 4xx response of a fetch as a console error
 * with the text "Failed to load resource"; a test lists the statuses it expects, and any other console error fails).
 */

const PASSWORD = generatedPassword();
const UUID_IN_URL = /\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const fixture = loadDemoFixture(new Date());

let stack: Stack;
let server: ServerProcess;
let acme: string;
let other: { session: Session; snapshotId: string; runId: string };
const state: { snapshot1?: string; baseline1Hash?: string; runAffected?: string; runNoKnown?: string; runIncomplete?: string } = {};

const email = (name: string) => `${name}@example.test`;
const asJson = (value: unknown) => JSON.stringify(value);

class Monitor {
  readonly consoleErrors: string[] = [];
  readonly pageErrors: string[] = [];
  readonly external: string[] = [];
  readonly statuses: number[] = [];
  readonly dialogs: string[] = [];
  constructor(private readonly origin: string) {}

  watch(page: Page): void {
    page.on("console", (msg) => {
      if (msg.type() !== "error") return;
      const text = msg.text();
      const status = /Failed to load resource: the server responded with a status of (\d{3})/.exec(text);
      if (status) this.statuses.push(Number(status[1]));
      else this.consoleErrors.push(text);
    });
    page.on("pageerror", (error) => this.pageErrors.push(String(error)));
    page.on("dialog", (dialog) => {
      this.dialogs.push(dialog.message());
      void dialog.dismiss();
    });
    page.on("request", (request) => {
      const url = request.url();
      if (!url.startsWith(this.origin) && !url.startsWith("data:") && !url.startsWith("blob:") && !url.startsWith("about:")) this.external.push(url);
    });
    page.on("requestfailed", (request) => {
      if (!request.failure()?.errorText.includes("ERR_ABORTED")) this.consoleErrors.push(`request failed: ${request.url()} ${request.failure()?.errorText}`);
    });
  }

  /** The console, exception, dialog and network invariants; `allowedStatuses` are the HTTP errors this test provoked. */
  assertClean(allowedStatuses: number[] = []): void {
    expect(this.consoleErrors, "console errors").toEqual([]);
    expect(this.pageErrors, "uncaught exceptions").toEqual([]);
    expect(this.dialogs, "alert/confirm/prompt dialogs").toEqual([]);
    expect(this.external, "requests to any origin other than the server").toEqual([]);
    const unexpected = this.statuses.filter((s) => !allowedStatuses.includes(s));
    expect(unexpected, "unexpected HTTP error responses seen by the browser").toEqual([]);
  }
}

async function open(browser: Browser, who: string, opts: { viewport?: { width: number; height: number } } = {}): Promise<{ context: BrowserContext; page: Page; monitor: Monitor }> {
  const context = await browser.newContext({ baseURL: stack.baseUrl, viewport: opts.viewport ?? { width: 1440, height: 900 } });
  const page = await context.newPage();
  const monitor = new Monitor(stack.baseUrl);
  monitor.watch(page);
  context.on("page", (p) => monitor.watch(p));
  await page.goto("/");
  await page.getByLabel("Email").fill(email(who));
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("who")).toBeVisible();
  return { context, page, monitor };
}

const importThroughUi = async (page: Page, revision: string, manifest: unknown) => {
  await page.goto("/snapshots/import");
  await page.getByLabel("Revision label").fill(revision);
  await page.locator("#manifest-text").fill(asJson(manifest));
  await page.getByRole("button", { name: "Import snapshot" }).click();
};

const requestRunThroughUi = async (page: Page, proposed: unknown): Promise<string> => {
  await page.locator("#proposed-text").fill(asJson(proposed));
  await page.getByRole("button", { name: "Request impact run" }).click();
  await page.waitForURL(/\/runs\/[0-9a-f-]{36}$/);
  return UUID_IN_URL.exec(page.url())![1]!;
};

const noHorizontalOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  stack = await createStack();
  acme = await createUser(stack, { email: email("admin"), password: PASSWORD, role: "admin", workspace: "Acme" });
  await createUser(stack, { email: email("operator"), password: PASSWORD, role: "operator", workspaceId: acme });
  await createUser(stack, { email: email("viewer"), password: PASSWORD, role: "viewer", workspaceId: acme });
  await createUser(stack, { email: email("other-admin"), password: PASSWORD, role: "admin", workspace: "Other" });
  await createUser(stack, { email: email("empty-admin"), password: PASSWORD, role: "admin", workspace: "Empty" });
  await createUser(stack, { email: email("hostile-admin"), password: PASSWORD, role: "admin", workspace: "Hostile" });
  server = await stack.serve();

  // The other workspace holds a snapshot and a finished run whose ids the Acme users must never be able to see.
  const session = await login(stack.baseUrl, email("other-admin"), PASSWORD);
  const snap = await api(stack.baseUrl, session, "POST", "/snapshots", { schema_version: 1, revision: "other-1", manifest: fixture.manifests.baseline });
  expect(snap.status, snap.text).toBe(201);
  const run = await api(stack.baseUrl, session, "POST", "/impact-runs", { snapshot_id: snap.json.id, proposed_manifest: fixture.manifests.proposal_breaking_removal, expected_hash: snap.json.hash });
  expect(run.status, run.text).toBe(202);
  await waitForRun(stack.baseUrl, session, run.json.id);
  other = { session, snapshotId: snap.json.id, runId: run.json.id };
});

test.afterAll(async () => {
  await server?.stop();
  stack?.cleanup();
});

test("sign in: a wrong password is refused, the session cookie is HttpOnly and SameSite=Strict, CSRF is enforced, the CSP is strict", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: stack.baseUrl });
  const page = await context.newPage();
  const monitor = new Monitor(stack.baseUrl);
  monitor.watch(page);
  const response = await page.goto("/");
  const csp = response!.headers()["content-security-policy"] ?? "";
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("script-src 'self'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(response!.headers()["x-content-type-options"]).toBe("nosniff");
  expect(csp).not.toContain("unsafe-inline'"); // scripts are never inline; styles are files too

  await page.getByLabel("Email").fill(email("admin"));
  await page.getByLabel("Password").fill("definitely-not-the-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator('[data-code="INVALID_CREDENTIALS"]')).toBeVisible();
  await expect(page.getByTestId("who")).toHaveCount(0);

  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("who")).toContainText("Acme");
  await expect(page.getByTestId("who")).toContainText("admin");

  const cookie = (await context.cookies()).find((c) => c.name === "changeradar_session");
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe("Strict");
  expect(await page.evaluate(() => document.cookie)).not.toContain("changeradar_session");

  // The browser sends the cookie, but a mutation without (or with a wrong) CSRF token is refused and changes nothing.
  const before = await page.request.get("/api/v1/snapshots");
  const noToken = await page.request.post("/api/v1/snapshots", { data: { schema_version: 1, revision: "csrf-probe", manifest: fixture.manifests.baseline } });
  expect(noToken.status()).toBe(403);
  expect((await noToken.json()).error.code).toBe("CSRF_INVALID");
  const wrongToken = await page.request.post("/api/v1/snapshots", { headers: { "x-csrf-token": "wrong" }, data: { schema_version: 1, revision: "csrf-probe", manifest: fixture.manifests.baseline } });
  expect(wrongToken.status()).toBe(403);
  expect(await (await page.request.get("/api/v1/snapshots")).json()).toEqual(await before.json());

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  expect((await page.request.get("/api/v1/snapshots")).status()).toBe(401);
  await context.close();
  monitor.assertClean([401, 403]);
});

test("operator imports a snapshot through the UI and gets its graph hash", async ({ browser }) => {
  const { context, page, monitor } = await open(browser, "operator");
  await expect(page.getByText("No snapshots yet")).toBeVisible();
  await importThroughUi(page, fixture.manifests.baseline.revision as string, fixture.manifests.baseline);
  const receipt = page.getByTestId("import-receipt");
  await expect(receipt).toContainText("Snapshot imported");
  await expect(receipt).toContainText("10 nodes, 9 edges");
  state.baseline1Hash = (await receipt.locator("dt:has-text('Graph hash') + dd code").textContent())!;
  expect(state.baseline1Hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  state.snapshot1 = (await receipt.getByRole("link", { name: /^[0-9a-f-]{36}$/ }).textContent())!;

  await page.goto("/snapshots");
  await expect(page.getByRole("link", { name: "demo-baseline-1" })).toBeVisible();
  await expect(page.locator("tbody tr").first()).toContainText("baseline");
  await context.close();
  monitor.assertClean([401]);
});

test("run impact with a seeded breaking removal: direct and transitive consumers, ordered path, owner", async ({ browser }) => {
  const { context, page, monitor } = await open(browser, "operator");
  await page.goto(`/snapshots/${state.snapshot1}`);
  await page.getByRole("link", { name: "Assess a proposed change" }).click();
  await expect(page.locator("#snapshot")).toHaveValue(state.snapshot1!);
  state.runAffected = await requestRunThroughUi(page, fixture.manifests.proposal_breaking_removal);

  const verdict = page.locator('section.verdict[data-verdict="AFFECTED"]');
  await expect(verdict).toBeVisible();
  await expect(verdict).toContainText("Known consumers can break");
  const rows = page.locator("tr[data-finding-id]");
  await expect(rows).toHaveCount(5);

  const rowFor = (consumer: string) => rows.filter({ has: page.locator(`td[data-label="Consumer"] code:text-is("${consumer}")`) });
  const direct = rowFor("job.invoice-export");
  await expect(direct).toContainText("HIGH direct");
  await expect(direct.locator('td[data-label="Owner"]')).toHaveText("team-data");
  expect(await direct.locator("ol.path li code").allTextContents()).toEqual(["contract.invoice", "job.invoice-export"]);
  await expect(rowFor("svc.ledger-sync").locator('td[data-label="Owner"]')).toHaveText("team-finance");

  const transitive = rowFor("svc.dashboard");
  await expect(transitive).toContainText("MEDIUM transitive (depth 3)");
  await expect(transitive.locator('td[data-label="Owner"]')).toHaveText("team-web");
  // The path is ordered from the changed contract to the consumer and shows where each hop is declared.
  expect(await transitive.locator("ol.path li code").allTextContents()).toEqual(["contract.invoice", "job.invoice-export", "artifact.invoice-report", "svc.dashboard"]);
  await expect(transitive.locator("ol.path")).toContainText("services/dashboard.yaml:9");
  expect(await rowFor("job.audit-archive").locator("ol.path li code").allTextContents()).toEqual(["contract.invoice", "job.invoice-export", "artifact.invoice-report", "job.audit-archive"]);
  // svc.mailer only declared invoice_id, so removing amount does not reach it.
  await expect(rowFor("svc.mailer")).toHaveCount(0);
  await expect(page.getByTestId("coverage")).toContainText("MANIFEST_DECLARED_ONLY");
  await context.close();
  monitor.assertClean([401]);
});

test("viewer reads results but has no mutation controls and is denied the mutation pages", async ({ browser }) => {
  const { context, page, monitor } = await open(browser, "viewer");
  await expect(page.getByTestId("who")).toContainText("viewer");
  await expect(page.getByRole("link", { name: "Import a snapshot" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Contract checks" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Administration" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "demo-baseline-1" })).toBeVisible();

  await page.goto(`/runs/${state.runAffected}`);
  await expect(page.locator('section.verdict[data-verdict="AFFECTED"]')).toBeVisible();
  await expect(page.getByRole("link", { name: "Download JSON report" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open HTML report" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Download evidence bundle" })).toHaveCount(0);

  for (const path of ["/snapshots/import", "/runs/new", "/admin"]) {
    await page.goto(path);
    await expect(page.locator('[data-state="denied"]')).toBeVisible();
  }
  // The server refuses too: the same viewer session cannot import, request a run or read the bundle.
  const session = await login(stack.baseUrl, email("viewer"), PASSWORD);
  expect((await api(stack.baseUrl, session, "POST", "/snapshots", { schema_version: 1, revision: "viewer-probe", manifest: fixture.manifests.baseline })).status).toBe(403);
  expect((await api(stack.baseUrl, session, "GET", `/impact-runs/${state.runAffected}/bundle`)).status).toBe(403);
  await context.close();
  monitor.assertClean([401]);
});

test("NO_KNOWN_IMPACT and INCOMPLETE are distinct, and both show coverage limits and never read as safe", async ({ browser }) => {
  const { context, page, monitor } = await open(browser, "operator");
  // Isolated change against the fresh baseline: NO_KNOWN_IMPACT.
  await page.goto(`/runs/new?snapshot=${state.snapshot1}`);
  state.runNoKnown = await requestRunThroughUi(page, fixture.manifests.proposal_no_known_impact);
  const noKnown = page.locator('section.verdict[data-verdict="NO_KNOWN_IMPACT"]');
  await expect(noKnown).toBeVisible();
  await expect(noKnown).toContainText("does not prove that nothing else depends");
  await expect(page.getByTestId("coverage")).toContainText("MANIFEST_DECLARED_ONLY");
  await expect(page.locator("tr[data-finding-id]")).toHaveCount(0);
  const noKnownStyle = await noKnown.evaluate((el) => getComputedStyle(el).borderStyle);
  const noKnownLabel = await noKnown.locator(".verdict-label").innerText();

  // Import a baseline in which one consumer edge was never verified, then remove the same field: INCOMPLETE.
  await importThroughUi(page, fixture.manifests.baseline_with_unverified_edge.revision as string, fixture.manifests.baseline_with_unverified_edge);
  await expect(page.getByTestId("import-receipt")).toContainText("UNVERIFIED_EDGE");
  await page.getByRole("link", { name: "Assess a proposed change" }).click();
  state.runIncomplete = await requestRunThroughUi(page, fixture.manifests.proposal_breaking_removal);
  const incomplete = page.locator('section.verdict[data-verdict="INCOMPLETE"]');
  await expect(incomplete).toBeVisible();
  await expect(incomplete).toContainText("Impact cannot be ruled out");
  await expect(incomplete).toContainText("not a safe result");
  await expect(incomplete).toContainText("Incomplete never cancels a known break");
  const unknowns = page.getByTestId("unknowns");
  await expect(unknowns).toContainText("UNVERIFIED_CONTRACT");
  await expect(unknowns).toContainText("job.audit-archive");
  await expect(page.getByTestId("coverage")).toContainText("MANIFEST_DECLARED_ONLY");
  await expect(page.locator("tr[data-finding-id]")).toHaveCount(5); // the known breaks stay visible next to the unknown
  const incompleteStyle = await incomplete.evaluate((el) => getComputedStyle(el).borderStyle);
  expect(incompleteStyle).not.toBe(noKnownStyle);
  expect(await incomplete.locator(".verdict-label").innerText()).not.toBe(noKnownLabel);
  await expect(page.locator('[data-verdict="NO_KNOWN_IMPACT"]')).toHaveCount(0);

  // In the run list both verdicts appear as different badges.
  await page.goto("/runs");
  await expect(page.locator("[data-verdict]")).toHaveCount(3); // wait for the list to load before reading it
  const badges = await page.locator("[data-verdict]").evaluateAll((els) => els.map((el) => el.getAttribute("data-verdict")));
  expect(new Set(badges)).toEqual(new Set(["AFFECTED", "NO_KNOWN_IMPACT", "INCOMPLETE"]));
  await context.close();
  monitor.assertClean([401]);
});

test("stale baseline: a run request made after the baseline moved is a 409 that names the current baseline, creates nothing, and recovers", async ({ browser }) => {
  const { context, page, monitor } = await open(browser, "operator");
  const adminSession = await login(stack.baseUrl, email("admin"), PASSWORD);
  await page.goto("/runs/new");
  await expect(page.locator("#snapshot")).toContainText("demo-baseline-2 (baseline)");
  const runsBefore = (await api(stack.baseUrl, adminSession, "GET", "/impact-runs?limit=100")).json.items.length;
  await page.locator("#proposed-text").fill(asJson(fixture.manifests.proposal_breaking_removal));

  // Meanwhile someone else imports a newer snapshot (the baseline moves under the form).
  const moved = await api(stack.baseUrl, adminSession, "POST", "/snapshots", { schema_version: 1, revision: "moved-1", manifest: fixture.manifests.baseline });
  expect(moved.status, moved.text).toBe(201);

  await page.getByRole("button", { name: "Request impact run" }).click();
  const banner = page.locator('[data-code="STALE_BASELINE"]');
  await expect(banner).toBeVisible();
  await expect(banner).toHaveAttribute("data-status", "409");
  await expect(banner).toContainText(moved.json.id);
  await expect(page).toHaveURL(/\/runs\/new$/);
  expect((await api(stack.baseUrl, adminSession, "GET", "/impact-runs?limit=100")).json.items.length).toBe(runsBefore);

  await banner.getByRole("button", { name: "Use the current baseline" }).click();
  await expect(page.locator("#snapshot")).toContainText("moved-1 (baseline)");
  await page.locator("#proposed-text").fill(asJson(fixture.manifests.proposal_breaking_removal));
  await page.getByRole("button", { name: "Request impact run" }).click();
  await page.waitForURL(/\/runs\/[0-9a-f-]{36}$/);
  await expect(page.locator("section.verdict")).toBeVisible();
  await context.close();
  monitor.assertClean([401, 409]);
});

test("JSON and HTML exports carry the same finding ids as the page, and the HTML report is self contained", async ({ browser }) => {
  const { context, page, monitor } = await open(browser, "viewer");
  await page.goto(`/runs/${state.runAffected}`);
  await expect(page.locator("tr[data-finding-id]")).toHaveCount(5);
  const onPage = (await page.locator("tr[data-finding-id]").evaluateAll((els) => els.map((el) => el.getAttribute("data-finding-id")!))).sort();

  const json = await page.request.get(`/api/v1/impact-runs/${state.runAffected}/export?format=json`);
  expect(json.status()).toBe(200);
  const report = await json.json();
  const inJson = (report.findings as { id: string }[]).map((f) => f.id).sort();
  const htmlResponse = await page.request.get(`/api/v1/impact-runs/${state.runAffected}/export?format=html`);
  expect(htmlResponse.status()).toBe(200);
  expect(htmlResponse.headers()["content-type"]).toContain("text/html");
  const html = await htmlResponse.text();
  const inHtml = [...new Set(html.match(/fnd_[0-9a-f]+/g) ?? [])].sort();
  expect(inJson).toHaveLength(5);
  expect(inHtml).toEqual(inJson);
  expect(onPage).toEqual(inJson);
  expect(report.report_hash).toMatch(/^sha256:/);
  expect(html).toContain(report.report_hash);

  // The report opened in the browser: same ids as visible text, no script, no external resource, strict policy.
  const opened = await page.goto(`/api/v1/impact-runs/${state.runAffected}/export?format=html`);
  expect(opened!.headers()["content-security-policy"]).toContain("default-src 'none'");
  for (const id of inJson) await expect(page.getByText(id, { exact: false }).first()).toBeVisible();
  expect(await page.evaluate(() => document.scripts.length)).toBe(0);
  expect(await page.evaluate(() => document.querySelectorAll("img,iframe,link[rel=stylesheet],script[src]").length)).toBe(0);
  await expect(page.locator("body")).toContainText("team-web");
  await context.close();
  monitor.assertClean([401]);
});

test("hostile strings in every free-text field render as text in the UI and in the report and execute nothing", async ({ browser }) => {
  const { context, page, monitor } = await open(browser, "hostile-admin");
  const field = (name: string, type: string, required = true) => ({ name, type, required });
  const node = (id: string, kind: string, extra: Record<string, unknown> = {}) => ({ id, kind, owner: HOSTILE.owner, version: HOSTILE.version, ...extra });
  const edge = (source_id: string, target_id: string, relation: string) => ({ source_id, target_id, relation, source_file: HOSTILE.file, source_line: 3, verified_at: new Date(Date.now() - 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z") });
  const doc = (fields: ReturnType<typeof field>[]) => ({
    schema_version: 1,
    revision: HOSTILE.revision,
    provenance: { source: "hostile-fixture" },
    nodes: [node("svc.producer", "service"), node("contract.thing", "contract", { contract: { fields } }), node("job.consumer", "job")],
    edges: [edge("svc.producer", "contract.thing", "produces"), edge("job.consumer", "contract.thing", "consumes")],
  });
  await importThroughUi(page, HOSTILE.revision, doc([field("id", "string"), field("amount", "number")]));
  await expect(page.getByTestId("import-receipt")).toBeVisible();
  const snapshotId = (await page.getByTestId("import-receipt").getByRole("link", { name: /^[0-9a-f-]{36}$/ }).textContent())!;

  const literal = async () => {
    expect(await page.evaluate(() => (window as unknown as { __pwned?: unknown }).__pwned)).toBeUndefined();
    expect(await page.locator("img[src='x'], svg[onload], script:not([src])").count()).toBe(0);
    const text = await page.locator("main").innerText();
    expect(text).toContain(HOSTILE.owner);
  };

  await page.goto(`/snapshots/${snapshotId}`);
  await expect(page.getByText("Snapshot " + HOSTILE.revision)).toBeVisible();
  await page.getByRole("button", { name: "Nodes" }).click();
  await expect(page.locator("main")).toContainText(HOSTILE.owner);
  await expect(page.locator("main")).toContainText(HOSTILE.version);
  await literal();

  await page.goto(`/runs/new?snapshot=${snapshotId}`);
  const runId = await requestRunThroughUi(page, doc([field("id", "string")]));
  await expect(page.locator('section.verdict[data-verdict]')).toBeVisible();
  await expect(page.locator("tr[data-finding-id]").first()).toBeVisible();
  await literal();
  await expect(page.locator("main")).toContainText(HOSTILE.file);

  // The static report escapes the same strings: they appear in the DOM text, never as elements.
  await page.goto(`/api/v1/impact-runs/${runId}/export?format=html`);
  expect(await page.evaluate(() => (window as unknown as { __pwned?: unknown }).__pwned)).toBeUndefined();
  expect(await page.locator("img[src='x'], svg[onload], script").count()).toBe(0);
  await expect(page.locator("body")).toContainText(HOSTILE.owner);
  await expect(page.locator("body")).toContainText(HOSTILE.revision);
  await context.close();
  monitor.assertClean([401]);
});

test("empty, denied, not found (another workspace) and failed states", async ({ browser }) => {
  // Empty: a workspace with nothing in it.
  const empty = await open(browser, "empty-admin");
  await expect(empty.page.locator('[data-state="empty"]')).toContainText("No snapshots yet");
  await empty.page.goto("/runs");
  await expect(empty.page.locator('[data-state="empty"]')).toBeVisible();
  await empty.context.close();
  empty.monitor.assertClean([401]);

  const { context, page, monitor } = await open(browser, "operator");
  // Not found: another workspace's objects look exactly like ones that never existed, and change nothing.
  const banners: Record<string, string> = {};
  const denied = async (label: string, path: string) => {
    await page.goto(path);
    const banner = page.locator('[data-state="denied"]');
    await expect(banner).toBeVisible();
    await expect(banner).toHaveAttribute("data-status", "404");
    banners[label] = (await banner.innerText()).replace(/Reference [0-9a-f-]+/i, "").trim();
  };
  await denied("foreign run", `/runs/${other.runId}`);
  await denied("missing run", `/runs/${UUID_UNKNOWN}`);
  await denied("foreign snapshot", `/snapshots/${other.snapshotId}`);
  await denied("missing snapshot", `/snapshots/${UUID_UNKNOWN}`);
  expect(banners["foreign run"]).toBe(banners["missing run"]);
  expect(banners["foreign snapshot"]).toBe(banners["missing snapshot"]);
  // API level: foreign ids are 404 on reads and on run requests, with the right hash, and create nothing.
  const session = await login(stack.baseUrl, email("operator"), PASSWORD);
  for (const path of [`/impact-runs/${other.runId}`, `/impact-runs/${other.runId}/export?format=json`, `/snapshots/${other.snapshotId}`, `/snapshots/${other.snapshotId}/nodes`]) {
    expect((await api(stack.baseUrl, session, "GET", path)).status, path).toBe(404);
  }
  const otherHash = (await api(stack.baseUrl, other.session, "GET", `/snapshots/${other.snapshotId}`)).json.hash;
  const runsBefore = (await api(stack.baseUrl, session, "GET", "/impact-runs?limit=100")).json.items.length;
  expect((await api(stack.baseUrl, session, "POST", "/impact-runs", { snapshot_id: other.snapshotId, proposed_manifest: fixture.manifests.baseline, expected_hash: otherHash })).status).toBe(404);
  expect((await api(stack.baseUrl, session, "GET", "/impact-runs?limit=100")).json.items.length).toBe(runsBefore);

  // Failed: a manifest with a dangling edge is refused whole with the reason, and nothing is stored.
  const snapshotsBefore = (await api(stack.baseUrl, session, "GET", "/snapshots?limit=100")).json.items.length;
  const dangling = { ...fixture.manifests.baseline, revision: "dangling-1", edges: [...(fixture.manifests.baseline.edges as unknown[]), { source_id: "svc.mailer", target_id: "svc.ghost", relation: "consumes", source_file: "services/mailer.yaml", source_line: 30, verified_at: null }] };
  await importThroughUi(page, "dangling-1", dangling);
  const failed = page.locator('[data-state="failed"][data-status="422"]');
  await expect(failed).toBeVisible();
  await expect(failed).toContainText("DANGLING_EDGE");
  await expect(page.getByTestId("import-receipt")).toHaveCount(0);
  expect((await api(stack.baseUrl, session, "GET", "/snapshots?limit=100")).json.items.length).toBe(snapshotsBefore);
  await context.close();
  monitor.assertClean([401, 404, 422]);
});

for (const viewport of [
  { width: 375, height: 812 },
  { width: 1440, height: 900 },
]) {
  test(`no horizontal overflow, no external requests and no console errors at ${viewport.width}px`, async ({ browser }) => {
    const { context, page, monitor } = await open(browser, "operator", { viewport });
    const snapshots = (await api(stack.baseUrl, await login(stack.baseUrl, email("operator"), PASSWORD), "GET", "/snapshots?limit=100")).json.items as { id: string }[];
    const paths = ["/snapshots", `/snapshots/${snapshots[0]!.id}`, "/snapshots/import", "/runs", `/runs/${state.runAffected}`, `/runs/${state.runIncomplete}`, `/runs/${state.runNoKnown}`, "/runs/new", `/api/v1/impact-runs/${state.runAffected}/export?format=html`];
    for (const path of paths) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      await expect(page.locator('[data-state="loading"]')).toHaveCount(0); // measure the loaded page, not the loading state
      await expect(page.locator("main, body").first()).not.toBeEmpty();
      expect(await noHorizontalOverflow(page), `horizontal overflow on ${path} at ${viewport.width}px`).toBe(true);
    }
    await context.close();
    monitor.assertClean([401]);
  });
}
