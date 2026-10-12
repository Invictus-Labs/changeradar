# ChangeRadar domain library (frozen interface, stage A)

This document is the contract between the pure domain layer and everything built on top of it (API, persistence, worker, UI). The domain layer has no database, no network and no clock of its own: every source of time is injected, and every function is deterministic for identical input.

- Entry point for consumers: `src/index.ts` (re-exports everything below).
- Behavior described here is covered by tests in `tests/unit/`; see `docs/qa/ac-matrix.md` for the mapping.
- Manifest authoring guide: `docs/MANIFEST.md`. JSON Schema: `schemas/dependencies.json`.

Changes to any signature, error code, id derivation or hash encoding below are breaking for stage B and must go through the domain owner.

## 1. Module map

| Path | Purpose |
| --- | --- |
| `src/domain/types.ts` | Node kinds, relations, field types, `GraphNode`, `GraphEdge`, `ImpactLink`, `Cycle`, `RunStatus`, `OverallAssessment`, `Severity`, `edgeKeyString` |
| `src/domain/manifest.ts` | zod schemas for manifest schema_version 1, `isUtcTimestamp`, `buildManifestJsonSchema` (source of `schemas/dependencies.json`) |
| `src/domain/limits.ts` | `DEFAULT_LIMITS` (10,000 nodes, 50,000 edges, 25 MB), `DEFAULT_ASSESS_CONFIG` |
| `src/domain/canonical.ts` | `canonicalJson`, `hashCanonical`, `sha256Hex`, `stableId`, `isHashString`, `compareStrings` |
| `src/domain/errors.ts` | `ERROR_STATUS` table, `DomainError`, `StaleBaselineError`, `InvalidExpectedHashError`, `InvalidRunTransitionError` |
| `src/domain/clock.ts` | `Clock`, `systemClock`, `fixedClock` |
| `src/domain/redaction.ts` | `redactSecrets`, `redactDeep`, `detectSecretKinds`, `containsSecret`, `escapeHtml`, `safeReportText`, and, exported before, `redactIdentifier` / `redactIdentifiers` (redaction at the strength of the manifest validator, for identifier fields) and the two markers `REDACTED` and `OVERSIZE_REDACTED`; the barrel (`src/index.ts`) names exactly these ten |
| `src/domain/contract-checks.ts` | read-only contract check model, `runContractCheck` (timeout wrapper), `ContractCheckRunner` interface |
| `src/domain/run-state.ts` | run status state machine |
| `src/domain/semver.ts` | `parseSemver` (numeric core only) |
| `src/services/graph.ts` | `buildGraph`, `buildGraphFromJson`, `parseManifestJson`, `DependencyGraph`, `exportManifest` |
| `src/services/diff.ts` | `diffGraphs`, `traverseDependents`, `affectsLink`, `Change` |
| `src/services/assess.ts` | `assess`, `checkBaselineHash`, `Assessment`, `Finding`, `AssessmentUnknown`, `Coverage` |

## 2. Scope statement: what a contract is in the MVP

A `contract` node may declare a list of fields, each with a `name`, a `type` (`string`, `number`, `integer`, `boolean`, `object`, `array`, `null`) and a `required` flag. That is the entire contract model.

This is a limited required-field/type subset. It is not arbitrary JSON Schema, OpenAPI or protobuf compatibility checking, it does not understand nested structure (field names are opaque strings, dotted names are allowed but not interpreted), enums, formats, ranges or semantics, and it does not observe runtime behavior. ChangeRadar only reasons about dependencies that are declared in the supplied manifests; it never infers that an undeclared dependency does not exist. Every assessment carries this statement in `coverage.limits`.

## 3. Manifest (schema_version 1)

```jsonc
{
  "schema_version": 1,                       // integer major version; anything else is rejected
  "revision": "2026-09-29.1",                // free text label for the snapshot
  "provenance": { "source": "billing-exporter", "generator": "optional", "generated_at": "2026-09-29T00:00:00Z" },
  "nodes": [
    { "id": "contract.invoice", "kind": "contract", "owner": "team-billing", "version": "1.0.0",
      "contract": { "fields": [ { "name": "invoice_id", "type": "string", "required": true } ] } }
  ],
  "edges": [
    { "source_id": "job.export", "target_id": "contract.invoice", "relation": "consumes",
      "source_file": "jobs/export.yaml", "source_line": 12, "verified_at": "2026-09-28T00:00:00Z",
      "fields": ["invoice_id"] }
  ]
}
```

