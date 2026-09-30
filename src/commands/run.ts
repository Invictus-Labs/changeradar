import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareSchema, startServer } from "../api/bootstrap.js";
import { migrate } from "../db/migrate.js";
import { type Ctx, defaultSettings } from "../platform/context.js";
import { contextFromConfig, loadConfig } from "../platform/config.js";
import { randomToken } from "../platform/crypto.js";
import { createWorkspace, grantUser, revokeAccess, type Role, ROLES } from "../services/auth.js";
import { deleteCredential, listCredentialAliases, setCredential } from "../services/checks.js";
import { buildBundle, BundleError, serializeBundle, staleEngineRuns, verifyBundle } from "../services/evidence.js";
import { pruneIdempotencyKeys } from "../services/idempotency.js";
import { restoreBundle, RestoreConflictError } from "../services/restore.js";
import { applyRetention, planRetention } from "../services/retention.js";
import { neutralize } from "../platform/terminal-text.js";
import { APP_VERSION } from "../platform/version.js";
import { startWorker } from "../workers/worker.js";
import { runDemo } from "./demo.js";
import { SAMPLE_FILES, writeSampleManifests } from "./demo-fixture.js";

export interface Io {
  out(message: string): void;
  err(message: string): void;
  stdin(): Promise<string>;
}

export const USAGE = `changeradar <command>

  version                                 print the version and the source commit the package was built from
  migrate                                 apply database migrations
  serve [--no-worker]                     start the API (and the job worker)
  worker                                  start only the job worker
  admin create --email E (--workspace NAME | --workspace-id ID) [--role admin|operator|viewer]
               (--password-stdin | --generate-password)
  admin revoke --email E --workspace-id ID [--remove-member]    end every session of a member (and remove the membership)
  credential set --workspace-id ID --alias A          read the credential value from stdin (sealed at rest)
  credential delete --workspace-id ID --alias A
  credential list --workspace-id ID
  export --workspace-id ID --out FILE [--run RUN_ID]  write a versioned, hashed evidence bundle
  verify-bundle --in FILE                              verify a bundle without touching any database
  restore --in FILE                                    restore a verified bundle into a clean installation
  idempotency prune [--older-than-days N]              delete idempotency keys older than N days (N >= 7)
  retention report [--days N] [--workspace-id ID]      show what an evidence retention window would delete (default 90 days)
  retention apply --approve [--days N] [--workspace-id ID]   delete it (operator approved; nothing is deleted automatically)
  sample-manifests --out DIR                           write synthetic sample manifests (baseline, proposals, a ready-to-post request body)
  demo [--dir DIR] [--port N] [--reset]                synthetic, account-free demo on localhost (embedded database in DIR, default ./changeradar-demo)

Configuration comes from the environment; see .env.example.
Exit codes: 0 success, 1 failure, 2 bundle rejected or restore conflict, 64 usage, 66 input file missing or unreadable,
70 unexpected internal error, 73 output could not be written, 130 or 143 interrupted (SIGINT or SIGTERM), 141 output pipe closed.`;

/** Exit codes (documented in README and docs/OPERATIONS.md). EPIPE and unexpected errors never reuse the first four. */
export const EXIT = { ok: 0, failure: 1, bundle: 2, usage: 64, noInput: 66, internal: 70, cannotWrite: 73, sigint: 130, sigterm: 143, pipe: 141 } as const;

/** A malformed command line: unknown, repeated or value-less flags. Exit 64 with the usage text. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

type Flags = Record<string, string | true>;

/** Flags that take no value. Every other flag needs one, so `--run` with the value forgotten is an error, not "no run". */
const BOOLEAN_FLAGS = new Set(["no-worker", "password-stdin", "generate-password", "reset", "approve", "remove-member"]);

