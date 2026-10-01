import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, inject, it } from "vitest";
import { FAKE_AWS_KEY, SECRET_CORES } from "../helpers/fake-secrets";
import { billingManifest, e, manifest, n } from "../helpers/builders";
import { addOptionalFieldDoc, removeAmountDoc } from "../helpers/scenario";
import { openAs, resetWeb, type RealApi } from "./support";

afterEach(resetWeb);

const heading = (name: string | RegExp) => screen.findByRole("heading", { name });
const type = (label: string | RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const submit = (name: string) => fireEvent.submit(screen.getByRole("form", { name }));
const posts = (api: RealApi, path: string) => api.calls.filter((c) => c.method === "POST" && c.path === path);
const countOf = async (api: RealApi, path: string): Promise<number> => ((await api.raw("GET", `${path}?limit=100`)).body.items as unknown[]).length;

describe("import snapshot (real API)", () => {
  it("a viewer is denied before any request is made", async () => {
    const { api } = await openAs("viewer", "write", "/snapshots/import");
    const alert = await screen.findByRole("alert");
    expect(alert.getAttribute("data-status")).toBe("403");
    expect(alert.textContent).toContain("does not allow importing snapshots");
    expect(screen.queryByRole("form", { name: "Import snapshot" })).toBeNull();
    expect(api.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("checks the form locally: missing revision, empty text, invalid JSON and a non-object are reported without a request", async () => {
    const { api } = await openAs("operator", "write", "/snapshots/import");
    await heading("Import a snapshot");
    submit("Import snapshot");
    expect((await screen.findByRole("alert")).textContent).toContain("Enter a revision label");
    type("Revision label", "local-checks");
    submit("Import snapshot");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Paste a manifest"));
    type(/Manifest \(JSON\)/, "{not json");
    submit("Import snapshot");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("not valid JSON"));
    type(/Manifest \(JSON\)/, "[1,2]");
    submit("Import snapshot");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("must be a JSON object"));
    expect(posts(api, "/api/v1/snapshots")).toHaveLength(0);
  });

  it("a manifest the domain rejects (dangling edge) shows the JSON pointer and code, and leaves no state behind (AC-01)", async () => {
    const { api } = await openAs("operator", "write", "/snapshots/import");
    await heading("Import a snapshot");
    const before = await countOf(api, "/api/v1/snapshots");
    const bad = manifest([n("svc.solo", "service")], [e("svc.solo", "contract.ghost", "consumes")]);
    type("Revision label", "dangling");
    type(/Manifest \(JSON\)/, JSON.stringify(bad));
    submit("Import snapshot");
    const alert = await screen.findByRole("alert");
    expect(alert.getAttribute("data-status")).toBe("422");
    expect(alert.textContent).toContain("Rejected");
    expect(alert.textContent).toContain("DANGLING_EDGE");
    expect(alert.textContent).toMatch(/\/edges\/0/);
    expect(alert.textContent).toContain("Reference ");
    expect(await countOf(api, "/api/v1/snapshots")).toBe(before);
  });

  it("a manifest containing a secret-looking value is refused and the value is never shown back (AC-09)", async () => {
    const { api } = await openAs("operator", "write", "/snapshots/import");
    await heading("Import a snapshot");
    const bad = manifest([n("svc.leaky", "service", { owner: FAKE_AWS_KEY })], []);
    type("Revision label", "leaky");
    type(/Manifest \(JSON\)/, JSON.stringify(bad));
    submit("Import snapshot");
    const alert = await screen.findByRole("alert");
    expect(alert.getAttribute("data-status")).toBe("422");
    expect(alert.textContent).toContain("SECRET_VALUE_REJECTED");
    // The answer never repeats the value (the text area still holds what the user typed, so that is excluded).
    const shown = (document.body.textContent ?? "").replace((screen.getByLabelText(/Manifest \(JSON\)/) as HTMLTextAreaElement).value, "");
    for (const core of SECRET_CORES) expect(shown).not.toContain(core);
    const answer = api.calls.filter((c) => c.method === "POST" && c.path === "/api/v1/snapshots");
    expect(answer).toHaveLength(1);
  });

  it("imports a valid manifest: CSRF token and idempotency key are sent, the receipt lists warnings, and the baseline moves", async () => {
    const { api, w } = await openAs("operator", "write", "/snapshots/import");
    await heading("Import a snapshot");
    type("Revision label", "  ui-import.1  ");
    type(/Manifest \(JSON\)/, JSON.stringify(addOptionalFieldDoc()));
    submit("Import snapshot");
    const receipt = await screen.findByTestId("import-receipt");
    expect(receipt.textContent).toContain("Snapshot imported");
    expect(receipt.textContent).toContain("7 nodes, 6 edges");
    expect(receipt.textContent).toMatch(/sha256:[0-9a-f]{64}/);
    const [call] = posts(api, "/api/v1/snapshots");
    expect(call).toBeTruthy();
    expect(call!.headers["x-csrf-token"]).toBeTruthy();
    expect(call!.headers["idempotency-key"]).toMatch(/^ui-[0-9a-f-]+$/);
    expect(call!.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(call!.body ?? "{}")).toMatchObject({ schema_version: 1, revision: "ui-import.1" });
    const baseline = await api.raw("GET", "/api/v1/baseline");
    expect(baseline.body.snapshot.revision).toBe("ui-import.1");
    // The receipt links on to the next step.
    const next = within(receipt).getByText("Assess a proposed change") as HTMLAnchorElement;
    expect(next.getAttribute("href")).toBe(`/runs/new?snapshot=${baseline.body.snapshot.id}`);
    expect(w.id).toBeTruthy();
  });

  it("loads a manifest from a file, and refuses a file over the 25 MB limit without reading it", async () => {
    await openAs("operator", "write", "/snapshots/import");
    await heading("Import a snapshot");
    const input = screen.getByLabelText("Or load a JSON file") as HTMLInputElement;
    const file = new File([JSON.stringify(billingManifest())], "manifest.json", { type: "application/json" });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect((screen.getByLabelText(/Manifest \(JSON\)/) as HTMLTextAreaElement).value).toContain('"svc.billing"'));
    const huge = new File(["{}"], "huge.json", { type: "application/json" });
    Object.defineProperty(huge, "size", { value: 26 * 1024 * 1024 });
    fireEvent.change(input, { target: { files: [huge] } });
    expect((await screen.findByRole("alert")).textContent).toContain("larger than 25 MB");
  });
});

describe("new impact run (real API)", () => {
  it("a viewer is denied before any request is made", async () => {
    const { api } = await openAs("viewer", "write", "/runs/new");
    const alert = await screen.findByRole("alert");
    expect(alert.getAttribute("data-status")).toBe("403");
    expect(api.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("requests a run against the baseline, follows it from queued to complete on the real worker, and shows the verdict", async () => {
    const { api } = await openAs("operator", "write", "/runs/new");
    await heading("New impact run");
    const select = (await screen.findByLabelText("Assess against snapshot")) as HTMLSelectElement;
    const baseline = (await api.raw("GET", "/api/v1/baseline")).body.snapshot as { id: string; hash: string };
    await waitFor(() => expect(select.value).toBe(baseline.id));
    expect(screen.getByText(baseline.hash)).toBeTruthy();
    submit("New impact run");
    expect((await screen.findByRole("alert")).textContent).toContain("Paste a manifest");
    type(/Proposed manifest/, JSON.stringify(removeAmountDoc()));
    submit("New impact run");
    await heading("Impact run");
    const banner = await screen.findByText("AFFECTED", { selector: ".verdict-label" }, { timeout: 20_000 });
    expect(banner.closest("section")?.getAttribute("data-verdict")).toBe("AFFECTED");
    const call = posts(api, "/api/v1/impact-runs")[0]!;
    expect(call.headers["x-csrf-token"]).toBeTruthy();
    expect(call.headers["idempotency-key"]).toMatch(/^ui-/);
    const body = JSON.parse(call.body ?? "{}") as { snapshot_id: string; expected_hash: string; run_checks: boolean; allow_superseded: boolean };
    expect(body).toMatchObject({ snapshot_id: baseline.id, expected_hash: baseline.hash, run_checks: true, allow_superseded: false });
    // The findings load once the run is complete and use the operator's bundle control.
    await screen.findByTestId("findings");
    expect(screen.getByText("Download evidence bundle")).toBeTruthy();
  }, 40_000);

  it("a baseline that moved while the form was open is a 409: the UI says so, sends nothing stale, and can switch to the current baseline (AC-05)", async () => {
    const { api } = await openAs("operator", "write", "/runs/new");
    await heading("New impact run");
    const select = (await screen.findByLabelText("Assess against snapshot")) as HTMLSelectElement;
    const seen = (await api.raw("GET", "/api/v1/baseline")).body.snapshot as { id: string };
    await waitFor(() => expect(select.value).toBe(seen.id));
    // Someone else imports a new snapshot: the baseline moves under the open form.
    const moved = await api.raw("POST", "/api/v1/snapshots", { schema_version: 1, revision: "moved-under-you", manifest: addOptionalFieldDoc() });
    expect(moved.status).toBe(201);
    const runsBefore = await countOf(api, "/api/v1/impact-runs");
    type(/Proposed manifest/, JSON.stringify(removeAmountDoc()));
    submit("New impact run");
    const alert = await screen.findByRole("alert");
    expect(alert.getAttribute("data-status")).toBe("409");
    expect(alert.getAttribute("data-code")).toBe("STALE_BASELINE");
    expect(alert.textContent).toContain("The baseline changed");
    expect(alert.textContent).toContain(moved.body.id);
    expect(await countOf(api, "/api/v1/impact-runs")).toBe(runsBefore);
    // Use the current baseline, then the same proposal is accepted.
    fireEvent.click(screen.getByRole("button", { name: "Use the current baseline" }));
    await waitFor(() => expect((screen.getByLabelText("Assess against snapshot") as HTMLSelectElement).value).toBe(moved.body.id));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    submit("New impact run");
    await heading("Impact run");
    await screen.findByText(/AFFECTED|INCOMPLETE/, { selector: ".verdict-label" }, { timeout: 20_000 });
    expect(await countOf(api, "/api/v1/impact-runs")).toBe(runsBefore + 1);
  }, 60_000);

  it("assessing against a superseded snapshot needs an explicit opt-in: without it 409, with it accepted and recorded on the run", async () => {
    const { api } = await openAs("operator", "write", "/runs/new");
    await heading("New impact run");
    const select = (await screen.findByLabelText("Assess against snapshot")) as HTMLSelectElement;
    const all = (await api.raw("GET", "/api/v1/snapshots?limit=100")).body.items as { id: string; is_baseline: boolean; revision: string }[];
    const old = all.find((s) => !s.is_baseline)!;
    await waitFor(() => expect(select.options.length).toBeGreaterThan(1));
    fireEvent.change(select, { target: { value: old.id } });
    const note = await screen.findByTestId("superseded-note");
    expect(note.textContent).toContain("not the current baseline");
    type(/Proposed manifest/, JSON.stringify(removeAmountDoc()));
    submit("New impact run");
    const alert = await screen.findByRole("alert");
    expect(alert.getAttribute("data-code")).toBe("STALE_BASELINE");
    // Opt in and resubmit.
    fireEvent.click(within(note).getByRole("checkbox"));
    submit("New impact run");
    await heading("Impact run");
    await screen.findByText(/no longer the workspace baseline/, {}, { timeout: 20_000 });
  }, 60_000);

  it("a proposal the domain rejects is a 422 with the reasons, and creates no run", async () => {
    const { api } = await openAs("operator", "write", "/runs/new");
    await heading("New impact run");
    await waitFor(() => expect((screen.getByLabelText("Assess against snapshot") as HTMLSelectElement).value).not.toBe(""));
    const before = await countOf(api, "/api/v1/impact-runs");
    type(/Proposed manifest/, JSON.stringify(manifest([n("svc.solo", "service")], [e("svc.solo", "contract.ghost", "consumes")])));
    submit("New impact run");
    const alert = await screen.findByRole("alert");
    expect(alert.getAttribute("data-status")).toBe("422");
    expect(alert.textContent).toContain("DANGLING_EDGE");
    expect(await countOf(api, "/api/v1/impact-runs")).toBe(before);
  });

  it("an empty workspace cannot start a run: it points at the import instead", async () => {
    await openAs("operator", "empty", "/runs/new");
    expect(await screen.findByText("No baseline to assess against")).toBeTruthy();
    expect(screen.queryByRole("form", { name: "New impact run" })).toBeNull();
  });
});

describe("contract checks and administration (real API)", () => {
  it("an operator reads checks but cannot create or disable them; a viewer is denied without a request", async () => {
    const { api } = await openAs("operator", "checks", "/checks");
    await heading("Contract checks");
    await screen.findByText("No contract checks configured");
    expect(screen.queryByRole("form", { name: "New contract check" })).toBeNull();
    expect(screen.getByText(/An admin can configure read-only checks/)).toBeTruthy();
    expect(api.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    resetWeb();
    const viewer = await openAs("viewer", "checks", "/checks");
    expect((await screen.findByRole("alert")).getAttribute("data-status")).toBe("403");
    expect(viewer.api.calls.some((c) => c.path.startsWith("/api/v1/contract-checks"))).toBe(false);
  });

  it("an admin creates a check, a failing live check makes the run INCOMPLETE and visible, and disabling works", async () => {
    const seed = inject("seed");
    const { api, w } = await openAs("admin", "checks", "/checks");
    await heading("Contract checks");
    await screen.findByText("No contract checks configured");
    // Local validation first.
    submit("New contract check");
    expect((await screen.findByRole("alert")).textContent).toContain("Key, node and URL are required");
    type("Key", "invoice-live");
    type("Node id", "contract.invoice");
    type("URL", "http://localhost:1/x");
    type(/Required response fields/, "amount:decimal");
    submit("New contract check");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("must look like name:type"));
    // A URL that is not allowlisted is refused by the API and explained.
    type(/Required response fields/, "amount:number");
    type("URL", "http://example.invalid/contract");
    submit("New contract check");
    await waitFor(() => expect(screen.getByRole("alert").getAttribute("data-status")).toBe("422"));
    expect(screen.getByRole("alert").textContent).toContain("HOST_NOT_ALLOWED");
    expect(screen.getByRole("alert").getAttribute("data-code")).toBe("URL_NOT_ALLOWED");
    // An allowed URL pointing at a closed port.
    const port = seed.closedPort;
    type("URL", `http://localhost:${port}/contract`);
    type("Retries (0 to 3)", "0");
    submit("New contract check");
    await screen.findByText(/was added/);
    const row = await waitFor(() => {
      const found = document.querySelector("tbody tr");
      if (!found) throw new Error("check list not reloaded yet");
      return found;
    });
    expect(row.textContent).toContain("invoice-live");
    expect(row.textContent).toContain("enabled");
    expect(row.textContent).toContain("GET");
    const create = posts(api, "/api/v1/contract-checks").at(-1)!;
    expect(create.headers["x-csrf-token"]).toBeTruthy();
    expect(create.headers["idempotency-key"]).toMatch(/^ui-/);
    // Run a change that touches the checked node: the check fails for real, the verdict is INCOMPLETE, never a pass.
    const run = await api.raw("POST", "/api/v1/impact-runs", { snapshot_id: w.ids.snapshot, proposed_manifest: removeAmountDoc(), expected_hash: w.ids.hash });
    expect(run.status).toBe(202);
    resetWeb();
    const view = await openAs("viewer", "checks", `/runs/${run.body.id}`);
    const banner = await screen.findByText("INCOMPLETE", { selector: ".verdict-label" }, { timeout: 20_000 });
    expect(banner.closest("section")?.getAttribute("data-verdict")).toBe("INCOMPLETE");
    const checks = await screen.findByTestId("checks");
    expect(checks.textContent).toContain("invoice-live");
    const states = [...checks.querySelectorAll("[data-check-state]")].map((x) => x.getAttribute("data-check-state"));
    expect(states).toEqual(["ERROR"]);
    expect(checks.textContent).toContain("ECONNREFUSED");
    expect(checks.textContent).toContain("Counted as an unknown");
    expect(screen.getByTestId("unknowns").textContent).toMatch(/CHECK_(ERROR|TIMED_OUT|FAILED)/);
    expect(view.api.calls.length).toBeGreaterThan(0);
    // Disable it again as admin.
    resetWeb();
    await openAs("admin", "checks", "/checks");
    fireEvent.click(await screen.findByRole("button", { name: "Disable invoice-live" }));
    await waitFor(() => expect(document.querySelector("tbody tr")?.textContent).toContain("disabled"));
    expect(screen.queryByRole("button", { name: "Disable invoice-live" })).toBeNull();
    expect(seed.workspaces.checks.id).toBe(w.id);
  }, 60_000);

  it("administration: an operator is denied, an admin sees members, effective settings (retention not enforced) and the audit trail", async () => {
    const op = await openAs("operator", "main", "/admin");
    const denied = await screen.findByRole("alert");
    expect(denied.getAttribute("data-status")).toBe("403");
    expect(op.api.calls.some((c) => c.path.startsWith("/api/v1/members") || c.path.startsWith("/api/v1/audit") || c.path.startsWith("/api/v1/settings"))).toBe(false);
    resetWeb();
    await openAs("admin", "main", "/admin");
    await heading("Administration");
    const members = (await screen.findByText("Members")).closest("section")!;
    await waitFor(() => expect(within(members).getAllByRole("row").length).toBe(4));
    expect(members.textContent).toContain("admin@ui-main.test");
    expect(members.textContent).toContain("viewer@ui-main.test");
    const settings = (await screen.findByText("Effective settings")).closest("section")!;
    await waitFor(() => expect(settings.textContent).toContain("Not enforced automatically"));
    expect(settings.textContent).toContain("evidence 90 days");
    expect(settings.textContent).toContain("localhost");
    const audit = (await screen.findByText("Audit trail")).closest("section")!;
    await waitFor(() => expect(audit.textContent).toContain("snapshot.imported"));
    expect(audit.textContent).toContain("impact_run.requested");
  });

  it("events: an operator reads the adapter feed, a viewer is denied", async () => {
    await openAs("operator", "main", "/events");
    await heading("Events");
    expect((await screen.findAllByText("snapshot.imported")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("impact_run.completed").length).toBeGreaterThan(0);
    resetWeb();
    await openAs("viewer", "main", "/events");
    expect((await screen.findByRole("alert")).getAttribute("data-status")).toBe("403");
  });
});
