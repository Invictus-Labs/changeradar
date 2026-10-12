import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { isSchemaCurrent } from "../db/migrate.js";
import { DomainError } from "../domain/errors.js";
import { MAX_PAGE_SIZE, parseLimit } from "../platform/cursor.js";
import type { Ctx } from "../platform/context.js";
import { safeEqual } from "../platform/crypto.js";
import { AppError, badRequest, forbidden, isDataException, isDatabaseUnavailable, tooManyRequests, unauthorized, unavailable } from "../platform/errors.js";
import { JsonRejectedError, parseStrictJson } from "../domain/strict-json.js";
import { RateLimiter, addressKey } from "../platform/rate-limit.js";
import { APP_VERSION } from "../platform/version.js";
import { listAudit } from "../services/audit.js";
import { authenticateSession, csrfFor, listMembers, login, logout, type Principal, requireRole, SESSION_COOKIE } from "../services/auth.js";
import { createCheck, disableCheck, listChecks } from "../services/checks.js";
import { redactIdentifier } from "../domain/redaction.js";
import { BundleError, exportRunBundle, serializeBundle } from "../services/evidence.js";
import { getImpactRun, listFindings, listImpactRuns, requestImpactRun } from "../services/impact.js";
import { listEvents } from "../services/outbox.js";
import { buildRunReport, renderRunReportHtml } from "../services/report.js";
import { getBaseline, getSnapshot, getSnapshotManifestChecked, importSnapshot, IntegrityError, listEdges, listNodes, listSnapshots } from "../services/snapshots.js";
import { registerAccessAudit } from "./access-audit.js";
import { createStaticHandler } from "./static.js";
import { enforceManifestBytes, headerOf, idParam, parseCookies, queryParam, requestHashOf } from "./http.js";
import { parseIdempotencyKey } from "../services/idempotency.js";

export interface AppOptions {
  /**
   * Directory with the built web UI (`dist/web`). When set, GET and HEAD requests outside `/api` that match no route
   * are answered from it with a single page app fallback (see `createStaticHandler`), and those requests skip the
   * readiness gate so the UI can load and show a "not ready" state instead of a bare 503.
   */
  webRoot?: string;
}

const ENVELOPE = (code: string, message: string, requestId: string, details?: unknown) => ({
  error: { code, message, request_id: requestId, ...(details === undefined ? {} : { details }) },
});

const HEALTH_PATHS = new Set(["/api/v1/health/live", "/api/v1/health/ready"]);
/** Receiving one request (headers and up to 25 MB of body) must finish within this time. */
const REQUEST_TIMEOUT_MS = 120_000;
/** Open connections the process accepts; further connections are refused by the operating system queue. */
const MAX_CONNECTIONS = 1024;
/** Exports and bundles one principal may request per rate-limit window, and how many may be built at the same moment. */
const EXPORTS_PER_WINDOW = 12;
const BUNDLES_PER_WINDOW = 4;
const MAX_CONCURRENT_EXPORTS = 2;

/** Requests per minute one address may send without a valid session before it is answered 429. */
const UNAUTHENTICATED_PER_ADDRESS = 300;

