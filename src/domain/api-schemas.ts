import { z } from "zod";
import { ManifestSchema } from "./manifest.js";

/**
 * Request body schemas of the write endpoints, generated from the same zod validators the server runs, so the
 * shipped JSON Schema (schemas/api-requests.json) cannot drift from behaviour (a test compares them).
 */

/** POST /api/v1/snapshots */
export const SnapshotRequestSchema = z.strictObject({
  schema_version: z.literal(1),
  revision: z.string().min(1).max(200),
  manifest: ManifestSchema,
});

export function buildRequestJsonSchemas(parts: {
  impactRun: z.ZodType;
  contractCheck: z.ZodType;
  limits: { max_nodes: number; max_edges: number };
}): Record<string, unknown> {
  const one = (schema: z.ZodType): Record<string, unknown> => {
    const generated = z.toJSONSchema(schema, { target: "draft-2020-12", io: "input", unrepresentable: "any" }) as Record<string, unknown>;
    const { $schema: _drop, ...rest } = generated;
    return rest;
  };
  const snapshot = one(SnapshotRequestSchema) as { properties: { manifest: { properties: Record<string, Record<string, unknown>> } } };
  const manifestProps = snapshot.properties.manifest.properties;
  manifestProps.nodes = { ...manifestProps.nodes, maxItems: parts.limits.max_nodes };
  manifestProps.edges = { ...manifestProps.edges, maxItems: parts.limits.max_edges };
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "api-requests.json",
    title: "ChangeRadar API request bodies",
    description:
      "Request bodies of POST /api/v1/snapshots, POST /api/v1/impact-runs and POST /api/v1/contract-checks, generated from the server's validators. Response bodies are in the companion file api-responses.json. Rules that need the whole document (unique node ids, dangling edges, secret-looking values) are enforced at runtime and listed in docs/MANIFEST.md.",
    $defs: {
      snapshot_request: snapshot,
      impact_run_request: one(parts.impactRun),
      contract_check_request: one(parts.contractCheck),
    },
  };
}