Rules, all enforced by `buildGraph`:

- Objects are strict: unknown properties are rejected (a typo such as `ownr` never silently drops data).
- Node `id` matches `^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,254}$` and is unique. `kind` is one of `service | job | contract | credential_alias | artifact`. `version` is required free text. `owner` is optional/nullable (missing owner is legal input but an unknown at assessment time). `placeholder: true` marks a node that is referenced but whose own manifest is not imported.
- Edge `source_id --relation--> target_id`; `relation` is `consumes | requires | produces`. `source_file` and `source_line` (>= 1) are required provenance. `verified_at` is a UTC timestamp (`YYYY-MM-DDTHH:MM:SS[.fff]Z`, real calendar instant) or absent/null (never verified). Duplicate (source, target, relation) triples are rejected.
- Edge `fields` (optional) lists the contract fields this consumer relies on; allowed only when the target is a contract node. Absent means "not declared": the consumer is assumed to rely on every required field. On a `produces` edge `fields` is not a filter and is ignored by the analysis (there it could only name fields of the produced contract); the validator still accepts it.
- `contract` is allowed only on `kind: "contract"` nodes; field names are unique within a contract.
- No string may contain control characters. Every string value is scanned for secret-looking content (private keys, cloud/API tokens, JWTs, bearer credentials, URL credentials, random-looking `password=` style assignments); a match rejects the whole manifest with `SECRET_VALUE_REJECTED`. The error names the JSON pointer and the secret kind, never the value. Manifests hold credential aliases only.

### Impact direction

`consumes` and `requires` make the source depend on the target. `produces` makes the target depend on the source. "Dependents of X" are the nodes reachable by following those dependencies backwards from X; that is the traversal used for impact.

## 4. Errors and HTTP mapping

`ERROR_STATUS` in `src/domain/errors.ts` is the single table. Manifest failures are returned as data (`{ ok:false, failure }`), never thrown, so no partially built graph can escape.

| Code | HTTP | Meaning |
| --- | --- | --- |
| `MALFORMED_JSON` | 400 | not JSON / not valid UTF-8 |
| `PAYLOAD_TOO_LARGE` | 413 | manifest bytes exceed `max_manifest_bytes` (checked before parsing) |
| `TOO_MANY_NODES` / `TOO_MANY_EDGES` | 413 | array length exceeds the limit (checked before any item is validated) |
| `UNSUPPORTED_SCHEMA_VERSION` | 422 | integer `schema_version` other than 1 |
| `SCHEMA_INVALID` | 422 | structural problem (type, pattern, range, unknown property, missing field) |
| `SECRET_VALUE_REJECTED` | 422 | a value looks like a secret |
| `DUPLICATE_NODE_ID`, `DUPLICATE_EDGE`, `DUPLICATE_CONTRACT_FIELD` | 422 | uniqueness violations |
| `DANGLING_EDGE` | 422 | edge endpoint is not a declared node |
| `CONTRACT_ON_NON_CONTRACT_NODE`, `EDGE_FIELDS_ON_NON_CONTRACT_TARGET` | 422 | misplaced contract data |
| `STALE_BASELINE` | 409 | expected_hash differs from the snapshot hash (`StaleBaselineError`) |
| `INVALID_EXPECTED_HASH` | 422 | expected_hash is not `sha256:<64 lowercase hex>` (`InvalidExpectedHashError`) |
| `INVALID_RUN_TRANSITION` | 409 | forbidden run status change (`InvalidRunTransitionError`) |

The API wraps these in the PRD envelope `{error:{code,message,request_id}}`; the domain supplies `code`, `message`, and `status`. Codes not in the table (401, 403, 404, 429, 503) belong to stage B.

## 5. Graph building (`src/services/graph.ts`)

