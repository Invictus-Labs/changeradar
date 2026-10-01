import { z } from "zod";
import { compareStrings, hashCanonical, stableId } from "../domain/canonical.js";
import { ERROR_STATUS, type ManifestErrorCode } from "../domain/errors.js";
import { DEFAULT_LIMITS, type ManifestLimits } from "../domain/limits.js";
import { EdgeSchema, ManifestSchema, NodeSchema, SUPPORTED_SCHEMA_VERSION, type Manifest } from "../domain/manifest.js";
import { detectSecretKinds, redactSecrets } from "../domain/redaction.js";
import { JsonRejectedError, parseStrictJson } from "../domain/strict-json.js";
import {
  edgeKeyString,
  type ContractField,
  type Cycle,
  type EdgeKey,
  type GraphEdge,
  type GraphNode,
  type ImpactLink,
  type Provenance,
} from "../domain/types.js";

/** One reason a manifest was rejected. Messages never echo submitted values. */
export interface ManifestIssue {
  readonly code: ManifestErrorCode;
  /** RFC 6901 JSON pointer to the offending location ("" for the whole document). */
  readonly path: string;
  readonly message: string;
}

export interface ManifestFailure {
  /** Primary code (highest precedence issue). */
  readonly code: ManifestErrorCode;
  /** HTTP status the API layer maps the primary code to. */
  readonly status: number;
  readonly message: string;
  /** Sorted by precedence then path, capped at limits.max_issues. */
  readonly issues: readonly ManifestIssue[];
  /** Number of issues found before capping. */
  readonly total_issues: number;
}

/** Aggregated non-fatal observation about an accepted manifest. */
export interface GraphWarning {
  readonly code: "CYCLE_DETECTED" | "MISSING_OWNER" | "PLACEHOLDER_NODE" | "UNVERIFIED_EDGE" | "EDGE_FIELD_NOT_IN_CONTRACT" | "EMPTY_FIELD_DECLARATION";
  readonly message: string;
  readonly count: number;
  /** Up to 20 sorted sample ids (node ids, or edge keys for edge warnings). */
  readonly sample_ids: readonly string[];
}

export type GraphBuildResult =
  | { readonly ok: true; readonly graph: DependencyGraph; readonly warnings: readonly GraphWarning[] }
  | { readonly ok: false; readonly failure: ManifestFailure };

export type ParseResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly failure: ManifestFailure };

export interface BuildOptions {
  readonly limits?: Partial<ManifestLimits>;
}

/** Immutable, indexed dependency graph with a deterministic content hash. */
export class DependencyGraph {
  readonly schema_version = SUPPORTED_SCHEMA_VERSION;
  readonly revision: string;
  readonly provenance: Provenance;
  /** sha256 over the canonical encoding of nodes and edges only (revision and provenance excluded). */
  readonly hash: string;
  /** sha256 over the canonical encoding of the whole normalized manifest, including revision and provenance. */
  readonly manifest_hash: string;
  /** Nodes sorted by id. */
  readonly nodes: readonly GraphNode[];
  /** Edges sorted by (source_id, target_id, relation). */
  readonly edges: readonly GraphEdge[];
  /** Dependency cycles, sorted by first member. Never traversed recursively. */
  readonly cycles: readonly Cycle[];

  readonly #nodeIndex: ReadonlyMap<string, GraphNode>;
  readonly #edgeIndex: ReadonlyMap<string, GraphEdge>;
  readonly #dependents: ReadonlyMap<string, readonly ImpactLink[]>;
  readonly #cycleIndex: ReadonlyMap<string, Cycle>;

  constructor(parts: {
    revision: string;
    provenance: Provenance;
    hash: string;
    manifest_hash: string;
    nodes: readonly GraphNode[];
    edges: readonly GraphEdge[];
    cycles: readonly Cycle[];
    dependents: ReadonlyMap<string, readonly ImpactLink[]>;
  }) {
    this.revision = parts.revision;
    this.provenance = parts.provenance;
    this.hash = parts.hash;
    this.manifest_hash = parts.manifest_hash;
    this.nodes = parts.nodes;
    this.edges = parts.edges;
    this.cycles = parts.cycles;
    this.#nodeIndex = new Map(parts.nodes.map((n) => [n.id, n]));
    this.#edgeIndex = new Map(parts.edges.map((e) => [edgeKeyString(e), e]));
    this.#dependents = parts.dependents;
    const cycleIndex = new Map<string, Cycle>();
    for (const cycle of parts.cycles) {
      for (const member of cycle.members) cycleIndex.set(member, cycle);
    }
    this.#cycleIndex = cycleIndex;
  }

