import type { Clock } from "../domain/clock.js";
import { DEFAULT_LIMITS, MAX_ASSESSMENT_BYTES, type AssessConfig } from "../domain/limits.js";
import type { Database } from "../db/index.js";
import type { ReportRenderer } from "../services/report.js";
import type { HostResolver } from "../workers/ssrf.js";
import type { SecretBox } from "./crypto.js";
import type { DiagnosticSink } from "./diagnostics.js";

export interface RateLimitSettings {
  loginPerAccount: number;
  loginPerAddress: number;
  /** Authenticated API requests per principal per window. */
  apiPerPrincipal: number;
  windowMs: number;
}

export interface CheckSettings {
  /** Operator-managed egress allowlist: `host` or `host:port` (default ports 80/443), `*.suffix` wildcards. */
  allowedHosts: string[];
  /** TEST ONLY. Permits loopback/private destinations that are still on the allowlist. Never enable in production. */
  allowPrivateNetwork: boolean;
  maxBodyBytes: number;
  maxTimeoutMs: number;
  maxRedirects: number;
  maxChecksPerRun: number;
  /** Base delay for exponential backoff between read-only retries. */
  backoffBaseMs: number;
  /**
   * Wall clock budget for all the checks of one run. Checks run one after another (50 checks x 4 attempts x 30 s
   * would otherwise hold the worker for hours); once the budget is used up every check not yet started is recorded
   * TIMED_OUT ("not run"), which is an unknown and forces INCOMPLETE.
   */
  runBudgetMs: number;
}

export interface RetentionSettings {
  /** Proposed defaults from PRD section 6. They are reported, never silently enforced. */
  evidenceDays: number;
  deletionHours: number;
  backupExpiryDays: number;
}

export interface Settings {
  sessionTtlSeconds: number;
  jobLeaseSeconds: number;
  jobMaxAttempts: number;
  secureCookies: boolean;
  maxManifestBytes: number;
  maxNodes: number;
  maxEdges: number;
  /** Extra bytes allowed on top of the manifest limit for the JSON request envelope. */
  bodyEnvelopeBytes: number;
  smallBodyBytes: number;
  maxBundleBytes: number;
  idempotencyRetentionDays: number;
  rateLimit: RateLimitSettings;
  checks: CheckSettings;
  eventSinkUrl: string | null;
  retention: RetentionSettings;
  /** Overrides of the assessment output bounds (tests and operators; the defaults protect the service). */
  assess: Partial<AssessConfig>;
  /** A run whose serialized assessment exceeds this fails visibly (OUTPUT_TOO_LARGE) instead of being persisted. */
  maxAssessmentBytes: number;
}

export const MIN_IDEMPOTENCY_RETENTION_DAYS = 7;

export const defaultSettings: Settings = {
  sessionTtlSeconds: 12 * 3600,
  jobLeaseSeconds: 60,
  jobMaxAttempts: 3,
  secureCookies: true,
  maxManifestBytes: DEFAULT_LIMITS.max_manifest_bytes,
  maxNodes: DEFAULT_LIMITS.max_nodes,
  maxEdges: DEFAULT_LIMITS.max_edges,
  bodyEnvelopeBytes: 64 * 1024,
  smallBodyBytes: 64 * 1024,
  // What the reference profile (2 CPUs, 4 GB) can verify and restore: about 40 times the bundle size is needed in memory
  // for ordinary text (measured: a 44.5 MB bundle restored at 1.63 GB) and up to about 130 times for a bundle of numbers or
  // one-key objects, so 64 MiB is the most it can hold for ordinary text. Raise it only with the memory.
  maxBundleBytes: 64 * 1024 * 1024,
  idempotencyRetentionDays: MIN_IDEMPOTENCY_RETENTION_DAYS,
  rateLimit: { loginPerAccount: 10, loginPerAddress: 100, apiPerPrincipal: 1200, windowMs: 60_000 },
  checks: {
    allowedHosts: [],
    allowPrivateNetwork: false,
    maxBodyBytes: 1024 * 1024,
    maxTimeoutMs: 30_000,
    maxRedirects: 3,
    maxChecksPerRun: 50,
    backoffBaseMs: 200,
    runBudgetMs: 10 * 60_000,
  },
  eventSinkUrl: null,
  retention: { evidenceDays: 90, deletionHours: 24, backupExpiryDays: 30 },
  assess: {},
  maxAssessmentBytes: MAX_ASSESSMENT_BYTES,
};

/** Readiness gate. When `ok` is false the server answers 503 to everything except liveness. */
export interface Readiness {
  ok: boolean;
  reason: "ready" | "migration_failed" | "database_unavailable" | "starting";
}

export interface Ctx {
  db: Database;
  clock: Clock;
  box: SecretBox;
  settings: Settings;
  readiness: Readiness;
  diagnostics: DiagnosticSink;
  /** HTML report renderer (stage C provides the template). A safe built-in renderer is the default. */
  reportRenderer?: ReportRenderer;
  /** DNS resolver override for tests; production uses the operating system resolver. */
  resolver?: HostResolver;
}

export const addSeconds = (date: Date, seconds: number) => new Date(date.getTime() + seconds * 1000);
export const addMs = (date: Date, ms: number) => new Date(date.getTime() + ms);
