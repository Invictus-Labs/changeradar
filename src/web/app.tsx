import { type ComponentType, type FormEvent, type ReactNode, useCallback, useEffect, useState } from "react";
import { BrowserRouter, Link, Navigate, NavLink, Route, Routes } from "react-router-dom";
import { ApiError, canReadOperational, isAdmin, loadSession, onUnauthorized, signIn, signOut, type User } from "./api";
import { ErrorView, Loading, RoleBadge } from "./components";
import { AdminPage, ChecksPage, EventsPage } from "./pages/admin";
import { NewRunPage, RunDetailPage, RunsPage } from "./pages/runs";
import { ImportSnapshotPage, SnapshotDetailPage, SnapshotsPage } from "./pages/snapshots";

// ---- workspace memory: only ids and names of workspaces this browser signed in to, never credentials ----

interface KnownWorkspace {
  id: string;
  name: string;
}

const WORKSPACES_KEY = "changeradar.workspaces";
const THEME_KEY = "changeradar.theme";

/** localStorage can throw or be empty (private windows, blocked storage); the UI works without it. */
function readStore(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeStore(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // Storage is a convenience only.
  }
}

export function rememberedWorkspaces(): KnownWorkspace[] {
  try {
    const parsed: unknown = JSON.parse(readStore(WORKSPACES_KEY) ?? "[]");
    // Keep only id and name, so nothing else that ends up in storage is ever carried along or written back.
    return Array.isArray(parsed)
      ? parsed
          .filter((w): w is KnownWorkspace => typeof w === "object" && w !== null && typeof (w as KnownWorkspace).id === "string" && typeof (w as KnownWorkspace).name === "string")
          .map((w) => ({ id: w.id, name: w.name }))
          .slice(0, 8)
      : [];
  } catch {
    return [];
  }
}

function rememberWorkspace(user: User): void {
  const others = rememberedWorkspaces().filter((w) => w.id !== user.workspace_id);
  writeStore(WORKSPACES_KEY, JSON.stringify([{ id: user.workspace_id, name: user.workspace_name }, ...others].slice(0, 8)));
}

type Theme = "auto" | "light" | "dark";

export function applyTheme(theme: Theme): void {
  if (theme === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
}

function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => {
    const stored = readStore(THEME_KEY);
    return stored === "light" || stored === "dark" ? stored : "auto";
  });
  useEffect(() => applyTheme(theme), [theme]);
  const next: Theme = theme === "auto" ? "light" : theme === "light" ? "dark" : "auto";
  return (
    <button
      type="button"
      className="button-secondary"
      onClick={() => {
        writeStore(THEME_KEY, next);
        setTheme(next);
      }}
    >
      Theme: {theme}
    </button>
  );
}

// ---- app ----

export interface AppProps {
  /** Router component; tests pass a MemoryRouter wrapper. Defaults to the browser router. */
  Router?: ComponentType<{ children: ReactNode }>;
}

export function App({ Router = BrowserRouter }: AppProps) {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [workspaceHint, setWorkspaceHint] = useState<string>("");

  const bootstrap = useCallback(() => {
    setLoadError(null);
    setUser(undefined);
    loadSession().then(
      (u) => {
        if (u) rememberWorkspace(u);
        setUser(u);
      },
      (e: unknown) => setLoadError(e),
    );
  }, []);
  useEffect(() => bootstrap(), [bootstrap]);

  // A 401 from any later call means the session is gone: return to the sign in form and say so.
  useEffect(() => {
    onUnauthorized(() => {
      setUser((current) => {
        if (current) setNotice("Your session has ended. Sign in again to continue.");
        return null;
      });
    });
    return () => onUnauthorized(null);
  }, []);

  const signedIn = useCallback((u: User) => {
    rememberWorkspace(u);
    setNotice(null);
    setUser(u);
  }, []);

  if (loadError) {
    return (
      <main className="center-block">
        <h1>ChangeRadar</h1>
        <ErrorView error={loadError} onRetry={bootstrap} />
      </main>
    );
  }
  if (user === undefined) return <Loading label="Loading ChangeRadar" />;
  if (user === null) return <Login onSignedIn={signedIn} notice={notice} initialWorkspace={workspaceHint} />;

  return (
    <Router>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <Shell
        user={user}
        onSignOut={async (switchWorkspace) => {
          try {
            await signOut();
          } catch {
            // The cookie may already be invalid; the local state is cleared either way.
          }
          setWorkspaceHint(switchWorkspace ?? "");
          setNotice(null);
          setUser(null);
        }}
      />
    </Router>
  );
}