```ts
buildGraph(input: unknown, options?: { limits?: Partial<ManifestLimits> }): GraphBuildResult
buildGraphFromJson(raw: string | Uint8Array, options?): GraphBuildResult   // byte limit, then parse, then build
parseManifestJson(raw: string | Uint8Array, options?): ParseResult

type GraphBuildResult =
  | { ok: true;  graph: DependencyGraph; warnings: GraphWarning[] }
  | { ok: false; failure: ManifestFailure }        // no graph object exists on failure

interface ManifestFailure { code: ManifestErrorCode; status: number; message: string;
                            issues: ManifestIssue[]; total_issues: number }   // issues capped at limits.max_issues
interface ManifestIssue   { code: ManifestErrorCode; path: string /* JSON pointer */; message: string }
```

Order of checks (nothing after a failed step runs): payload bytes (before `JSON.parse`), node/edge counts (before any item is inspected), unsupported major version, structure (zod), then secrets and cross references (unique ids, duplicates, dangling edges, misplaced contract data) together. All issues from the last stage are reported together, sorted by code precedence then path, so the same bad input always yields the same failure.

`DependencyGraph` (immutable, frozen):

```ts
readonly schema_version: 1; revision: string; provenance: Provenance
readonly hash: string             // graph hash, see section 6
readonly manifest_hash: string    // includes revision and provenance
readonly nodes: readonly GraphNode[]   // sorted by id
readonly edges: readonly GraphEdge[]   // sorted by (source_id, target_id, relation)
readonly cycles: readonly Cycle[]      // strongly connected groups / self loops, members sorted
getNode(id), hasNode(id), getEdge(key), dependentsOf(id): ImpactLink[], cycleOf(id)
```

Normalization: `owner` absent or null becomes `null`; `placeholder` defaults to `false`; `verified_at` absent becomes `null`; contract fields and edge `fields` are sorted (edge `fields` also de-duplicated); `contract` absent is `null` (undeclared, not the same as an empty field list).

`GraphWarning` (`CYCLE_DETECTED`, `MISSING_OWNER`, `PLACEHOLDER_NODE`, `UNVERIFIED_EDGE`, `EDGE_FIELD_NOT_IN_CONTRACT`) is aggregated: `{ code, message, count, sample_ids (max 20, sorted) }`. Warnings are the `warnings` of `POST /api/v1/snapshots`.

`exportManifest(graph): Manifest` returns the normalized manifest; `canonicalJson(exportManifest(g))` fed back to `buildGraphFromJson` reproduces both hashes (used for evidence export and restore). A truncated export is never accepted at any cut point (tested).

Cycles are supported. They are found with an iterative Tarjan pass (no recursion, so a 10,000-node chain is safe), reported in `graph.cycles`, and never traversed twice.

## 6. Canonical JSON and hash encoding

`canonicalJson(value)`: UTF-8 JSON with no whitespace; object keys sorted by UTF-16 code unit (plain `<` comparison, never locale dependent); array order preserved; `undefined` object properties omitted; non-finite numbers, `undefined` array items, bigint, functions and circular structures throw `TypeError`.

Hash value format: `sha256:<64 lowercase hex>` = SHA-256 of the canonical JSON. Hashed documents (each carries a `format` tag for domain separation):

- Graph hash `graph.hash`: `{ format:"changeradar-graph", schema_version:1, nodes, edges }` using the normalized, sorted `nodes` and `edges`. `revision` and `provenance` are excluded, so identical dependency content gives an identical hash regardless of label. Any change to a node or edge field, including `verified_at`, changes the hash.
- Manifest hash `graph.manifest_hash`: `{ format:"changeradar-manifest", schema_version:1, revision, provenance, nodes, edges }`.

`hash` is the value stored as `snapshots.manifest_hash` and compared with `expected_hash`. Stage B stores the raw manifest, rebuilds the graph on read and must treat `rebuilt.hash !== stored hash` as corruption (an integrity failure, not a stale request).

## 7. Diff (`src/services/diff.ts`)

`diffGraphs(baseline, proposed): Change[]`, sorted by (node_id, kind, field, edge). Each `Change` has a stable id `chg_<20 hex>` derived from its content and a `propagation`:

