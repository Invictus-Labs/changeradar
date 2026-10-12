import type { FastifyRequest } from "fastify";
import { badRequest, notFound, tooLarge } from "../platform/errors.js";
import { isUuid } from "../platform/ids.js";
import { sha256Hex } from "../platform/crypto.js";
import type { Principal } from "../services/auth.js";

declare module "fastify" {
  interface FastifyInstance {
    /** Every registered route as "METHOD /path" (HEAD variants excluded). Used by tests to prove each one is authorization tested. */
    routeTable: string[];
  }
  interface FastifyRequest {
    rawBody?: string;
    principal?: Principal;
    startedAt?: number;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0) {
      try {
        out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
      } catch {
        throw badRequest("INVALID_COOKIE", "Malformed cookie encoding");
      }
    }
  }
  return out;
}

export const headerOf = (req: FastifyRequest, name: string): string | undefined => {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

/** A path parameter that must be a UUID. A malformed id looks exactly like a missing one. */
export function idParam(req: FastifyRequest, name = "id"): string {
  const value = (req.params as Record<string, string>)[name];
  if (!isUuid(value)) throw notFound();
  return value as string;
}

/** A single-valued query parameter. Repeated parameters are rejected instead of guessed at. */
export function queryParam(req: FastifyRequest, name: string): string | undefined {
  const value = (req.query as Record<string, unknown>)[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw badRequest("INVALID_QUERY", `query parameter ${name} must appear once`);
  return value;
}

/** Hash of the exact request bytes, used to compare an Idempotency-Key replay with the original. */
export const requestHashOf = (req: FastifyRequest, extra = ""): string => sha256Hex(`${extra}\n${req.rawBody ?? ""}`);

/**
 * The body limit already caps the whole request. This exact check makes the 25 MB manifest limit precise for
 * bodies that land near it, without re-serializing ordinary requests.
 */
export function enforceManifestBytes(body: unknown, key: string, req: FastifyRequest, limit: number): void {
  if ((req.rawBody?.length ?? 0) < limit - 4096) return;
  const value = typeof body === "object" && body !== null ? (body as Record<string, unknown>)[key] : undefined;
  if (value !== undefined && Buffer.byteLength(JSON.stringify(value), "utf8") > limit) {
    throw tooLarge(`manifest exceeds the ${limit} byte limit`);
  }
}
