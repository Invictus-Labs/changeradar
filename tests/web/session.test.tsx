import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, inject, it } from "vitest";
import { applyTheme, rememberedWorkspaces } from "../../src/web/app";
import { apiError, mockAny, openAs, renderApp, resetWeb, useRealApi } from "./support";

afterEach(resetWeb);

const heading = (name: string | RegExp) => screen.findByRole("heading", { name });
const signInForm = () => screen.findByRole("form", { name: "Sign in" });
const fillLogin = (email: string, password: string, workspace = "") => {
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: email } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: password } });
  fireEvent.change(screen.getByLabelText(/Workspace ID/), { target: { value: workspace } });
  fireEvent.submit(screen.getByRole("form", { name: "Sign in" }));
};

describe("session lifecycle against the real API", () => {
  it("sign out revokes the session on the server and returns to the sign in form", async () => {
    const { api } = await openAs("viewer", "main", "/snapshots");
    await heading("Snapshots");
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await signInForm();
    const logout = api.calls.find((c) => c.path === "/api/v1/auth/logout");
    expect(logout?.method).toBe("POST");
    expect(logout?.headers["x-csrf-token"]).toBeTruthy();
    // The cookie is gone and the old session is unusable.
    expect((await api.raw("GET", "/api/v1/snapshots")).status).toBe(401);
  });

  it("a session that ends while the page is open returns to sign in with an explanation, not a broken page", async () => {
    const { api } = await openAs("viewer", "main", "/snapshots");
    await heading("Snapshots");
    api.dropCookie();
    fireEvent.click(screen.getByRole("link", { name: "Impact runs" }));
    await signInForm();
    expect(screen.getByText("Your session has ended. Sign in again to continue.")).toBeTruthy();
    // Signing in again works.
    const w = api.workspace("main");
    fillLogin(w.emails.viewer, inject("seed").password, w.id);
    expect((await screen.findByTestId("who")).textContent).toContain("UI Main");
    expect(screen.queryByText("Your session has ended. Sign in again to continue.")).toBeNull();
  });

  it("the CSRF token is sent on every mutation and a wrong one is refused by the server", async () => {
    const { api } = await openAs("operator", "write", "/snapshots");
    await heading("Snapshots");
    expect((await api.raw("POST", "/api/v1/snapshots", { schema_version: 1, revision: "x", manifest: {} }, "wrong-token")).status).toBe(403);
    expect((await api.raw("POST", "/api/v1/snapshots", { schema_version: 1, revision: "x", manifest: {} }, "")).status).toBe(403);
  });

  it("the server being unreachable is a failed state with a retry that reloads the session", async () => {
    mockAny("network");
    renderApp("/snapshots");
    const alert = await screen.findByRole("alert");
    expect(alert.getAttribute("data-status")).toBe("0");
    resetWeb();
    let up = false;
    mockAny(() => (up ? apiError(401, "UNAUTHENTICATED", "Authentication required") : apiError(503, "NOT_READY", "starting")));
    renderApp("/snapshots");
    expect((await screen.findByRole("alert")).getAttribute("data-status")).toBe("503");
    up = true;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await signInForm();
  });

  it("unknown pages are 'not found', and / goes to the snapshot list", async () => {
    await openAs("viewer", "main", "/nowhere/at/all");
    const alert = await screen.findByRole("alert");
    expect(alert.getAttribute("data-status")).toBe("404");
    expect(alert.textContent).toContain("This page does not exist");
    resetWeb();
    await openAs("viewer", "main", "/");
    await heading("Snapshots");
  });
});

