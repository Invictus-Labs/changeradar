import { randomUUID } from "node:crypto";
import type { Queryable } from "../db/index.js";
import { type Ctx, addSeconds } from "../platform/context.js";
import { DUMMY_PASSWORD_HASH, hashPassword, randomToken, sha256Hex, verifyPassword } from "../platform/crypto.js";
import { type Page, decodeCursor, encodeCursor } from "../platform/cursor.js";
import { conflict, forbidden, unauthorized, unprocessable } from "../platform/errors.js";
import { audit } from "./audit.js";

export type Role = "admin" | "operator" | "viewer";
export const ROLES: readonly Role[] = ["admin", "operator", "viewer"];
const RANK: Record<Role, number> = { viewer: 1, operator: 2, admin: 3 };

export interface Principal {
  userId: string;
  email: string;
  workspaceId: string;
  workspaceName: string;
  role: Role;
  sessionId: string;
}

/**
 * Role gate. Every service entry point calls it before touching data, so a route that forgets to check
 * still cannot read, write, enqueue or export on behalf of an unauthorized role.
 */
export function requireRole(principal: Principal, minimum: Role): void {
  if (RANK[principal.role] < RANK[minimum]) throw forbidden();
}

export const SESSION_COOKIE = "changeradar_session";
export const MIN_PASSWORD_LENGTH = 12;

export async function createWorkspace(tx: Queryable, name: string, at: Date): Promise<string> {
  const id = randomUUID();
  await tx.query("INSERT INTO workspaces (id, name, created_at) VALUES ($1,$2,$3)", [id, name, at]);
  return id;
}

/**
 * Creates (or reuses) a user and grants a workspace role. Used only by the explicit bootstrap CLI and
 * test fixtures: there is no open registration and no default password.
 */
export async function grantUser(
  tx: Queryable,
  input: { workspaceId: string; email: string; password: string; role: Role; at: Date },
): Promise<string> {
  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(email) || email.length > 320) throw unprocessable("INVALID_EMAIL", "A valid email is required");
  if (input.password.length < MIN_PASSWORD_LENGTH) throw unprocessable("WEAK_PASSWORD", `Passwords need at least ${MIN_PASSWORD_LENGTH} characters`);
  const workspace = await tx.query("SELECT 1 FROM workspaces WHERE id = $1", [input.workspaceId]);
  if (workspace.rows.length === 0) throw unprocessable("UNKNOWN_WORKSPACE", "Workspace does not exist");
  const existing = await tx.query<{ id: string }>("SELECT id FROM users WHERE email = $1", [email]);
  let userId = existing.rows[0]?.id;
  if (!userId) {
    userId = randomUUID();
    await tx.query("INSERT INTO users (id, email, password_hash, created_at) VALUES ($1,$2,$3,$4)", [
      userId,
      email,
      await hashPassword(input.password),
      input.at,
    ]);
  }
  const member = await tx.query("SELECT 1 FROM memberships WHERE workspace_id = $1 AND user_id = $2", [input.workspaceId, userId]);
  if (member.rows.length > 0) throw conflict("ALREADY_MEMBER", "User is already a member of this workspace");
  await tx.query("INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1,$2,$3)", [input.workspaceId, userId, input.role]);
  return userId;
}

/**
 * Operator action (CLI): end every session of a member of a workspace and, optionally, remove the membership. A
 * departed operator or a stolen session is cut off at the next request (sessions are checked on every request).
 */
export async function revokeAccess(
  tx: Queryable,
  input: { workspaceId: string; email: string; removeMember: boolean; at: Date },
): Promise<{ sessions_revoked: number; membership_removed: boolean }> {
  const email = input.email.trim().toLowerCase();
  const member = await tx.query<{ user_id: string }>(
    "SELECT m.user_id FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1 AND u.email = $2",
    [input.workspaceId, email],
  );
  const userId = member.rows[0]?.user_id;
  if (!userId) throw unprocessable("UNKNOWN_MEMBER", "No such member in this workspace");
  const revoked = await tx.query(
    "UPDATE sessions SET revoked_at = $3 WHERE workspace_id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id",
    [input.workspaceId, userId, input.at],
  );
  if (input.removeMember) {
    // Sessions reference the membership; they are ephemeral, so they go with it.
    await tx.query("DELETE FROM sessions WHERE workspace_id = $1 AND user_id = $2", [input.workspaceId, userId]);
    await tx.query("DELETE FROM memberships WHERE workspace_id = $1 AND user_id = $2", [input.workspaceId, userId]);
  }
  await audit(tx, {
    workspaceId: input.workspaceId,
    actorType: "cli",
    actorId: null,
    action: input.removeMember ? "member.removed" : "member.sessions_revoked",
    resourceType: "user",
    resourceId: userId,
    at: input.at,
    metadata: { sessions_revoked: revoked.rows.length },
  });
  return { sessions_revoked: revoked.rows.length, membership_removed: input.removeMember };
}