| Kind | Propagation |
| --- | --- |
| `node_removed`, `node_kind_changed` | `all` dependents |
| `node_version_changed` | `all` when the change can break dependents, otherwise `none`. Conservative rules (`classifyVersionChange` in `src/domain/semver.ts`): breaking when either side is not semver (an optional `v` prefix is accepted; the parser is lenient, not strict SemVer 2.0: leading zeros in the numbers and in prerelease identifiers are accepted as written); when the major version differs in EITHER direction (a rollback `1.2.3` to `0.9.0` is breaking); at major 0 when the minor differs and at 0.0.x when the patch differs; on any decrease of minor or patch (a downgrade); when the target is a prerelease (`1.2.3` to `1.3.0-alpha.1` or `1.2.4-rc.1`: a prerelease promises nothing, whatever its core); and when the same core changes its prerelease, except graduating from a prerelease to the release. Build metadata (`+...`) never matters. A minor or patch upgrade at major 1 or above is `none`. |
| `contract_field_removed` | `field` (required_relevant = field was required) |
| `contract_field_type_changed` | `field` (required_relevant = required on either side) |
| `contract_field_added` | `field` when the new field is required, else `none`. A NEW requirement reaches EVERY consumer of the contract (engine version 3, see "A new requirement" below) |
| `contract_field_requirement_changed` | `field` in BOTH directions (`required_relevant` is true: the field is required on exactly one side). Consumers of a producer's output lose a guaranteed field when it becomes optional, and callers must start sending it when it becomes required; the model does not say which way data flows, so a field that becomes optional reaches consumers that declare the field and undeclared consumers, and a field that becomes REQUIRED reaches every consumer (engine version 3) |
| `edge_removed` | `all` from the produced node when the relation is `produces`; otherwise `none` |
| `node_added`, `edge_added`, `node_owner_changed`, `node_placeholder_changed`, `contract_declaration_changed` | `none` (informational) |

Edge changes attached to an added or removed node are folded into `node_added` / `node_removed`. Edge metadata (`source_file`, `source_line`, `verified_at`, `fields`) is not part of edge identity.

Field propagation (`affectsLink`): a consumer edge that declares `fields` is affected only if the list contains the changed field, **provided the declaration is usable** (`usableDeclaredFields`): every declared name must exist in the origin contract of the BASELINE, and the edge must not be a `produces` edge. An unusable declaration (a typo such as `invoice_idd`, a name left over from a rename, or a valid name mixed with an invalid one) never excludes a consumer: the edge is treated as undeclared AND an `EDGE_FIELD_NOT_IN_CONTRACT` unknown is recorded for every such examined first-hop edge, so the run is `INCOMPLETE`. A consumer that declares nothing is assumed to rely on every required field, so it is affected when `required_relevant` is true. Use of optional fields is therefore only considered for consumers that declare `fields`.

`traverseDependents(graph, originId, { acceptFirstHop?, budget? }): Traversal` is a breadth-first traversal over pre-sorted neighbours. Each node is visited once, the origin is never its own consumer, cycles that contain any visited node are returned in `cycles`. The result is a parent tree (one hop object and a pointer per reached node, linear in the number of nodes whatever the depth); a node's ordered `hops` (source-to-consumer path with edge provenance) are materialised on access, and `boundedPath()` gives the first 12 and last 12 hops of a longer path with the number omitted. Path ties resolve to the shortest path, then lexicographic neighbour order. **First hop filter:** `acceptFirstHop` decides which links out of the origin are FOLLOWED (a consumer that declares only other fields is not affected by a field change), but every first hop edge it looked at, rejected ones included, is in `examined_edges`, so its `verified_at` goes through the unverified, stale and future checks: the claim "this consumer does not use the changed field" is only as good as the evidence on the edge that declares it (an unverified or stale edge behind an exclusion makes the run INCOMPLETE). `budget` is a shared count of dependent links the traversals may look at; when it runs out `truncated` is true.

**A new requirement (engine version 3).** The paragraph above is the rule for removals, type changes and fields that become optional. A field ADDED as required, or an optional field that becomes required, reaches every consumer of the contract, whatever `fields` it declares: a declaration lists what a consumer reads, not what it supplies, and a newly required field cannot appear in any baseline declaration. The consumer's declared list therefore never exempts it from a new requirement (`affectsLink` in `src/services/diff.ts`).

**An empty declaration (`fields: []`).** A consumer edge that declares an EMPTY list reads no field of the contract, so it (and what depends on it) is exempt from every field removal and type change: the rule is unchanged. Because an exporter that writes `[]` for "not tracked" would hide consumers by it, the import names every such edge in a warning (`EMPTY_FIELD_DECLARATION`); omit `fields` when the fields a consumer reads are not known.