  getNode(id: string): GraphNode | undefined {
    return this.#nodeIndex.get(id);
  }

  hasNode(id: string): boolean {
    return this.#nodeIndex.has(id);
  }

  getEdge(key: EdgeKey): GraphEdge | undefined {
    return this.#edgeIndex.get(edgeKeyString(key));
  }

  /** Nodes that depend on `id`, i.e. the next impact step when `id` changes. Sorted deterministically. */
  dependentsOf(id: string): readonly ImpactLink[] {
    return this.#dependents.get(id) ?? EMPTY_LINKS;
  }

  /** The cycle `id` belongs to, if any. */
  cycleOf(id: string): Cycle | undefined {
    return this.#cycleIndex.get(id);
  }
}

const EMPTY_LINKS: readonly ImpactLink[] = Object.freeze([]);

const PRECEDENCE: readonly ManifestErrorCode[] = [
  "PAYLOAD_TOO_LARGE",
  "TOO_MANY_NODES",
  "TOO_MANY_EDGES",
  "MALFORMED_JSON",
  "DUPLICATE_JSON_KEY",
  "JSON_TOO_COMPLEX",
  "UNSUPPORTED_SCHEMA_VERSION",
  "SCHEMA_INVALID",
  "SECRET_VALUE_REJECTED",
  "DUPLICATE_NODE_ID",
  "DUPLICATE_EDGE",
  "DUPLICATE_CONTRACT_FIELD",
  "DANGLING_EDGE",
  "CONTRACT_ON_NON_CONTRACT_NODE",
  "EDGE_FIELDS_ON_NON_CONTRACT_TARGET",
];

function fail(issues: ManifestIssue[], limits: ManifestLimits): GraphBuildResult & { ok: false } {
  return { ok: false, failure: makeFailure(issues, limits) };
}

function makeFailure(issues: ManifestIssue[], limits: ManifestLimits): ManifestFailure {
  const sorted = [...issues].sort(
    (a, b) =>
      PRECEDENCE.indexOf(a.code) - PRECEDENCE.indexOf(b.code) ||
      compareStrings(a.path, b.path) ||
      compareStrings(a.message, b.message),
  );
  const primary = sorted[0];
  if (!primary) throw new Error("makeFailure requires at least one issue");
  return {
    code: primary.code,
    status: ERROR_STATUS[primary.code],
    message: primary.message,
    issues: sorted.slice(0, limits.max_issues),
    total_issues: sorted.length,
  };
}

function resolveLimits(options: BuildOptions | undefined): ManifestLimits {
  return { ...DEFAULT_LIMITS, ...(options?.limits ?? {}) };
}

function issue(code: ManifestErrorCode, path: string, message: string): ManifestIssue {
  return { code, path, message };
}

function pointer(segments: readonly PropertyKey[]): string {
  return segments
    .map((s) => "/" + redactSecrets(String(s)).replaceAll("~", "~0").replaceAll("/", "~1"))
    .join("");
}

/**
 * Parse manifest JSON text. The byte limit is enforced BEFORE JSON.parse so an oversize payload
 * never reaches the parser (AC-09).
 */
export function parseManifestJson(raw: string | Uint8Array, options?: BuildOptions): ParseResult {
  const limits = resolveLimits(options);
  const bytes = typeof raw === "string" ? Buffer.byteLength(raw, "utf8") : raw.byteLength;
  if (bytes > limits.max_manifest_bytes) {
    return {
      ok: false,
      failure: makeFailure(
        [issue("PAYLOAD_TOO_LARGE", "", `manifest is ${bytes} bytes; the limit is ${limits.max_manifest_bytes} bytes`)],
        limits,
      ),
    };
  }
  const text = typeof raw === "string" ? raw : new TextDecoder("utf-8", { fatal: true }).decode(raw);
  try {
    return { ok: true, value: parseStrictJson(text) };
  } catch (error) {
    if (error instanceof JsonRejectedError && error.code !== "MALFORMED_JSON") {
      return { ok: false, failure: makeFailure([issue(error.code, "", `manifest is rejected: ${error.message}`)], limits) };
    }
    return {
      ok: false,
      failure: makeFailure([issue("MALFORMED_JSON", "", "manifest is not valid JSON")], limits),
    };
  }
}