function Shell({ user, onSignOut }: { user: User; onSignOut: (switchToWorkspace?: string) => Promise<void> }) {
  const others = rememberedWorkspaces().filter((w) => w.id !== user.workspace_id);
  return (
    <>
      <header className="topbar">
        <Link to="/snapshots" className="brand">
          ChangeRadar
        </Link>
        <nav aria-label="Main">
          <NavLink to="/snapshots">Snapshots</NavLink>
          <NavLink to="/runs">Impact runs</NavLink>
          {canReadOperational(user.role) && <NavLink to="/checks">Contract checks</NavLink>}
          {canReadOperational(user.role) && <NavLink to="/events">Events</NavLink>}
          {isAdmin(user.role) && <NavLink to="/admin">Administration</NavLink>}
        </nav>
        <div className="who">
          <span data-testid="who">
            {user.workspace_name} · {user.email} <RoleBadge role={user.role} />
          </span>
          {others.length > 0 && (
            <label className="switch">
              <span className="visually-hidden">Switch workspace</span>
              <select
                aria-label="Switch workspace"
                value=""
                onChange={(e) => {
                  if (e.target.value) void onSignOut(e.target.value);
                }}
              >
                <option value="">Switch workspace…</option>
                {others.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <ThemeToggle />
          <button type="button" className="button-secondary" onClick={() => void onSignOut()}>
            Sign out
          </button>
        </div>
      </header>
      <main id="main">
        <Routes>
          <Route path="/" element={<Navigate to="/snapshots" replace />} />
          <Route path="/snapshots" element={<SnapshotsPage user={user} />} />
          <Route path="/snapshots/import" element={<ImportSnapshotPage user={user} />} />
          <Route path="/snapshots/:id" element={<SnapshotDetailPage user={user} />} />
          <Route path="/runs" element={<RunsPage user={user} />} />
          <Route path="/runs/new" element={<NewRunPage user={user} />} />
          <Route path="/runs/:id" element={<RunDetailPage user={user} />} />
          <Route path="/checks" element={<ChecksPage user={user} />} />
          <Route path="/events" element={<EventsPage user={user} />} />
          <Route path="/admin" element={<AdminPage user={user} />} />
          <Route
            path="*"
            element={
              <div className="banner banner-denied" role="alert" data-state="denied" data-status="404">
                <strong>Not found.</strong> This page does not exist. <Link to="/snapshots">Go to snapshots</Link>.
              </div>
            }
          />
        </Routes>
      </main>
    </>
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function Login({ onSignedIn, notice, initialWorkspace }: { onSignedIn: (u: User) => void; notice: string | null; initialWorkspace: string }) {
  const [error, setError] = useState<unknown>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const known = rememberedWorkspaces();
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const workspace = String(form.get("workspace") ?? "").trim();
    if (workspace !== "" && !UUID.test(workspace)) return setProblem("A workspace ID looks like 123e4567-e89b-12d3-a456-426614174000. Leave it empty to use your first workspace.");
    setProblem(null);
    setError(null);
    setBusy(true);
    try {
      onSignedIn(await signIn(String(form.get("email") ?? ""), String(form.get("password") ?? ""), workspace || undefined));
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "UNEXPECTED", "Sign in failed"));
      setBusy(false);
    }
  };
  return (
    <main className="login">
      <form onSubmit={(e) => void submit(e)} aria-label="Sign in">
        <h1>ChangeRadar</h1>
        <p className="muted">See which consumers a proposed change can break. Accounts are created by an administrator with the command line tool; there is no registration.</p>
        {notice && (
          <p className="banner banner-warn" role="status">
            {notice}
          </p>
        )}
        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" name="email" type="email" autoComplete="username" required />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input id="password" name="password" type="password" autoComplete="current-password" required />
        </div>
        <div className="field">
          <label htmlFor="workspace">Workspace ID (optional)</label>
          <input id="workspace" name="workspace" list="known-workspaces" defaultValue={initialWorkspace} autoComplete="off" placeholder="first workspace by name" />
          <datalist id="known-workspaces">
            {known.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </datalist>
          <span className="muted">A session belongs to one workspace. Pick another ID to work in a different one.</span>
        </div>
        <button type="submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
        {problem && (
          <p className="banner banner-failed" role="alert" data-state="failed" data-status="client">
            {problem}
          </p>
        )}
        {error !== null && <ErrorView error={error} />}
      </form>
    </main>
  );
}