Impact is computed on the BASELINE graph: "known consumers" are the consumers declared before the change. Consumers or edges that appear only in the proposal are reported as informational changes and do not add findings.

## 8. Assessment (`src/services/assess.ts`)

```ts
assess(input: {
  baseline: DependencyGraph; proposed: DependencyGraph;
  expected_hash: string;                    // what the caller believes the baseline hash is
  clock: Clock;                             // injected UTC clock
  config?: Partial<AssessConfig>;           // max_contract_age_ms (30 days), future_skew_ms (5 minutes) and the output bounds
  check_results?: ContractCheckResult[];    // optional read-only check outcomes
  missing_check_keys?: string[];            // requested checks that never ran: each is a CHECK_NOT_RUN unknown
  live_checks?: "ran" | "disabled" | "none_selected";   // adds the LIVE_CHECKS_NOT_RUN coverage limit when live checks did not contribute
}): { ok: true; assessment: Assessment } | { ok: false; error: StaleBaselineError | InvalidExpectedHashError }

checkBaselineHash(actual: string, expected: string): StaleBaselineError | InvalidExpectedHashError | null
```

The actual snapshot hash is `baseline.hash`. `assess` returns the typed error before doing any work when `expected_hash` is malformed (422) or not equal (409). It is pure: no persistence, no I/O.

`Assessment`:

```ts
{ schema_version: 1,
  assessment: "AFFECTED" | "NO_KNOWN_IMPACT" | "INCOMPLETE",
  baseline_hash, proposed_hash, evaluated_at /* clock.now() ISO */,
  changes: Change[], findings: Finding[], unknowns: AssessmentUnknown[], cycles: Cycle[],
  coverage: Coverage, summary: { changes, findings, direct_findings, transitive_findings, unknowns, known_impact } }
```

Verdict precedence: any unknown gives `INCOMPLETE`; otherwise any finding gives `AFFECTED`; otherwise `NO_KNOWN_IMPACT`. `INCOMPLETE` deliberately wins over `AFFECTED` (PRD: missing owners, stale contracts and unknown nodes force INCOMPLETE); the findings are still listed and `summary.known_impact` says whether a break is already known. A run being COMPLETE describes computation only.

### Unknowns (each forces INCOMPLETE)

Checked on the nodes and edges the assessment actually examined: the origin of each propagating change, every reached consumer, and every edge followed out of them, including an edge that leads into a node already visited (each node is visited once, but every edge out of it is examined and its gaps count). Unrelated gaps elsewhere in the graph do not force INCOMPLETE but are counted in `coverage.limits` (`BASELINE_HAS_GAPS`).

| Code | Trigger |
| --- | --- |
| `MISSING_OWNER` | an examined node has no owner |
| `PLACEHOLDER_NODE` | an examined node is a placeholder for an unimported manifest |
| `UNVERIFIED_CONTRACT` | an examined edge has no `verified_at` |
| `STALE_CONTRACT` | an examined edge's `verified_at` is older than `max_contract_age_ms` against the injected clock (age exactly equal to the maximum is still fresh) |
| `FUTURE_VERIFIED_AT` | `verified_at` is more than `future_skew_ms` in the future |
| `UNDECLARED_CONTRACT` | a contract node present in both manifests changed AS A NODE (its version, owner, placeholder flag or field declaration; not an edge change and not a removal) and its fields are not declared in both manifests. It does not fire for a contract that appears in only one manifest |
| `CHECK_FAILED`, `CHECK_TIMED_OUT`, `CHECK_ERROR`, `CHECK_UNKNOWN` | a supplied contract check result is not `PASSED` |
| `CHECK_NOT_RUN` | a check named in the run request (`missing_check_keys`) has no recorded outcome because it was disabled or removed before the worker ran: a requested verification that did not happen is never "none needed" |
| `EDGE_FIELD_NOT_IN_CONTRACT` | a consumer edge that the proposal introduces or rewrites names a field the proposed contract does not have, OR an examined first-hop consumer edge of the baseline names a field the baseline contract does not have (round 2: the exclusion by a declaration is only as good as the declaration; an unusable one is treated as undeclared). It fires whatever the kind of the change (also a self-loop edge and a newly introduced `produces` edge that names a field the contract lacks, although `produces` `fields` are otherwise ignored), and it does not fire when the origin contract itself declares no fields. The message names the unknown fields; a message (like every derived text) is cut to 2,000 characters when it would be longer, the same bound a restore keeps, so a restored workspace verifies again |
| `FINDINGS_TRUNCATED`, `UNKNOWNS_TRUNCATED` | an output bound was reached (`AssessConfig.max_findings`, `max_findings_per_origin`, `max_traversal_links`, `max_finding_bytes`, `max_unknowns`); the listed consumers or unknowns are incomplete. The bounds are recorded in `coverage.bounds`, and a bundle re-derives the assessment under the same bounds (never above the defaults) |

