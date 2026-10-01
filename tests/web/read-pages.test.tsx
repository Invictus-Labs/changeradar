import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, inject, it } from "vitest";
import { UUID_ZERO } from "../helpers/ids";
import { HOSTILE } from "./hostile";
import { openAs, renderApp, resetWeb, useRealApi } from "./support";

afterEach(resetWeb);

const heading = (name: string | RegExp) => screen.findByRole("heading", { name });

describe("snapshots: list, empty, detail, graph preview (real API)", () => {
  it("a viewer sees both snapshots, the baseline marked, and no import control", async () => {
    await openAs("viewer", "main", "/snapshots");
    await heading("Snapshots");
    await screen.findByText("2026-09-29.1");
    expect(screen.getByText("2026-09-28.1")).toBeTruthy();
    expect(screen.getAllByText("baseline")).toHaveLength(1);
    expect(screen.getByText("superseded")).toBeTruthy();
    expect(screen.queryByText("Import a snapshot")).toBeNull();
    // Navigation is membership aware: a viewer gets no operator or admin destinations.
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(within(nav).queryByText("Contract checks")).toBeNull();
    expect(within(nav).queryByText("Events")).toBeNull();
    expect(within(nav).queryByText("Administration")).toBeNull();
    expect(screen.getByTestId("who").textContent).toContain("viewer");
  });

  it("an operator gets the import control and the operator destinations, but not administration", async () => {
    await openAs("operator", "main", "/snapshots");
    await heading("Snapshots");
    expect(await screen.findByText("Import a snapshot")).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(within(nav).getByText("Contract checks")).toBeTruthy();
    expect(within(nav).getByText("Events")).toBeTruthy();
    expect(within(nav).queryByText("Administration")).toBeNull();
  });

  it("an admin sees every destination", async () => {
    await openAs("admin", "main", "/snapshots");
    await heading("Snapshots");
    const nav = screen.getByRole("navigation", { name: "Main" });
    for (const label of ["Snapshots", "Impact runs", "Contract checks", "Events", "Administration"]) expect(within(nav).getByText(label)).toBeTruthy();
  });

  it("an empty workspace shows an empty state that tells a viewer to ask, and an operator how to start", async () => {
    await openAs("viewer", "empty", "/snapshots");
    expect((await screen.findByText("No snapshots yet")).closest("[data-state]")?.getAttribute("data-state")).toBe("empty");
    expect(screen.getByText(/Ask an operator or admin/)).toBeTruthy();
    resetWeb();
    await openAs("operator", "empty", "/snapshots");
    await screen.findByText("No snapshots yet");
    expect(screen.getAllByText("Import a snapshot").length).toBeGreaterThan(0);
  });

  it("snapshot detail shows hashes and warnings, pages nodes, filters them, and previews edges as an accessible graph", async () => {
    const { w } = await openAs("operator", "main", "/snapshots");
    const link = await screen.findByText("2026-09-29.1");
    fireEvent.click(link);
    await heading("Snapshot 2026-09-29.1");
    expect(screen.getByText(/baseline \(used for new assessments\)/)).toBeTruthy();
    expect(document.body.textContent).toContain(w.ids.hash as string);
    expect(screen.getByText("Warnings from import")).toBeTruthy();
    expect(screen.getByText(/UNVERIFIED_EDGE/)).toBeTruthy();
    // Nodes.
    fireEvent.click(screen.getByRole("button", { name: "Nodes" }));
    await screen.findByText("svc.mailer");
    expect(screen.getAllByRole("row").length).toBeGreaterThan(7);
    fireEvent.change(screen.getByLabelText("Filter loaded nodes"), { target: { value: "mailer" } });
    expect(screen.getByText("svc.mailer")).toBeTruthy();
    expect(screen.queryByText("svc.dashboard")).toBeNull();
    fireEvent.change(screen.getByLabelText("Filter loaded nodes"), { target: { value: "no-such-node-anywhere" } });
    expect(screen.getByText("No loaded node matches the filter.")).toBeTruthy();
    // Edges and the graph preview.
    fireEvent.click(screen.getByRole("button", { name: "Edges and graph" }));
    await screen.findByTestId("graph");
    const svg = screen.getByTestId("graph").querySelector("svg")!;
    expect(svg.getAttribute("role")).toBe("img");
    expect(svg.querySelector("title")?.textContent).toBe("Dependency edges of this snapshot");
    expect(svg.querySelector("desc")?.textContent).toContain("same information as text");
    expect(svg.querySelectorAll("[data-node-id]").length).toBe(7);
    expect(screen.getByText(/never verified/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Filter loaded edges"), { target: { value: "nothing-matches-this" } });
    expect(screen.getByText("No loaded edge matches the filter.")).toBeTruthy();
    // Download of the normalized manifest is an operator control.
    fireEvent.click(screen.getByRole("button", { name: "Overview" }));
    expect((screen.getByText("Download normalized manifest") as HTMLAnchorElement).getAttribute("href")).toBe(`/api/v1/snapshots/${w.ids.snapshot}/manifest`);
  });

  it("a viewer does not get the manifest download or the run control on a snapshot page", async () => {
    const { w } = await openAs("viewer", "main", "/snapshots");
    await heading("Snapshots");
    fireEvent.click(await screen.findByText("2026-09-29.1"));
    await heading("Snapshot 2026-09-29.1");
    expect(screen.queryByText("Download normalized manifest")).toBeNull();
    expect(screen.queryByText("Assess a proposed change")).toBeNull();
    expect(w.ids.snapshot).toBeTruthy();
  });

  it("another workspace's snapshot is 'not found', worded exactly like a missing one, with no other detail", async () => {
    const api = useRealApi();
    const main = api.workspace("main");
    const other = api.workspace("other");
    await api.signIn(main.emails.viewer, main.id);
    const first = renderApp(`/snapshots/${other.ids.snapshot}`);
    const foreign = await screen.findByRole("alert");
    const foreignText = foreign.textContent;
    expect(foreign.getAttribute("data-state")).toBe("denied");
    expect(foreign.getAttribute("data-status")).toBe("404");
    expect(foreignText).toContain("This item does not exist, or you do not have access to it.");
    first.unmount();
    renderApp(`/snapshots/${UUID_ZERO}`);
    const missing = await screen.findByRole("alert");
    // The wording (and everything else visible except the request reference) is identical.
    const strip = (s: string | null) => (s ?? "").replace(/Reference [0-9a-f-]+/, "");
    expect(strip(missing.textContent)).toBe(strip(foreignText));
    expect(document.body.textContent).not.toContain(other.ids.snapshot as string);
    expect(document.body.textContent).not.toContain("UI Other");
  });
});

describe("impact runs: list and detail for every verdict (real API)", () => {
  it("lists runs, filters by status and shows an empty filter result", async () => {
    await openAs("viewer", "main", "/runs");
    await heading("Impact runs");
    await waitFor(() => expect(document.querySelectorAll("tbody tr").length).toBe(3));
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "queued" } });
    expect(await screen.findByText("No queued runs")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "complete" } });
    await waitFor(() => expect(document.querySelectorAll("tbody tr").length).toBe(3));
    // 'complete' is a neutral status badge, not a verdict and not styled as success.
    expect(document.querySelector('[data-status="complete"]')?.className).toContain("badge-neutral");
  });

  it("an empty workspace's run list explains itself", async () => {
    await openAs("viewer", "empty", "/runs");
    expect(await screen.findByText("No impact runs yet")).toBeTruthy();
    expect(screen.getByText(/once an operator or admin requests them/)).toBeTruthy();
  });

  it("AFFECTED: verdict, owners, ordered source-to-consumer paths, stable ids equal to the JSON export, graph, exports", async () => {
    const { w, api } = await openAs("viewer", "main", "/runs");
    const seed = inject("seed");
    await heading("Impact runs");
    const runId = w.ids.runAffected as string;
    const opener = (await screen.findAllByText("Open")).find((a) => a.getAttribute("href") === `/runs/${runId}`)!;
    fireEvent.click(opener);
    await heading("Impact run");
    const banner = await screen.findByText("AFFECTED", { selector: ".verdict-label" });
    expect(banner.closest("section")?.getAttribute("data-verdict")).toBe("AFFECTED");
    expect(screen.getByText("Known consumers can break")).toBeTruthy();
    const table = await screen.findByTestId("findings");
    await waitFor(() => expect(table.querySelectorAll("tr[data-finding-id]").length).toBe(seed.affectedFindingIds.length));
    const shown = [...table.querySelectorAll("tr[data-finding-id]")].map((r) => r.getAttribute("data-finding-id"));
    expect(shown).toEqual(seed.affectedFindingIds);
    // The JSON export from the same server lists the same ids.
    const exported = await api.raw("GET", `/api/v1/impact-runs/${runId}/export?format=json`);
    expect((exported.body.findings as { id: string }[]).map((f) => f.id)).toEqual(shown);
    // Direct and transitive consumers, with owners and ordered paths.
    const rows = [...table.querySelectorAll("tr[data-finding-id]")];
    const byConsumer = (name: string) => rows.find((r) => r.querySelector("td:nth-child(3) code")?.textContent === name)!;
    const exportJob = byConsumer("job.export");
    expect(exportJob.textContent).toContain("HIGH direct");
    expect(exportJob.textContent).toContain("team-data");
    expect([...exportJob.querySelectorAll("ol.path code")].map((c) => c.textContent)).toEqual(["contract.invoice", "job.export"]);
    const dashboard = byConsumer("svc.dashboard");
    expect(dashboard.textContent).toContain("MEDIUM transitive");
    expect([...dashboard.querySelectorAll("ol.path code")].map((c) => c.textContent)).toEqual(["contract.invoice", "job.export", "artifact.report", "svc.dashboard"]);
    expect(dashboard.textContent).toContain("via manifests/");
    // Graph: accessible SVG with the changed item and consumers drawn.
    const svg = screen.getByTestId("graph").querySelector("svg")!;
    expect(svg.getAttribute("role")).toBe("img");
    expect(svg.querySelector('[data-node-id="contract.invoice"] rect')?.getAttribute("class")).toContain("g-origin");
    expect(svg.querySelector('[data-node-id="job.export"] rect')?.getAttribute("class")).toContain("g-direct");
    expect(svg.querySelector('[data-node-id="svc.dashboard"] rect')?.getAttribute("class")).toContain("g-transitive");
    // Coverage limits are on the page for every verdict.
    expect(screen.getByTestId("coverage").textContent).toContain("MANIFEST_DECLARED_ONLY");
    // Viewer: redacted report exports, no evidence bundle.
    const controls = screen.getByTestId("export-controls");
    expect((within(controls).getByText("Download JSON report") as HTMLAnchorElement).getAttribute("href")).toBe(`/api/v1/impact-runs/${runId}/export?format=json`);
    const htmlLink = within(controls).getByText("Open HTML report") as HTMLAnchorElement;
    expect(htmlLink.getAttribute("href")).toBe(`/api/v1/impact-runs/${runId}/export?format=html`);
    expect(htmlLink.getAttribute("rel")).toContain("noopener");
    expect(within(controls).queryByText("Download evidence bundle")).toBeNull();
    expect(controls.textContent).toContain("Your role reads redacted reports only");
  });

  it("an operator additionally gets the evidence bundle", async () => {
    const seed = inject("seed");
    const runId = seed.workspaces.main.ids.runAffected as string;
    await openAs("operator", "main", `/runs/${runId}`);
    await screen.findByTestId("export-controls");
    const bundle = screen.getByText("Download evidence bundle") as HTMLAnchorElement;
    expect(bundle.getAttribute("href")).toBe(`/api/v1/impact-runs/${runId}/bundle`);
  });

  it("INCOMPLETE is visibly not safe: coverage limits, every unknown, the checks note and the known impact", async () => {
    const { w } = await openAs("viewer", "main", `/runs/${inject("seed").workspaces.main.ids.runIncomplete}`);
    const banner = await screen.findByText("INCOMPLETE", { selector: ".verdict-label" });
    const section = banner.closest("section")!;
    expect(section.getAttribute("data-verdict")).toBe("INCOMPLETE");
    expect(section.className).toContain("verdict-incomplete");
    expect(section.textContent).toContain("Impact cannot be ruled out");
    expect(section.textContent).toContain("not a safe result");
    expect(section.textContent).toContain("Known impact was also found");
    const unknowns = await screen.findByTestId("unknowns");
    expect(unknowns.querySelectorAll("tr[data-unknown-id]").length).toBeGreaterThanOrEqual(1);
    expect(unknowns.textContent).toContain("UNVERIFIED_CONTRACT");
    expect(unknowns.textContent).toContain("never treated as safe");
    expect(screen.getByTestId("coverage").textContent).toContain("RUNTIME_NOT_OBSERVED");
    expect(document.body.textContent).not.toMatch(/all clear|is safe\b/i);
    // Coverage and unknowns come before the findings for a verdict that is not a known break.
    const order = [...document.querySelectorAll('[data-testid="coverage"], [data-testid="unknowns"], [data-testid="findings"]')].map((e) => e.getAttribute("data-testid"));
    expect(order).toEqual(["coverage", "unknowns", "findings"]);
    expect(w.id).toBeTruthy();
  });

  it("NO_KNOWN_IMPACT states its limits and does not read as safe", async () => {
    await openAs("viewer", "main", `/runs/${inject("seed").workspaces.main.ids.runNoImpact}`);
    const banner = await screen.findByText("NO KNOWN IMPACT", { selector: ".verdict-label" });
    const section = banner.closest("section")!;
    expect(section.getAttribute("data-verdict")).toBe("NO_KNOWN_IMPACT");
    expect(section.className).toContain("verdict-noknown");
    expect(section.textContent).toContain("does not prove that nothing else depends");
    expect(screen.getByTestId("coverage").textContent).toContain("MANIFEST_DECLARED_ONLY");
    expect(screen.getByTestId("coverage").textContent).toContain("never infers that an undeclared dependency does not exist");
    await screen.findByText(/No declared consumer is affected by the detected changes \(within the coverage limits\)/);
    expect(document.body.textContent).not.toMatch(/all clear|\bsafe to (ship|deploy|roll)/i);
  });

  it("a cycle is reported once, marked in the list and in the drawing, and the run still terminates", async () => {
    await openAs("viewer", "cycles", `/runs/${inject("seed").workspaces.cycles.ids.runCycle}`);
    const cycles = await screen.findByTestId("cycles");
    expect(cycles.textContent).toContain("svc.a");
    expect(cycles.textContent).toContain("svc.b");
    expect(cycles.textContent).toMatch(/cyc_[0-9a-f]{20}/);
    await screen.findByTestId("graph");
    expect(screen.getByTestId("graph").textContent).toContain("↻");
    expect(document.body.textContent).toContain("in a dependency cycle");
  });

  it("a big run pages its findings and degrades the drawing instead of drawing everything", async () => {
    const { api } = await openAs("viewer", "big", `/runs/${inject("seed").workspaces.big.ids.runBig}`);
    const findings = await screen.findByTestId("findings");
    expect(findings.querySelector("h2")?.textContent).toBe("Affected consumers (250)");
    await waitFor(() => expect(findings.querySelectorAll("tr[data-finding-id]").length).toBe(100));
    expect(screen.getByTestId("graph").textContent).toMatch(/Drawing the first \d+ of 100 findings/);
    expect(screen.getByTestId("graph").querySelectorAll("[data-node-id]").length).toBeLessThanOrEqual(60);
    fireEvent.click(screen.getByRole("button", { name: "Load more findings" }));
    await waitFor(() => expect(findings.querySelectorAll("tr[data-finding-id]").length).toBe(200));
    fireEvent.click(screen.getByRole("button", { name: "Load more findings" }));
    await waitFor(() => expect(findings.querySelectorAll("tr[data-finding-id]").length).toBe(250));
    expect(screen.queryByRole("button", { name: "Load more findings" })).toBeNull();
    expect(findings.textContent).toContain("All 250 findings loaded.");
    fireEvent.change(screen.getByLabelText("Filter loaded findings"), { target: { value: "consumer-0007" } });
    expect(findings.querySelectorAll("tr[data-finding-id]").length).toBe(1);
    fireEvent.change(screen.getByLabelText("Filter loaded findings"), { target: { value: "zzzz-no-match" } });
    expect(screen.getByText("No loaded finding matches the filter.")).toBeTruthy();
    // The run endpoint itself only carries the first page and says so.
    const run = await api.raw("GET", `/api/v1/impact-runs/${inject("seed").workspaces.big.ids.runBig}`);
    expect(run.body.truncated.findings).toBe(true);
  });

  it("another workspace's run is 'not found' in the run page as well", async () => {
    await openAs("viewer", "main", `/runs/${inject("seed").workspaces.other.ids.runOther}`);
    const alert = await screen.findByRole("alert");
    expect(alert.getAttribute("data-status")).toBe("404");
    expect(alert.textContent).toContain("does not exist, or you do not have access");
    expect(document.body.textContent).not.toContain("UI Other");
  });
});

