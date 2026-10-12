import { DomainError } from "../domain/errors.js";
import { redactSecrets } from "../domain/redaction.js";

/**
 * API error carrying the PRD envelope `{error:{code,message,request_id}}`. `details` is an optional
 * structured addition (for example manifest issues) that never carries submitted values or secrets.
 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const badRequest = (code: string, message: string) => new AppError(400, code, message);
export const unauthorized = (code = "UNAUTHENTICATED", message = "Authentication required") => new AppError(401, code, message);
export const forbidden = (message = "This action is not permitted for your role", code = "FORBIDDEN") => new AppError(403, code, message);
/** Foreign and missing objects look identical so existence never leaks across workspaces. */
export const notFound = () => new AppError(404, "NOT_FOUND", "Not found");
export const conflict = (code: string, message: string, details?: unknown) => new AppError(409, code, message, {}, details);
export const tooLarge = (message = "Payload exceeds the size limit", code = "PAYLOAD_TOO_LARGE") => new AppError(413, code, message);
export const unprocessable = (code: string, message: string, details?: unknown) => new AppError(422, code, message, {}, details);
export const tooManyRequests = (retryAfterSeconds: number) =>
  new AppError(429, "RATE_LIMITED", "Too many requests", { "retry-after": String(retryAfterSeconds) });
/** 503 is retryable, so it always carries Retry-After (the readiness gate and the mid-request outage path agree). */
export const unavailable = (code = "NOT_READY", message = "Service is not ready") => new AppError(503, code, message, { "retry-after": "5" });

/**
 * 422 `details.issues` for a request body: a JSON pointer and a fixed message per kind of problem. zod's own
 * messages can quote submitted text (`Unrecognized key: "<whatever the client typed>"`), and API.md promises that
 * error details never contain submitted values.
 */
export function requestIssues(issues: readonly { code: string; path: readonly PropertyKey[]; message: string }[]): { path: string; message: string }[] {
  return issues.slice(0, 100).map((issue) => ({
    path: "/" + issue.path.map((segment) => redactSecrets(String(segment)).replaceAll("~", "~0").replaceAll("/", "~1")).join("/"),
    message: FIXED_ISSUE_MESSAGE[issue.code] ?? (issue.code === "custom" ? issue.message : "value is not valid"),
  }));
}
const FIXED_ISSUE_MESSAGE: Record<string, string> = {
  unrecognized_keys: "unrecognized properties are not allowed",
  invalid_type: "value has the wrong type",
  invalid_value: "value is not one of the allowed values",
  too_big: "value or length is out of range",
  too_small: "value or length is out of range",
  invalid_format: "value has an invalid format",
};

const CONNECTION_ERROR_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "ECONNABORTED", "53300", "57P01", "57P02", "57P03"]);
const CONNECTION_ERROR_TEXT = /connection terminated|not queryable|pool after calling end|connection error|connect ECONN|PGlite is closed|database is closed|client was closed|timeout exceeded when trying to connect/i;

/**
 * Is `error` a database that cannot be reached (server down or restarting, connection dropped, pool or embedded
 * engine closed) rather than a bug or a bad query? The API answers those with 503 (PRD: dependency unavailable),
 * never 500, so an operator and a client can tell an outage from a defect.
 */
export function isDatabaseUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error instanceof AggregateError && error.errors.some(isDatabaseUnavailable)) return true;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && (CONNECTION_ERROR_CODES.has(code) || code.startsWith("08"))) return true;
  return CONNECTION_ERROR_TEXT.test(error.message);
}

/**
 * Is `error` a PostgreSQL data exception (SQLSTATE class 22: a value out of range for its column, an invalid timestamp or
 * uuid text)? A value a client sent that reached the database is the client's mistake: a 400, never a 500.
 */
export function isDataException(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^22[0-9A-Z]{3}$/.test(code);
}

/** Maps a typed domain error (409/422 from the frozen domain layer) onto the API envelope. */
export function fromDomainError(error: DomainError): AppError {
  return new AppError(error.status, error.code, error.message);
}