### Findings

One finding per (origin node, reached consumer). Fields: `id`, `origin_id`, `consumer_id`, `consumer_kind`, `consumer_owner`, `severity` (`high` = direct, `medium` = transitive), `direct`, `depth`, `path` (ordered node ids, changed node first, consumer last), `hops` (ordered edge steps with `source_file`/`source_line`), `change_ids` (changes that reach the consumer through the first hop), `reason`. Sorted by severity, depth, consumer, origin, id.

### Coverage

Every assessment is stamped with `engine_version` (`ENGINE_VERSION` in `src/services/assess.ts`, currently 3; a change to any decision rule that can change a verdict must bump it). Bundle verification refuses a run from a NEWER engine version with its own code and accepts a run from an older one on its hashes alone (it cannot re-derive it), and views mark such a run "re-run required" (docs/OPERATIONS.md, Upgrade). A finished run whose engine is not the current one has NO current assessment: `assessment` is `null` in the run view, the run list and the JSON export, and the verdict the older engine recorded is in `recorded_assessment`, so a script that gates on `assessment == "NO_KNOWN_IMPACT"` cannot accept it (the bundle keeps the recorded verdict, it is hashed evidence). The UI shows a "RE-RUN REQUIRED" banner and the HTML report a stale block, and neither prints a present-tense claim about the run. The consumer rule is the same everywhere (docs/API.md lists every surface): only `assessment == "NO_KNOWN_IMPACT"` on a run of the current engine means no known impact; `null`, `INCOMPLETE` and `AFFECTED` are all "not safe", and `null` with `status: "complete"` means a re-run is required, never pending. A single function (`isStaleEngineRun`) decides which runs are stale. What does not depend on the rules is still verified for such a run in a bundle: a NO_KNOWN_IMPACT run lists no finding and no unknown, an AFFECTED run lists findings, and the summary counts the listed rows (unless the run records `FINDINGS_TRUNCATED`). Version 3: a NEW requirement reaches every consumer of the contract. A field added as required, or a field that becomes required, is a break for a consumer whatever `fields` it declares, because a declaration lists what the consumer reads, not what it supplies; removals and type changes still reach only the consumers that declare the field. A bundle that holds such a run also carries a `stale_runs` member (the ids of those runs) outside every hash, so a reader sees that the recorded verdict is history; the HTTP route adds the header `x-changeradar-stale-runs` with the count.

`coverage` states what was and was not known: `scope: "declared_manifests_only"`, node/edge counts of both manifests, changed and origin node ids, `nodes_examined`, `edges_examined`, `consumers_found`, `known` (what was known) and `limits` (what was not). Every assessment includes `MANIFEST_DECLARED_ONLY`, `CONTRACT_SUBSET_ONLY` and `RUNTIME_NOT_OBSERVED`; conditional limits are `NO_CHANGES_DETECTED`, `INFORMATIONAL_CHANGES_ONLY`, `NO_AFFECTED_CONSUMERS_DECLARED` (with `node_ids`) and `BASELINE_HAS_GAPS`. An isolated change reports `NO_KNOWN_IMPACT` together with these limits.

## 9. Stable ids

All ids are derived from content, never random: `<prefix>_<first 20 hex of sha256(canonicalJson(document))>`.