describe("AC-09 in the UI: hostile manifest strings are text, never markup", () => {
  it("snapshot, node and run pages show payloads literally and execute nothing", async () => {
    const seed = inject("seed");
    const h = seed.workspaces.hostile;
    const { api } = await openAs("operator", "hostile", "/snapshots");
    await screen.findByText(HOSTILE.revision);
    expect(document.querySelector("svg[onload]")).toBeNull();
    fireEvent.click(screen.getByText(HOSTILE.revision));
    await heading(`Snapshot ${HOSTILE.revision}`);
    fireEvent.click(screen.getByRole("button", { name: "Nodes" }));
    await screen.findByText("svc.producer");
    expect(document.body.textContent).toContain(HOSTILE.owner);
    expect(document.body.textContent).toContain(HOSTILE.version);
    expect(document.querySelector("img[src='x']")).toBeNull();
    expect(document.querySelector("script")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edges and graph" }));
    await screen.findByTestId("graph");
    expect(document.body.textContent).toContain(HOSTILE.file);
    // Run page.
    resetWeb();
    const again = useRealApi();
    await again.signIn(h.emails.viewer, h.id);
    renderApp(`/runs/${h.ids.runHostile}`);
    await screen.findByText("AFFECTED", { selector: ".verdict-label" });
    const findings = await screen.findByTestId("findings");
    await waitFor(() => expect(findings.querySelectorAll("tr[data-finding-id]").length).toBeGreaterThan(0));
    expect(document.body.textContent).toContain(HOSTILE.owner);
    expect(document.querySelector("img[src='x']")).toBeNull();
    expect(document.querySelector("svg[onload]")).toBeNull();
    expect(document.querySelector("script")).toBeNull();
    expect((window as unknown as { __pwned?: unknown }).__pwned).toBeUndefined();
    expect(api.workspace("hostile").id).toBe(h.id);
  });
});