/** Accepted flags per command (and sub command). Anything else, including a typo, is a usage error. */
const ALLOWED_FLAGS: Record<string, readonly string[]> = {
  migrate: [],
  version: [],
  serve: ["no-worker"],
  worker: [],
  "admin create": ["email", "workspace", "workspace-id", "role", "password-stdin", "generate-password"],
  "admin revoke": ["email", "workspace-id", "remove-member"],
  "credential set": ["workspace-id", "alias"],
  "credential delete": ["workspace-id", "alias"],
  "credential list": ["workspace-id"],
  export: ["workspace-id", "out", "run"],
  "verify-bundle": ["in"],
  restore: ["in"],
  "idempotency prune": ["older-than-days"],
  "retention report": ["days", "workspace-id"],
  "retention apply": ["days", "workspace-id", "approve"],
  "sample-manifests": ["out"],
  demo: ["dir", "port", "reset"],
};
const COMMANDS_WITH_SUB = new Set(["admin", "credential", "idempotency", "retention"]);

function parseArgs(argv: string[]): { flags: Flags; positional: string[] } {
  // No prototype: `--__proto__ x` must be an unknown flag, not a silently ignored assignment to Object.prototype's setter.
  const flags: Flags = Object.create(null) as Flags;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (key === "" || key.includes("=")) throw new UsageError(`unrecognised argument ${JSON.stringify(arg.slice(0, 40))}; write flags as --name value`);
    if (Object.hasOwn(flags, key)) throw new UsageError(`--${key} was given more than once`);
    if (BOOLEAN_FLAGS.has(key)) {
      flags[key] = true;
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) throw new UsageError(`--${key} needs a value`);
    if (next.trim() === "") throw new UsageError(`--${key} must not be empty`);
    flags[key] = next;
    i += 1;
  }
  return { flags, positional };
}

/** Reject flags the command does not know and stray positional arguments. */
function validateArgs(command: string, sub: string | undefined, flags: Flags, positional: string[]): void {
  const key = COMMANDS_WITH_SUB.has(command) && sub ? `${command} ${sub}` : command;
  const allowed = ALLOWED_FLAGS[key];
  if (!allowed) return; // an unknown command or sub command falls through to the usage text
  for (const flag of Object.keys(flags)) {
    if (!allowed.includes(flag)) throw new UsageError(`--${flag} is not a flag of \`changeradar ${key}\``);
  }
  const expected = COMMANDS_WITH_SUB.has(command) ? 1 : 0;
  if (positional.length > expected) throw new UsageError(`unexpected argument ${JSON.stringify((positional[expected] as string).slice(0, 40))}`);
}

const str = (flags: Flags, key: string): string | undefined => (typeof flags[key] === "string" ? (flags[key] as string) : undefined);
const need = (flags: Flags, key: string): string => {
  const value = str(flags, key);
  if (!value) throw new Error(`--${key} is required`);
  return value;
};
const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A flag that names a UUID: anything else is a usage error before the database sees it (its own message would echo the text). */
const strUuid = (flags: Flags, key: string): string | undefined => {
  const value = str(flags, key);
  if (value !== undefined && !UUID_TEXT.test(value)) throw new UsageError(`--${key} must be a UUID`);
  return value;
};
const needUuid = (flags: Flags, key: string): string => {
  need(flags, key);
  return strUuid(flags, key) as string;
};
/** A whole number flag; anything else (for example `--days abc`) is a usage error instead of NaN reaching the service. */
function intFlag(flags: Flags, key: string, fallback: number, min: number, max: number): number {
  const raw = str(flags, key);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) throw new UsageError(`--${key} must be a whole number between ${min} and ${max}`);
  return value;
}

/**
 * Work to do when a one-shot command is interrupted (close the database, remove a half written file). The bin
 * shim runs these on SIGINT/SIGTERM before exiting non-zero.
 */
const cleanups = new Set<() => void | Promise<void>>();
export function registerCleanup(fn: () => void | Promise<void>): () => void {
  cleanups.add(fn);
  return () => void cleanups.delete(fn);
}
export async function runCleanups(timeoutMs = 3000): Promise<void> {
  const all = [...cleanups].map(async (fn) => {
    try {
      await fn();
    } catch {
      /* best effort: the process is exiting */
    }
  });
  await Promise.race([Promise.all(all), new Promise((resolve) => setTimeout(resolve, timeoutMs).unref())]);
}

