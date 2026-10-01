import { inject, describe, expect, it } from "vitest";
import { REPORT_CSP } from "../../src/report/html-report.js";
import { HOSTILE } from "./hostile.js";

/** Plain HTTP against the real, seeded API (see global-setup.ts): a real session cookie, real exports. */
async function session(email: string): Promise<{ get: (path: string) => Promise<Response> }> {
  const seed = inject("seed");
  const login = await fetch(`${seed.baseUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: seed.password }),
  });
  expect(login.status).toBe(200);
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return { get: (path) => fetch(`${seed.baseUrl}${path}`, { headers: { cookie } }) };
}

const idsInHtml = (html: string): string[] => [...html.matchAll(/<tr id="finding-[^"]*" data-finding-id="([^"]*)"/g)].map((m) => m[1] as string);

describe("AC-07: the JSON export and the HTML export of a real run list the same finding ids", () => {
  const cases: [string, "main" | "big" | "cycles" | "hostile", string][] = [
    ["AFFECTED (direct and transitive)", "main", "runAffected"],
    ["NO_KNOWN_IMPACT", "main", "runNoImpact"],
    ["INCOMPLETE with known impact", "main", "runIncomplete"],
    ["cycles reported", "cycles", "runCycle"],
    ["hostile strings", "hostile", "runHostile"],
    ["more than one page of findings", "big", "runBig"],
  ];

  it.each(cases)("%s", async (_label, workspace, key) => {
    const seed = inject("seed");
    const w = seed.workspaces[workspace];
    const viewer = await session(w.emails.viewer);
    const runId = w.ids[key] as string;
    const json = await viewer.get(`/api/v1/impact-runs/${runId}/export?format=json`);
    expect(json.status).toBe(200);
    const report = (await json.json()) as { findings: { id: string }[]; report_hash: string; run: { assessment: string }; unknowns: unknown[] };
    const htmlResponse = await viewer.get(`/api/v1/impact-runs/${runId}/export?format=html`);
    expect(htmlResponse.status).toBe(200);
    expect(htmlResponse.headers.get("content-type")).toContain("text/html");
    const html = await htmlResponse.text();

    const htmlIds = idsInHtml(html);
    expect(htmlIds).toEqual(report.findings.map((f) => f.id));
    for (const finding of report.findings) expect(html).toContain(`<code>${finding.id}</code>`);
    expect(html).toContain(report.report_hash);
    expect(html).toContain(`data-verdict="${report.run.assessment}"`);
    // Both come from the same service object: the API's own count agrees.
    const run = (await (await viewer.get(`/api/v1/impact-runs/${runId}`)).json()) as { totals: { findings: number } };
    expect(report.findings.length).toBe(run.totals.findings);
  });

  it("the served HTML is the registered renderer's document: strict policy in the header and in the document, no script", async () => {
    const seed = inject("seed");
    const viewer = await session(seed.workspaces.main.emails.viewer);
    const res = await viewer.get(`/api/v1/impact-runs/${seed.workspaces.main.ids.runAffected}/export?format=html`);
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const html = await res.text();
    expect(html).toContain(REPORT_CSP);
    expect(html).not.toMatch(/<script|<link|<img|https?:\/\//);
    expect(html).toContain("Impact report");
  });

  it("the HTML export is deterministic for a finished run: two requests return identical bytes", async () => {
    const seed = inject("seed");
    const viewer = await session(seed.workspaces.main.emails.viewer);
    const path = `/api/v1/impact-runs/${seed.workspaces.main.ids.runAffected}/export?format=html`;
    expect(await (await viewer.get(path)).text()).toBe(await (await viewer.get(path)).text());
  });

  it("hostile manifest strings reach the real HTML export only as escaped text (AC-09)", async () => {
    const seed = inject("seed");
    const w = seed.workspaces.hostile;
    const viewer = await session(w.emails.viewer);
    const html = await (await viewer.get(`/api/v1/impact-runs/${w.ids.runHostile}/export?format=html`)).text();
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<svg/onload");
    expect(html).not.toContain("<script>window");
    expect(html).toContain("&lt;svg/onload=window.__pwned=1&gt;");
    expect(html).toContain("&lt;img src=x onerror=&quot;window.__pwned=1&quot;&gt;");
    expect(html).toContain(HOSTILE.file.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"));
    // The JSON export keeps the raw strings as data (JSON is not an HTML context) and is served as JSON.
    const jsonRes = await viewer.get(`/api/v1/impact-runs/${w.ids.runHostile}/export?format=json`);
    expect(jsonRes.headers.get("content-type")).toContain("application/json");
  });

  it("a run in another workspace is a 404 for both formats, revealing nothing", async () => {
    const seed = inject("seed");
    const viewer = await session(seed.workspaces.main.emails.viewer);
    const foreign = seed.workspaces.other.ids.runOther as string;
    for (const format of ["json", "html"]) {
      const res = await viewer.get(`/api/v1/impact-runs/${foreign}/export?format=${format}`);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain(seed.workspaces.other.ids.snapshot as string);
    }
  });
});