| Id | Prefix | Hashed document |
| --- | --- | --- |
| change | `chg_` | `{ kind, node_id, origin_id, field, edge, before, after }` |
| finding | `fnd_` | `{ baseline_hash, proposed_hash, origin_id, consumer_id, path, change_ids }` |
| unknown | `unk_` | `{ code, node_id, edge (source_id, target_id, relation), extra }` where `extra` is the check id for `CHECK_*` unknowns and `null` otherwise |
| cycle | `cyc_` | sorted member ids |

Ids do not depend on evaluation time, input order or edge metadata such as `verified_at`. The same finding id therefore appears in a JSON export and in an HTML rendering of the same assessment. Database rows that need a UUID primary key (`findings.id UUID`) should store the content id in a separate text column (`finding_key`) or derive a UUID deterministically from it; the domain never mints UUIDs.

## 10. Contract checks (`src/domain/contract-checks.ts`)

Result states: `PASSED | FAILED | TIMED_OUT | ERROR | UNKNOWN`. Stage B implements:

```ts
interface ContractCheckRunner {
  readonly read_only: true;     // asserted, and checked at runtime
  run(definition: ContractCheckDefinition, context: { signal: AbortSignal; attempt: number }): Promise<{ state: "PASSED" | "FAILED"; detail?: string }>;
}
```

`runContractCheck(definition, runner, { clock, timers?, max_timeout_ms? }): Promise<ContractCheckResult>` never rejects and never throws. Guarantees:

- Only a runner outcome whose `state` is exactly `PASSED` gives `PASSED`.
- No answer within `timeout_ms` gives `TIMED_OUT` (the abort signal is fired; a late answer is ignored, a late rejection is swallowed).
- A thrown or rejected runner gives `ERROR`; any other return value gives `UNKNOWN`; an invalid definition or a runner that does not declare `read_only` gives `ERROR` without running it.
- `max_attempts` (1 to 4, default 1) retries only `ERROR` and `TIMED_OUT`, with exponential backoff `backoff_base_ms * 2^(n-1)`. `FAILED` and `UNKNOWN` are definitive. `attempt_log` keeps every attempt, so earlier failures stay visible even if a retry passes. The result is `PASSED` only if an attempt genuinely reported `PASSED`.
- `detail` is secret-redacted, control characters removed, truncated to 500 characters.

Pass the results to `assess({ check_results })`; anything other than `PASSED` becomes an unknown.

`Timers` and `Clock` are injectable (`realTimers` resolves `globalThis.setTimeout` at call time so fake timers work).

## 11. Run state machine (`src/domain/run-state.ts`)

`QUEUED -> RUNNING -> COMPLETE | FAILED`, plus `RUNNING -> QUEUED` (lease expired, job reclaimed; safe because assessment is pure) and `QUEUED -> FAILED` (rejected before start). `COMPLETE` and `FAILED` are terminal. `transition(from, to)` returns `to` or throws `InvalidRunTransitionError` (409). COMPLETE describes computation, never safety.

## 12. Redaction and escaping (`src/domain/redaction.ts`)

- `redactSecrets(text)`: replaces private keys, AWS/GitHub/Slack/Stripe/Google/API keys, JWTs, bearer/basic credentials, URL credentials and `password=`/`token:` style values with `[REDACTED]` (assignment keys stay readable; only the value is replaced).
- `redactDeep(value)`: deep copy safe for logs and exports; also replaces values under sensitive property names (password, secret, token, authorization, cookie, api key, credentials...), redacts secret-looking keys, reduces `Error` to name plus redacted message, cuts cycles and depth over 12.
- `detectSecretKinds` / `containsSecret`: used by manifest validation; assignment-style matches count only when the value looks random (contains a digit and a letter), so aliases such as `cred.payments.api-key` are accepted while logs stay stricter.
- `redactIdentifier(text)` (round 2): redacts only what the validator would reject (`detectSecretKinds` strength). `redactDeep` uses it for identifier fields (`id`, `key`, `check_key`, `check_id`, `node_id`, `source_id`, `target_id`, `origin_id`, `consumer_id`, `finding_key`, `snapshot_id`, `run_id`, `workspace_id`, `credential_alias`, `path`, `change_ids`, `node_ids`, `check_keys`), so an id that was accepted at import is never rewritten in a view or a bundle and `redactDeep` is a fixed point. Text above the scan cap (8 MiB, 512 K characters when non-ASCII) is refused: `redactSecrets` returns `[REDACTED: value too large to scan]` and `detectSecretKinds` reports `oversize`. There are no scan windows. The complete list of what is and is not detected is `docs/MANIFEST.md`.
- Work budget (round 7): one scan counts the reads that could repeat for many starts (docs/MANIFEST.md, "Size cap, fail closed") and is abandoned past 64 counted steps per character plus 65,536. The whole text is then replaced by the same `[REDACTED: value too large to scan]` as an oversize text, on every path that reads it: `redactSecrets`, `redactIdentifier` and `redactDeep` return the marker, and `detectSecretKinds` reports `oversize`, so the import validator refuses the text and `containsSecret` is true; no path shows it, and redacting the marker again changes nothing. Measured on this tree the counted steps are 0 to 8 per character (frozen fixtures 1.9 to 5.5 at most, `.env`, YAML, Kubernetes, JSON logs, HTTP dumps and a 1 MiB ordinary log 0 to 1, generated garbled strings up to 7.8), so a legitimate large text is far below the budget; only the counted reads are in it (other scanners are linear by construction and are not counted).
- `escapeHtml(text)`: escapes `& < > " ' \``; `safeReportText` redacts then escapes. All report text must pass through one of them. The pattern set is a safety net, not a guarantee.

