import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RunDetailPage } from "../../src/web/pages/runs";
import { mockApi, page, renderPage, resetWeb, users } from "./support";

/**
 * Review round 5 (logic P2, ruled must-fix): the run page of a run assessed by an older engine qualifies, as the HTML export does,
 * every statement and count the older engine recorded: the coverage limits and what was known, the run facts, the unknowns and
 * the findings heading. The fixture carries the coverage limit a genuine older NO_KNOWN_IMPACT run holds
 * (NO_AFFECTED_CONSUMERS_DECLARED), which the earlier fixture did not.
 */

afterEach(resetWeb);
const H = (c: string) => `sha256:${c.repeat(64)}`;
const OLD = "As assessed by the older engine: ";
const NO_CONSUMER = "No declared consumer is affected by the changes to these nodes. This means none are declared, not that none exist.";

const run = (over: Record<string, unknown> = {}) => ({
  id: "run-1",
  snapshot_id: "snap-1",
  status: "complete",
  assessment: null,
  recorded_assessment: "NO_KNOWN_IMPACT",
  baseline_hash: H("a"),
  proposed_hash: H("b"),
  baseline_version: 2,
  allow_superseded: false,
  created_at: "2026-09-29T00:00:00.000Z",
  started_at: "2026-09-29T00:00:01.000Z",
  finished_at: "2026-09-29T00:00:02.000Z",
  error: null,
  engine: { version: 1, current: 3, rerun_required: true, note: "assessed by an older decision engine (version 1, this build is 3): re-run required" },
  summary: { changes: 1, findings: 0, direct_findings: 0, transitive_findings: 0, unknowns: 0, known_impact: false },
  coverage: {
    scope: "declared_manifests_only",
    nodes_examined: 2,
    edges_examined: 1,
    consumers_found: 0,
    known: ["0 consumer(s) reached through declared edges"],
    limits: [{ code: "NO_AFFECTED_CONSUMERS_DECLARED", message: NO_CONSUMER }],
  },
  cycles: [],
  changes: [],
  unknowns: [],
  checks: [],
  totals: { findings: 0, unknowns: 0 },
  truncated: { findings: false, unknowns: false },
  ...over,
});
const open = (over: Record<string, unknown> = {}) => {
  mockApi({ "GET /impact-runs/run-1": { body: run(over) }, "GET /impact-runs/run-1/findings?limit=100": page([]) });
  renderPage(<RunDetailPage user={users.viewer} />, "/runs/run-1", "/runs/:id");
};
const current = { assessment: "NO_KNOWN_IMPACT", recorded_assessment: null, engine: { version: 3, current: 3, rerun_required: false } };

describe("R5 (components.tsx:124): the run page of an older engine's run qualifies what that engine recorded", () => {
  it("coverage limits, what was known and the examined counts are labelled as the older engine's; the unqualified sentence appears nowhere", async () => {
    open();
    const coverage = await screen.findByTestId("coverage");
    expect(within(coverage).getByRole("heading", { level: 2 }).textContent).toBe("Coverage limits (as recorded by the older engine)");
    const limit = within(coverage).getByText(new RegExp("NO_AFFECTED_CONSUMERS_DECLARED"));
    expect((limit.closest("li") as HTMLElement).textContent).toContain(`${OLD}${NO_CONSUMER}`);
    const known = within(coverage).getByText(/0 consumer\(s\) reached through declared edges/);
    expect(known.textContent).toBe(`${OLD}0 consumer(s) reached through declared edges`);
    expect(coverage.textContent).toContain(`${OLD}Examined 2 nodes and 1 edges; 0 consumers found.`);
    // Every occurrence of the sentence is directly preceded by the qualifier.
    const parts = document.body.textContent?.split("No declared consumer is affected by the changes") ?? [];
    expect(parts.length).toBeGreaterThan(1);
    for (const before of parts.slice(0, -1)) expect(before.endsWith(OLD), before.slice(-60)).toBe(true);
  });

  it("the run facts label the counts as the older engine's (the plain 'Findings 0' and 'Unknowns 0' are gone)", async () => {
    open();
    const facts = await screen.findByLabelText("Run facts");
    const labels = Array.from(facts.querySelectorAll("dt")).map((dt) => dt.textContent);
    expect(labels).toContain("Changes (older engine)");
    expect(labels).toContain("Findings (older engine)");
    expect(labels).toContain("Unknowns (older engine)");
    expect(labels).not.toContain("Findings");
    expect(labels).not.toContain("Unknowns");
  });

  it("the unknowns and the findings headings, and the empty unknowns line, say whose they are", async () => {
    open();
    const unknowns = await screen.findByTestId("unknowns");
    expect(within(unknowns).getByRole("heading", { level: 2 }).textContent).toBe("Unknowns as recorded by the older engine (0)");
    expect(unknowns.textContent).toContain(`${OLD}no unknowns were recorded for this run.`);
    const findings = screen.getByTestId("findings");
    await waitFor(() => expect(within(findings).getByRole("heading", { level: 2 }).textContent).toBe("Affected consumers as listed by the older engine (0)"));
    expect(document.body.textContent).not.toContain("No unknowns were recorded for this run.");
  });

  it("control: a current run is unchanged (plain headings, labels and sentences; no qualifier anywhere)", async () => {
    open(current);
    const coverage = await screen.findByTestId("coverage");
    expect(within(coverage).getByRole("heading", { level: 2 }).textContent).toBe("Coverage limits");
    expect(coverage.textContent).toContain(NO_CONSUMER);
    const facts = screen.getByLabelText("Run facts");
    const labels = Array.from(facts.querySelectorAll("dt")).map((dt) => dt.textContent);
    expect(labels).toContain("Findings");
    expect(labels).toContain("Unknowns");
    expect(within(screen.getByTestId("unknowns")).getByRole("heading", { level: 2 }).textContent).toBe("Unknowns (0)");
    await waitFor(() => expect(within(screen.getByTestId("findings")).getByRole("heading", { level: 2 }).textContent).toBe("Affected consumers (0)"));
    expect(document.body.textContent).not.toContain("older engine");
  });
});
