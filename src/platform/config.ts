import { systemClock } from "../domain/clock.js";
import { openDatabase } from "../db/index.js";
import { SecretBox } from "./crypto.js";
import { type Ctx, defaultSettings, MIN_IDEMPOTENCY_RETENTION_DAYS, type Settings } from "./context.js";
import { htmlReportRenderer } from "../report/html-report.js";
import { diagnosticsFor } from "./diagnostics.js";

export interface ServerConfig {
  databaseUrl: string;
  encryptionKey: string;
  host: string;
  port: number;
  settings: Settings;
  logRequests: boolean;
  /** Directory with the built web UI. Null means "look for dist/web next to the compiled server" (see the serve command). */
  webRoot: string | null;
}

function integerFrom(env: NodeJS.ProcessEnv, key: string, fallback: number, minimum: number, maximum: number): number {
  const raw = env[key];
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${key} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

const truthy = (raw: string | undefined): boolean => raw === "1" || raw === "true";

/** Read configuration from the environment. Missing required values stop startup with a diagnostic. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const missing = ["CHANGERADAR_DATABASE_URL", "CHANGERADAR_ENCRYPTION_KEY"].filter((k) => !env[k]);
  if (missing.length > 0) throw new Error(`missing required configuration: ${missing.join(", ")} (see .env.example)`);
  const publicUrl = env.CHANGERADAR_PUBLIC_URL ?? "";
  if (publicUrl && !["http:", "https:"].includes(new URL(publicUrl).protocol)) {
    throw new Error("CHANGERADAR_PUBLIC_URL must use http or https");
  }
  let databaseUrl = env.CHANGERADAR_DATABASE_URL as string;
  // Compose supplies the literal password separately; URL handles delimiter encoding.
  if (env.CHANGERADAR_DATABASE_PASSWORD !== undefined) {
    const url = new URL(databaseUrl);
    if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error("CHANGERADAR_DATABASE_PASSWORD requires PostgreSQL");
    url.password = encodeURIComponent(env.CHANGERADAR_DATABASE_PASSWORD);
    databaseUrl = url.toString();
  }
  const host = env.CHANGERADAR_HOST ?? "127.0.0.1";
  if (!host.trim()) throw new Error("CHANGERADAR_HOST must not be empty");

  const allowedHosts = (env.CHANGERADAR_CHECK_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  const sink = env.CHANGERADAR_EVENT_SINK_URL?.trim() || null;
  if (sink && !["http:", "https:"].includes(new URL(sink).protocol)) throw new Error("CHANGERADAR_EVENT_SINK_URL must use http or https");

  const settings: Settings = {
    ...defaultSettings,
    // Secure cookies unless the operator explicitly serves plain http (local demo).
    secureCookies: !publicUrl.startsWith("http://"),
    sessionTtlSeconds: integerFrom(env, "CHANGERADAR_SESSION_TTL_SECONDS", defaultSettings.sessionTtlSeconds, 60, 30 * 86400),
    jobLeaseSeconds: integerFrom(env, "CHANGERADAR_JOB_LEASE_SECONDS", defaultSettings.jobLeaseSeconds, 5, 3600),
    maxManifestBytes: integerFrom(env, "CHANGERADAR_MAX_MANIFEST_BYTES", defaultSettings.maxManifestBytes, 1024, 25 * 1024 * 1024),
    maxNodes: integerFrom(env, "CHANGERADAR_MAX_NODES", defaultSettings.maxNodes, 1, defaultSettings.maxNodes),
    maxEdges: integerFrom(env, "CHANGERADAR_MAX_EDGES", defaultSettings.maxEdges, 1, defaultSettings.maxEdges),
    maxBundleBytes: integerFrom(env, "CHANGERADAR_MAX_BUNDLE_BYTES", defaultSettings.maxBundleBytes, 1024, 4 * 1024 * 1024 * 1024),
    idempotencyRetentionDays: integerFrom(env, "CHANGERADAR_IDEMPOTENCY_RETENTION_DAYS", MIN_IDEMPOTENCY_RETENTION_DAYS, MIN_IDEMPOTENCY_RETENTION_DAYS, 365),
    rateLimit: {
      ...defaultSettings.rateLimit,
      apiPerPrincipal: integerFrom(env, "CHANGERADAR_RATE_LIMIT_PER_MINUTE", defaultSettings.rateLimit.apiPerPrincipal, 1, 1_000_000),
    },
    checks: {
      ...defaultSettings.checks,
      allowedHosts,
      allowPrivateNetwork: truthy(env.CHANGERADAR_CHECK_ALLOW_PRIVATE_NETWORK),
      maxBodyBytes: integerFrom(env, "CHANGERADAR_CHECK_MAX_BODY_BYTES", defaultSettings.checks.maxBodyBytes, 1024, 16 * 1024 * 1024),
      maxTimeoutMs: integerFrom(env, "CHANGERADAR_CHECK_MAX_TIMEOUT_MS", defaultSettings.checks.maxTimeoutMs, 100, 120_000),
    },
    eventSinkUrl: sink,
    retention: {
      evidenceDays: integerFrom(env, "CHANGERADAR_RETENTION_EVIDENCE_DAYS", defaultSettings.retention.evidenceDays, 1, 3650),
      deletionHours: integerFrom(env, "CHANGERADAR_RETENTION_DELETION_HOURS", defaultSettings.retention.deletionHours, 1, 24 * 90),
      backupExpiryDays: integerFrom(env, "CHANGERADAR_RETENTION_BACKUP_DAYS", defaultSettings.retention.backupExpiryDays, 1, 3650),
    },
  };
  return {
    databaseUrl,
    encryptionKey: env.CHANGERADAR_ENCRYPTION_KEY as string,
    host,
    port: integerFrom(env, "CHANGERADAR_PORT", 8797, 1, 65535),
    settings,
    logRequests: truthy(env.CHANGERADAR_LOG),
    webRoot: env.CHANGERADAR_WEB_ROOT?.trim() || null,
  };
}

export async function contextFromConfig(config: ServerConfig): Promise<Ctx> {
  const box = SecretBox.fromBase64(config.encryptionKey);
  const db = await openDatabase(config.databaseUrl);
  return {
    db,
    box,
    clock: systemClock,
    settings: config.settings,
    readiness: { ok: false, reason: "starting" },
    diagnostics: diagnosticsFor(config.logRequests),
    // The static, self-contained HTML report (AC-07, AC-09). The service falls back to a minimal built-in one if unset.
    reportRenderer: htmlReportRenderer,
  };
}