## 13. Performance and limits

Defaults: 10,000 nodes, 50,000 edges, 25 MB manifest bytes, 100 reported issues (`DEFAULT_LIMITS`). Measurements are in `docs/BENCHMARK.md`.

## 14. Notes for stage B

- Persist the raw manifest (or canonical export) plus `hash`; do not persist the `DependencyGraph` object. Rebuild on read and compare hashes.
- Import path: `buildGraphFromJson(body)`; map `failure.status`/`failure.code`; return `graph.hash` and `warnings`.
- Impact run: load baseline, `buildGraph(proposed_manifest)`, `assess(...)`. On `{ok:false}` map `error.status` (409/422). Persist the `assessment` JSON and the `findings` with their content ids; keep unknowns, coverage and cycles.
- Worker: wrap assessment in the `run-state` transitions; re-running after a lease reclaim is safe because everything is pure.
- The network contract check runner must implement `ContractCheckRunner`, must be read-only, must honor `signal`, and must apply the URL allowlist/redirect/DNS rules of PRD section 6 itself; the domain only guarantees the state semantics.
- `tsconfig.web.json` exists but `npm run typecheck` does not include it yet because `src/web/` is created in stage C; add `tsc -p tsconfig.web.json --noEmit` to the script when the UI lands.

## 15. How stage B used this interface (no interface was changed)

Stage B (API, persistence, worker; see `docs/API.md` and `docs/OPERATIONS.md`) consumes every signature, error code, id derivation and hash encoding above unchanged, and every domain test still passes. Where stage B had to choose, it chose as follows:

- Snapshots persist the normalized manifest as canonical JSON text plus `graph.hash` and `graph.manifest_hash`; every read that feeds an assessment rebuilds the graph with `buildGraphFromJson` and treats a hash mismatch as corruption (`INTEGRITY_FAILURE`), never as a stale request. Nodes and edges are also stored as rows for browsing and are protected by composite foreign keys.
- Finding ids: the content id (`fnd_...`) is stored in `findings.finding_key` next to a random UUID primary key and is the only id the API and every export show.
- `assess({expected_hash})` is called by the worker with the hash recorded when the run was accepted. The HTTP 409/422 for a stale or malformed `expected_hash` is decided at request time with `checkBaselineHash` against the snapshot hash, plus a second, stronger rule the domain does not know about: the workspace baseline pointer (see `docs/API.md`, "Snapshots and the baseline").
- `ContractCheckRunner` is implemented by `src/workers/checks.ts` (GET/HEAD against allowlisted endpoints, `read_only: true`). The domain wrapper owns the deadline; the runner's own client timeout is deliberately longer, so a timeout is always reported as `TIMED_OUT` and never as a runner `ERROR`.
- A run whose worker died with a check in flight ends that check `UNKNOWN` (it is not re-run); the domain maps it to `CHECK_UNKNOWN` and therefore `INCOMPLETE`.
- Run status is exposed in lower case; the verdict field is named `assessment`. `RUNNING -> QUEUED` is used for lease reclaim exactly as documented in section 11.