async function openMigrated(env: NodeJS.ProcessEnv): Promise<Ctx> {
  const ctx = await contextFromConfig(loadConfig(env));
  const unregister = registerCleanup(() => ctx.db.close());
  const schema = await prepareSchema(ctx);
  if (!schema.ready) {
    unregister();
    await ctx.db.close();
    throw new Error(schema.error ?? "database is not ready");
  }
  return ctx;
}

/** Close a one-shot command's database and forget its interrupt cleanup. */
async function closeCtx(ctx: Ctx, unregister?: () => void): Promise<void> {
  unregister?.();
  await ctx.db.close();
}

/**
 * Where the built web UI lives: `CHANGERADAR_WEB_ROOT` when set, otherwise `dist/web` next to the compiled server
 * (`dist/src/commands/run.js` -> `dist/web`) when it has been built. Running from source (tsx) finds nothing and
 * serves the API only, so raw `src/web` files are never exposed.
 */
export function resolveWebRoot(configured: string | null): string | null {
  const candidate = configured ? resolve(configured) : resolve(dirname(fileURLToPath(import.meta.url)), "../../web");
  return existsSync(resolve(candidate, "index.html")) ? candidate : null;
}

/** Marker value for commands that keep running (serve, worker). */
export const KEEP_RUNNING = -1;

const WRITE_ERRNO = new Set(["EACCES", "EPERM", "EROFS", "ENOSPC", "EDQUOT", "EEXIST", "EMFILE", "ENAMETOOLONG", "EISDIR", "ENOTDIR"]);
const READ_ERRNO = new Set(["ENOENT", "EISDIR", "ENOTDIR", "EACCES", "EPERM"]);

/** Where a failing file operation was heading, so that the same errno maps to a write or a read failure code. */
type FileRole = "write" | "read" | null;

function mapFileError(error: unknown, role: FileRole, io: Io): number | null {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code !== "string" || role === null) return null;
  const target = String((error as NodeJS.ErrnoException).path ?? "").split("/").pop() ?? "";
  if (role === "write" && WRITE_ERRNO.has(code)) {
    io.err(
      code === "EEXIST"
        ? `changeradar: ${JSON.stringify(target)} already exists; an existing file is never overwritten`
        : `changeradar: cannot write ${JSON.stringify(target)} (${code}); check the path, permissions and free disk space`,
    );
    return EXIT.cannotWrite;
  }
  if (role === "read" && READ_ERRNO.has(code)) {
    io.err(`changeradar: cannot read ${JSON.stringify(target)} (${code})`);
    return EXIT.noInput;
  }
  return null;
}

/**
 * Run one CLI invocation. Returns the process exit code, or KEEP_RUNNING for long-running commands.
 * Exit codes: 0 success, 1 failure, 2 bundle rejected or restore conflict, 64 usage, 66 input file missing,
 * 73 output could not be written. (70, 130, 141 and 143 are produced by the bin shim.)
 */