/** Size check, parse and build in one atomic step from raw JSON text or bytes. */
export function buildGraphFromJson(raw: string | Uint8Array, options?: BuildOptions): GraphBuildResult {
  let parsed: ParseResult;
  try {
    parsed = parseManifestJson(raw, options);
  } catch {
    // TextDecoder in fatal mode throws on invalid UTF-8.
    return fail([issue("MALFORMED_JSON", "", "manifest is not valid UTF-8 JSON")], resolveLimits(options));
  }
  if (!parsed.ok) return { ok: false, failure: parsed.failure };
  return buildFromParsed(parsed.value, resolveLimits(options), true);
}

/**
 * Validate a parsed manifest and build the graph.
 *
 * Atomic: on any failure the result carries only a failure record, never a partially built graph.
 * Order of checks: node/edge counts and payload size, schema version, structure, secrets and
 * cross-reference rules. Nothing beyond cheap length reads happens before the limits pass.
 */
export function buildGraph(input: unknown, options?: BuildOptions): GraphBuildResult {
  return buildFromParsed(input, resolveLimits(options), false);
}

function buildFromParsed(input: unknown, limits: ManifestLimits, bytesChecked: boolean): GraphBuildResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return fail([issue("SCHEMA_INVALID", "", "manifest must be a JSON object")], limits);
  }
  const doc = input as Record<string, unknown>;

  const limitIssues: ManifestIssue[] = [];
  if (Array.isArray(doc.nodes) && doc.nodes.length > limits.max_nodes) {
    limitIssues.push(
      issue("TOO_MANY_NODES", "/nodes", `manifest has ${doc.nodes.length} nodes; the limit is ${limits.max_nodes}`),
    );
  }
  if (Array.isArray(doc.edges) && doc.edges.length > limits.max_edges) {
    limitIssues.push(
      issue("TOO_MANY_EDGES", "/edges", `manifest has ${doc.edges.length} edges; the limit is ${limits.max_edges}`),
    );
  }
  if (limitIssues.length > 0) return fail(limitIssues, limits);

  if (!bytesChecked) {
    let bytes: number;
    try {
      bytes = Buffer.byteLength(JSON.stringify(input), "utf8");
    } catch {
      return fail([issue("SCHEMA_INVALID", "", "manifest is not serializable as JSON")], limits);
    }
    if (bytes > limits.max_manifest_bytes) {
      return fail(
        [issue("PAYLOAD_TOO_LARGE", "", `manifest is ${bytes} bytes; the limit is ${limits.max_manifest_bytes} bytes`)],
        limits,
      );
    }
  }

  if ("schema_version" in doc && Number.isInteger(doc.schema_version) && doc.schema_version !== SUPPORTED_SCHEMA_VERSION) {
    return fail(
      [
        issue(
          "UNSUPPORTED_SCHEMA_VERSION",
          "/schema_version",
          `schema_version ${String(doc.schema_version)} is not supported; supported major version: ${SUPPORTED_SCHEMA_VERSION}`,
        ),
      ],
      limits,
    );
  }

  const structured = validateStructure(doc, limits.max_issues);
  if (!structured.ok) return fail(structured.issues, limits);
  const manifest = structured.manifest;

  const issues = [...scanSecrets(manifest), ...checkReferences(manifest)];
  if (issues.length > 0) return fail(issues, limits);

  return assemble(manifest);
}

const EnvelopeSchema = z.strictObject({
  schema_version: z.literal(1),
  revision: ManifestSchema.shape.revision,
  provenance: ManifestSchema.shape.provenance,
  nodes: z.array(z.unknown()),
  edges: z.array(z.unknown()),
});

/**
 * Structural validation that stops collecting once `cap` issues exist. Validating the whole document with one
 * schema collects EVERY issue first (hundreds of thousands for a hostile 7 MB body: seconds of blocked event loop
 * and hundreds of MB) only to report the first hundred. The envelope is checked first, then each node and edge on
 * its own in index order, so the outcome for the same input is always the same. `total_issues` therefore counts the
 * issues seen up to that point: it is exact below the cap and "at least the cap" above it.
 */
