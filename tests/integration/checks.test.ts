import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultSettings } from "../../src/platform/context.js";
import { deleteCredential, listCredentialAliases, loadCredential, setCredential } from "../../src/services/checks.js";
import { clone } from "../helpers/builders.js";
import { FAKE_BEARER, FAKE_GITHUB_TOKEN } from "../helpers/fake-secrets.js";
import { startFixture, type Fixture } from "../helpers/fixture-server.js";
import { createHarness, getRun, type Harness, type TestWorkspace } from "../helpers/harness.js";
import { baselineDoc, removeAmountDoc } from "../helpers/scenario.js";

/** FIXTURE server: a real local HTTP endpoint. Checks below exercise the real network path against it. */
describe("AC-06 read-only contract checks against a fixture HTTP server", () => {
  let h: Harness;
  let ws: TestWorkspace;
  let fx: Fixture;
  const bearer = "planted-check-secret-0123456789";

  beforeAll(async () => {
    fx = await startFixture({ bearer });
    h = await createHarness({
      settings: { checks: { ...defaultSettings.checks, allowedHosts: [`127.0.0.1:${fx.port}`], allowPrivateNetwork: true, backoffBaseMs: 10, maxBodyBytes: 512 * 1024 } },
    });
    ws = await h.workspace("Checks");
  });
  afterAll(async () => {
    await h.close();
    await fx.close();
  });

  let seq = 0;
  async function defineCheck(overrides: Record<string, unknown> = {}) {
    seq += 1;
    const res = await h.api(ws.admin, "POST", "/api/v1/contract-checks", {
      key: `chk.live-${seq}`,
      node_id: "contract.invoice",
      url: `${fx.origin}/ok`,
      timeout_ms: 1000,
      retries: 0,
      required_fields: [
        { name: "invoice_id", type: "string" },
        { name: "amount", type: "number" },
      ],
      ...overrides,
    });
    expect(res.status, res.text).toBe(201);
    return res.body as { id: string; key: string };
  }
  async function runWith(check: { key: string }, proposed: unknown = removeAmountDoc()) {
    const snap = await h.importSnapshot(ws.operator, baselineDoc());
    const run = await h.requestRun(ws.operator, { snapshot_id: snap.body.id, proposed_manifest: proposed, expected_hash: snap.body.hash, check_keys: [check.key] });
    expect(run.status, run.text).toBe(202);
    await h.drain();
    return getRun(h, ws.viewer, run.body.id);
  }
  const disableAll = async () => {
    const list = await h.api(ws.admin, "GET", "/api/v1/contract-checks");
    for (const c of list.body.items) if (c.enabled) await h.api(ws.admin, "POST", `/api/v1/contract-checks/${c.id}/disable`);
  };

  describe("check definitions", () => {
    it("an admin creates a check; the response carries the definition and never a credential value", async () => {
      const res = await h.api(ws.admin, "POST", "/api/v1/contract-checks", {
        key: "chk.definition",
        node_id: "contract.invoice",
        url: `${fx.origin}/ok`,
        credential_alias: "billing-api",
      });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ key: "chk.definition", method: "GET", timeout_ms: 5000, retries: 2, expect_status: 200, required_fields: [], credential_alias: "billing-api", credential_configured: false, enabled: true, disabled_at: null });
      const listed = await h.api(ws.operator, "GET", "/api/v1/contract-checks");
      expect(listed.body.items.map((c: any) => c.key)).toContain("chk.definition");
      await disableAll();
    });

    it("rejects duplicates (409), non-allowlisted hosts (422 URL_NOT_ALLOWED), credentials in URLs, and malformed definitions (422)", async () => {
      await defineCheck({ key: "chk.dup" });
      const dup = await h.api(ws.admin, "POST", "/api/v1/contract-checks", { key: "chk.dup", node_id: "contract.invoice", url: `${fx.origin}/ok` });
      expect(dup.status).toBe(409);
      expect(dup.body.error.code).toBe("CHECK_EXISTS");
      const blocked = await h.api(ws.admin, "POST", "/api/v1/contract-checks", { key: "chk.blocked", node_id: "contract.invoice", url: "http://169.254.169.254/latest/meta-data" });
      expect(blocked.status).toBe(422);
      expect(blocked.body.error).toMatchObject({ code: "URL_NOT_ALLOWED", details: { reason: "HOST_NOT_ALLOWED" } });
      const wrongPort = await h.api(ws.admin, "POST", "/api/v1/contract-checks", { key: "chk.port", node_id: "contract.invoice", url: "http://127.0.0.1:1/ok" });
      expect(wrongPort.body.error.details.reason).toBe("PORT_NOT_ALLOWED");
      const creds = await h.api(ws.admin, "POST", "/api/v1/contract-checks", { key: "chk.creds", node_id: "contract.invoice", url: `http://user:pw@127.0.0.1:${fx.port}/ok` });
      expect(creds.status).toBe(422);
      const secretUrl = await h.api(ws.admin, "POST", "/api/v1/contract-checks", { key: "chk.secret", node_id: "contract.invoice", url: `${fx.origin}/ok?token=${FAKE_GITHUB_TOKEN}` });
      expect(secretUrl.body.error.code).toBe("SECRET_VALUE_REJECTED");
      expect(secretUrl.text).not.toContain(FAKE_GITHUB_TOKEN);
      const bad: Record<string, unknown>[] = [
        { key: "bad key" },
        { node_id: "" },
        { url: "" },
        { url: "not a url" },
        { method: "POST" },
        { method: "HEAD", required_fields: [{ name: "a", type: "string" }] },
        { timeout_ms: 0 },
        { timeout_ms: 99_999_999 },
        { retries: 4 },
        { retries: -1 },
        { expect_status: 99 },
        { required_fields: [{ name: "a", type: "date" }] },
        { required_fields: [{ name: "a", type: "string" }, { name: "a", type: "number" }] },
        { credential_alias: "bad alias" },
        { unknown_property: true },
      ];
      for (const patch of bad) {
        const res = await h.api(ws.admin, "POST", "/api/v1/contract-checks", { key: "chk.bad", node_id: "contract.invoice", url: `${fx.origin}/ok`, ...patch });
        expect(res.status, JSON.stringify(patch)).toBe(422);
      }
      await disableAll();
    });

    it("disabling is idempotent, audited, and removes the check from selection", async () => {
      const check = await defineCheck();
      const first = await h.api(ws.admin, "POST", `/api/v1/contract-checks/${check.id}/disable`);
      const second = await h.api(ws.admin, "POST", `/api/v1/contract-checks/${check.id}/disable`);
      expect(first.body).toMatchObject({ enabled: false });
      expect(second.body.disabled_at).toBe(first.body.disabled_at);
      const snap = await h.importSnapshot(ws.operator, baselineDoc());
      const run = await h.requestRun(ws.operator, { snapshot_id: snap.body.id, proposed_manifest: removeAmountDoc(), expected_hash: snap.body.hash, check_keys: [check.key] });
      expect(run.status).toBe(422);
      expect(run.body.error.code).toBe("UNKNOWN_CHECK");
      const audit = await h.api(ws.admin, "GET", "/api/v1/audit?limit=100");
      expect(audit.body.items.map((a: any) => a.action)).toEqual(expect.arrayContaining(["contract_check.created", "contract_check.disabled"]));
    });
  });

  describe("outcomes are visible and never converted to a pass", () => {
    it("PASSED: expected status and every required field with the right type", async () => {
      const check = await defineCheck();
      const view = await runWith(check);
      expect(view.checks).toEqual([expect.objectContaining({ check_key: check.key, node_id: "contract.invoice", state: "PASSED", attempts: 1, error_code: null })]);
      expect(view.assessment).toBe("AFFECTED"); // a passing live check adds no unknown; the verdict is the impact
      expect(view.unknowns).toEqual([]);
      const before = fx.requests.filter((r) => r.url === "/ok").length;
      expect(before).toBeGreaterThan(0);
    });

    it("only GET (or HEAD) is ever sent to the endpoint: checks are read-only", async () => {
      expect(fx.requests.length).toBeGreaterThan(0);
      expect(new Set(fx.requests.map((r) => r.method))).toEqual(new Set(["GET"]));
    });

    it("HEAD checks are supported", async () => {
      const check = await defineCheck({ method: "HEAD", required_fields: [] });
      const view = await runWith(check);
      expect(view.checks[0].state).toBe("PASSED");
      expect(fx.requests.some((r) => r.method === "HEAD")).toBe(true);
    });

    it("FAILED: missing field, wrong type, non-JSON, non-object, wrong status -> INCOMPLETE with the reason", async () => {
      const cases: [string, string][] = [
        ["/missing-field", "missing fields: amount"],
        ["/wrong-type", "wrong type: invoice_id, amount"],
        ["/not-json", "not valid JSON"],
        ["/array", "not a JSON object"],
        ["/server-error", "expected HTTP 200, got 500"],
        ["/nowhere", "expected HTTP 200, got 404"],
      ];
      for (const [path, expected] of cases) {
        const check = await defineCheck({ url: `${fx.origin}${path}` });
        const view = await runWith(check);
        expect(view.checks[0], path).toMatchObject({ state: "FAILED" });
        expect(view.checks[0].detail, path).toContain(expected);
        expect(view.assessment, path).toBe("INCOMPLETE");
        expect(view.unknowns.map((u: any) => u.code), path).toContain("CHECK_FAILED");
        expect(view.summary.known_impact).toBe(true); // real findings stay visible next to the unknown
      }
    });

    it("expect_status can be configured (a 404 the operator expects is a pass)", async () => {
      const check = await defineCheck({ url: `${fx.origin}/nowhere`, expect_status: 404, required_fields: [] });
      expect((await runWith(check)).checks[0].state).toBe("PASSED");
    });

    it("TIMED_OUT within the configured limit, never a pass; the run stays visible and INCOMPLETE", async () => {
      const check = await defineCheck({ url: `${fx.origin}/hang`, timeout_ms: 200 });
      const started = Date.now();
      const view = await runWith(check);
      expect(Date.now() - started).toBeLessThan(3000);
      expect(view.checks[0]).toMatchObject({ state: "TIMED_OUT", error_code: "TIMEOUT" });
      expect(view.checks[0].detail).toContain("200 ms");
      expect(view.assessment).toBe("INCOMPLETE");
      expect(view.unknowns.map((u: any) => u.code)).toContain("CHECK_TIMED_OUT");
    });

    it("a slow endpoint that answers after the limit is a TIMEOUT even though it eventually answers correctly", async () => {
      fx.setSlowMs(600);
      const check = await defineCheck({ url: `${fx.origin}/slow`, timeout_ms: 150 });
      const view = await runWith(check);
      expect(view.checks[0].state).toBe("TIMED_OUT");
      expect(view.assessment).toBe("INCOMPLETE");
      await new Promise((r) => setTimeout(r, 700)); // let the fixture finish its late answer; it must change nothing
      expect((await getRun(h, ws.viewer, view.id)).checks[0].state).toBe("TIMED_OUT");
    });

    it("retries transport failures with exponential backoff (up to three retries) and keeps every failed attempt visible", async () => {
      const check = await defineCheck({ url: `${fx.origin}/flaky`, retries: 3, timeout_ms: 1000 });
      const view = await runWith(check);
      expect(fx.hits("/flaky")).toBe(3);
      expect(view.checks[0]).toMatchObject({ state: "PASSED", attempts: 3 });
      expect(view.checks[0].attempt_log.map((a: any) => a.state)).toEqual(["ERROR", "ERROR", "PASSED"]);
      expect(view.checks[0].attempt_log[0].detail).toContain("connection failed");
    });

    it("exhausted retries end as ERROR, never PASSED, with the attempt count", async () => {
      const closed = await startFixture();
      const port = closed.port;
      await closed.close();
      // The allowlist admits only the fixture port, so extend it for the dead port through a second harness.
      const h2 = await createHarness({ settings: { checks: { ...defaultSettings.checks, allowedHosts: [`127.0.0.1:${port}`], allowPrivateNetwork: true, backoffBaseMs: 5 } } });
      try {
        const w = await h2.workspace("Dead");
        const created = await h2.api(w.admin, "POST", "/api/v1/contract-checks", { key: "chk.dead", node_id: "contract.invoice", url: `http://127.0.0.1:${port}/ok`, retries: 2, timeout_ms: 500 });
        expect(created.status).toBe(201);
        const snap = await h2.importSnapshot(w.operator, baselineDoc());
        const run = await h2.requestRun(w.operator, { snapshot_id: snap.body.id, proposed_manifest: removeAmountDoc(), expected_hash: snap.body.hash });
        await h2.drain();
        const view = await getRun(h2, w.viewer, run.body.id);
        expect(view.checks[0]).toMatchObject({ state: "ERROR", attempts: 3, error_code: "RUNNER_ERROR" });
        expect(view.checks[0].detail).toContain("ECONNREFUSED");
        expect(view.assessment).toBe("INCOMPLETE");
        expect(view.unknowns.map((u: any) => u.code)).toContain("CHECK_ERROR");
      } finally {
        await h2.close();
      }
    });

    it("selects checks automatically by the changed nodes; a check on an unchanged node is not run", async () => {
      await disableAll();
      const onChanged = await defineCheck({ key: "chk.auto-changed", node_id: "contract.invoice" });
      await defineCheck({ key: "chk.auto-other", node_id: "job.export", url: `${fx.origin}/server-error` });
      const snap = await h.importSnapshot(ws.operator, baselineDoc());
      const run = await h.requestRun(ws.operator, { snapshot_id: snap.body.id, proposed_manifest: removeAmountDoc(), expected_hash: snap.body.hash });
      await h.drain();
      const view = await getRun(h, ws.viewer, run.body.id);
      expect(view.checks.map((c: any) => c.check_key)).toEqual([onChanged.key]);
      // With no change at all no check runs, and the verdict is not affected by unrelated failing checks.
      const same = await h.requestRun(ws.operator, { snapshot_id: snap.body.id, proposed_manifest: baselineDoc(), expected_hash: snap.body.hash });
      await h.drain();
      expect((await getRun(h, ws.viewer, same.body.id)).checks).toEqual([]);
      await disableAll();
    });

    it("refuses a run that would execute more checks than the per-run cap, visibly (FAILED TOO_MANY_CHECKS)", async () => {
      await disableAll();
      const capped = await createHarness({ settings: { checks: { ...defaultSettings.checks, allowedHosts: [`127.0.0.1:${fx.port}`], allowPrivateNetwork: true, maxChecksPerRun: 1 } } });
      try {
        const w = await capped.workspace("Capped");
        for (const key of ["chk.one", "chk.two"]) {
          await capped.api(w.admin, "POST", "/api/v1/contract-checks", { key, node_id: "contract.invoice", url: `${fx.origin}/ok` });
        }
        const snap = await capped.importSnapshot(w.operator, baselineDoc());
        const run = await capped.requestRun(w.operator, { snapshot_id: snap.body.id, proposed_manifest: removeAmountDoc(), expected_hash: snap.body.hash });
        await capped.drain();
        const view = await getRun(capped, w.viewer, run.body.id);
        expect(view).toMatchObject({ status: "failed", assessment: null, error: { code: "TOO_MANY_CHECKS" } });
      } finally {
        await capped.close();
      }
    });
  });

  describe("egress policy is enforced when the check runs, including redirects and DNS resolution", () => {
    it("follows an allowlisted redirect and refuses a redirect to a host that is not allowlisted (visible ERROR)", async () => {
      const followed = await runWith(await defineCheck({ url: `${fx.origin}/redirect-to-ok` }));
      expect(followed.checks[0].state).toBe("PASSED");
      const escaped = await runWith(await defineCheck({ url: `${fx.origin}/redirect-elsewhere` }));
      expect(escaped.checks[0]).toMatchObject({ state: "ERROR" });
      expect(escaped.checks[0].detail).toContain("EgressDeniedError");
      expect(escaped.assessment).toBe("INCOMPLETE");
    });

    it("without the test-only private network override even an allowlisted loopback endpoint is refused", async () => {
      const strict = await createHarness({ settings: { checks: { ...defaultSettings.checks, allowedHosts: [`127.0.0.1:${fx.port}`], allowPrivateNetwork: false } } });
      try {
        const w = await strict.workspace("Strict");
        await strict.api(w.admin, "POST", "/api/v1/contract-checks", { key: "chk.strict", node_id: "contract.invoice", url: `${fx.origin}/ok`, retries: 0 });
        const snap = await strict.importSnapshot(w.operator, baselineDoc());
        const before = fx.requests.length;
        const run = await strict.requestRun(w.operator, { snapshot_id: snap.body.id, proposed_manifest: removeAmountDoc(), expected_hash: snap.body.hash });
        await strict.drain();
        const view = await getRun(strict, w.viewer, run.body.id);
        expect(view.checks[0]).toMatchObject({ state: "ERROR" });
        expect(view.checks[0].detail).toContain("not allowed");
        expect(fx.requests.length).toBe(before); // no packet reached the server
      } finally {
        await strict.close();
      }
    });

    it("a check whose URL stopped being allowlisted after creation is refused at run time", async () => {
      const narrowed = await createHarness({ settings: { checks: { ...defaultSettings.checks, allowedHosts: ["other.example.test"], allowPrivateNetwork: true } } });
      try {
        const w = await narrowed.workspace("Narrowed");
        // Simulate a definition that predates a tightened allowlist by inserting it directly.
        await narrowed.db.query(
          "INSERT INTO contract_checks (id, workspace_id, check_key, node_id, url, method, timeout_ms, retries, expect_status, enabled, created_at) VALUES (gen_random_uuid(), $1, 'chk.old', 'contract.invoice', $2, 'GET', 500, 0, 200, true, now())",
          [w.id, `${fx.origin}/ok`],
        );
        const snap = await narrowed.importSnapshot(w.operator, baselineDoc());
        const run = await narrowed.requestRun(w.operator, { snapshot_id: snap.body.id, proposed_manifest: removeAmountDoc(), expected_hash: snap.body.hash });
        await narrowed.drain();
        const view = await getRun(narrowed, w.viewer, run.body.id);
        expect(view.checks[0].state).toBe("ERROR");
        expect(view.checks[0].detail).toContain("allowlist");
      } finally {
        await narrowed.close();
      }
    });

    it("enforces the response body limit (declared and streamed) as ERROR, not as a pass", async () => {
      for (const path of ["/huge", "/huge-declared", "/huge-chunked"]) {
        const view = await runWith(await defineCheck({ url: `${fx.origin}${path}` }));
        expect(view.checks[0], path).toMatchObject({ state: "ERROR" });
        expect(view.checks[0].detail, path).toContain("size limit");
      }
    });

    it("checks every supported field type, and reports a mismatch by field name only", async () => {
      const all = [
        { name: "s", type: "string" },
        { name: "n", type: "number" },
        { name: "i", type: "integer" },
        { name: "b", type: "boolean" },
        { name: "nul", type: "null" },
        { name: "arr", type: "array" },
        { name: "obj", type: "object" },
      ];
      const ok = await runWith(await defineCheck({ url: `${fx.origin}/types`, required_fields: all }));
      expect(ok.checks[0].state).toBe("PASSED");
      const wrong = all.map((f) => ({ name: f.name, type: f.type === "string" ? "number" : f.type === "number" ? "integer" : f.type === "integer" ? "string" : f.type === "boolean" ? "null" : f.type === "null" ? "boolean" : f.type === "array" ? "object" : "array" }));
      const bad = await runWith(await defineCheck({ url: `${fx.origin}/types`, required_fields: wrong }));
      expect(bad.checks[0].state).toBe("FAILED");
      expect(bad.checks[0].detail).toBe("wrong type: s, n, i, b, nul, arr, obj");
    });

    it("the HTML report lists checks with their state and detail, and unknowns with their codes", async () => {
      const check = await defineCheck({ url: `${fx.origin}/missing-field` });
      const view = await runWith(check);
      const html = await h.api(ws.viewer, "GET", `/api/v1/impact-runs/${view.id}/export?format=html`);
      expect(html.text).toContain(`${check.key}: FAILED (missing fields: amount)`);
      expect(html.text).toContain("CHECK_FAILED");
      expect(html.text).toContain("Unknowns (1)");
    });
  });

  describe("credential aliases", () => {
    it("the alias resolves to a value sealed at rest; the value is sent only as a bearer header and appears nowhere else", async () => {
      await setCredential(h.ctx, ws.id, "billing-api", bearer);
      expect(await listCredentialAliases(h.ctx, ws.id)).toEqual(["billing-api"]);
      expect(await loadCredential(h.ctx, ws.id, "billing-api")).toBe(bearer);
      const check = await defineCheck({ url: `${fx.origin}/auth`, credential_alias: "billing-api" });
      expect((await h.api(ws.operator, "GET", "/api/v1/contract-checks")).body.items.find((c: any) => c.key === check.key).credential_configured).toBe(true);
      const view = await runWith(check);
      expect(view.checks[0].state).toBe("PASSED");
      expect(fx.requests.filter((r) => r.url === "/auth").every((r) => r.authorization === `Bearer ${bearer}`)).toBe(true);

      // Nothing the API, the exports or the database expose contains the value.
      const dumps = await Promise.all([
        h.api(ws.admin, "GET", "/api/v1/contract-checks"),
        h.api(ws.admin, "GET", `/api/v1/impact-runs/${view.id}`),
        h.api(ws.admin, "GET", `/api/v1/impact-runs/${view.id}/export?format=json`),
        h.api(ws.admin, "GET", `/api/v1/impact-runs/${view.id}/export?format=html`),
        h.api(ws.admin, "GET", `/api/v1/impact-runs/${view.id}/bundle`),
        h.api(ws.admin, "GET", "/api/v1/audit?limit=100"),
        h.api(ws.admin, "GET", "/api/v1/events?limit=100"),
      ]);
      for (const d of dumps) expect(d.text).not.toContain(bearer);
      const raw = await h.db.query<{ t: string }>(
        "SELECT (SELECT string_agg(secret_enc, '|') FROM credential_secrets) || (SELECT string_agg(definition::text, '|') FROM check_results) || (SELECT string_agg(redacted_metadata::text, '|') FROM audit_events) AS t",
      );
      expect(raw.rows[0]?.t).not.toContain(bearer);
      const sealed = await h.db.query<{ secret_enc: string }>("SELECT secret_enc FROM credential_secrets");
      expect(sealed.rows[0]?.secret_enc).toMatch(/^v1:/);
    });

    it("an alias with no stored value is a visible ERROR, and deleting a value takes effect", async () => {
      const check = await defineCheck({ url: `${fx.origin}/auth`, credential_alias: "missing-alias" });
      const view = await runWith(check);
      expect(view.checks[0]).toMatchObject({ state: "ERROR" });
      expect(view.checks[0].detail).toContain("no stored value");
      expect(await deleteCredential(h.ctx, ws.id, "billing-api")).toBe(true);
      expect(await deleteCredential(h.ctx, ws.id, "billing-api")).toBe(false);
      expect(await loadCredential(h.ctx, ws.id, "billing-api")).toBeNull();
    });

    it("the wrong bearer value is a FAILED check (401), not a pass", async () => {
      await setCredential(h.ctx, ws.id, "wrong-token", FAKE_BEARER);
      const view = await runWith(await defineCheck({ url: `${fx.origin}/auth`, credential_alias: "wrong-token" }));
      expect(view.checks[0].state).toBe("FAILED");
      expect(view.checks[0].detail).toContain("got 401");
    });

    it("rejects invalid aliases and values in the credential service", async () => {
      await expect(setCredential(h.ctx, ws.id, "bad alias", "v")).rejects.toThrow(/alias/);
      await expect(setCredential(h.ctx, ws.id, "ok-alias", "")).rejects.toThrow(/value/);
      await expect(setCredential(h.ctx, ws.id, "ok-alias", "line\nbreak")).rejects.toThrow(/value/);
      await setCredential(h.ctx, ws.id, "rotating", "first-value-1");
      await setCredential(h.ctx, ws.id, "rotating", "second-value-2");
      expect(await loadCredential(h.ctx, ws.id, "rotating")).toBe("second-value-2");
    });
  });

  it("run checks flag off: a failing configured check does not run and does not change the verdict", async () => {
    await disableAll();
    await defineCheck({ key: "chk.skipped", url: `${fx.origin}/server-error` });
    const snap = await h.importSnapshot(ws.operator, baselineDoc());
    const before = fx.hits("/server-error");
    const run = await h.requestRun(ws.operator, { snapshot_id: snap.body.id, proposed_manifest: clone(removeAmountDoc()), expected_hash: snap.body.hash, run_checks: false });
    await h.drain();
    expect((await getRun(h, ws.viewer, run.body.id)).checks).toEqual([]);
    expect(fx.hits("/server-error")).toBe(before);
  });
});