export async function runCli(argv: string[], env: NodeJS.ProcessEnv, rawIo: Io, hooks: { onServer?: (stop: () => Promise<void>) => void } = {}): Promise<number> {
  // One boundary for everything printed: a message may quote an untrusted file or argument, and a terminal
  // treats ESC, OSC, CSI, bidi controls and carriage returns as commands.
  const io: Io = { out: (message) => rawIo.out(neutralize(message)), err: (message) => rawIo.err(neutralize(message)), stdin: () => rawIo.stdin() };
  const [command, sub] = argv;
  let role: FileRole = null;
  try {
    const { flags, positional } = parseArgs(argv.slice(1));
    validateArgs(command ?? "", sub, flags, positional);
    switch (command) {
      case "version":
      case "--version": {
        const info = readBuildInfo();
        io.out(`changeradar ${APP_VERSION} commit ${info.commit ?? "unknown"}${info.dirty ? " dirty" : ""}`);
        return 0;
      }
      case "migrate": {
        const ctx = await contextFromConfig(loadConfig(env));
        const unregister = registerCleanup(() => ctx.db.close());
        try {
          const result = await migrate(ctx.db);
          io.out(result.applied.length ? `applied: ${result.applied.join(", ")}` : "schema up to date");
        } finally {
          await closeCtx(ctx, unregister);
        }
        return 0;
      }
      case "serve": {
        const config = loadConfig(env);
        const ctx = await contextFromConfig(config);
        const webRoot = resolveWebRoot(config.webRoot);
        let server: Awaited<ReturnType<typeof startServer>>;
        try {
          server = await startServer(ctx, { host: config.host, port: config.port, withWorker: flags["no-worker"] !== true, ...(webRoot ? { webRoot } : {}) });
        } catch (error) {
          // A port that is taken (or any startup failure) must not leave the database open: an open pool or
          // embedded engine keeps the process alive for tens of seconds after the error is printed.
          await ctx.db.close().catch(() => undefined);
          throw error;
        }
        hooks.onServer?.(async () => {
          await server.stop();
          await ctx.db.close();
        });
        if (!webRoot) io.err("web UI not found (run `npm run build`, or set CHANGERADAR_WEB_ROOT); serving the API only");
        if (server.ready) io.out(`changeradar listening on ${server.address}`);
        else io.err(`changeradar listening on ${server.address} but NOT READY: migrations failed; every route except /api/v1/health answers 503`);
        return KEEP_RUNNING;
      }
      case "demo": {
        const port = intFlag(flags, "port", 8797, 1, 65535);
        role = "write";
        await runDemo({ dir: str(flags, "dir") ?? "changeradar-demo", port, reset: flags.reset === true, webRoot: resolveWebRoot(null) }, io, (stop) => hooks.onServer?.(stop));
        return KEEP_RUNNING;
      }
      case "sample-manifests": {
        const out = resolve(need(flags, "out"));
        role = "write";
        const written = writeSampleManifests(out, new Date());
        io.out(`wrote ${written.length} synthetic files to ${out} (edges are stamped as verified one day ago):`);
        for (const [name, purpose] of Object.entries(SAMPLE_FILES)) io.out(`  ${name}  ${purpose}`);
        return 0;
      }
      case "worker": {
        const ctx = await openMigrated(env);
        const stop = startWorker(ctx);
        hooks.onServer?.(async () => {
          await stop();
          await ctx.db.close();
        });
        io.out("changeradar worker started");
        return KEEP_RUNNING;
      }
      case "admin": {
        if (sub === "revoke") {
          const ctx = await openMigrated(env);
          try {
            const removeMember = flags["remove-member"] === true;
            const email = need(flags, "email");
            const result = await ctx.db.transaction((tx) => revokeAccess(tx, { workspaceId: needUuid(flags, "workspace-id"), email, removeMember, at: ctx.clock.now() }));
            io.out(`revoked ${result.sessions_revoked} session(s) of ${email.trim().toLowerCase()}${result.membership_removed ? " and removed the membership" : ""}`);
          } finally {
            await closeCtx(ctx);
          }
          return 0;
        }
        if (sub !== "create") break;
        const ctx = await openMigrated(env);
        try {
          const role_ = (str(flags, "role") ?? "admin") as Role;
          if (!ROLES.includes(role_)) throw new UsageError("--role must be admin, operator or viewer");
          let password: string;
          if (flags["password-stdin"] === true) password = (await io.stdin()).trim();
          else if (flags["generate-password"] === true) password = randomToken(18);
          else throw new Error("choose --password-stdin or --generate-password (there is no default password)");
          const email = need(flags, "email");
          const now = ctx.clock.now();
          const workspaceId = await ctx.db.transaction(async (tx) => {
            const ws = strUuid(flags, "workspace-id") ?? (await createWorkspace(tx, need(flags, "workspace"), now));
            await grantUser(tx, { workspaceId: ws, email, password, role: role_, at: now });
            return ws;
          });
          io.out(`created ${role_} ${email.trim().toLowerCase()} in workspace ${workspaceId}`);
          if (flags["generate-password"] === true) io.out(`password (shown once): ${password}`);
        } finally {
          await closeCtx(ctx);
        }
        return 0;
      }
      case "credential": {
        if (sub !== "set" && sub !== "delete" && sub !== "list") break;
        const ctx = await openMigrated(env);
        try {
          const workspaceId = needUuid(flags, "workspace-id");
          if (sub === "set") {
            await setCredential(ctx, workspaceId, need(flags, "alias"), (await io.stdin()).replace(/\r?\n$/, ""));
            io.out(`credential ${need(flags, "alias")} stored (sealed)`);
          } else if (sub === "delete") {
            io.out((await deleteCredential(ctx, workspaceId, need(flags, "alias"))) ? "deleted" : "no such alias");
          } else {
            for (const alias of await listCredentialAliases(ctx, workspaceId)) io.out(alias);
          }
        } finally {
          await closeCtx(ctx);
        }
        return 0;
      }
      case "export": {
        const ctx = await openMigrated(env);
        try {
          const out = resolve(need(flags, "out"));
          const runId = strUuid(flags, "run");
          // The installation's own limit applies to what it writes: a bundle that verify-bundle and restore would refuse
          // (BUNDLE_TOO_LARGE, exit 2) is never written, and nothing is created on disk.
          const bundle = await buildBundle(ctx.db, { workspaceId: needUuid(flags, "workspace-id"), ...(runId ? { runId } : {}) }, ctx.clock.now(), { maxBytes: ctx.settings.maxBundleBytes });
          if (!bundle) {
            io.err("nothing to export: workspace or run not found");
            return 1;
          }
          role = "write";
          mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
          // Exclusive create with owner-only permissions: an existing file or symlink is never overwritten.
          const fd = openSync(out, "wx", 0o600);
          // A half written bundle must never be mistaken for a complete one: remove it if this command is
          // interrupted or the write fails.
          const removePartial = registerCleanup(() => rmSync(out, { force: true }));
          try {
            writeFileSync(fd, serializeBundle(bundle));
          } catch (error) {
            closeSync(fd);
            rmSync(out, { force: true });
            removePartial();
            throw error;
          }
          closeSync(fd);
          removePartial();
          io.out(`exported ${bundle.snapshots.length} snapshot(s), ${bundle.impact_runs.length} run(s) to ${out} (bundle_hash ${bundle.bundle_hash})`);
          const staleExported = bundle.stale_runs?.length ?? 0;
          if (staleExported > 0) io.out(`${staleExported} exported run(s) were assessed by an older decision engine: their recorded verdict is history, not a current answer; the ids are in the bundle's stale_runs member`);
        } finally {
          await closeCtx(ctx);
        }
        return 0;
      }
      case "verify-bundle": {
        const limit = bundleLimit(env);
        role = "read";
        const bytes = readBounded(resolve(need(flags, "in")), limit);
        role = null;
        const bundle = verifyBundle(bytes, { maxBytes: limit });
        io.out(`bundle ok: ${bundle.snapshots.length} snapshot(s), ${bundle.impact_runs.length} run(s), bundle_hash ${bundle.bundle_hash}`);
        const stale = staleEngineRuns(bundle);
        if (stale.length > 0) io.out(`${stale.length} finished run(s) were assessed by an older decision engine: verified by their hashes only, not re-derived, and shown as "re-run required" once restored`);
        return 0;
      }
      case "restore": {
        const ctx = await openMigrated(env);
        try {
          const file = resolve(need(flags, "in"));
          role = "read";
          const bytes = readBounded(file, ctx.settings.maxBundleBytes);
          role = null;
          const summary = await restoreBundle(ctx, bytes);
          io.out(`restored workspace ${summary.workspace_id}: ${summary.snapshots} snapshot(s), ${summary.impact_runs} run(s), ${summary.findings} finding(s)`);
          if (summary.interrupted_runs.length > 0) io.out(`${summary.interrupted_runs.length} unfinished run(s) were restored as FAILED (interrupted); request new runs`);
          if (summary.contract_checks > 0) io.out(`${summary.contract_checks} contract check(s) were restored DISABLED (a bundle is not authenticated); to re-arm one, POST /api/v1/contract-checks with the SAME key and the definition you want: the disabled check is replaced after the allowlist and secret rules have run`);
          if (summary.stale_runs.length > 0) io.out(`${summary.stale_runs.length} finished run(s) were assessed by an older decision engine: they are shown as "re-run required" and their recorded verdict may differ today; request new runs for anything you rely on`);
          io.out("next: create an administrator with `changeradar admin create --workspace-id <id> ...`; users and credentials are not part of a bundle");
        } finally {
          await closeCtx(ctx);
        }
        return 0;
      }
      case "idempotency": {
        if (sub !== "prune") break;
        const ctx = await openMigrated(env);
        try {
          const days = intFlag(flags, "older-than-days", ctx.settings.idempotencyRetentionDays, 0, 3650);
          io.out(`deleted ${await pruneIdempotencyKeys(ctx, days)} idempotency key(s)`);
        } finally {
          await closeCtx(ctx);
        }
        return 0;
      }
      case "retention": {
        if (sub !== "report" && sub !== "apply") break;
        if (sub === "apply" && flags.approve !== true) throw new Error("retention apply deletes evidence and needs --approve after the operator approved the window");
        const ctx = await openMigrated(env);
        try {
          const days = intFlag(flags, "days", ctx.settings.retention.evidenceDays, 0, 3650);
          const workspace = strUuid(flags, "workspace-id");
          const result = sub === "report" ? await planRetention(ctx, days, workspace) : await applyRetention(ctx, days, workspace);
          io.out(`${sub === "report" ? "would delete" : "deleted"} ${result.impact_runs} run(s), ${result.findings} finding(s), ${result.snapshots} snapshot(s) older than ${result.older_than_days} day(s) (before ${result.cutoff})`);
        } finally {
          await closeCtx(ctx);
        }
        return 0;
      }
      default:
        break;
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`changeradar: ${error.message}`);
      io.err(USAGE);
      return EXIT.usage;
    }
    if (error instanceof BundleError || error instanceof RestoreConflictError) {
      io.err(`changeradar: ${error instanceof BundleError ? error.code : "RESTORE_CONFLICT"}: ${error.message}`);
      return 2;
    }
    const mapped = mapFileError(error, role, io);
    if (mapped !== null) return mapped;
    io.err(`changeradar: ${(error as Error).message}`);
    return 1;
  }
  // Asked-for help is output (stdout, exit 0, so `changeradar help | less` works); an unknown command is an error (stderr, 64).
  const asked = command === undefined || command === "help" || command === "--help";
  (asked ? io.out : io.err)(USAGE);
  return asked ? 0 : 64;
}