function validateStructure(input: Record<string, unknown>, cap: number): { ok: true; manifest: Manifest } | { ok: false; issues: ManifestIssue[] } {
  const envelope = EnvelopeSchema.safeParse(input);
  const issues: ManifestIssue[] = envelope.success ? [] : envelope.error.issues.map(zodIssueToManifestIssue);
  const collect = (section: "nodes" | "edges", items: readonly unknown[], schema: z.ZodType): unknown[] => {
    const out: unknown[] = [];
    for (let i = 0; i < items.length && issues.length < cap; i += 1) {
      const result = schema.safeParse(items[i]);
      if (result.success) out.push(result.data);
      else for (const z_ of result.error.issues) issues.push(zodIssueToManifestIssue({ ...z_, path: [section, i, ...z_.path] }));
    }
    return out;
  };
  // A structurally wrong envelope may still have array sections worth reporting on; only an array can be walked.
  const nodesRaw = Array.isArray(input.nodes) ? input.nodes : [];
  const edgesRaw = Array.isArray(input.edges) ? input.edges : [];
  const nodes = collect("nodes", nodesRaw, NodeSchema);
  const edges = collect("edges", edgesRaw, EdgeSchema);
  if (issues.length > 0 || !envelope.success) return { ok: false, issues };
  return { ok: true, manifest: { ...envelope.data, nodes, edges } as Manifest };
}

function zodIssueToManifestIssue(z_: z.core.$ZodIssue): ManifestIssue {
  const path = pointer(z_.path);
  switch (z_.code) {
    case "unrecognized_keys":
      return issue("SCHEMA_INVALID", path, "unrecognized properties are not allowed");
    case "invalid_type":
      return issue("SCHEMA_INVALID", path, `expected ${String(z_.expected)}`);
    case "invalid_value":
      return issue("SCHEMA_INVALID", path, "value is not one of the allowed values");
    case "too_big":
    case "too_small":
      return issue("SCHEMA_INVALID", path, "value or length is out of range");
    case "invalid_format":
      return issue("SCHEMA_INVALID", path, "value has an invalid format");
    default:
      // Custom refinements only carry messages written in this repository.
      return issue("SCHEMA_INVALID", path, redactSecrets(z_.message));
  }
}

function scanSecrets(manifest: Manifest): ManifestIssue[] {
  const issues: ManifestIssue[] = [];
  const visit = (value: unknown, path: string): void => {
    if (typeof value === "string") {
      const kinds = detectSecretKinds(value);
      if (kinds.length > 0) {
        issues.push(
          issue(
            "SECRET_VALUE_REJECTED",
            path,
            `value looks like a secret (${kinds.join(", ")}); manifests may contain credential aliases only`,
          ),
        );
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, i) => visit(item, `${path}/${i}`));
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) visit(item, `${path}/${key}`);
    }
  };
  visit(manifest, "");
  return issues;
}

function checkReferences(manifest: Manifest): ManifestIssue[] {
  const issues: ManifestIssue[] = [];
  const nodesById = new Map<string, Manifest["nodes"][number]>();
  manifest.nodes.forEach((node, i) => {
    if (nodesById.has(node.id)) {
      issues.push(issue("DUPLICATE_NODE_ID", `/nodes/${i}/id`, `this node id is declared more than once`));
    } else {
      nodesById.set(node.id, node);
    }
    if (node.contract !== undefined) {
      if (node.kind !== "contract") {
        issues.push(
          issue("CONTRACT_ON_NON_CONTRACT_NODE", `/nodes/${i}/contract`, `only nodes of kind contract may declare contract fields`),
        );
      }
      const seen = new Set<string>();
      node.contract.fields.forEach((field, j) => {
        if (seen.has(field.name)) {
          issues.push(
            issue("DUPLICATE_CONTRACT_FIELD", `/nodes/${i}/contract/fields/${j}/name`, `this contract field name is declared more than once`),
          );
        }
        seen.add(field.name);
      });
    }
  });

  const seenEdges = new Set<string>();
  manifest.edges.forEach((edge, i) => {
    const key = edgeKeyString(edge);
    if (seenEdges.has(key)) {
      issues.push(issue("DUPLICATE_EDGE", `/edges/${i}`, `this edge is declared more than once`));
    }
    seenEdges.add(key);
    const source = nodesById.get(edge.source_id);
    const target = nodesById.get(edge.target_id);
    if (!source) {
      issues.push(issue("DANGLING_EDGE", `/edges/${i}/source_id`, `this edge source is not a declared node`));
    }
    if (!target) {
      issues.push(issue("DANGLING_EDGE", `/edges/${i}/target_id`, `this edge target is not a declared node`));
    }
    if (edge.fields !== undefined && target && target.kind !== "contract") {
      issues.push(
        issue("EDGE_FIELDS_ON_NON_CONTRACT_TARGET", `/edges/${i}/fields`, `fields may only be declared on edges that target a contract node`),
      );
    }
  });
  return issues;
}