describe("workspace selection and sign in", () => {
  it("a wrong password and a workspace the user does not belong to fail identically, without saying which part was wrong", async () => {
    const api = useRealApi();
    const seed = inject("seed");
    const main = seed.workspaces.main;
    renderApp("/snapshots");
    await signInForm();
    fillLogin(main.emails.viewer, "definitely-wrong");
    const wrong = (await screen.findByRole("alert")).textContent;
    expect(wrong).toContain("The email, password or workspace is not correct");
    // Correct password, but a workspace this user is not a member of.
    fillLogin(main.emails.viewer, seed.password, seed.workspaces.other.id);
    const foreign = await screen.findByRole("alert");
    expect(foreign.getAttribute("data-status")).toBe("401");
    expect(foreign.textContent).toContain("The email, password or workspace is not correct");
    expect(foreign.textContent).not.toContain("UI Other");
    expect(api.calls.filter((c) => c.path === "/api/v1/auth/login")).toHaveLength(2);
  });

  it("a workspace id that is not an id is refused before any request", async () => {
    const api = useRealApi();
    renderApp("/snapshots");
    await signInForm();
    fillLogin("someone@example.test", "whatever-password", "not-a-uuid");
    expect((await screen.findByRole("alert")).textContent).toContain("A workspace ID looks like");
    expect(api.calls.filter((c) => c.path === "/api/v1/auth/login")).toHaveLength(0);
  });

  it("a user in two workspaces lands in the first by name, can pick the other by id, and switches from the header", async () => {
    const api = useRealApi();
    const seed = inject("seed");
    const main = seed.workspaces.main;
    const empty = seed.workspaces.empty;
    renderApp("/snapshots");
    await signInForm();
    // No workspace given: the first by name ("UI Empty" sorts before "UI Main").
    fillLogin(main.emails.admin, seed.password);
    expect((await screen.findByTestId("who")).textContent).toContain("UI Empty");
    await screen.findByText("No snapshots yet");
    expect(screen.queryByLabelText("Switch workspace")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await signInForm();
    // The workspace this browser used before is offered.
    expect(document.querySelector('#known-workspaces option[value="' + empty.id + '"]')?.textContent).toBe("UI Empty");
    fillLogin(main.emails.admin, seed.password, main.id);
    expect((await screen.findByTestId("who")).textContent).toContain("UI Main");
    await screen.findByText("2026-09-29.1");
    // Switch from the header: it signs out and asks for the password again, with the workspace filled in.
    const select = screen.getByLabelText("Switch workspace") as HTMLSelectElement;
    expect(within(select).getByRole("option", { name: "UI Empty" })).toBeTruthy();
    fireEvent.change(select, { target: { value: empty.id } });
    await signInForm();
    expect((screen.getByLabelText(/Workspace ID/) as HTMLInputElement).value).toBe(empty.id);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: main.emails.admin } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: seed.password } });
    fireEvent.submit(screen.getByRole("form", { name: "Sign in" }));
    expect((await screen.findByTestId("who")).textContent).toContain("UI Empty");
    expect(api.calls.filter((c) => c.path === "/api/v1/auth/login")).toHaveLength(3);
  });

  it("the remembered workspaces contain ids and names only, tolerate garbage and never hold a credential", async () => {
    localStorage.setItem("changeradar.workspaces", "not json");
    expect(rememberedWorkspaces()).toEqual([]);
    localStorage.setItem("changeradar.workspaces", JSON.stringify({ not: "a list" }));
    expect(rememberedWorkspaces()).toEqual([]);
    localStorage.setItem("changeradar.workspaces", JSON.stringify([{ id: "w1", name: "One" }, { id: 5 }, null, "x", { id: "w2", name: "Two", password: "leak" }]));
    expect(rememberedWorkspaces().map((w) => w.id)).toEqual(["w1", "w2"]);
    const { w } = await openAs("viewer", "main", "/snapshots");
    await screen.findByTestId("who");
    const stored = localStorage.getItem("changeradar.workspaces") ?? "";
    expect(stored).toContain(w.id);
    expect(stored).not.toMatch(/password|csrf|token|cookie|@/i);
  });

  it("works when browser storage is unavailable", async () => {
    const original = Storage.prototype.setItem;
    const originalGet = Storage.prototype.getItem;
    Storage.prototype.setItem = () => {
      throw new Error("blocked");
    };
    Storage.prototype.getItem = () => {
      throw new Error("blocked");
    };
    try {
      await openAs("viewer", "main", "/snapshots");
      await heading("Snapshots");
      fireEvent.click(screen.getByRole("button", { name: /Theme:/ }));
      expect(screen.getByRole("button", { name: /Theme: light/ })).toBeTruthy();
      expect(rememberedWorkspaces()).toEqual([]);
    } finally {
      Storage.prototype.setItem = original;
      Storage.prototype.getItem = originalGet;
    }
  });
});

describe("theme", () => {
  it("cycles auto, light and dark, applies data-theme, and remembers the choice", async () => {
    await openAs("viewer", "main", "/snapshots");
    await heading("Snapshots");
    const toggle = () => screen.getByRole("button", { name: /Theme:/ });
    expect(toggle().textContent).toBe("Theme: auto");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    fireEvent.click(toggle());
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    fireEvent.click(toggle());
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(localStorage.getItem("changeradar.theme")).toBe("dark");
    fireEvent.click(toggle());
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(localStorage.getItem("changeradar.theme")).toBe("auto");
    applyTheme("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("starts in the remembered theme", async () => {
    localStorage.setItem("changeradar.theme", "dark");
    await openAs("viewer", "main", "/snapshots");
    await heading("Snapshots");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(screen.getByRole("button", { name: "Theme: dark" })).toBeTruthy();
  });
});
