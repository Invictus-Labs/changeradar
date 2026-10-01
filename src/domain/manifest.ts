import { z } from "zod";
import { FIELD_TYPES, NODE_KINDS, RELATIONS } from "./types.js";

/**
 * Explicit versioned dependency manifest (schema_version 1).
 *
 * MVP contract scope: a limited required-field/type subset per contract node. This is NOT
 * arbitrary JSON Schema or OpenAPI compatibility checking (docs/MANIFEST.md, docs/DOMAIN.md).
 * Objects are strict: unknown properties are rejected so typos never silently drop data.
 */

const NO_CONTROL_CHARACTERS = /^[^\u0000-\u001f\u007f]*$/;
const NODE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,254}$/;
const FIELD_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.[\]-]{0,127}$/;
const UTC_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?Z$/;

function text(max: number) {
  return z.string().min(1).max(max).regex(NO_CONTROL_CHARACTERS, "control characters are not allowed");
}

/** True when `value` is a real UTC instant written as ISO 8601 with a trailing Z. */
export function isUtcTimestamp(value: string): boolean {
  const m = UTC_TIMESTAMP.exec(value);
  if (!m) return false;
  const [, y, mo, d, h, mi, s] = m;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return false;
  const back = new Date(ms);
  // Reject calendar overflow such as 2026-02-31 that Date.parse would silently accept in some engines.
  return (
    back.getUTCFullYear() === Number(y) &&
    back.getUTCMonth() + 1 === Number(mo) &&
    back.getUTCDate() === Number(d) &&
    back.getUTCHours() === Number(h) &&
    back.getUTCMinutes() === Number(mi) &&
    back.getUTCSeconds() === Number(s)
  );
}

const utcTimestamp = z
  .string()
  .max(32)
  .regex(UTC_TIMESTAMP, "timestamp must be ISO 8601 UTC with a trailing Z")
  .refine(isUtcTimestamp, "timestamp is not a real UTC instant");

const nodeId = z.string().regex(NODE_ID, "id must match the node id pattern");
const fieldName = z.string().regex(FIELD_NAME, "field name must match the field name pattern");

export const ContractFieldSchema = z.strictObject({
  name: fieldName,
  type: z.enum(FIELD_TYPES),
  required: z.boolean(),
});

export const ContractSchema = z.strictObject({
  fields: z.array(ContractFieldSchema).max(1000),
});

export const NodeSchema = z.strictObject({
  id: nodeId,
  kind: z.enum(NODE_KINDS),
  owner: text(256).nullable().optional(),
  version: text(128),
  placeholder: z.boolean().optional(),
  contract: ContractSchema.optional(),
});

export const EdgeSchema = z.strictObject({
  source_id: nodeId,
  target_id: nodeId,
  relation: z.enum(RELATIONS),
  source_file: text(1024),
  source_line: z.int().min(1).max(10_000_000),
  verified_at: utcTimestamp.nullable().optional(),
  fields: z.array(fieldName).max(1000).optional(),
});

export const ProvenanceSchema = z.strictObject({
  source: text(256),
  generator: text(256).optional(),
  generated_at: utcTimestamp.optional(),
});

export const ManifestSchema = z.strictObject({
  schema_version: z.literal(1),
  revision: text(128),
  provenance: ProvenanceSchema,
  nodes: z.array(NodeSchema),
  edges: z.array(EdgeSchema),
});

export type Manifest = z.infer<typeof ManifestSchema>;
export type ManifestNode = z.infer<typeof NodeSchema>;
export type ManifestEdge = z.infer<typeof EdgeSchema>;

export const SUPPORTED_SCHEMA_VERSION = 1;

/**
 * JSON Schema (draft 2020-12) for the manifest, generated from the runtime zod schema so the two
 * cannot drift (a test compares the committed schemas/dependencies.json with this output).
 *
 * The JSON Schema checks structure only. Rules that need the whole document (unique node ids,
 * dangling edges, duplicate edges, secret-looking values, real calendar dates) are enforced by the
 * runtime validator in src/services/graph.ts and are listed in `description`.
 */
export function buildManifestJsonSchema(limits: { max_nodes: number; max_edges: number }): Record<string, unknown> {
  const generated = z.toJSONSchema(ManifestSchema, {
    target: "draft-2020-12",
    io: "input",
    unrepresentable: "any",
  }) as { properties: Record<string, Record<string, unknown>> } & Record<string, unknown>;

  const properties = generated.properties;
  properties.schema_version = { type: "integer", const: SUPPORTED_SCHEMA_VERSION };
  properties.nodes = { ...properties.nodes, maxItems: limits.max_nodes };
  properties.edges = { ...properties.edges, maxItems: limits.max_edges };
  const edgeItems = properties.edges.items as { properties: Record<string, Record<string, unknown>> };
  edgeItems.properties.source_line = { ...edgeItems.properties.source_line, type: "integer" };

  const { $schema, ...rest } = generated;
  return {
    $schema,
    $id: "dependencies.json",
    title: "ChangeRadar dependency manifest",
    description:
      "Explicit versioned dependency manifest, schema_version 1. Contracts describe a limited required-field/type subset, not arbitrary schema compatibility. Also enforced at runtime and not expressible here: unique node ids, no dangling or duplicate edges, fields only on contract nodes/edges targeting contracts, real UTC calendar dates, no secret-looking values (credential aliases only).",
    ...rest,
  };
}