function assemble(manifest: Manifest): GraphBuildResult {
  const nodes: GraphNode[] = manifest.nodes
    .map((n): GraphNode => {
      const contract: readonly ContractField[] | null = n.contract
        ? Object.freeze(
            n.contract.fields
              .map((f): ContractField => Object.freeze({ name: f.name, type: f.type, required: f.required }))
              .sort((a, b) => compareStrings(a.name, b.name)),
          )
        : null;
      return Object.freeze({
        id: n.id,
        kind: n.kind,
        owner: n.owner ?? null,
        version: n.version,
        placeholder: n.placeholder ?? false,
        contract,
      });
    })
    .sort((a, b) => compareStrings(a.id, b.id));

  const edges: GraphEdge[] = manifest.edges
    .map((e): GraphEdge => {
      const fields = e.fields ? Object.freeze([...new Set(e.fields)].sort(compareStrings)) : null;
      return Object.freeze({
        source_id: e.source_id,
        target_id: e.target_id,
        relation: e.relation,
        source_file: e.source_file,
        source_line: e.source_line,
        verified_at: e.verified_at ?? null,
        fields,
      });
    })
    .sort(
      (a, b) =>
        compareStrings(a.source_id, b.source_id) ||
        compareStrings(a.target_id, b.target_id) ||
        compareStrings(a.relation, b.relation),
    );

  const provenance: Provenance = Object.freeze({
    source: manifest.provenance.source,
    ...(manifest.provenance.generator !== undefined ? { generator: manifest.provenance.generator } : {}),
    ...(manifest.provenance.generated_at !== undefined ? { generated_at: manifest.provenance.generated_at } : {}),
  });

  const hash = hashCanonical({ format: "changeradar-graph", schema_version: SUPPORTED_SCHEMA_VERSION, nodes, edges });
  const manifest_hash = hashCanonical({
    format: "changeradar-manifest",
    schema_version: SUPPORTED_SCHEMA_VERSION,
    revision: manifest.revision,
    provenance,
    nodes,
    edges,
  });

  const dependents = buildDependents(edges);
  const cycles = findCycles(nodes, dependents);

  const graph = new DependencyGraph({
    revision: manifest.revision,
    provenance,
    hash,
    manifest_hash,
    nodes: Object.freeze(nodes),
    edges: Object.freeze(edges),
    cycles,
    dependents,
  });
  return { ok: true, graph, warnings: collectWarnings(graph) };
}

/**
 * Impact direction: consumes/requires make the source depend on the target (target -> source);
 * produces makes the target depend on the source (source -> target).
 */
export function impactLinkOf(edge: GraphEdge): ImpactLink {
  return edge.relation === "produces"
    ? { from: edge.source_id, to: edge.target_id, edge }
    : { from: edge.target_id, to: edge.source_id, edge };
}

function buildDependents(edges: readonly GraphEdge[]): ReadonlyMap<string, readonly ImpactLink[]> {
  const map = new Map<string, ImpactLink[]>();
  for (const edge of edges) {
    const link = Object.freeze(impactLinkOf(edge));
    const list = map.get(link.from);
    if (list) list.push(link);
    else map.set(link.from, [link]);
  }
  for (const list of map.values()) {
    list.sort(
      (a, b) =>
        compareStrings(a.to, b.to) ||
        compareStrings(a.edge.relation, b.edge.relation) ||
        compareStrings(a.edge.source_id, b.edge.source_id) ||
        compareStrings(a.edge.target_id, b.edge.target_id),
    );
    Object.freeze(list);
  }
  return map;
}