export interface LoginResult {
  token: string;
  csrfToken: string;
  principal: Principal;
  expiresAt: Date;
}

export async function login(ctx: Ctx, email: string, password: string, workspaceId?: string): Promise<LoginResult> {
  const now = ctx.clock.now();
  const user = await ctx.db.query<{ id: string; email: string; password_hash: string }>(
    "SELECT id, email, password_hash FROM users WHERE email = $1",
    [email.trim().toLowerCase()],
  );
  const row = user.rows[0];
  // Always run a hash comparison so response timing does not reveal account existence.
  const ok = await verifyPassword(password, row?.password_hash ?? DUMMY_PASSWORD_HASH);
  if (!row || !ok) throw unauthorized("INVALID_CREDENTIALS", "Email or password is incorrect");
  const memberships = await ctx.db.query<{ workspace_id: string; role: Role; name: string }>(
    `SELECT m.workspace_id, m.role, w.name FROM memberships m JOIN workspaces w ON w.id = m.workspace_id
     WHERE m.user_id = $1 ORDER BY w.name, w.id`,
    [row.id],
  );
  const membership = workspaceId ? memberships.rows.find((m) => m.workspace_id === workspaceId) : memberships.rows[0];
  if (!membership) throw unauthorized("INVALID_CREDENTIALS", "Email or password is incorrect");
  const token = randomToken();
  const sessionId = randomUUID();
  const expiresAt = addSeconds(now, ctx.settings.sessionTtlSeconds);
  await ctx.db.query(
    "INSERT INTO sessions (id, token_hash, user_id, workspace_id, created_at, expires_at) VALUES ($1,$2,$3,$4,$5,$6)",
    [sessionId, sha256Hex(token), row.id, membership.workspace_id, now, expiresAt],
  );
  await audit(ctx.db, { workspaceId: membership.workspace_id, actorType: "user", actorId: row.id, action: "auth.login", resourceType: "session", resourceId: sessionId, at: now });
  return {
    token,
    csrfToken: csrfFor(ctx, token),
    expiresAt,
    principal: {
      userId: row.id,
      email: row.email,
      workspaceId: membership.workspace_id,
      workspaceName: membership.name,
      role: membership.role,
      sessionId,
    },
  };
}

/** CSRF token bound to the session token with a server-side key; recomputable after a page reload. */
export const csrfFor = (ctx: Ctx, sessionToken: string) => ctx.box.mac("csrf", sessionToken);

export async function authenticateSession(ctx: Ctx, token: string | undefined): Promise<Principal | null> {
  if (!token) return null;
  const result = await ctx.db.query<{
    id: string;
    user_id: string;
    email: string;
    workspace_id: string;
    role: Role;
    name: string;
  }>(
    `SELECT s.id, s.user_id, u.email, s.workspace_id, m.role, w.name
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       JOIN memberships m ON m.workspace_id = s.workspace_id AND m.user_id = s.user_id
       JOIN workspaces w ON w.id = s.workspace_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > $2`,
    [sha256Hex(token), ctx.clock.now()],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { userId: row.user_id, email: row.email, workspaceId: row.workspace_id, workspaceName: row.name, role: row.role, sessionId: row.id };
}

export async function logout(ctx: Ctx, principal: Principal): Promise<void> {
  await ctx.db.query("UPDATE sessions SET revoked_at = $1 WHERE id = $2 AND revoked_at IS NULL", [ctx.clock.now(), principal.sessionId]);
  await audit(ctx.db, { workspaceId: principal.workspaceId, actorType: "user", actorId: principal.userId, action: "auth.logout", resourceType: "session", resourceId: principal.sessionId, at: ctx.clock.now() });
}

export async function listMembers(ctx: Ctx, principal: Principal, opts: { limit: number; cursor?: string | undefined }): Promise<Page<{ user_id: string; email: string; role: Role }>> {
  requireRole(principal, "admin");
  const after = decodeCursor(opts.cursor, ["string"]);
  const result = await ctx.db.query<{ user_id: string; email: string; role: Role }>(
    `SELECT m.user_id, u.email, m.role FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = $1 AND ($2::text IS NULL OR u.email COLLATE "C" > $2::text COLLATE "C")
      ORDER BY u.email COLLATE "C" LIMIT $3`,
    [principal.workspaceId, after ? after[0] : null, opts.limit + 1],
  );
  const items = result.rows.slice(0, opts.limit);
  const last = items[items.length - 1];
  return { items, next_cursor: result.rows.length > opts.limit && last ? encodeCursor([last.email]) : null };
}