/** The source commit a package was built from (written by scripts/write-build-info.mjs at pack time). */
function readBuildInfo(): { commit: string | null; dirty: boolean | null } {
  try {
    const raw = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../build-info.json"), "utf8")) as { commit?: unknown; dirty?: unknown };
    return { commit: typeof raw.commit === "string" && /^[0-9a-f]{40}$/.test(raw.commit) ? raw.commit : null, dirty: typeof raw.dirty === "boolean" ? raw.dirty : null };
  } catch {
    return { commit: null, dirty: null }; // running from source (tsx) or a build that never went through `npm pack`
  }
}

/** Bundle size cap for commands that do not open the database (same variable the server reads). */
function bundleLimit(env: NodeJS.ProcessEnv): number {
  const raw = env.CHANGERADAR_MAX_BUNDLE_BYTES;
  const value = raw === undefined || raw === "" ? defaultSettings.maxBundleBytes : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1024) throw new Error("CHANGERADAR_MAX_BUNDLE_BYTES must be an integer of at least 1024");
  return value;
}

/** Read a file after checking its size, so an oversized bundle is refused before it is read into memory. */
function readBounded(file: string, maxBytes: number): Buffer {
  const stat = statSync(file);
  // A FIFO, device or socket has no size to check and a read of it ignores signals and the byte cap.
  if (!stat.isFile()) throw new BundleError("BUNDLE_MALFORMED", "the input is not a regular file");
  const size = stat.size;
  if (size > maxBytes) throw new BundleError("BUNDLE_TOO_LARGE", `bundle is ${size} bytes; the limit is ${maxBytes}`);
  return readFileSync(file);
}