/** Iterative Tarjan strongly connected components over the impact graph (no recursion, so long chains are safe). */
function findCycles(nodes: readonly GraphNode[], dependents: ReadonlyMap<string, readonly ImpactLink[]>): Cycle[] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: Cycle[] = [];
  let counter = 0;

  for (const root of nodes) {
    if (index.has(root.id)) continue;
    const work: { id: string; next: number }[] = [{ id: root.id, next: 0 }];
    index.set(root.id, counter);
    low.set(root.id, counter);
    counter += 1;
    stack.push(root.id);
    onStack.add(root.id);

    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const links = dependents.get(frame.id) ?? EMPTY_LINKS;
      if (frame.next < links.length) {
        const to = links[frame.next]!.to;
        frame.next += 1;
        if (!index.has(to)) {
          index.set(to, counter);
          low.set(to, counter);
          counter += 1;
          stack.push(to);
          onStack.add(to);
          work.push({ id: to, next: 0 });
        } else if (onStack.has(to)) {
          low.set(frame.id, Math.min(low.get(frame.id)!, index.get(to)!));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) {
        low.set(parent.id, Math.min(low.get(parent.id)!, low.get(frame.id)!));
      }
      if (low.get(frame.id) === index.get(frame.id)) {
        const members: string[] = [];
        for (;;) {
          const member = stack.pop()!;
          onStack.delete(member);
          members.push(member);
          if (member === frame.id) break;
        }
        const selfLoop = members.length === 1 && links.some((l) => l.to === frame.id);
        if (members.length > 1 || selfLoop) {
          members.sort(compareStrings);
          cycles.push(Object.freeze({ id: stableId("cyc", members), members: Object.freeze(members) }));
        }
      }
    }
  }
  cycles.sort((a, b) => compareStrings(a.members[0]!, b.members[0]!));
  return cycles;
}

function collectWarnings(graph: DependencyGraph): GraphWarning[] {
  const warnings: GraphWarning[] = [];
  const add = (
    code: GraphWarning["code"],
    message: string,
    ids: string[],
  ): void => {
    if (ids.length === 0) return;
    ids.sort(compareStrings);
    warnings.push({ code, message, count: ids.length, sample_ids: ids.slice(0, 20) });
  };

  add(
    "CYCLE_DETECTED",
    "dependency cycles exist; they are supported and reported, and traversal terminates at already visited nodes",
    graph.cycles.map((c) => c.members.join(",")),
  );
  add(
    "MISSING_OWNER",
    "nodes without an owner; impact assessments that reach them are INCOMPLETE",
    graph.nodes.filter((n) => n.owner === null).map((n) => n.id),
  );
  add(
    "PLACEHOLDER_NODE",
    "placeholder nodes stand for unimported manifests; impact assessments that reach them are INCOMPLETE",
    graph.nodes.filter((n) => n.placeholder).map((n) => n.id),
  );
  add(
    "UNVERIFIED_EDGE",
    "edges without verified_at; impact assessments that reach them are INCOMPLETE",
    graph.edges.filter((e) => e.verified_at === null).map(edgeKeyString),
  );
  const offending: string[] = [];
  for (const edge of graph.edges) {
    if (edge.fields === null) continue;
    const target = graph.getNode(edge.target_id);
    if (!target || target.contract === null) continue;
    const names = new Set(target.contract.map((f) => f.name));
    if (edge.fields.some((f) => !names.has(f))) offending.push(edgeKeyString(edge));
  }
  add(
    "EDGE_FIELD_NOT_IN_CONTRACT",
    "edges declare fields that the target contract does not define",
    offending,
  );
  // `fields: []` says the consumer reads NO field of the contract, so it (and what depends on it) is exempt from every field
  // change. That is the rule, and an exporter that writes `[]` for "not tracked" would hide consumers by it: name every edge.
  add(
    "EMPTY_FIELD_DECLARATION",
    "edges declare an empty field list: the consumer reads no field of the contract, so it is exempt from every field change; omit `fields` if the fields it reads are not known",
    graph.edges.filter((edge) => edge.fields !== null && edge.fields.length === 0).map(edgeKeyString),
  );
  return warnings;
}

/**
 * The normalized manifest for a graph: valid input for buildGraph that reproduces both hashes.
 * Used for evidence export and restore (AC-10); the caller serializes it with canonicalJson.
 */
export function exportManifest(graph: DependencyGraph): Manifest {
  return {
    schema_version: SUPPORTED_SCHEMA_VERSION,
    revision: graph.revision,
    provenance: { ...graph.provenance },
    nodes: graph.nodes.map((node) => ({
      id: node.id,
      kind: node.kind,
      owner: node.owner,
      version: node.version,
      placeholder: node.placeholder,
      ...(node.contract ? { contract: { fields: node.contract.map((field) => ({ ...field })) } } : {}),
    })),
    edges: graph.edges.map((edge) => ({
      source_id: edge.source_id,
      target_id: edge.target_id,
      relation: edge.relation,
      source_file: edge.source_file,
      source_line: edge.source_line,
      verified_at: edge.verified_at,
      ...(edge.fields ? { fields: [...edge.fields] } : {}),
    })),
  };
}
