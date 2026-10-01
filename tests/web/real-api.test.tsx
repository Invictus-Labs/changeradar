import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, inject, it } from "vitest";
import { renderApp, resetWeb, useRealApi } from "./support";

afterEach(resetWeb);

describe("web UI against the real API: session, navigation and lists", () => {
  it("signs in through the form with a real session cookie and shows the workspace and role", async () => {
    const api = useRealApi();
    const main = api.workspace("main");
    renderApp("/snapshots");
    const form = await screen.findByRole("form", { name: "Sign in" });
    expect(within(form).getByText(/no registration/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: main.emails.viewer } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "not-the-password" } });
    fireEvent.submit(form);
    const denied = await screen.findByRole("alert");
    expect(denied.textContent).toContain("Sign in failed");
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: inject("seed").password } });
    fireEvent.submit(screen.getByRole("form", { name: "Sign in" }));
    expect((await screen.findByTestId("who")).textContent).toContain("UI Main");
    expect(screen.getByTestId("who").textContent).toContain(main.emails.viewer);
    expect(await screen.findByText("2026-09-29.1")).toBeTruthy();
    expect(screen.getByText("2026-09-28.1")).toBeTruthy();
    // Only the first of two snapshots is the baseline.
    expect(screen.getAllByText("baseline")).toHaveLength(1);
  });

  it("lists snapshots and impact runs with distinct verdict badges", async () => {
    const api = useRealApi();
    await api.signIn(api.workspace("main").emails.viewer);
    renderApp("/runs");
    await screen.findByRole("heading", { name: "Impact runs" });
    await waitFor(() => expect(document.querySelectorAll("[data-verdict]").length).toBeGreaterThanOrEqual(3));
    const verdicts = [...document.querySelectorAll("tbody [data-verdict]")].map((x) => x.getAttribute("data-verdict")).sort();
    expect(verdicts).toEqual(["AFFECTED", "INCOMPLETE", "NO_KNOWN_IMPACT"]);
    expect(screen.getAllByText(/^complete$/).length).toBe(3);
  });
});
