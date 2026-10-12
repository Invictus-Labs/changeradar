import type { FastifyInstance } from "fastify";
import { migrate, MigrationError } from "../db/migrate.js";
import type { Ctx } from "../platform/context.js";
import { startWorker } from "../workers/worker.js";
import { buildApp } from "./server.js";

/**
 * Run migrations and record the outcome in the readiness gate. A failed migration rolls back completely
 * (see `migrate`), leaves the server NOT ready, and is reported instead of being retried into a half state.
 */
export async function prepareSchema(ctx: Ctx, migrationsDir?: string): Promise<{ ready: boolean; error?: string }> {
  try {
    await migrate(ctx.db, migrationsDir);
    ctx.readiness = { ok: true, reason: "ready" };
    return { ready: true };
  } catch (error) {
    ctx.readiness = { ok: false, reason: error instanceof MigrationError ? "migration_failed" : "database_unavailable" };
    ctx.diagnostics({ event: "startup.migration_failed", level: "error", code: ctx.readiness.reason });
    return { ready: false, error: (error as Error).message };
  }
}

/** How long in-flight requests may finish after a stop request before their connections are closed. */
const SHUTDOWN_GRACE_MS = 5000;

export interface RunningServer {
  app: FastifyInstance;
  address: string;
  stop(): Promise<void>;
}

/**
 * Start the HTTP server (and, unless disabled, the job worker). When migrations fail the server still
 * listens so that the health endpoint can report `not_ready`, but it answers 503 to everything else and
 * does not start the worker.
 */
export async function startServer(
  ctx: Ctx,
  options: { host: string; port: number; withWorker: boolean; migrationsDir?: string; webRoot?: string; shutdownGraceMs?: number },
): Promise<RunningServer & { ready: boolean }> {
  const schema = await prepareSchema(ctx, options.migrationsDir);
  const app = await buildApp(ctx, options.webRoot ? { webRoot: options.webRoot } : {});
  const stopWorker = schema.ready && options.withWorker ? startWorker(ctx) : async () => undefined;
  let address: string;
  try {
    address = await app.listen({ host: options.host, port: options.port });
  } catch (error) {
    // A port that is already taken must not leave the worker polling (it would keep the process alive) or the app open.
    await stopWorker();
    await app.close();
    throw error;
  }
  return {
    app,
    address,
    ready: schema.ready,
    async stop() {
      await stopWorker();
      // In-flight requests get a bounded time to finish; after that every remaining connection (a client that
      // trickles a body, or holds a keep-alive open) is closed so shutdown never waits on a slow peer.
      const deadline = setTimeout(() => app.server.closeAllConnections(), options.shutdownGraceMs ?? SHUTDOWN_GRACE_MS);
      try {
        await app.close();
      } finally {
        clearTimeout(deadline);
      }
    },
  };
}