export async function buildApp(ctx: Ctx, options: AppOptions = {}): Promise<FastifyInstance> {
  const { settings } = ctx;
  const staticHandler = options.webRoot ? createStaticHandler(options.webRoot) : null;
  const app = Fastify({
    logger: false, // Only allowlisted diagnostics are emitted below; raw framework errors may contain secrets.
    bodyLimit: settings.smallBodyBytes,
    // A body that is trickled in must not hold a connection open for ever (requestTimeout covers header and body
    // receipt; the rest are the Node defaults made explicit so a change of runtime default cannot remove them).
    requestTimeout: REQUEST_TIMEOUT_MS,
    keepAliveTimeout: 5_000,
    genReqId: () => randomUUID(),
    // Never match routes case-insensitively or with trailing slashes: one URL, one route.
    routerOptions: { ignoreTrailingSlash: false, caseSensitive: true },
  });
  const routeTable: string[] = [];
  app.decorate("routeTable", routeTable);
  app.addHook("onRoute", (route) => {
    for (const method of [route.method].flat()) if (method !== "HEAD" && method !== "OPTIONS") routeTable.push(`${method} ${route.url}`);
  });
  const loginByAccount = new RateLimiter(settings.rateLimit.loginPerAccount, settings.rateLimit.windowMs);
  const loginByAddress = new RateLimiter(settings.rateLimit.loginPerAddress, settings.rateLimit.windowMs);
  const apiByPrincipal = new RateLimiter(settings.rateLimit.apiPerPrincipal, settings.rateLimit.windowMs);
  const unauthenticatedByAddress = new RateLimiter(UNAUTHENTICATED_PER_ADDRESS, settings.rateLimit.windowMs);
  app.server.maxConnections = MAX_CONNECTIONS;
  const bigBody = settings.maxManifestBytes + settings.bodyEnvelopeBytes;

  // JSON is the only accepted body type (anything else is a 400). Keep the exact raw body: idempotency
  // compares bytes, not re-serialized objects.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    const text = body as string;
    req.rawBody = text;
    if (text.length === 0) return done(null, undefined);
    try {
      // Duplicate keys, absurd nesting and container bombs are refused before the ordinary parse allocates anything.
      done(null, parseStrictJson(text));
    } catch (error) {
      if (error instanceof JsonRejectedError) return done(badRequest(error.code, error.message), undefined);
      done(badRequest("MALFORMED_JSON", "Body is not valid JSON"), undefined);
    }
  });

  const report = (req: FastifyRequest, event: string, level: "info" | "warn" | "error", code?: string, status?: number) =>
    ctx.diagnostics({
      event,
      level,
      request_id: String(req.id),
      operation: req.routeOptions?.url ?? "unmatched",
      method: req.method,
      ...(status !== undefined ? { status } : {}),
      ...(code ? { code } : {}),
    });

  app.setErrorHandler((error: Error & { statusCode?: number; code?: string }, req, reply) => {
    const requestId = String(req.id);
    if (error instanceof AppError) {
      if (error.status === 401 || error.status === 403 || error.status === 429) {
        const event = error.status === 429 ? "auth.throttled" : req.routeOptions?.url === "/api/v1/auth/login" ? "auth.login_failed" : "auth.denied";
        report(req, event, "warn", String(error.status));
      }
      return reply.status(error.status).headers(error.headers).send(ENVELOPE(error.code, error.message, requestId, error.details));
    }
    if (error instanceof DomainError) {
      return reply.status(error.status).send(ENVELOPE(error.code, error.message, requestId));
    }
    if (error instanceof BundleError) {
      // A stored run that no longer reproduces, or a bundle over the size limit: a specific, documented refusal, never a 500.
      report(req, "api.bundle_refused", "warn", error.code);
      return reply.status(error.code === "BUNDLE_TOO_LARGE" ? 413 : 409).send(ENVELOPE(error.code, error.message, requestId));
    }
    if (error instanceof IntegrityError) {
      report(req, "api.integrity_failure", "error", "INTEGRITY_FAILURE");
      return reply.status(500).send(ENVELOPE("INTEGRITY_FAILURE", "Stored data failed integrity verification", requestId));
    }
    if (error.code === "FST_ERR_CTP_BODY_TOO_LARGE" || error.statusCode === 413) {
      return reply.status(413).send(ENVELOPE("PAYLOAD_TOO_LARGE", "Payload exceeds the size limit", requestId));
    }
    if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
      return reply.status(400).send(ENVELOPE("BAD_REQUEST", "Request could not be processed", requestId));
    }
    if (isDataException(error)) {
      // A value the client sent was refused by the database itself (out of range, not a timestamp): the client's mistake.
      report(req, "api.bad_value", "warn", "INVALID_REQUEST", 400);
      const cursor = typeof (req.query as { cursor?: unknown } | undefined)?.cursor === "string";
      return reply.status(400).send(ENVELOPE(cursor ? "INVALID_CURSOR" : "INVALID_REQUEST", cursor ? "cursor is not valid" : "A value in the request is not valid", requestId));
    }
    if (isDatabaseUnavailable(error)) {
      // An outage after startup is a dependency failure, not a defect: 503 like the readiness endpoint, retryable.
      report(req, "api.database_unavailable", "error", "database_unavailable", 503);
      return reply.status(503).header("retry-after", "5").send(ENVELOPE("NOT_READY", "Service is not ready (database_unavailable)", requestId));
    }
    report(req, "api.unhandled_error", "error", "INTERNAL");
    return reply.status(500).send(ENVELOPE("INTERNAL", "Internal error", requestId));
  });

  app.setNotFoundHandler(async (req, reply) => {
    if (staticHandler && (await staticHandler(req, reply))) return reply;
    return reply.status(404).send(ENVELOPE("NOT_FOUND", "Not found", String(req.id)));
  });

  // Readiness gate: while migrations have not succeeded nothing but liveness answers.
  app.addHook("onRequest", async (req) => {
    req.startedAt = Date.now();
    const path = req.url.split("?")[0] as string;
    const isApi = path === "/api" || path.startsWith("/api/");
    if (!ctx.readiness.ok && !HEALTH_PATHS.has(path) && (isApi || !staticHandler)) throw unavailable("NOT_READY", `Service is not ready (${ctx.readiness.reason})`);
  });

  app.addHook("onResponse", async (req, reply) => {
    ctx.diagnostics({
      event: "http.response",
      level: "info",
      request_id: String(req.id),
      operation: req.routeOptions?.url ?? "unmatched",
      method: req.method,
      status: reply.statusCode,
      duration_ms: Date.now() - (req.startedAt ?? Date.now()),
    });
  });

  app.addHook("onSend", async (req, reply, payload) => {
    reply.header("x-request-id", String(req.id));
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    reply.header("x-frame-options", "DENY");
    reply.header("cache-control", "no-store");
    if (!reply.hasHeader("content-security-policy")) {
      reply.header("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
    }
    return payload;
  });

  /**
   * Runs in `onRequest`, BEFORE the body is read or parsed: an unauthenticated, forbidden or rate limited client
   * never makes the server buffer or parse up to 25 MB. Only headers are needed here.
   */
  const sessionAuth = async (req: FastifyRequest): Promise<void> => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const principal = await authenticateSession(ctx, token);
    if (!principal || !token) {
      const retry = unauthenticatedByAddress.take(ctx.box.mac("unauthenticated-ip", addressKey(req.ip)), ctx.clock.now().getTime());
      if (retry !== null) throw tooManyRequests(retry);
      throw unauthorized();
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      const csrf = headerOf(req, "x-csrf-token");
      if (!csrf || !safeEqual(csrf, csrfFor(ctx, token))) throw forbidden("Missing or invalid CSRF token", "CSRF_INVALID");
    }
    const retry = apiByPrincipal.take(ctx.box.mac("api-principal", principal.userId), ctx.clock.now().getTime());
    if (retry !== null) throw tooManyRequests(retry);
    req.principal = principal;
  };
  const who = (req: FastifyRequest): Principal => req.principal as Principal;
  registerAccessAudit(app, ctx, who);
  /**
   * Exports and evidence bundles are built synchronously in this process and can hold the event loop for a
   * long time on a large run. They get their own small per-principal budget and a cap on concurrent builds, so
   * one authenticated viewer cannot stall every other request by repeating them.
   */
  const exportsByPrincipal = new RateLimiter(EXPORTS_PER_WINDOW, settings.rateLimit.windowMs);
  // An evidence bundle also parses, hashes and re-derives itself before it is served (about 4 s of one thread at the
  // largest size), so it has a much smaller budget of its own than the reports.
  const bundlesByPrincipal = new RateLimiter(BUNDLES_PER_WINDOW, settings.rateLimit.windowMs);
  let exportsInFlight = 0;
  const heavyExport = async <T>(req: FastifyRequest, build: () => Promise<T>, budget = exportsByPrincipal): Promise<T> => {
    const retry = budget.take(ctx.box.mac(budget === exportsByPrincipal ? "export-principal" : "bundle-principal", who(req).userId), ctx.clock.now().getTime());
    if (retry !== null) throw tooManyRequests(retry);
    if (exportsInFlight >= MAX_CONCURRENT_EXPORTS) throw tooManyRequests(1);
    exportsInFlight += 1;
    try {
      return await build();
    } finally {
      exportsInFlight -= 1;
    }
  };
  const page = (req: FastifyRequest) => ({ limit: parseLimit(queryParam(req, "limit")), cursor: queryParam(req, "cursor") });
  const idemKey = (req: FastifyRequest) => parseIdempotencyKey(headerOf(req, "idempotency-key"));
  const replayHeader = (reply: FastifyReply, replayed: boolean) => {
    if (replayed) reply.header("idempotent-replayed", "true");
  };

  await app.register(
    async (api) => {
      api.get("/health/live", async () => ({ status: "ok", version: APP_VERSION }));
      api.get("/health/ready", async (req, reply) => {
        let reason: string | null = ctx.readiness.ok ? null : ctx.readiness.reason;
        if (reason === null) {
          try {
            await ctx.db.query("SELECT 1");
            if (!(await isSchemaCurrent(ctx.db))) reason = "migration_failed";
          } catch {
            reason = "database_unavailable";
          }
        }
        if (reason !== null) {
          report(req, "api.not_ready", "error", reason);
          throw unavailable("NOT_READY", `Service is not ready (${reason})`);
        }
        return { status: "ready", version: APP_VERSION };
      });

      api.post("/auth/login", async (req, reply) => {
        const body = (req.body ?? {}) as { email?: unknown; password?: unknown; workspace_id?: unknown };
        if (typeof body.email !== "string" || typeof body.password !== "string") throw badRequest("INVALID_REQUEST", "email and password are required");
        if (body.email.length > 320 || body.password.length > 4096) throw badRequest("INVALID_REQUEST", "Credentials exceed the size limit");
        const normalizedEmail = body.email.trim().toLowerCase();
        // Separate budgets stop account spelling or address changes from defeating throttling. Keyed MACs keep
        // raw emails and addresses out of the bounded bucket map.
        const now = ctx.clock.now().getTime();
        // The address budget is spent first and a throttled address never creates an account bucket, so a client
        // cannot fill the bucket table with random names. The account budget is per account AND address: someone
        // else guessing a known account's password from another address cannot lock the real user out.
        const addressRetry = loginByAddress.take(ctx.box.mac("login-ip", addressKey(req.ip)), now);
        if (addressRetry !== null) throw tooManyRequests(addressRetry);
        const accountRetry = loginByAccount.take(ctx.box.mac("login-account", `${normalizedEmail}\n${addressKey(req.ip)}`), now);
        if (accountRetry !== null) throw tooManyRequests(accountRetry);
        const result = await login(ctx, normalizedEmail, body.password, typeof body.workspace_id === "string" ? body.workspace_id : undefined);
        const cookie = [
          `${SESSION_COOKIE}=${result.token}`,
          "Path=/",
          "HttpOnly",
          "SameSite=Strict",
          `Max-Age=${settings.sessionTtlSeconds}`,
          settings.secureCookies ? "Secure" : "",
        ].filter(Boolean);
        reply.header("set-cookie", cookie.join("; "));
        report(req, "auth.login_succeeded", "info");
        return { user: publicPrincipal(result.principal), csrf_token: result.csrfToken };
      });

      api.register(async (authed) => {
        authed.addHook("onRequest", sessionAuth);
        // Role checks that decide a big body's fate also run before it is read (the services check again).
        const needs = (role: "operator" | "admin") => async (req: FastifyRequest) => requireRole(who(req), role);

        authed.get("/auth/session", async (req) => {
          const token = parseCookies(req.headers.cookie)[SESSION_COOKIE] as string;
          return { user: publicPrincipal(who(req)), csrf_token: csrfFor(ctx, token) };
        });
        authed.post("/auth/logout", async (req, reply) => {
          await logout(ctx, who(req));
          report(req, "auth.logout", "info");
          reply.header("set-cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
          return { ok: true };
        });

        authed.get("/members", async (req) => listMembers(ctx, who(req), page(req)));
        authed.get("/audit", async (req) => listAudit(ctx, who(req), page(req)));
        authed.get("/events", async (req) => listEvents(ctx, who(req), page(req)));
        authed.get("/settings", async (req) => {
          requireRole(who(req), "admin");
          return {
            limits: {
              max_manifest_bytes: settings.maxManifestBytes,
              max_nodes: settings.maxNodes,
              max_edges: settings.maxEdges,
              max_page_size: MAX_PAGE_SIZE,
              max_bundle_bytes: settings.maxBundleBytes,
              idempotency_retention_days: settings.idempotencyRetentionDays,
            },
            rate_limit: settings.rateLimit,
            checks: {
              allowed_hosts: settings.checks.allowedHosts,
              allow_private_network: settings.checks.allowPrivateNetwork,
              max_timeout_ms: settings.checks.maxTimeoutMs,
              max_body_bytes: settings.checks.maxBodyBytes,
              max_redirects: settings.checks.maxRedirects,
            },
            event_sink_configured: settings.eventSinkUrl !== null,
            retention: {
              ...settings.retention,
              enforced: false,
              note: "Proposed defaults. Nothing is deleted automatically; an operator must approve and run retention (see docs/OPERATIONS.md).",
            },
          };
        });

        // ---- snapshots ----
        authed.get("/baseline", async (req) => getBaseline(ctx, who(req)));
        authed.get("/snapshots", async (req) => listSnapshots(ctx, who(req), page(req)));
        authed.post("/snapshots", { bodyLimit: bigBody, onRequest: needs("operator") }, async (req, reply) => {
          enforceManifestBytes(req.body, "manifest", req, settings.maxManifestBytes);
          const out = await importSnapshot(ctx, who(req), { body: req.body, idempotencyKey: idemKey(req), requestHash: requestHashOf(req) });
          replayHeader(reply, out.replayed);
          return reply.status(out.status).header("location", `/api/v1/snapshots/${out.body.id}`).send(out.body);
        });
        authed.get("/snapshots/:id", async (req) => getSnapshot(ctx, who(req), idParam(req)));
        authed.get("/snapshots/:id/manifest", async (req, reply) => {
          const out = await getSnapshotManifestChecked(ctx, who(req), idParam(req));
          // A stored manifest that the current validator rejects is served redacted, and the header names the stored document's hash.
          if (out.redactedFrom !== null) reply.header("x-changeradar-manifest-redacted", out.redactedFrom);
          return out.manifest;
        });
        authed.get("/snapshots/:id/nodes", async (req) => listNodes(ctx, who(req), idParam(req), page(req)));
        authed.get("/snapshots/:id/edges", async (req) => listEdges(ctx, who(req), idParam(req), page(req)));

        // ---- impact runs ----
        authed.get("/impact-runs", async (req) =>
          listImpactRuns(ctx, who(req), { ...page(req), status: queryParam(req, "status"), snapshotId: queryParam(req, "snapshot_id") }),
        );
        authed.post("/impact-runs", { bodyLimit: bigBody, onRequest: needs("operator") }, async (req, reply) => {
          enforceManifestBytes(req.body, "proposed_manifest", req, settings.maxManifestBytes);
          const out = await requestImpactRun(ctx, who(req), { body: req.body, idempotencyKey: idemKey(req), requestHash: requestHashOf(req) });
          replayHeader(reply, out.replayed);
          return reply.status(out.status).header("location", `/api/v1/impact-runs/${out.body.id}`).send(out.body);
        });
        authed.get("/impact-runs/:id", async (req) => getImpactRun(ctx, who(req), idParam(req)));
        authed.get("/impact-runs/:id/findings", async (req) => listFindings(ctx, who(req), idParam(req), page(req)));
        authed.get("/impact-runs/:id/export", async (req, reply) => {
          const format = queryParam(req, "format") ?? "json";
          if (format !== "json" && format !== "html") throw badRequest("INVALID_FORMAT", "format must be json or html");
          const id = idParam(req);
          if (format === "json") return reply.type("application/json; charset=utf-8").send(await heavyExport(req, () => buildRunReport(ctx, who(req), id)));
          const { html } = await heavyExport(req, () => renderRunReportHtml(ctx, who(req), id));
          return reply
            .type("text/html; charset=utf-8")
            .header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'")
            .send(html);
        });
        authed.get("/impact-runs/:id/bundle", async (req, reply) => {
          const id = idParam(req);
          const bundle = await heavyExport(req, () => exportRunBundle(ctx, who(req), id), bundlesByPrincipal);
          return reply
            .type("application/json; charset=utf-8")
            .header("content-disposition", `attachment; filename="changeradar-run-${id}.json"`)
            // The recorded `verdict` of a run assessed by an older engine is history: the count is in a header as well as in the
            // body (`stale_runs`), so a script that only gates on the verdict field has something to look at (docs/API.md).
            .header("x-changeradar-stale-runs", String(bundle.stale_runs?.length ?? 0))
            .send(serializeBundle(bundle));
        });

        // ---- contract checks (read-only, admin configured) ----
        authed.get("/contract-checks", async (req) => listChecks(ctx, who(req), page(req)));
        authed.post("/contract-checks", { onRequest: needs("admin") }, async (req, reply) => {
          const out = await createCheck(ctx, who(req), { body: req.body, idempotencyKey: idemKey(req), requestHash: requestHashOf(req) });
          replayHeader(reply, out.replayed);
          return reply.status(out.status).send(out.body);
        });
        authed.post("/contract-checks/:id/disable", async (req) => disableCheck(ctx, who(req), idParam(req)));
      });
    },
    { prefix: "/api/v1" },
  );

  return app;
}

/** The signed-in user as the API shows it; the workspace name may come from a restored bundle, so it passes the redactor. */
const publicPrincipal = (p: Principal) => ({ id: p.userId, email: p.email, workspace_id: p.workspaceId, workspace_name: redactIdentifier(p.workspaceName), role: p.role });
