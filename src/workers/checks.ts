import type { CheckOutcome, CheckRunContext, ContractCheckDefinition, ContractCheckRunner } from "../domain/contract-checks.js";
import type { FieldType } from "../domain/types.js";
import { type FetchError, safeFetch } from "./safe-fetch.js";
import type { EgressPolicy, HostResolver } from "./ssrf.js";

/** The HTTP part of an admin-configured check (the domain's ContractCheckDefinition carries the timing). */
export interface HttpCheckSpec {
  key: string;
  node_id: string;
  url: string;
  method: "GET" | "HEAD";
  expect_status: number;
  /** Top-level JSON fields the live response must carry. Requires GET. */
  required_fields: readonly { name: string; type: FieldType }[];
  credential_alias: string | null;
  timeout_ms: number;
  /** Read-only retries after the first attempt (0 to 3). */
  retries: number;
}

export interface CheckRunnerDeps {
  policy: EgressPolicy;
  resolver?: HostResolver | undefined;
  maxBodyBytes: number;
  maxRedirects: number;
  backoffBaseMs: number;
  /** Resolves a credential alias to its value (decrypted). null when the alias has no stored value. */
  loadCredential(alias: string): Promise<string | null>;
}

export function definitionFor(spec: HttpCheckSpec, backoffBaseMs: number): ContractCheckDefinition {
  return {
    id: spec.key,
    node_id: spec.node_id,
    description: `${spec.method} live contract check for ${spec.node_id}`,
    timeout_ms: spec.timeout_ms,
    max_attempts: spec.retries + 1,
    backoff_base_ms: backoffBaseMs,
  };
}

function jsonTypeMatches(value: unknown, type: FieldType): boolean {
  switch (type) {
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
  }
}

/**
 * Read-only HTTP contract check. It reports PASSED only when the endpoint answered with the expected
 * status AND (when required_fields are configured) a JSON object carrying every field with the right
 * type. A wrong answer is FAILED. A transport problem or a policy refusal is thrown, which the domain
 * wrapper records as ERROR (or TIMED_OUT); neither can turn into a pass. Details name fields and codes,
 * never response values.
 */
export function httpCheckRunner(spec: HttpCheckSpec, deps: CheckRunnerDeps): ContractCheckRunner {
  return {
    read_only: true,
    async run(_definition: ContractCheckDefinition, context: CheckRunContext): Promise<CheckOutcome> {
      let authorization: string | undefined;
      if (spec.credential_alias !== null) {
        const secret = await deps.loadCredential(spec.credential_alias);
        if (secret === null) throw new Error("credential alias has no stored value");
        authorization = `Bearer ${secret}`;
      }
      let response;
      try {
        response = await safeFetch(spec.url, {
          method: spec.method,
          policy: deps.policy,
          resolver: deps.resolver,
          // The domain wrapper owns the deadline (and aborts through `signal`); this longer limit is only a
          // backstop so the wrapper, not this client, is what reports TIMED_OUT.
          timeoutMs: spec.timeout_ms + 1000,
          signal: context.signal,
          maxBodyBytes: deps.maxBodyBytes,
          maxRedirects: deps.maxRedirects,
          authorization,
        });
      } catch (error) {
        const e = error as FetchError;
        throw new Error(e.name === "EgressDeniedError" || e.name === "FetchError" ? `${e.name}: ${e.message}` : "request failed");
      }
      if (response.status !== spec.expect_status) {
        return { state: "FAILED", detail: `expected HTTP ${spec.expect_status}, got ${response.status}` };
      }
      if (spec.required_fields.length === 0) return { state: "PASSED", detail: `HTTP ${response.status} as expected` };
      let parsed: unknown;
      try {
        parsed = JSON.parse(response.body.toString("utf8"));
      } catch {
        return { state: "FAILED", detail: "response body is not valid JSON" };
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return { state: "FAILED", detail: "response body is not a JSON object" };
      }
      const record = parsed as Record<string, unknown>;
      const missing = spec.required_fields.filter((f) => !Object.hasOwn(record, f.name)).map((f) => f.name);
      const wrongType = spec.required_fields.filter((f) => Object.hasOwn(record, f.name) && !jsonTypeMatches(record[f.name], f.type)).map((f) => f.name);
      if (missing.length > 0 || wrongType.length > 0) {
        const parts = [];
        if (missing.length > 0) parts.push(`missing fields: ${missing.join(", ")}`);
        if (wrongType.length > 0) parts.push(`wrong type: ${wrongType.join(", ")}`);
        return { state: "FAILED", detail: parts.join("; ") };
      }
      return { state: "PASSED", detail: `HTTP ${response.status} with ${spec.required_fields.length} required field(s)` };
    },
  };
}
