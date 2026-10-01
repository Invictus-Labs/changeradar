#!/usr/bin/env node
// Seeded mutation controls. For each mutant: run the named tests on an unmodified copy (must pass), apply ONE
// semantic mutation to a disposable copy (never to the checkout), rerun (must FAIL on assertions, not on a
// build error), restore, rerun (must pass again). A surviving mutant means the test suite would not notice
// that safety property being removed, and the script exits non-zero.
//
//   node scripts/mutation-controls.mjs            run every mutant
//   node scripts/mutation-controls.mjs auth-role  run the mutants whose id contains the argument
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { classifyLoad, classifyMutantRun, killProcessGroup, loadProbe } from "./mutation-classify.mjs";

const repo = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const only = args.find((a) => !a.startsWith("--"));
// --check: run no tests, only verify that every mutant's `find` text occurs exactly once (an instrument that no
// longer matches the code would otherwise fail late, after minutes of test runs).
const checkOnly = args.includes("--check");

/** id, what property is removed, where, exact text to replace (must occur exactly once), replacement, tests that must catch it. */
const MUTANTS = [
  {
    id: "auth-role-import",
    property: "AC-12: a viewer cannot import a snapshot (role check on writes)",
    file: "src/services/snapshots.ts",
    find: 'requireRole(principal, "operator");\n  const route = { route: "POST /snapshots"',
    replace: 'const route = { route: "POST /snapshots"',
    tests: ["tests/integration/auth.test.ts"],
  },
  {
    id: "auth-role-export",
    property: "AC-12: a viewer cannot download an evidence bundle (role check on exports)",
    file: "src/services/evidence.ts",
    find: 'requireRole(principal, "operator");\n  if (!isUuid(runId)) throw notFound();\n  const bundle',
    replace: "if (!isUuid(runId)) throw notFound();\n  const bundle",
    tests: ["tests/integration/auth.test.ts"],
  },
  {
    id: "scope-snapshot-read",
    property: "AC-12: another workspace's snapshot id is 404 (workspace scoping on reads)",
    file: "src/services/snapshots.ts",
    find: "WHERE s.workspace_id = $1 AND s.id = $2`,\n    [principal.workspaceId, id],",
    replace: "WHERE s.id = $2 AND $1::uuid IS NOT NULL`,\n    [principal.workspaceId, id],",
    tests: ["tests/integration/isolation.test.ts"],
  },
  {
    id: "scope-run-read",
    property: "AC-12: another workspace's run id is 404 (workspace scoping on run reads and exports)",
    file: "src/services/impact.ts",
    find: "FROM impact_runs WHERE workspace_id = $1 AND id = $2`, [principal.workspaceId, id]);",
    replace: "FROM impact_runs WHERE id = $2 AND $1::uuid IS NOT NULL`, [principal.workspaceId, id]);",
    tests: ["tests/integration/isolation.test.ts"],
  },
  {
    id: "baseline-moved-409",
    property: "AC-05: a run request against a superseded baseline is 409 (concurrent baseline change)",
    file: "src/services/impact.ts",
    find: "if (!body.allow_superseded && current?.baseline_snapshot_id !== body.snapshot_id) {",
    replace: "if (false) {",
    tests: ["tests/integration/impact.test.ts", "tests/integration/idempotency.test.ts"],
  },
  {
    id: "baseline-hash-409",
    property: "AC-05: a stale expected_hash is 409 (immutable baseline hash)",
    file: "src/services/impact.ts",
    find: "if (hashProblem) throw fromDomainError(hashProblem);",
    replace: "void hashProblem;",
    tests: ["tests/integration/impact.test.ts"],
  },
  {
    id: "csrf",
    property: "AC-12: mutations require the CSRF token",
    file: "src/api/server.ts",
    find: "if (!csrf || !safeEqual(csrf, csrfFor(ctx, token))) throw forbidden(",
    replace: "if (false) throw forbidden(",
    tests: ["tests/integration/auth.test.ts"],
  },
  {
    id: "ssrf-private-address",
    property: "AC-06/AC-09: private and loopback destinations are refused",
    file: "src/workers/ssrf.ts",
    find: 'if (klass === "blocked" || (klass === "private" && !policy.allowPrivateNetwork)) {',
    replace: "if (false) {",
    tests: ["tests/unit/ssrf.test.ts", "tests/integration/checks.test.ts"],
  },
  {
    id: "check-failure-becomes-pass",
    property: "AC-06: a failed live check is never converted to passed",
    file: "src/workers/checks.ts",
    find: 'return { state: "FAILED", detail: parts.join("; ") };',
    replace: 'return { state: "PASSED", detail: parts.join("; ") };',
    tests: ["tests/integration/checks.test.ts"],
  },
  {
    id: "uncertain-outcome-not-unknown",
    property: "AC-13: a check interrupted by a restart ends UNKNOWN and is not silently re-run",
    file: "src/services/run-store.ts",
    find: 'if (row.state === "STARTED") {',
    replace: "if (false) {",
    tests: ["tests/integration/worker.test.ts"],
  },
  {
    id: "lease-fencing",
    property: "AC-13: a worker that lost its lease cannot commit results",
    file: "src/services/jobs.ts",
    find: "WHERE id = $1 AND locked_by = $2 AND attempt = $3 AND state = 'running' FOR UPDATE\",\n    [job.id, job.locked_by, job.attempt],",
    replace: "WHERE id = $1 AND $2::text IS NOT NULL AND $3::int IS NOT NULL AND state = 'running' FOR UPDATE\",\n    [job.id, job.locked_by, job.attempt],",
    tests: ["tests/integration/worker.test.ts"],
  },
  {
    id: "idempotency-body-conflict",
    property: "Idempotency: the same key with a changed body is 409",
    file: "src/services/idempotency.ts",
    find: "if (stored.body_hash !== args.requestHash) {",
    replace: "if (false) {",
    tests: ["tests/integration/idempotency.test.ts"],
  },
  {
    id: "bundle-hash-check",
    property: "AC-10: an edited or truncated evidence bundle is rejected (bundle hash)",
    file: "src/services/evidence.ts",
    find: 'if (hashCanonical(rest) !== claimed) fail("BUNDLE_HASH_MISMATCH", "bundle hash does not match its content");',
    replace: "void claimed;",
    tests: ["tests/integration/export-restore.test.ts"],
  },
  {
    id: "bundle-rederivation",
    property: "AC-10: a re-sealed bundle with edited findings is rejected (runs are re-derived)",
    file: "src/services/evidence.ts",
    find: "if (a.assessment !== run.verdict || !sameFindings || !sameUnknowns || !sameDetail) {",
    replace: "if (false) {",
    tests: ["tests/integration/export-restore.test.ts"],
  },
  {
    id: "readiness-gate",
    property: "AC-13: a failed migration stops readiness and the server refuses traffic",
    file: "src/api/server.ts",
    find: "if (!ctx.readiness.ok && !HEALTH_PATHS.has(path) && (isApi || !staticHandler)) throw",
    replace: "if (false) throw",
    tests: ["tests/integration/migrations.test.ts"],
  },
  {
    id: "payload-limit",
    property: "AC-09: oversize bodies are refused before processing",
    file: "src/api/server.ts",
    find: "bodyLimit: settings.smallBodyBytes,",
    replace: "bodyLimit: 1024 * 1024 * 1024,",
    tests: ["tests/integration/snapshots.test.ts"],
  },
  // Stage C-2: mutants that the acceptance suite (tests/changeradar.spec.ts) alone must catch.
  {
    id: "spec-unknown-becomes-safe",
    property: "AC-04: an unknown never becomes a safe verdict (the spec must catch it on its own)",
    file: "src/services/assess.ts",
    find: 'unknowns.length > 0 ? "INCOMPLETE" : findings.length > 0 ? "AFFECTED" : "NO_KNOWN_IMPACT";',
    replace: 'findings.length > 0 ? "AFFECTED" : "NO_KNOWN_IMPACT";',
    tests: ["tests/changeradar.spec.ts"],
  },
  {
    id: "spec-dangling-edge-accepted",
    property: "AC-01: a dangling edge target is rejected atomically (the spec must catch it on its own)",
    file: "src/services/graph.ts",
    find: "    if (!target) {\n      issues.push(issue(\"DANGLING_EDGE\", `/edges/${i}/target_id`",
    replace: "    if (false as boolean) {\n      issues.push(issue(\"DANGLING_EDGE\", `/edges/${i}/target_id`",
    tests: ["tests/changeradar.spec.ts"],
  },
  {
    id: "spec-html-not-escaped",
    property: "AC-09: hostile markup renders as text in the HTML export (the spec must catch it on its own)",
    file: "src/domain/redaction.ts",
    find: "export function escapeHtml(input: unknown): string {",
    replace: "export function escapeHtml(input: unknown): string {\n  if (input !== undefined) return String(input ?? \"\");",
    tests: ["tests/changeradar.spec.ts"],
  },
  // Review round 1: one mutant per fixed P0/P1 (the regression tests must each notice their fix being removed).
  {
    id: "r1-first-hop-evidence",
    property: "R1 P0: the evidence on an edge that only EXCLUDES a consumer is still checked (unverified, stale, future)",
    file: "src/services/diff.ts",
    find: "      examined.set(edgeKeyString(link.edge), link.edge);\n      if (current === null && options.acceptFirstHop && !options.acceptFirstHop(link)) continue;",
    replace: "      if (current === null && options.acceptFirstHop && !options.acceptFirstHop(link)) continue;\n      examined.set(edgeKeyString(link.edge), link.edge);",
    tests: ["tests/unit/review-round1-decision.test.ts"],
    filter: "R1 P0",
  },
  {
    id: "r1-version-downgrade",
    property: "R1 P1: a major version DOWNGRADE (1.2.3 to 0.9.0) is breaking",
    file: "src/domain/semver.ts",
    find: 'if (b.major !== a.major) return { breaking: true, comparable: true, why: "major version change" };',
    replace: 'if (b.major < a.major) return { breaking: true, comparable: true, why: "major version change" };',
    tests: ["tests/unit/review-round1-decision.test.ts"],
    filter: "version change rules",
  },
  {
    id: "r1-required-relevant",
    // The reviewers' `||` to `&&` mutant is VERDICT-equivalent since round 1 (a requiredness change is itself a
    // propagating, required_relevant change) but NOT output-equivalent: a combined type and requiredness change loses a
    // cause from the finding. That is pinned by `r2-required-relevant-and` (round 2). This control pins the property by
    // removing the relevance altogether instead.
    property: "R1 P1: a type change on a required field reaches consumers that declare nothing (the matrix, all 100 combinations)",
    file: "src/services/diff.ts",
    find: "required_relevant: b.required || a.required,",
    replace: "required_relevant: false,",
    tests: ["tests/unit/review-round1-decision.test.ts"],
    filter: "contract field change matrix",
  },
  {
    id: "r1-requiredness-one-way",
    property: "R1 P1: required to optional reaches consumers that declare the field",
    file: "src/services/diff.ts",
    find: '          propagation: "field",\n          required_relevant: true,',
    replace: '          propagation: a.required ? "field" : "none",\n          required_relevant: true,',
    tests: ["tests/unit/review-round1-decision.test.ts"],
    filter: "requiredness changes reach",
  },
  {
    id: "r1-baseline-hash-prefix",
    property: "R1 P2: expected_hash is compared in full, not by a prefix",
    file: "src/services/assess.ts",
    find: "if (expected !== actual) return new StaleBaselineError(expected, actual);",
    replace: "if (expected.slice(0, 27) !== actual.slice(0, 27)) return new StaleBaselineError(expected, actual);",
    tests: ["tests/unit/review-round1-decision.test.ts"],
    filter: "baseline hash comparison is exact",
  },
  {
    id: "r1-findings-unbounded-path",
    property: "R1 P1: a stored path is elided at both ends instead of listing every hop of a long chain",
    file: "src/services/diff.ts",
    find: "if (this.depth <= PATH_HEAD_HOPS + PATH_TAIL_HOPS) return { hops: this.hops, omitted: 0 };",
    replace: "if (true) return { hops: this.hops, omitted: 0 };",
    tests: ["tests/unit/review-round1-scale.test.ts"],
    filter: "bounded findings",
  },
  {
    id: "r1-truncation-silent",
    property: "R1 P1: reaching an output bound is an explicit FINDINGS_TRUNCATED unknown, never a safe verdict",
    file: "src/services/assess.ts",
    find: "  if (truncated) {\n    const parts",
    replace: "  if (false) {\n    const parts",
    tests: ["tests/unit/review-round1-scale.test.ts"],
    filter: "bounded findings",
  },
  {
    id: "r1-check-keys-dropped",
    property: "R1 P1: a requested check that never ran is an unknown (CHECK_NOT_RUN), not silently dropped",
    file: "src/workers/worker.ts",
    find: "const missingCheckKeys = run.run_checks ? run.check_keys.filter((k) => !recordedKeys.has(k)) : [];",
    replace: "const missingCheckKeys: string[] = [];",
    tests: ["tests/integration/review-round1-worker.test.ts"],
    filter: "never silently dropped",
  },
  {
    id: "r1-failwith-open-checks",
    property: "R1 P2: a run that fails for good leaves no check STARTED",
    file: "src/workers/worker.ts",
    find: '        await failRun(tx, run, "RUNNING", code, detail, revision, ctx.clock.now());\n        await concludeStartedChecksUnknown(tx, run, ctx);',
    replace: '        await failRun(tx, run, "RUNNING", code, detail, revision, ctx.clock.now());',
    tests: ["tests/integration/review-round1-worker.test.ts"],
    filter: "failWith",
  },
  {
    id: "r1-check-budget",
    property: "R1 P2: the checks of one run share a wall clock budget",
    file: "src/workers/worker.ts",
    find: "if (Date.now() - checksStarted >= ctx.settings.checks.runBudgetMs) {",
    replace: "if (false) {",
    tests: ["tests/integration/review-round1-extra.test.ts"],
    filter: "wall clock budget",
  },
  {
    id: "r1-credential-origin",
    property: "R1 P1: a stored credential is only sent to the origin it was configured for (also A to B to B)",
    file: "src/workers/safe-fetch.ts",
    find: "    originalOrigin ??= vetted.url.origin;\n    const sameOrigin = vetted.url.origin === originalOrigin;",
    replace: "    const sameOrigin = originalOrigin === null || originalOrigin === vetted.url.origin;\n    originalOrigin = vetted.url.origin;",
    tests: ["tests/integration/review-round1-fetch.test.ts"],
    filter: "credential goes only",
  },
  {
    id: "r1-json-duplicate-key",
    property: "R1 P1: a repeated JSON object key is refused, not last-wins",
    file: "src/domain/strict-json.ts",
    find: "if (frame.keys.has(key)) throw new JsonRejectedError(",
    replace: "if (false) throw new JsonRejectedError(",
    tests: ["tests/unit/strict-json.test.ts"],
  },
  {
    id: "r1-auth-before-body",
    property: "R1 P1: authentication and rate limiting run before the body is read and parsed",
    file: "src/api/server.ts",
    find: 'authed.addHook("onRequest", sessionAuth);',
    replace: 'authed.addHook("preHandler", sessionAuth);',
    tests: ["tests/integration/review-round1-api.test.ts"],
    filter: "before the body is read",
  },
  {
    id: "r1-db-outage-503",
    property: "R1 P1: a database that became unreachable is a 503 NOT_READY, not a 500",
    file: "src/platform/errors.ts",
    find: "export function isDatabaseUnavailable(error: unknown): boolean {\n  if (!(error instanceof Error)) return false;",
    replace: "export function isDatabaseUnavailable(error: unknown): boolean {\n  if (error !== undefined) return false;\n  if (!(error instanceof Error)) return false;",
    tests: ["tests/integration/review-round1-api.test.ts"],
    filter: "database outage",
  },
  {
    id: "r1-redaction-npm",
    property: "R1 P1: an npm token is detected and redacted",
    file: "src/domain/redaction.ts",
    find: '  { kind: "npm_token", regex: /npm_[A-Za-z0-9]{20,}/g },\n',
    replace: "",
    tests: ["tests/unit/review-round1-redaction.test.ts"],
    filter: "shapes that used to pass",
  },
  {
    id: "r1-redaction-fold",
    property: "R1 P1: zero-width split and fullwidth secrets are seen (NFKC fold with the invisible characters removed)",
    file: "src/domain/redaction.ts",
    find: "const folded = needsFold ? fold(source) : null;",
    replace: "const folded: Folded | null = null;",
    tests: ["tests/unit/review-round1-redaction.test.ts"],
    filter: "shapes that used to pass",
  },
  {
    id: "r1-view-redaction",
    property: "R1 P1: node and edge views are redacted on the way out",
    file: "src/services/snapshots.ts",
    find: "const items = stored.map((row) => redactDeep(row) as NodeView);",
    replace: "const items = stored as NodeView[];",
    tests: ["tests/integration/review-round1-api.test.ts"],
    filter: "stored rows are redacted",
  },
  {
    id: "r1-cli-interrupt",
    property: "R1 P1: an interrupted one-shot command never exits 0",
    file: "src/cli.ts",
    find: "process.exit(interruptedExit));",
    replace: "process.exit(EXIT.ok));",
    tests: ["tests/integration/review-round1-cli.test.ts"],
    filter: "interrupted one-shot command",
  },
  {
    id: "r1-cli-repeated-flag",
    property: "R1 P2: a repeated flag is a usage error, not last-wins",
    file: "src/commands/run.ts",
    find: 'if (Object.hasOwn(flags, key)) throw new UsageError(`--${key} was given more than once`);',
    replace: "",
    tests: ["tests/integration/review-round1-cli.test.ts"],
    filter: "repeated, value-less",
  },
  // ---- review round 2: every one must be killed by a FAILING TEST that fails on an assertion ----
  { id: "r2-aws-run", property: "R2: an AWS-shaped run is consumed whole (no residue, idempotent)", file: "src/domain/redaction.ts", find: "[0-9A-Z]{16}[0-9A-Z]*/g },", replace: "[0-9A-Z]{16}(?![0-9A-Z])/g },", tests: ["tests/unit/review-round2-redaction.test.ts"], filter: "idempotence" },
  { id: "r2-quoted-run-parity", property: "R2 P1: a quote closes a value only after an even (or exactly the opening) backslash run", file: "src/domain/redaction.ts", find: "if (openRun > 0 ? run === openRun : run % 2 === 0) return", replace: "if (true) return", tests: ["tests/unit/review-round2-redaction.test.ts"], filter: "escaped quotes" },
  { id: "r2-identifier-keys", property: "R2 P2: from, to and the node id lists are identifier fields (validator strength)", file: "src/domain/redaction.ts", find: "|from|to|origin_node_ids|changed_node_ids)$/;", replace: ")$/;", tests: ["tests/unit/review-round2-redaction.test.ts"], filter: "identifier fields shown" },
  { id: "r2-oversize-refused", property: "R2 P2: text above the scan cap is refused, never passed through", file: "src/domain/redaction.ts", find: "if (source.length > MAX_SCAN_CHARS) return null;", replace: "", tests: ["tests/unit/review-round2-redaction.test.ts"], filter: "above the size cap the redactor REFUSES" },
  { id: "r2-fold-cap", property: "R2 P2: non-ASCII text above the fold cap is refused", file: "src/domain/redaction.ts", find: "if (needsFold && source.length > MAX_FOLD_CHARS) return null;", replace: "", tests: ["tests/unit/review-round2-redaction.test.ts"], filter: "capped lower" },
  // (U+034F itself is a combining mark and is also dropped by the \p{M} rule, so removing it from the list is an EQUIVALENT mutant; U+3164 is a letter and only the list removes it.)
  { id: "r2-invisible-3164", property: "R2 P2: U+3164 (Hangul filler) is folded away before matching", file: "src/domain/redaction.ts", find: "cp === 0x3164 ||\n", replace: "", tests: ["tests/unit/review-round2-redaction.test.ts"], filter: "U\\+3164" },
  { id: "r2-truncated-partial", property: "R2 P1: a traversal cut inside one origin forces FINDINGS_TRUNCATED", file: "src/services/assess.ts", find: "if (traversal.truncated) originsTruncated += 1;", replace: "", tests: ["tests/unit/review-round2-truncation.test.ts"], filter: "traversal cut inside ONE origin" },
  { id: "r2-origin-not-analyzed", property: "R2 P1: an origin skipped after the budget is used up forces FINDINGS_TRUNCATED", file: "src/services/assess.ts", find: "originsNotAnalyzed.push(originId);", replace: "void originId;", tests: ["tests/unit/review-round2-truncation.test.ts"], filter: "later origin skipped" },
  { id: "r2-produces-fields", property: "R2 P1: `fields` on a produces edge never filters", file: "src/services/diff.ts", find: 'if (edge.relation === "produces" || edge.fields === null) return null;', replace: "if (edge.fields === null) return null;", tests: ["tests/unit/review-round2-logic.test.ts"], filter: "produces edge" },
  { id: "r2-typo-fields-unusable", property: "R2 P1: a declaration naming fields the baseline contract lacks is unusable", file: "src/services/diff.ts", find: "if (originFields !== null && edge.fields.some((name) => !originFields.has(name))) return null;", replace: "", tests: ["tests/unit/review-round2-logic.test.ts"], filter: "names fields the baseline contract lacks" },
  { id: "r2-typo-fields-unknown", property: "R2 P1: an unusable baseline declaration is recorded as an unknown", file: "src/services/assess.ts", find: 'if (edge.relation === "produces" || edge.target_id !== originId || edge.fields === null) continue;', replace: "continue;", tests: ["tests/unit/review-round2-logic.test.ts"], filter: "names fields the baseline contract lacks" },
  { id: "r2-semver-prerelease-target", property: "R2 P2: moving into a prerelease is breaking", file: "src/domain/semver.ts", find: "if (a.prerelease !== null && !(sameCore && b.prerelease === a.prerelease)) {", replace: "if (false) {", tests: ["tests/unit/review-round2-logic.test.ts"], filter: "moving INTO a prerelease" },
  { id: "r2-semver-zero-zero", property: "R2 P2: a patch change at 0.0.x is breaking", file: "src/domain/semver.ts", find: 'if (b.major === 0 && b.minor === 0 && b.patch !== a.patch) return { breaking: true, comparable: true, why: "patch version change at 0.0" };', replace: "", tests: ["tests/unit/review-round2-logic.test.ts"], filter: "moving INTO a prerelease" },
  { id: "r2-required-relevant-and", property: "R2 P2: the reviewers' `||` to `&&` mutant is output-visible: a combined type and requiredness change names both causes", file: "src/services/diff.ts", find: "required_relevant: b.required || a.required,", replace: "required_relevant: b.required && a.required,", tests: ["tests/unit/review-round2-logic.test.ts"], filter: "causes are complete" },
  { id: "r2-engine-version-refusal", property: "R2 P2: a run from another engine version is refused with its own code", file: "src/services/evidence.ts", find: "if (Number.isNaN(recordedEngine) || recordedEngine > ENGINE_VERSION) {", replace: "if (false) {", tests: ["tests/integration/review-round2-evidence.test.ts"], filter: "refused with its own code" },
  { id: "r2-finding-field-compare", property: "R2 P1: a resealed bundle with an edited finding severity is rejected", file: "src/services/evidence.ts", find: "severity: f.severity, direct: f.direct,", replace: "severity: row.severity, direct: f.direct,", tests: ["tests/integration/review-round2-evidence.test.ts"], filter: "finding severity" },
  { id: "r2-export-self-verify", property: "R2 P1: export verifies its own bundle and fails closed", file: "src/services/evidence.ts", find: "verifyBundle(serialized, { maxBytes: Number.MAX_SAFE_INTEGER });", replace: "void serialized;", tests: ["tests/integration/review-round2-evidence.test.ts"], filter: "fails closed when the stored run no longer reproduces" },
  { id: "r2-restore-checks-disabled", property: "R2 P2: restore brings contract checks back disabled", file: "src/services/restore.ts", find: "$10::jsonb,$11,false,$12,$13)", replace: "$10::jsonb,$11,true,$12,$13)", tests: ["tests/integration/review-round2-evidence.test.ts"], filter: "checks come back disabled" },
  { id: "r2-check-keys-resolved", property: "R2 P2: auto-selected checks are resolved at request time", file: "src/services/impact.ts", find: "keys = selected.map((row) => row.check_key);", replace: "keys = null;", tests: ["tests/integration/review-round2-evidence.test.ts"], filter: "disabled between request and worker" },
  { id: "r2-engine-flag", property: "R2 P2: a run from an older engine is flagged re-run required", file: "src/services/impact.ts", find: "rerun_required: stale,", replace: "rerun_required: false,", tests: ["tests/unit/review-round2-logic.test.ts"], filter: "older engine is flagged" },
  { id: "r2-graph-echo", property: "R2 P1: a 422 detail never repeats a submitted id", file: "src/services/graph.ts", find: "`this edge target is not a declared node`", replace: "`edge target ${edge.target_id} is not a declared node`", tests: ["tests/integration/review-round2-evidence.test.ts"], filter: "never repeat a submitted id" },
  { id: "r2-cli-neutralize", property: "R2 P1: CLI stderr is escaped", file: "src/commands/run.ts", find: "err: (message) => rawIo.err(neutralize(message)),", replace: "err: (message) => rawIo.err(message),", tests: ["tests/integration/review-round2-cli.test.ts"], filter: "text from a hostile file" },
  { id: "r2-cli-help-stdout", property: "R2 P3: asked-for help goes to stdout", file: "src/commands/run.ts", find: "(asked ? io.out : io.err)(USAGE);", replace: "io.err(USAGE);", tests: ["tests/integration/review-round2-cli.test.ts"], filter: "asked-for help" },
  { id: "r2-cli-proto-flag", property: "R2 P3: --__proto__ is an unknown flag", file: "src/commands/run.ts", find: "const flags: Flags = Object.create(null) as Flags;", replace: "const flags: Flags = {};", tests: ["tests/integration/review-round2-cli.test.ts"], filter: "__proto__" },
  { id: "r2-stdin-cap", property: "R2 P2: standard input is capped", file: "src/cli.ts", find: "if (total > STDIN_LIMIT_BYTES) throw", replace: "if (false) throw", tests: ["tests/integration/review-round2-cli.test.ts"], filter: "standard input is capped" },
  { id: "r2-export-ratelimit", property: "R2 P2: exports have their own per-user budget", file: "src/api/server.ts", find: "const EXPORTS_PER_WINDOW = 12;", replace: "const EXPORTS_PER_WINDOW = 1_000_000;", tests: ["tests/integration/review-round2-evidence.test.ts"], filter: "13th export" },
  { id: "r2-shutdown-force", property: "R2 P2: shutdown closes slow connections after the grace period", file: "src/api/bootstrap.ts", find: "() => app.server.closeAllConnections()", replace: "() => undefined", tests: ["tests/integration/review-round2-server.test.ts"], filter: "stop\\(\\) closes an incomplete request" },
  { id: "r2-check-identifier-scan", property: "R2 P2: a secret-shaped check key or node id is refused", file: "src/services/checks.ts", find: "if (containsSecret(b.key) || containsSecret(b.node_id))", replace: "if (false)", tests: ["tests/integration/review-round2-server.test.ts"], filter: "secret-shaped check key" },
  { id: "r2-snapshot-summary-redaction", property: "R2 P2: snapshot summaries are redacted", file: "src/services/snapshots.ts", find: "revision: redactDeep(r.revision) as string,", replace: "revision: r.revision,", tests: ["tests/integration/review-round2-server.test.ts"], filter: "snapshot summaries" },
  { id: "r2-runner-getter", property: "R2 P3: runContractCheck never rejects when reading the outcome throws", file: "src/domain/contract-checks.ts", find: "  } catch (error) {\n    return runnerError(error);\n  }\n  return { state: \"UNKNOWN\"", replace: "  } catch (error) {\n    throw error;\n  }\n  return { state: \"UNKNOWN\"", tests: ["tests/unit/review-round2-platform.test.ts"], filter: "getter throws is an ERROR" },
  { id: "r2-503-retry-after", property: "R2 P3: every 503 carries Retry-After", file: "src/platform/errors.ts", find: 'new AppError(503, code, message, { "retry-after": "5" })', replace: "new AppError(503, code, message)", tests: ["tests/unit/review-round2-platform.test.ts"], filter: "readiness 503" },
  { id: "r2-db-class-08", property: "R2 P2: SQLSTATE class 08 is a database outage", file: "src/platform/errors.ts", find: 'code.startsWith("08")', replace: 'code.startsWith("08x")', tests: ["tests/unit/review-round2-platform.test.ts"], filter: "class 08" },
  { id: "r2-db-aggregate", property: "R2 P2: an AggregateError holding an outage is an outage", file: "src/platform/errors.ts", find: "if (error instanceof AggregateError && error.errors.some(isDatabaseUnavailable)) return true;", replace: "", tests: ["tests/unit/review-round2-platform.test.ts"], filter: "AggregateError is an outage" },
  { id: "r2-contract-view-rename", property: "R2 contract: a response member renamed (assessment to verdict) fails a contract test", file: "src/services/impact.ts", find: "    assessment: currentAssessment(run.verdict, engine),\n    recorded_assessment: recordedAssessment(run.verdict, engine),", replace: "    verdict: currentAssessment(run.verdict, engine),\n    recorded_assessment: recordedAssessment(run.verdict, engine),", tests: ["tests/integration/review-round2-contract.test.ts"], filter: "conforms to the shipped schemas" },
  { id: "r2-contract-findings-cursor", property: "R2 contract: a response member removed (next_cursor of the findings page) fails a contract test", file: "src/services/impact.ts", find: "return { items: page.map((r) => redactDeep(toFindingView(r)) as FindingView), next_cursor:", replace: "return { items: page.map((r) => redactDeep(toFindingView(r)) as FindingView), cursor:", tests: ["tests/integration/review-round2-contract.test.ts"], filter: "conforms to the shipped schemas" },
  { id: "r2-restore-yield", property: "R2 P2: restore gives the event loop a turn per snapshot, so a signal is seen", file: "src/services/restore.ts", find: "await nextTurn();\n      const built = buildGraph(s.manifest);", replace: "const built = buildGraph(s.manifest);", tests: ["tests/integration/review-round2-cli.test.ts"], filter: "event loop a turn" },
  // Review round 3.
  { id: "r3-restore-method", property: "R3 P1: restore keeps a check's method", file: "src/services/restore.ts", find: "capText(c.url), c.method, c.timeout_ms", replace: 'capText(c.url), "GET", c.timeout_ms', tests: ["tests/integration/export-restore.test.ts"], filter: "restores into a clean installation" },
  { id: "r3-restore-timeout", property: "R3 P1: restore keeps a check's timeout", file: "src/services/restore.ts", find: "c.method, c.timeout_ms,", replace: "c.method, 5000,", tests: ["tests/integration/export-restore.test.ts"], filter: "restores into a clean installation" },
  { id: "r3-restore-retries", property: "R3 P1: restore keeps a check's retries", file: "src/services/restore.ts", find: "c.timeout_ms, c.retries,", replace: "c.timeout_ms, 0,", tests: ["tests/integration/export-restore.test.ts"], filter: "restores into a clean installation" },
  { id: "r3-restore-expect-status", property: "R3 P1: restore keeps a check's expected status", file: "src/services/restore.ts", find: "c.retries, c.expect_status,", replace: "c.retries, 200,", tests: ["tests/integration/export-restore.test.ts"], filter: "restores into a clean installation" },
  { id: "r3-restore-required-fields", property: "R3 P1: restore keeps a check's required fields", file: "src/services/restore.ts", find: "JSON.stringify(capLeaves(c.required_fields)), capText(c.credential_alias),", replace: '"[]", capText(c.credential_alias),', tests: ["tests/integration/export-restore.test.ts"], filter: "restores into a clean installation" },
  { id: "r3-restore-credential-alias", property: "R3 P1: restore keeps a check's credential alias", file: "src/services/restore.ts", find: "JSON.stringify(capLeaves(c.required_fields)), capText(c.credential_alias), c.created_at", replace: "JSON.stringify(capLeaves(c.required_fields)), null, c.created_at", tests: ["tests/integration/export-restore.test.ts"], filter: "restores into a clean installation" },
  { id: "r3-restore-cap-revision", property: "R3 P2: restore caps the snapshot revision", file: "src/services/restore.ts", find: "capText(s.revision)", replace: "s.revision", tests: ["tests/integration/review-round3-evidence.test.ts"], filter: "cut to 2000 characters" },
  { id: "r3-restore-cap-error-detail", property: "R3 P2: restore caps a run's error detail", file: "src/services/restore.ts", find: "capText(r.error_detail)", replace: "r.error_detail", tests: ["tests/integration/review-round3-evidence.test.ts"], filter: "cut to 2000 characters" },
  { id: "r3-restore-cap-warnings", property: "R3 P2: restore caps the free text inside snapshot warnings", file: "src/services/restore.ts", find: "JSON.stringify(capLeaves(s.warnings))", replace: "JSON.stringify(s.warnings)", tests: ["tests/integration/review-round3-evidence.test.ts"], filter: "cut to 2000 characters" },
  { id: "r3-bundle-text-error-detail", property: "R3 P1: a run's error detail is redacted in a bundle", file: "src/services/evidence.ts", find: "error_detail: r.error_detail === null ? null : (capText(redactDeep(r.error_detail) as string) as string),", replace: "error_detail: r.error_detail,", tests: ["tests/integration/review-round3-evidence.test.ts"], filter: "legacy row and a crafted bundle" },
  { id: "r3-bundle-text-contract-checks", property: "R3 P1: contract check definitions are redacted in a bundle", file: "src/services/evidence.ts", find: "contract_checks: body.contract_checks.map((c) => redactIdentifiers(c) as typeof c),", replace: "contract_checks: body.contract_checks,", tests: ["tests/integration/review-round3-evidence.test.ts"], filter: "legacy row and a crafted bundle" },
  { id: "r3-bundle-text-workspace-name", property: "R3 P1: the workspace name is redacted in a bundle", file: "src/services/evidence.ts", find: "name: redactIdentifier(body.workspace.name)", replace: "name: body.workspace.name", tests: ["tests/integration/review-round3-evidence.test.ts"], filter: "legacy row and a crafted bundle" },
  { id: "r3-check-required-fields-scan", property: "R3 P1: a secret-shaped required field name is refused at creation", file: "src/services/checks.ts", find: "b.required_fields.some((field) => containsSecret(field.name)) || ", replace: "", tests: ["tests/integration/review-round3-evidence.test.ts"], filter: "secret-shaped required field name" },
  { id: "r3-check-reenable", property: "R3 P1: re-creating a disabled check re-enables it", file: "src/services/checks.ts", find: "credential_alias = $10, enabled = true, disabled_at = NULL", replace: "credential_alias = $10, enabled = false, disabled_at = NULL", tests: ["tests/integration/review-round3-evidence.test.ts"], filter: "can be re-created and re-enabled" },
  { id: "r3-check-enabled-conflict", property: "R3 P1: an ENABLED key is still a conflict", file: "src/services/checks.ts", find: "if (previous?.enabled) throw conflict(", replace: "if (false) throw conflict(", tests: ["tests/integration/review-round3-evidence.test.ts"], filter: "can be re-created and re-enabled" },
  { id: "r3-stale-run-verifies", property: "R3 P1: an older-engine run verifies on its hashes (an upgrade never blocks export)", file: "src/services/evidence.ts", find: "      continue;\n    }\n    const results = run.checks", replace: "    }\n    const results = run.checks", tests: ["tests/integration/review-round3-evidence.test.ts"], filter: "genuine 2cc918e bundle verifies" },
  { id: "r3-stale-run-listed", property: "R3 P1: an older-engine run is reported as stale", file: "src/services/evidence.ts", find: 'isStaleEngineRun(r.status === "COMPLETE", ', replace: "isStaleEngineRun(false, ", tests: ["tests/integration/review-round3-evidence.test.ts"], filter: "genuine 2cc918e bundle verifies" },
  { id: "r3-list-rerun-flag", property: "R3 P1: the run list flags an older-engine run", file: "src/services/impact.ts", find: "rerun_required: engine.rerun_required,", replace: "rerun_required: engine.rerun_required && false,", tests: ["tests/integration/review-round3-api.test.ts"], filter: "the run list flags a run from an older engine" },
  { id: "r3-html-stale-block", property: "R3 P1: the HTML report never shows a current-looking verdict for an older-engine run", file: "src/report/html-report.ts", find: 'if (run.status === "complete" && run.engine?.rerun_required) {', replace: "if (false) {", tests: ["tests/integration/review-round3-evidence.test.ts"], filter: "nothing old looks safe" },
  { id: "r3-html-id-strength", property: "R3 P2: the HTML report prints accepted ids at identifier strength", file: "src/report/html-report.ts", find: "escapeHtml(redactIdentifier(value === null", replace: "escapeHtml(logText(value === null", tests: ["tests/integration/review-round3-api.test.ts"], filter: "two different accepted ids" },
  { id: "r3-quoted-key-run", property: "R3 P1: a quoted credential key at JSON depth 2 or more is recognised", file: "src/domain/redaction.ts", find: "if (keyRun > 0) i += text[i + keyRun] === '\"' || text[i + keyRun] === \"'\" ? keyRun : 1;", replace: "if (keyRun > 0) i += 1;", tests: ["tests/unit/review-round3-redaction.test.ts"] },
  { id: "r3-finding-position", property: "R3 P1: finding positions 0, 1, 2, ... are verified", file: "src/services/evidence.ts", find: "row.position !== index", replace: "false", tests: ["tests/integration/review-round3-evidence.test.ts"], filter: "each edit of a resealed bundle is rejected" },
  { id: "r3-finding-path-omitted", property: "R3 P1: path_omitted_hops of a finding is compared", file: "src/services/evidence.ts", find: "hops: row.hops, path_omitted_hops: row.path_omitted_hops,", replace: "hops: row.hops, path_omitted_hops: f.path_omitted_hops ?? 0,", tests: ["tests/integration/review-round3-evidence.test.ts"], filter: "each edit of a resealed bundle is rejected" },
  { id: "r3-finding-change-ids-omitted", property: "R3 P1: change_ids_omitted of a finding is compared", file: "src/services/evidence.ts", find: "change_ids: row.change_ids, change_ids_omitted: row.change_ids_omitted,", replace: "change_ids: row.change_ids, change_ids_omitted: f.change_ids_omitted ?? 0,", tests: ["tests/integration/review-round3-evidence.test.ts"], filter: "each edit of a resealed bundle is rejected" },
  { id: "r3-detail-compare", property: "R3 P1: the assessment detail (coverage, changes) is compared", file: "src/services/evidence.ts", find: "const sameDetail = sameText(rederivedDetail, detail);", replace: "const sameDetail = true;", tests: ["tests/integration/review-round3-evidence.test.ts"], filter: "each edit of a resealed bundle is rejected" },
  { id: "r3-unknowns-compare", property: "R3 P1: the unknown text of a run is compared", file: "src/services/evidence.ts", find: "const sameUnknowns = sameText(a.unknowns, run.unknowns);", replace: "const sameUnknowns = true;", tests: ["tests/integration/review-round3-evidence.test.ts"], filter: "each edit of a resealed bundle is rejected" },
  { id: "r3-cursor-numeric", property: "R3 P2: a numeric cursor part is a non-negative safe integer", file: "src/platform/cursor.ts", find: 'return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;', replace: 'return typeof value === "number";', tests: ["tests/integration/review-round3-api.test.ts"], filter: "numeric cursor" },
  { id: "r3-unknown-check-echo", property: "R3 P2: a 422 UNKNOWN_CHECK never repeats a submitted key", file: "src/services/impact.ts", find: "{ count: unknown.length, indexes:", replace: "{ unknown_keys: unknown, count: unknown.length, indexes:", tests: ["tests/integration/review-round3-api.test.ts"], filter: "never echoes the submitted check keys" },
  { id: "r3-bundle-budget", property: "R3 P2: bundles have a smaller per-user budget than exports", file: "src/api/server.ts", find: "const BUNDLES_PER_WINDOW = 4;", replace: "const BUNDLES_PER_WINDOW = 12;", tests: ["tests/integration/review-round3-api.test.ts"], filter: "bundles have a smaller budget" },
  { id: "r3-export-budget-exact", property: "R3 P2: the export budget is exactly 12 per window", file: "src/api/server.ts", find: "const EXPORTS_PER_WINDOW = 12;", replace: "const EXPORTS_PER_WINDOW = 13;", tests: ["tests/integration/review-round3-api.test.ts"], filter: "the 13th export in a window" },
  { id: "r3-export-concurrency", property: "R3 P2: no more than two exports are built at once", file: "src/api/server.ts", find: "const MAX_CONCURRENT_EXPORTS = 2;", replace: "const MAX_CONCURRENT_EXPORTS = 99;", tests: ["tests/integration/review-round3-api.test.ts"], filter: "no more than two exports" },
  { id: "r3-bundle-size-cap", property: "R3 P2: a bundle above the installation limit is refused at export", file: "src/services/evidence.ts", find: "if (opts.maxBytes !== undefined && byteLength > opts.maxBytes) {", replace: "if (false) {", tests: ["tests/integration/review-round3-api.test.ts"], filter: "BUNDLE_TOO_LARGE at export" },
  { id: "r3-bundle-size-cap-wiring", property: "R3 P2: the run bundle endpoint passes the installation limit", file: "src/services/evidence.ts", find: "{ maxBytes: ctx.settings.maxBundleBytes }", replace: "{}", tests: ["tests/integration/review-round3-api.test.ts"], filter: "BUNDLE_TOO_LARGE at export" },
  { id: "r3-readiness-retry-after", property: "R3 P3: the readiness gate's 503 carries Retry-After on every route", file: "src/api/server.ts", find: 'throw unavailable("NOT_READY", `Service is not ready (${ctx.readiness.reason})`);', replace: 'throw new AppError(503, "NOT_READY", `Service is not ready (${ctx.readiness.reason})`);', tests: ["tests/integration/review-round3-api.test.ts"], filter: "readiness gate" },
  { id: "r3-semver-same-core", property: "R3 P2: a prerelease that moves to another patch is breaking", file: "src/domain/semver.ts", find: "const sameCore = a.minor === b.minor && a.patch === b.patch;", replace: "const sameCore = a.minor === b.minor;", tests: ["tests/unit/review-round3-logic.test.ts"] },
  { id: "r3-new-required-added", property: "R3 P2: a newly added required field reaches every consumer", file: "src/services/diff.ts", find: 'if (change.kind === "contract_field_added" || (change.kind', replace: 'if ((change.kind', tests: ["tests/unit/review-round3-logic.test.ts"] },
  { id: "r3-new-required-flipped", property: "R3 P2: a field that becomes required reaches every consumer", file: "src/services/diff.ts", find: '(change.kind === "contract_field_requirement_changed" && change.after === "required")) return true;', replace: "false) return true;", tests: ["tests/unit/review-round3-logic.test.ts"] },
  { id: "r3-engine-version", property: "R3 P2: the engine version moved with the rule change", file: "src/services/assess.ts", find: "export const ENGINE_VERSION = 3;", replace: "export const ENGINE_VERSION = 2;", tests: ["tests/unit/review-round3-logic.test.ts"], filter: "the engine version says the rules changed" },
  { id: "r3-cli-stdout-neutralize", property: "R3 P3: CLI stdout is escaped like stderr", file: "src/commands/run.ts", find: "out: (message) => rawIo.out(neutralize(message)),", replace: "out: (message) => rawIo.out(message),", tests: ["tests/integration/review-round3-cli.test.ts"], filter: "never reaches stdout raw" },
  { id: "r3-stdin-boundary", property: "R3 P2: the stdin cap is exactly 65,536 bytes", file: "src/cli.ts", find: "if (total > STDIN_LIMIT_BYTES) throw", replace: "if (total >= STDIN_LIMIT_BYTES) throw", tests: ["tests/integration/review-round3-cli.test.ts"], filter: "65,536 bytes pass the cap" },
  { id: "r3-restore-message-same-key", property: "R3 P1: the restore message names the way that works (re-create with the SAME key)", file: "src/commands/run.ts", find: "POST /api/v1/contract-checks with the SAME key", replace: "POST /api/v1/contract-checks with a new key", tests: ["tests/integration/review-round3-cli.test.ts"], filter: "names re-creating with the SAME key" },
  // Redactor cross-check (unit level).
  { id: "r3x-key-run-cap", property: "R3 cross-check: the backslash run before a quoted key has no fixed cap", file: "src/domain/redaction.ts", find: 'while (text[i + keyRun] === "\\\\") keyRun += 1;', replace: 'while (text[i + keyRun] === "\\\\" && keyRun < 64) keyRun += 1;', tests: ["tests/unit/review-round3-crosscheck.test.ts"] },
  { id: "r3x-open-run-cap", property: "R3 cross-check: the backslash run before a quoted value has no fixed cap", file: "src/domain/redaction-forms.ts", find: 'while (text[i + openRun] === "\\\\") openRun += 1;', replace: 'while (text[i + openRun] === "\\\\" && openRun < 64) openRun += 1;', tests: ["tests/unit/review-round3-crosscheck.test.ts"] },
  { id: "r3x-key-suffix-cap", property: "R3 cross-check: a credential word inside a long key name still introduces an assignment", file: "src/domain/redaction.ts", find: "while (i < text.length && isKeyChar(text.charCodeAt(i))) i += 1;\n      runEnd = i;", replace: "while (i < text.length && i < keyEnd + 30 && isKeyChar(text.charCodeAt(i))) i += 1;\n      runEnd = i;", tests: ["tests/unit/review-round3-crosscheck.test.ts"] },
  { id: "r3x-yaml-next-line", property: "R3 cross-check: a value on the line after `key:` is redacted", file: "src/domain/redaction.ts", find: 'i = separator === ":" ? skipGap(text, after) : skipBlank(text, after);', replace: "i = skipBlank(text, after);", tests: ["tests/unit/review-round3-crosscheck.test.ts"] },
  { id: "r3x-arrow-operators", property: "R3 cross-check: `=>` and `:=` assign", file: "src/domain/redaction.ts", find: 'if ((separator === "=" && text[after] === ">") || (separator === ":" && text[after] === "=")) after += 1;', replace: "void after;", tests: ["tests/unit/review-round3-crosscheck.test.ts"] },
  { id: "r3x-name-hides-value", property: "R3 cross-check: a property name that held a secret hides its value (idempotence)", file: "src/domain/redaction.ts", find: "|| safeKey !== key || pairedValues.has(key);", replace: "|| pairedValues.has(key);", tests: ["tests/unit/review-round3-crosscheck.test.ts"] },
  { id: "r3x-identifier-keys", property: "R3 cross-check: redactIdentifiers redacts property names", file: "src/domain/redaction.ts", find: "put(out, redactIdentifier(key), redactIdentifiers(item, depth + 1));", replace: "put(out, key, redactIdentifiers(item, depth + 1));", tests: ["tests/unit/review-round3-crosscheck.test.ts"] },
  { id: "r3x-bracket-key-group", property: "R3 cross-check: a bracketed token glued to a credential word belongs to the key", file: "src/domain/redaction.ts", find: 'if (text[i] === "<" || text[i] === "[" || text[i] === "(") {', replace: "if (false) {", tests: ["tests/unit/review-round3-crosscheck.test.ts"] },
  // Review round 4.
  { id: "r4-cli-export-cap", property: "R4 P1: the CLI export honours the bundle limit", file: "src/commands/run.ts", find: "ctx.clock.now(), { maxBytes: ctx.settings.maxBundleBytes });", replace: "ctx.clock.now());", tests: ["tests/integration/review-round4-export-cap.test.ts"], filter: "honours CHANGERADAR_MAX_BUNDLE_BYTES" },
  { id: "r4-bundle-bytes", property: "R4 P1: the bundle limit is measured in bytes", file: "src/services/evidence.ts", find: 'const byteLength = Buffer.byteLength(serialized, "utf8");', replace: "const byteLength = serialized.length;", tests: ["tests/integration/review-round4-export-cap.test.ts"], filter: "compared in bytes" },
  { id: "r4-assessment-null", property: "R4: a run from an older engine has no current assessment", file: "src/services/impact.ts", find: "return engine.rerun_required ? null : verdict;", replace: "return verdict;", tests: ["tests/integration/review-round4-stale.test.ts"] },
  { id: "r4-recorded-assessment", property: "R4: the old verdict is kept as recorded_assessment", file: "src/services/impact.ts", find: "return engine.rerun_required ? verdict : null;", replace: "return null;", tests: ["tests/integration/review-round4-stale.test.ts"] },
  { id: "r4-html-stale-body", property: "R4: the HTML body of a stale run makes no present-tense claim", file: "src/report/html-report.ts", find: "const stale = isStale(report);", replace: "const stale = false;", tests: ["tests/integration/review-round4-stale.test.ts"], filter: "makes no present-tense claim" },
  { id: "r4-html-stale-facts", property: "R4: the counts of a stale run are labelled as the older engine's", file: "src/report/html-report.ts", find: '[isStale(report) ? "Findings (older engine)" : "Findings",', replace: '["Findings",', tests: ["tests/integration/review-round4-stale.test.ts"], filter: "makes no present-tense claim" },
  { id: "r4-cursor-int4", property: "R4 P2: a position cursor must fit the column", file: "src/platform/cursor.ts", find: "value <= 2_147_483_647", replace: "value <= 9_007_199_254_740_991", tests: ["tests/integration/review-round4-cursors.test.ts"] },
  { id: "r4-cursor-calendar", property: "R4 P2: a cursor timestamp is a real calendar date", file: "src/platform/cursor.ts", find: "return day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate();", replace: "return day >= 1 && day <= 31;", tests: ["tests/integration/review-round4-cursors.test.ts"] },
  { id: "r4-data-exception", property: "R4 P2: a database data exception is a 400", file: "src/api/server.ts", find: "if (isDataException(error)) {", replace: "if (false) {", tests: ["tests/integration/review-round4-cursors.test.ts"], filter: "data exception" },
  { id: "r4-limiter-evict", property: "R4 P2: a full limiter makes room from idle buckets", file: "src/platform/rate-limit.ts", find: "if (this.hits.size >= this.maxBuckets && !this.evictIdle())", replace: "if (this.hits.size >= this.maxBuckets)", tests: ["tests/unit/review-round4-rate-limit.test.ts"] },
  { id: "r4-limiter-keeps-throttled", property: "R4 P2: a throttled bucket is never evicted", file: "src/platform/rate-limit.ts", find: "if (entry.count >= this.limit) this.idle.delete(key);", replace: "", tests: ["tests/unit/review-round4-rate-limit.test.ts"] },
  { id: "r4-address-v6", property: "R4 P2: an IPv6 client is keyed by its /64", file: "src/platform/rate-limit.ts", find: 'if (!ip.includes(":")) return ip;', replace: "return ip;", tests: ["tests/unit/review-round4-rate-limit.test.ts"] },
  { id: "r4-stale-verdict-rows", property: "R4 P2: a stale run's verdict must agree with its rows", file: "src/services/evidence.ts", find: 'if (run.verdict === "NO_KNOWN_IMPACT" && (run.findings.length > 0 || unknowns.length > 0)) return', replace: 'if (false) return', tests: ["tests/integration/review-round4-evidence.test.ts"], filter: "contradict" },
  { id: "r4-stale-summary-count", property: "R4 P2: a stale run's summary must count its rows", file: "src/services/evidence.ts", find: "if (summary && typeof summary.findings === \"number\" && !truncated && summary.findings !== run.findings.length)", replace: "if (false)", tests: ["tests/integration/review-round4-evidence.test.ts"], filter: "contradict" },
  { id: "r4-restore-cap-check-key", property: "R4 P2: restore caps a run check's key", file: "src/services/restore.ts", find: "capText(c.check_key)", replace: "c.check_key", tests: ["tests/integration/review-round4-restore-caps.test.ts"] },
  { id: "r4-restore-cap-expected-hash", property: "R4 P2: restore caps a run's expected hash", file: "src/services/restore.ts", find: "capText(r.expected_hash)", replace: "r.expected_hash", tests: ["tests/integration/review-round4-restore-caps.test.ts"] },
  { id: "r4-restore-cap-check-keys", property: "R4 P2: restore caps the check keys of a run", file: "src/services/restore.ts", find: "JSON.stringify(capLeaves(r.check_keys))", replace: "JSON.stringify(r.check_keys)", tests: ["tests/integration/review-round4-restore-caps.test.ts"] },
  { id: "r4-restore-cap-finding", property: "R4 P2: restore caps the text of a finding", file: "src/services/restore.ts", find: "...(capLeaves(f) as typeof f)", replace: "...f", tests: ["tests/integration/review-round4-restore-caps.test.ts"] },
  { id: "r4-restore-cap-contract-url", property: "R4 P2: restore caps a contract check's url", file: "src/services/restore.ts", find: "capText(c.url)", replace: "c.url", tests: ["tests/integration/review-round4-restore-caps.test.ts"] },
  { id: "r4-audit-login", property: "R4 P3: a login is audited", file: "src/services/auth.ts", find: 'action: "auth.login",', replace: 'action: "auth.loginx",', tests: ["tests/integration/review-round4-audit.test.ts"] },
  { id: "r4-audit-logout", property: "R4 P3: a logout is audited", file: "src/services/auth.ts", find: 'action: "auth.logout",', replace: 'action: "auth.logoutx",', tests: ["tests/integration/review-round4-audit.test.ts"] },
  { id: "r4-audit-downloads", property: "R4 P3: evidence downloads are audited", file: "src/api/server.ts", find: "registerAccessAudit(app, ctx, who);", replace: "void who;", tests: ["tests/integration/review-round4-audit.test.ts"] },
  { id: "r4-audit-only-success", property: "R4 P3: a refused request leaves no audit row", file: "src/api/access-audit.ts", find: 'reply.statusCode !== 200) return;', replace: "false) return;", tests: ["tests/integration/review-round4-audit.test.ts"], filter: "refused request" },
  { id: "r4-cli-uuid", property: "R4 P3: an id flag must be a UUID", file: "src/commands/run.ts", find: "if (value !== undefined && !UUID_TEXT.test(value)) throw new UsageError", replace: "if (false) throw new UsageError", tests: ["tests/integration/review-round4-cli.test.ts"] },
  { id: "r4-empty-fields-warning", property: "R4 P2: an empty field declaration is reported at import", file: "src/services/graph.ts", find: "graph.edges.filter((edge) => edge.fields !== null && edge.fields.length === 0).map(edgeKeyString),", replace: "[],", tests: ["tests/unit/review-round4-logic.test.ts"] },
  { id: "r4-classifier-plus-zero", property: "R4 P2: the crash-shaped exit status assertion is recognised in vitest's wording (+0)", file: "scripts/mutation-classify.mjs", find: " to (?:be|equal|deeply equal) \\\\+?0(?![\\\\d.])", replace: " to (?:be|equal|deeply equal) 0(?![\\\\d.])", tests: ["tests/unit/mutation-classify.test.ts"] },
  { id: "r4-classifier-no-report", property: "R4 P3: without a test report nothing is ever KILLED", file: "scripts/mutation-classify.mjs", find: 'const result = buildError ? "INSTRUMENT_ERROR" : status !== 0 ? "SUSPECT" : "SURVIVED";', replace: 'const result = buildError ? "INSTRUMENT_ERROR" : status !== 0 ? "KILLED" : "SURVIVED";', tests: ["tests/unit/mutation-classify.test.ts"] },
  { id: "r4-pair-tuples", property: "R4 P1: tuples and argument vectors are searched from the next character", file: "src/domain/redaction-pairs.ts", find: "TUPLE_G.lastIndex = next;", replace: "TUPLE_G.lastIndex = TUPLE_G.lastIndex;", tests: ["tests/unit/review-round4-redaction.test.ts"], filter: "argv" },
  { id: "r4-pair-scan", property: "R4 P1: name/value pairs are found in text", file: "src/domain/redaction-pairs.ts", find: "const NAME_PAIR_G = new RegExp(NAME_PAIR, \"gi\");", replace: "const NAME_PAIR_G = new RegExp(\"x^\", \"gi\");", tests: ["tests/unit/review-round4-redaction.test.ts"], filter: "pair is redacted at every JSON depth" },
  { id: "r4-skipgap-run", property: "R4 P1: a YAML line break nested any number of layers is a gap", file: "src/domain/redaction.ts", find: 'while (text[i + run] === "\\\\") run += 1;', replace: ";", tests: ["tests/unit/review-round4-redaction.test.ts"], filter: "YAML" },
  { id: "r4-percent-decode", property: "R4 P2: percent-encoded separators are decoded into a scanned copy", file: "src/domain/redaction.ts", find: "if (PERCENT_ESCAPE.test(text)) {", replace: "if (false) {", tests: ["tests/unit/review-round4-redaction.test.ts"], filter: "percent-encoded separators" },
  { id: "r4-fixed-point", property: "R4 P2: redaction is repeated to a fixed point", file: "src/domain/redaction.ts", find: "const REDACT_PASSES = 32;", replace: "const REDACT_PASSES = 1;", tests: ["tests/unit/review-round4-redaction.test.ts"], filter: "bounded fixed point" },
  { id: "r4-format-chars", property: "R4 P3: every format character is folded away", file: "src/domain/redaction.ts", find: "(cp >= 0x80 && FORMAT_CHAR.test(String.fromCodePoint(cp))) ||", replace: "", tests: ["tests/unit/review-round4-redaction.test.ts"], filter: "control character, is folded away" },
  { id: "r4-lower-key", property: "R4 P2: the whole lower-cased key is tested for a credential name", file: "src/domain/redaction.ts", find: "LOWER_KEY_SECRET.test(key.toLowerCase())", replace: "false", tests: ["tests/unit/review-round4-redaction.test.ts"], filter: "credential-looking property name" },
  { id: "r4-object-pairs", property: "R4 P1: the value half of a name/value pair is hidden in objects", file: "src/domain/redaction.ts", find: "const pairedValues = pairedValueKeys(value as Record<string, unknown>, foldName);", replace: "const pairedValues = new Set<string>();", tests: ["tests/unit/review-round4-redaction.test.ts"], filter: "objects:" },
  { id: "r4-array-pairs", property: "R4 P1: the item after a credential name in an array (tuple, argv) is hidden", file: "src/domain/redaction.ts", find: "const paired = pairedArrayIndexes(value, foldName);", replace: "const paired = new Set<number>();", tests: ["tests/unit/review-round4-redaction.test.ts"], filter: "objects:" },
  { id: "r4-own-proto", property: "R4 P3: an own __proto__ key is kept as data", file: "src/domain/redaction.ts", find: 'if (key === "__proto__") Object.defineProperty', replace: 'if (false) Object.defineProperty', tests: ["tests/unit/review-round4-redaction.test.ts"], filter: "own `__proto__`" },
  { id: "r4-token-counter-listed", property: "R4: a listed token counter (tokens_used, max_tokens, ...) holding a number stays visible", file: "src/domain/redaction.ts", find: "&& ORDINARY_TOKEN_NAMES.has(key.toLowerCase()", replace: "&& false && ORDINARY_TOKEN_NAMES.has(key.toLowerCase()", tests: ["tests/unit/review-round3-redaction.test.ts"], filter: "ordinary names are not swept up" },
  { id: "r4-token-counter-any-type", property: "R4: a listed token counter holding a STRING is still hidden (the value must be a number or a boolean)", file: "src/domain/redaction.ts", find: 'return (typeof value === "number" || typeof value === "boolean") &&', replace: "return true &&", tests: ["tests/unit/review-round4-redaction.test.ts"], filter: "token stay visible only" },
  { id: "r4-token-counter-widened", property: "R4: the allow-list is exact; a name that merely contains a listed name (`tokens`, `api_tokens`) stays hidden", file: "src/domain/redaction.ts", find: "ORDINARY_TOKEN_NAMES.has(key.toLowerCase().replace(/-/g, \"_\"))", replace: "[...ORDINARY_TOKEN_NAMES, \"tokens\", \"api_tokens\"].includes(key.toLowerCase().replace(/-/g, \"_\"))", tests: ["tests/unit/review-round4-redaction.test.ts"], filter: "token stay visible only" },
  { id: "r4-stale-predicate-unfinished", property: "R4: an unfinished run is never stale (the one predicate needs `finished`)", file: "src/services/assess.ts", find: "return finished && version !== ENGINE_VERSION;", replace: "return version !== ENGINE_VERSION;", tests: ["tests/unit/review-round4-logic.test.ts"], filter: "ONE predicate" },
  { id: "r4-stale-predicate-unstamped", property: "R4: a run stored without an engine stamp is version 1, hence stale", file: "src/services/assess.ts", find: "stamp === undefined || stamp === null ? 1 : stamp", replace: "stamp === undefined || stamp === null ? ENGINE_VERSION : stamp", tests: ["tests/unit/review-round4-logic.test.ts"], filter: "ONE predicate" },
  { id: "r4-stale-predicate-newer", property: "R4: a stamp NEWER than this build is not current either (strict comparison, not `<`)", file: "src/services/assess.ts", find: "return finished && version !== ENGINE_VERSION;", replace: "return finished && (version as number) < ENGINE_VERSION;", tests: ["tests/unit/review-round4-logic.test.ts"], filter: "ONE predicate" },
  // ---- round 5: authored, NOT yet run (a full run is a gate step) ----
  { id: "r5-derived-cap-unknown", property: "R5 P1: every unknown message is cut to the restore cap when it is created", file: "src/services/assess.ts", find: "message: input.uncapped_text === true ? message : capDerived(message) });", replace: "message });", tests: ["tests/integration/review-round5-derived-text.test.ts"], filter: "no derived string" },
  { id: "r5-derived-cap-reason", property: "R5 P1: a finding reason is cut to the restore cap when it is created", file: "src/services/assess.ts", find: "(input.uncapped_text === true ? text : capDerived(text))", replace: "(text)", tests: ["tests/integration/review-round5-derived-text.test.ts"], filter: "no derived string" },
  { id: "r5-verify-recorded-cap", property: "R5 P1: verification reads the recorded unknowns through the same cap (bundles of earlier builds verify)", file: "src/services/evidence.ts", find: ", (value) => capLeaves(redactDeep(capLeaves(value)))];", replace: "];", tests: ["tests/integration/review-round7-logic.test.ts"], filter: "text written by an earlier build" },
  { id: "r5-stale-marker-check", property: "R5 P2: a stale_runs marker that does not name the stale runs is refused", file: "src/services/evidence.ts", find: "if (staleMarker !== undefined && canonicalText(staleMarker) !== canonicalText(staleEngineRuns(bundle))) {", replace: "if (false) {", tests: ["tests/integration/review-round5-stale-bundle.test.ts"], filter: "the marker is checked" },
  { id: "r5-stale-marker-export", property: "R5 P2: an exported bundle names its stale runs", file: "src/services/evidence.ts", find: "stale_runs: staleEngineRuns(hashed) };", replace: "stale_runs: [] };", tests: ["tests/integration/review-round5-stale-bundle.test.ts"], filter: "says so outside the hashed body" },
  { id: "r5-stale-header", property: "R5 P2: the run bundle response carries the stale count in a header", file: "src/api/server.ts", find: 'String(bundle.stale_runs?.length ?? 0))', replace: '"0")', tests: ["tests/integration/review-round5-stale-bundle.test.ts"], filter: "says so outside the hashed body" },
  { id: "r5-bounds-calendar", property: "R5 P2: a timestamp must be a real calendar date (31 February is refused)", file: "src/services/bundle-bounds.ts", find: "day <= daysInMonth", replace: "day <= 31", tests: ["tests/integration/review-round5-restore.test.ts"], filter: "calendar date" },
  { id: "r5-bounds-int4", property: "R5 P2: an integer past int4 is a bundle rejection", file: "src/services/bundle-bounds.ts", find: "const INT4 = 2_147_483_647;", replace: "const INT4 = Number.MAX_SAFE_INTEGER;", tests: ["tests/integration/review-round5-restore.test.ts"], filter: "above int4" },
  { id: "r5-bounds-nul", property: "R5 P2: a NUL character anywhere in a bundle is a bundle rejection", file: "src/services/bundle-bounds.ts", find: "const unstorable = unstorableText(bundle);\n  if (unstorable !== null) return unstorable;", replace: "", tests: ["tests/integration/review-round5-restore.test.ts"], filter: "NUL" },
  { id: "r5-restore-map-23", property: "R5 P2: a database constraint violation (class 23) during the restore is BUNDLE_SCHEMA_INVALID", file: "src/services/restore.ts", find: "/^2[23][0-9A-Z]{3}$/", replace: "/^22[0-9A-Z]{3}$/", tests: ["tests/integration/review-round5-restore.test.ts"], filter: "SQLSTATE class 22 and 23" },
  { id: "r5-restore-event-cap", property: "R5 P3: run event statuses are cut to the text cap", file: "src/services/restore.ts", find: "capText(e.from_status)", replace: "e.from_status", tests: ["tests/integration/review-round5-restore.test.ts"], filter: "event statuses" },
  { id: "r5-limiter-spent", property: "R5: a bucket at exactly its limit is spent and never evicted", file: "src/platform/rate-limit.ts", find: "if (entry.count >= this.limit) this.idle.delete(key);", replace: "if (entry.count > this.limit) this.idle.delete(key);", tests: ["tests/unit/review-round5-rate-limit.test.ts"], filter: "spent" },
  { id: "r5-limiter-first-hit", property: "R5: with a limit of one the first hit spends the bucket", file: "src/platform/rate-limit.ts", find: "if (1 < this.limit) this.idle.add(key);", replace: "this.idle.add(key);", tests: ["tests/unit/review-round5-rate-limit.test.ts"], filter: "limit 1" },
  { id: "r5-list-stamp-raw", property: "R5 P3: the run list reads the engine stamp as stored, like the run view", file: "src/services/impact.ts", find: "{ engine_version: r.engine_version }", replace: "{ engine_version: Number(r.engine_version) }", tests: ["tests/integration/review-round5-pins.test.ts"], filter: "agree on a stamp" },
  { id: "r5-crash-matcher-part", property: "R5 P1: the crash shape is read from the matcher part, never from a custom label", file: "scripts/mutation-classify.mjs", find: "!crashShaped(matcherPart(message), processes)", replace: "!crashShaped(message, processes)", tests: ["tests/unit/mutation-classify.test.ts"], filter: "R5: the kill rule over real vitest text" },
  { id: "r5-lookup-failure", property: "R5 P1: a Testing Library lookup failure is an assertion failure", file: "scripts/mutation-classify.mjs", find: " || LOOKUP_FAILURE.test(message)", replace: "", tests: ["tests/unit/mutation-classify.test.ts"], filter: "Testing Library lookup" },
  { id: "r5-expect-structure", property: "R5 P1: a Playwright expect failure is recognised by its structure, labelled or not", file: "scripts/mutation-classify.mjs", find: "return /(?:^|\\n\\n)(?:Error: )?expect\\(.*\\)\\.[^\\n]*\\n\\n?(?:Locator:|Expected|Received|Call log:|Timeout:|- Expected|\\+ Received)/.test(text);", replace: "return false;", tests: ["tests/unit/mutation-classify-context.test.ts"], filter: "real Playwright text" },
  { id: "r6-expect-after-blank-line", property: "R6 P3: an `expect(` line in the middle of a thrown message is not a failed expectation", file: "scripts/mutation-classify.mjs", find: "\\n\\n?(?:Locator:|Expected|Received|Call log:|Timeout:|- Expected|\\+ Received)/.test(text);", replace: "/.test(text);", tests: ["tests/unit/review-round7-classifier.test.ts"], filter: "threw" },
  { id: "r5-crash-status-exit-2", property: "R5 P1: exit status 2 (a bundle refused) is a decision of the program, not a crash", file: "scripts/mutation-classify.mjs", find: 'const CRASH_STATUS = "(?:null|1|70|13[4-9]|14[0-3])";', replace: 'const CRASH_STATUS = "(?:null|1|2|70|13[4-9]|14[0-3])";', tests: ["tests/unit/mutation-classify.test.ts"], filter: "decision of the program" },
  { id: "r5-kill-group", property: "R5 P3: a runner's whole process group is ended with it", file: "scripts/mutation-classify.mjs", find: 'process.kill(-pid, "SIGKILL");', replace: 'process.kill(pid, "SIGKILL");', tests: ["tests/unit/mutation-classify.test.ts"], filter: "spinning worker" },
  { id: "r5-pair-bare-name-first", property: "R5 P1: a name=/value= pair without JSON quoting is read, name first", file: "src/domain/redaction-pairs.ts", find: "const head = seekBare(text, m.index + m[0].length, BARE_VALUE_HEAD);", replace: "const head = null as RegExpExecArray | null;", tests: ["tests/unit/review-round5-redaction.test.ts"], filter: "without JSON quoting" },
  { id: "r5-pair-gap", property: "R5 P2: the two halves of a pair may be 600 characters apart", file: "src/domain/redaction-pairs.ts", find: "const MAX_PAIR_GAP = 600;", replace: "const MAX_PAIR_GAP = 100;", tests: ["tests/unit/review-round5-redaction.test.ts"], filter: "gap of any size" },
  { id: "r5-pair-group-value", property: "R5 P2: an array or object value of a pair is read as a group", file: "src/domain/redaction-pairs.ts", find: 'const end = c === "[" || c === "{" ? groupEnd(text, q, ends.endOf) : ends.unquotedEnd(text, q);', replace: "const end = ends.unquotedEnd(text, q);", tests: ["tests/unit/review-round5-redaction.test.ts"], filter: "values of every type" },
  { id: "r5-block-scalar-dedent", property: "R5 P2: a block scalar ends at the first line indented no more than its key", file: "src/domain/redaction-forms.ts", find: "if (j >= text.length || here <= indent) break;", replace: "if (j >= text.length) break;", tests: ["tests/unit/review-round5-redaction.test.ts"], filter: "block scalars" },
  { id: "r5-block-scalar-closing-quote", property: "R5 P2: a block scalar inside JSON text ends at the quote that closes the enclosing string", file: "src/domain/redaction-forms.ts", find: "if (stopRun > 0 && c === 34) return", replace: "if (false) return", tests: ["tests/unit/review-round6-security.test.ts"], filter: "closing quote of the enclosing JSON string" },
  { id: "r6-block-scalar-closing-quote-run", property: "R6 P3: a block scalar in JSON text nested twice ends at the escaped quote that closes the enclosing string", file: "src/domain/redaction-forms.ts", find: "if (stopRun > 0 && letter === 34 && run < stopRun) return", replace: "if (false) return", tests: ["tests/unit/review-round6-security.test.ts"], filter: "closing quote of the enclosing JSON string" },
  { id: "r5-node-properties", property: "R5 P2: a YAML anchor or tag between a credential key and its value is skipped", file: "src/domain/redaction.ts", find: 'const properties = separator === ":" ? skipNodeProperties(text, i, out) : i;', replace: "const properties = i;", tests: ["tests/unit/review-round5-redaction.test.ts"], filter: "block scalars" },
  { id: "r5-typed-declaration", property: "R5 P2: a type name after a credential key is not the value (`password: string = S`)", file: "src/domain/redaction.ts", find: "if (!value.quoted && value.end - value.start <= 16 && TYPE_WORD.test(text.slice(value.start, value.end))) {", replace: "if (false) {", tests: ["tests/unit/review-round5-redaction.test.ts"], filter: "assignment operators, flags" },
  { id: "r5-compound-operators", property: "R5 P2: `?=` and `+=` assign", file: "src/domain/redaction.ts", find: 'if ((separator === "?" || separator === "+") && text[i + 1] === "=") {', replace: "if (false) {", tests: ["tests/unit/review-round5-redaction.test.ts"], filter: "assignment operators, flags" },
  { id: "r5-python-prefix", property: "R5 P2: a Python literal prefix (b'', r\"\") in front of a quote is skipped", file: "src/domain/redaction-forms.ts", find: `if (text[k] === '"' || text[k] === "'") i += prefix;`, replace: "if (false) i += prefix;", tests: ["tests/unit/review-round5-redaction.test.ts"], filter: "Python string literal" },
  { id: "r5-export-boundary", property: "R5 P1: a bundle of exactly the limit exports (the comparison is `>`, not `>=`), and its exit status 2 counts as a kill, not a crash", file: "src/services/evidence.ts", find: "byteLength > opts.maxBytes", replace: "byteLength >= opts.maxBytes", tests: ["tests/integration/review-round4-export-cap.test.ts"] },
  { id: "r5-fold-property-name", property: "R5 P2: a property name is matched after the text fold (invisible characters)", file: "src/domain/redaction.ts", find: "SENSITIVE_KEY.test(folded) && !isOrdinaryTokenCounter(folded, raw)", replace: "SENSITIVE_KEY.test(key) && !isOrdinaryTokenCounter(key, raw)", tests: ["tests/unit/review-round5-redaction.test.ts"], filter: "matched after the same fold" },
  { id: "r5-percent-mask", property: "R5 P2/P3: a character decoded from %XX never ends an unquoted value", file: "src/domain/redaction.ts", find: "decodedMask = mask;", replace: "", tests: ["tests/unit/review-round5-redaction.test.ts"], filter: "came from %XX" },
  { id: "r5-spaced-colon", property: "R5 P2: `dsn: value` assigns (a spaced bare colon after the added names)", file: "src/domain/redaction.ts", find: `const spacedColon = separator === ":" && spacedKey && /[ \\t\\r\\n"'\\\\=]/.test(text[i + 1] ?? "");`, replace: "const spacedColon = false;", tests: ["tests/unit/review-round5-redaction.test.ts"], filter: "text keyword list" },
  { id: "r5-glued-colon-identifier", property: "R5: a glued `dsn:value` or a route `/sid:abc` stays an identifier (only the spaced style assigns)", file: "src/domain/redaction.ts", find: `spacedKey && /[ \\t\\r\\n"'\\\\=]/.test(text[i + 1] ?? "");`, replace: "spacedKey;", tests: ["tests/unit/review-round5-robustness.test.ts"], filter: "bare-colon names" },
  { id: "r5-mask-not-for-pairs", property: "R5: a decoded space between the halves of a bare pair still separates them (the mask is for assignments only)", file: "src/domain/redaction.ts", find: "unquotedEnd: (text, from) => unquotedEnd(text, from, false) };", replace: "unquotedEnd: (text, from) => unquotedEnd(text, from, true) };", tests: ["tests/integration/review-round5-sweep.test.ts"] },
  { id: "r5-head-of-assignment", property: "R5: a bare word that is itself `key=` (the head of another assignment) is not consumed as the value of `pw: ...`", file: "src/domain/redaction.ts", find: "if (value.end - value.start >= 6 && !headOfAnother) {", replace: "if (value.end - value.start >= 6) {", tests: ["tests/unit/review-round6-no-leak.test.ts"], filter: "key words as values" },
  { id: "r6-rescan-short-value", property: "R6 P1: the scan goes on inside a short bare value, so a key that is the value of another key still hides its own value", file: "src/domain/redaction.ts", find: "if (rescans(value.end - value.start)) resume = keyEnd;", replace: "if (false) resume = keyEnd;", tests: ["tests/unit/review-round6-no-leak.test.ts"], filter: "minimal repros" },
  { id: "r6-rescan-long-masked", property: "R6 P1: a long value (bare, quoted or decoded) is scanned again for a key inside it while the rescan budget lasts", file: "src/domain/redaction.ts", find: "let rescanBudget = 8 * text.length + 65_536;", replace: "let rescanBudget = 0;", tests: ["tests/unit/review-round6-no-leak.test.ts"], filter: "LONG" },
  { id: "r6-rescan-short-limit", property: "R6 P1: a value or block scalar of at most 128 characters is always scanned again (only longer ones draw on the budget)", file: "src/domain/redaction.ts", find: "if (length <= RESCAN_LIMIT) return true;", replace: "if (length <= RESCAN_LIMIT) return false;", tests: ["tests/unit/review-round6-no-leak.test.ts"], filter: "minimal repros" },
  { id: "r6-rescan-block", property: "R6 P1: a short block scalar is scanned again from its start, so a key inside it hides its own value", file: "src/domain/redaction.ts", find: "rescans(block.end - block.start) ? keyEnd : block.end", replace: "block.end", tests: ["tests/unit/review-round6-no-leak.test.ts"], filter: "block scalar" },
  { id: "r7-hash-memo-inside", property: "R7: the gap memo is used only when the new gap starts inside it (a key that reads ahead through a bracket group)", file: "src/domain/redaction.ts", find: "from >= hashScanned.from && from < hashScanned.to;", replace: "from < hashScanned.to;", tests: ["tests/unit/review-round7-shapes.test.ts"], filter: "read ahead of a key" },
  { id: "r7-block-rescan-from-key", property: "R7 (test review P1): a block scalar is rescanned from the end of its key, so a key in a comment between them is hidden", file: "src/domain/redaction.ts", find: "rescans(block.end - block.start) ? keyEnd : block.end);", replace: "rescans(block.end - block.start) ? block.start : block.end);", tests: ["tests/unit/review-round7-shapes.test.ts"], filter: "glued to the key is hidden" },
  { id: "r6-presigned-signature", property: "R6 P2: a pre-signed URL signature (`sig=`, `X-Amz-Signature=`) is redacted", file: "src/domain/redaction.ts", find: "|x-amz-(?:signature|security-token)|(?<=[?&])(?:sig(?![A-Za-z])|(?:x-goog-)?signature)|", replace: "|", tests: ["tests/unit/review-round6-known-limits.test.ts"], filter: "now redacted" },
  { id: "r6-credential-singular", property: "R6 P2: `credential: S` assigns like `credentials: S`", file: "src/domain/redaction.ts", find: "const SPACED_COLON_KEY = /^(?:credential|session[_-]?id|", replace: "const SPACED_COLON_KEY = /^(?:session[_-]?id|", tests: ["tests/unit/review-round6-known-limits.test.ts"], filter: "now redacted" },
  { id: "r6-hash-value", property: "R6 P1: a value that starts with # after `key: ` is hidden (its first word)", file: "src/domain/redaction.ts", find: "if (word - k >= 6) out.push(", replace: "if (false) out.push(", tests: ["tests/unit/review-round6-security.test.ts"], filter: "root causes" },
  { id: "r6-head-needs-quote", property: "R6 P1: a word that looks like `key:` is the head of another assignment only when a quote follows it", file: "src/domain/redaction.ts", find: "if (quoteBehind && HEAD_OF_ASSIGNMENT.test(word)) return true;", replace: "if (HEAD_OF_ASSIGNMENT.test(word)) return true;", tests: ["tests/unit/review-round6-security.test.ts"], filter: "root causes" },
  { id: "r6-short-property-backslash", property: "R6 P1: a short property followed by a backslash that is not a line break is the start of the value", file: "src/domain/redaction.ts", find: 'if (text[run] !== "n" && text[run] !== "r" && text[run] !== "t" && text[run] !== \'"\' && text[run] !== "\'") return start;', replace: "", tests: ["tests/unit/review-round6-security.test.ts"], filter: "root causes" },
  { id: "r6-pair-scan-bound", property: "R6 P1: backslashes count against a bound of 2^19 characters, not 4,096, so pairs are read at JSON depth 13", file: "src/domain/redaction-pairs.ts", find: "const MAX_PAIR_SCAN = 524_288;", replace: "const MAX_PAIR_SCAN = 4096;", tests: ["tests/unit/review-round6-security.test.ts"], filter: "every JSON depth from 0 to 13" },
  { id: "r6-pair-block-scalar", property: "R6 P2: a block scalar as the value of a name/value pair is read", file: "src/domain/redaction-pairs.ts", find: 'if (c === "|" || c === ">") {\n    let key = q;', replace: 'if (false) {\n    let key = q;', tests: ["tests/unit/review-round6-security.test.ts"], filter: "block scalars at every JSON depth" },
  { id: "r6-array-marker", property: "R6 P3: an array element that holds the marker is not a name (redacting twice changes nothing)", file: "src/domain/redaction-pairs.ts", find: 'if (item.includes("[REDACTED]")) continue;', replace: "", tests: ["tests/unit/review-round6-security.test.ts"], filter: "redacting a string array twice" },
  { id: "r6-bounds-surrogate", property: "R6 P2: an unpaired surrogate anywhere in a bundle is a bundle rejection", file: "src/services/bundle-bounds.ts", find: ': hasLoneSurrogate(value) ? "a text holds an unpaired surrogate" : null', replace: ": null", tests: ["tests/integration/review-round6-bundle-bounds.test.ts"], filter: "surrogate" },
  { id: "r6-bounds-key-cap", property: "R6 P1: an object key longer than the text cap is a bundle rejection", file: "src/services/bundle-bounds.ts", find: "if (key.length > TEXT_CAP) return", replace: "if (false) return", tests: ["tests/integration/review-round6-bundle-bounds.test.ts"], filter: "over the cap" },
  { id: "r6-export-cut-after-redaction", property: "R6 P1: the unknowns of an exported run are cut to the cap AFTER redaction", file: "src/services/evidence.ts", find: "unknowns: capLeaves(redactDeep(r.unknowns)) as unknown[],", replace: "unknowns: redactDeep(r.unknowns) as unknown[],", tests: ["tests/integration/review-round6-cap-after-redaction.test.ts"], filter: "unknown fields of 124" },
  { id: "r6-verify-redact-then-cut", property: "R6 P1: verification accepts a recorded text that was cut after redaction", file: "src/services/evidence.ts", find: "[(value) => capLeaves(redactDeep(value)), ", replace: "[", tests: ["tests/integration/review-round7-logic.test.ts"], filter: "text written by an earlier build" },
  { id: "r6-cut-keeps-markers-whole", property: "R6 P1: a cut at the cap never splits a redaction marker", file: "src/domain/derived-text.ts", find: "if (marker >= 0 && marker + MARKER.length > end) end = marker;", replace: "", tests: ["tests/integration/review-round6-cap-after-redaction.test.ts"], filter: "cut after redaction is stable" },
  { id: "r6-classify-process-context", property: "R6 P2: an exit-status-shaped failure message is a crash only in a test file that starts processes", file: "scripts/mutation-classify.mjs", find: "(processes && CRASH_STATUS_SHAPED.test(matcher))", replace: "CRASH_STATUS_SHAPED.test(matcher)", tests: ["tests/unit/mutation-classify-context.test.ts"], filter: "spawns nothing" },
  { id: "r6-refusal-names-locations", property: "R6 P2: the refusal for a stored manifest that no longer validates names the locations and the rule", file: "src/services/evidence.ts", find: 'return `${shown.join("; ")}${more > 0', replace: "return `${more > 0", tests: ["tests/integration/review-round6-legacy-manifests.test.ts"], filter: "export refuses" },
  { id: "r6-legacy-manifest-download-redacted", property: "R6 P2: a stored manifest that the current validator rejects is never served verbatim", file: "src/services/snapshots.ts", find: "return { manifest: redactDeep(stored), redactedFrom: row.document_hash };", replace: "return { manifest: stored, redactedFrom: null };", tests: ["tests/integration/review-round6-legacy-manifests.test.ts"], filter: "manifest download" },
  { id: "r6-embedded-key-tail-hidden", property: "R6 P1: a key embedded in a short bare value stays readable and everything behind it is hidden (the swallowed part is not shown)", file: "src/domain/redaction.ts", find: "if (embedded.after < value.end) out.push(", replace: "if (false) out.push(", tests: ["tests/unit/review-round6-security.test.ts"], filter: "embedded" },
  { id: "r6-anchor-not-value", property: "R6 P1: only a `!`-led short property before a backslash starts the value (an anchor keeps the previous reading)", file: "src/domain/redaction.ts", find: 'if (text[start] === "!" && i - start < 6 && text[i] === "\\\\") {', replace: 'if (i - start < 6 && text[i] === "\\\\") {', tests: ["tests/unit/review-round6-security.test.ts"], filter: "embedded" },
  { id: "r6-block-after-equals", property: "R6 P1: a block scalar header after an equals sign (`auth = >-`) is read", file: "src/domain/redaction.ts", find: 'if (separator === ":" || separator === "=") {\n      // A YAML node property', replace: 'if (separator === ":") {\n      // A YAML node property', tests: ["tests/unit/review-round6-rules.test.ts"], filter: "equals sign" },
  { id: "r6-group-word", property: "R6 P1: a bracket group glued to the rest of its word ends with the word", file: "src/domain/redaction-forms.ts", find: "return { start: i, end: Math.max(group, gluedWordEnd(text, group, ends), ends.unquotedEnd(text, i)), quoted: false };", replace: "return { start: i, end: group, quoted: false };", tests: ["tests/unit/review-round6-no-leak.test.ts"], filter: "bracket group" },
  { id: "r7-verify-uncapped-derivation", property: "R7 P1: verification derives the comparison text uncut, so a text written before the cut existed still verifies", file: "src/services/evidence.ts", find: "uncapped_text: true,", replace: "", tests: ["tests/integration/review-round7-logic.test.ts"], filter: "text written by an earlier build" },
  { id: "r7-verify-refuses-long-text", property: "R7 P2-b: a recorded text longer than the comparison bound is refused before it is redacted", file: "src/services/evidence.ts", find: "if (exceedsBound(recorded)) return false;", replace: "", tests: ["tests/integration/review-round7-logic.test.ts"], filter: "at the bound" },
  { id: "r7-cut-keeps-pairs", property: "R7 P2-a: a cut at the cap never separates the halves of a surrogate pair", file: "src/domain/derived-text.ts", find: "if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1;", replace: "", tests: ["tests/integration/review-round7-bounds.test.ts"], filter: "astral character" },
  { id: "r7-bounds-key-uniqueness", property: "R7 P2-a: two contract check keys that are one key after restore's cut are a bundle rejection", file: "src/services/bundle-bounds.ts", find: "if (seenChecks.has(kept)) return", replace: "if (false) return", tests: ["tests/integration/review-round7-bounds.test.ts"], filter: "contract check keys that differ only after" },
  { id: "r7-bounds-run-key-uniqueness", property: "R7 P2-a: two check result keys of one run that are one key after restore's cut are a bundle rejection", file: "src/services/bundle-bounds.ts", find: "if (seenResults.has(kept)) return", replace: "if (false) return", tests: ["tests/integration/review-round7-bounds.test.ts"], filter: "run check keys that differ only after" },
  { id: "r7-event-revision-redacted", property: "R7 P2-b: the revision of an event is redacted when the envelope is written", file: "src/services/outbox.ts", find: "revision: redactSecrets(envelope.revision),", replace: "revision: envelope.revision,", tests: ["tests/integration/review-round7-outbox.test.ts"], filter: "" },
  { id: "r7-event-claim-redacted", property: "R7 P2-b: an event claimed for the sink is redacted whatever was stored", file: "src/services/outbox.ts", find: "envelope: redactEnvelope(row.envelope)", replace: "envelope: row.envelope", tests: ["tests/integration/review-round7-outbox.test.ts"], filter: "" },
  { id: "r7-audit-served-redacted", property: "R7 P2-b: an audit row is redacted again when it is served", file: "src/services/audit.ts", find: "metadata: redactDeep(r.redacted_metadata),", replace: "metadata: r.redacted_metadata,", tests: ["tests/integration/review-round7-outbox.test.ts"], filter: "" },
  { id: "r7-findings-page-rerun", property: "R7 P3: the findings page of a run from an older engine says rerun_required", file: "src/services/impact.ts", find: "rerun_required: rerunRequired };", replace: "rerun_required: false };", tests: ["tests/integration/review-round7-stale-findings.test.ts"], filter: "" },
  { id: "r7-line-break-short-keys", property: "R7 P1: sid, pw, pswd, pin and otp start a word after a line break written as text", file: "src/domain/redaction.ts", find: "(?:(?<![A-Za-z])|(?<=\\\\[nrt])|(?<=%0[AaDd]))(?:sid|pw|pswd|pin|otp)", replace: "(?<![A-Za-z])(?:sid|pw|pswd|pin|otp)", tests: ["tests/unit/review-round7-security.test.ts"], filter: "forms that start a line" },
  { id: "r7-line-break-long-flag", property: "R7 P1: a long flag starts a word after a line break written as text", file: "src/domain/redaction-forms.ts", find: "const LONG_FLAG = /(?:(?<![A-Za-z0-9_-])|(?<=\\\\[nrt]))--", replace: "const LONG_FLAG = /(?<![A-Za-z0-9_-])--", tests: ["tests/unit/review-round7-security.test.ts"], filter: "forms that start a line" },
  { id: "r7-line-break-bare-pairs", property: "R7 P1: name=/value= pairs start a word after a line break written as text", file: "src/domain/redaction-pairs.ts", find: "String.raw`(?:(?<![A-Za-z0-9_])|(?<=\\\\[nrt]))`", replace: "String.raw`(?<![A-Za-z0-9_])`", tests: ["tests/unit/review-round7-security.test.ts"], filter: "forms that start a line" },
  { id: "r7-x-oauth-basic", property: "R7 P2: the user part of TOKEN:x-oauth-basic@host is hidden", file: "src/domain/redaction.ts", find: "if (colon > 0 && /^x-oauth-basic$/i.test(", replace: "if (false && /^x-oauth-basic$/i.test(", tests: ["tests/unit/review-round7-shapes.test.ts"], filter: "x-oauth-basic" },
  { id: "r7-signature-key", property: "R7 P2: signature= and X-Goog-Signature= in a query are hidden", file: "src/domain/redaction.ts", find: "|(?:x-goog-)?signature)", replace: "|(?!))", tests: ["tests/unit/review-round7-shapes.test.ts"], filter: "pre-signed URL signature" },
  { id: "r7-plural-parent", property: "R7 P2: passwords:, tokens: and secrets: are credential parents", file: "src/domain/redaction.ts", find: "auth(?:orization)?)s?$/i;", replace: "auth(?:orization)?)$/i;", tests: ["tests/unit/review-round7-shapes.test.ts"], filter: "plural credential parent" },
  { id: "r7-colon-equals", property: "R7 P2: := assigns behind the names that assign with a spaced colon", file: "src/domain/redaction.ts", find: `"'\\\\=]/.test(text[i + 1] ?? "");`, replace: `"'\\\\]/.test(text[i + 1] ?? "");`, tests: ["tests/unit/review-round7-shapes.test.ts"], filter: "the := operator" },
  { id: "r7-decode-escapes", property: "R7 P2: a JSON escape or an HTML entity of an ASCII character is decoded into the scanned copy", file: "src/domain/redaction.ts", find: "if (unit === 37 || unit === 92 || unit === 38) {", replace: "if (unit === 37) {", tests: ["tests/unit/review-round7-shapes.test.ts"], filter: "JSON or HTML escape" },
  { id: "r7-property-hash-word", property: "R7 P3: a # word after a YAML node property is a value", file: "src/domain/redaction.ts", find: "hideHashWords(text, gap, i, out);", replace: "", tests: ["tests/unit/review-round7-shapes.test.ts"], filter: "after a YAML node property" },
  { id: "r7-budget-spent", property: "R7 P1: a scan that spends its work budget is abandoned and the whole text is hidden", file: "src/domain/redaction-pairs.ts", find: "if (workLeft < 0) throw new ScanBudgetExceeded", replace: "if (false) throw new ScanBudgetExceeded", tests: ["tests/unit/review-round7-budget.test.ts"], filter: "exceeds its budget" },
  { id: "r7-linear-property-run", property: "R7 P1: the run after ! or & is read once for the keys that share it", file: "src/domain/redaction.ts", find: "const known = knownEnd(propertyRun, text, start);", replace: "const known = -1;", tests: ["tests/unit/review-round7-linear.test.ts"], filter: "property run: token" },
  { id: "r7-linear-value-first", property: "R7 P1: an unquoted read is read once for the starts inside it", file: "src/domain/redaction.ts", find: "const known = knownEnd(plainRead, text, from);", replace: "const known = -1;", tests: ["tests/unit/review-round7-linear.test.ts"], filter: "value-first pair" },
  { id: "r7-linear-gap-comment", property: "R7 P1: a # comment in a gap is read once for the keys that share it", file: "src/domain/redaction.ts", find: "const known = knownEnd(commentRun, text, i);", replace: "const known = -1;", tests: ["tests/unit/review-round7-linear.test.ts"], filter: "gap comment: ':= #bearer" },
  { id: "r7-linear-block-header", property: "R7 P1: the comment after a block header is read once for the headers that share it", file: "src/domain/redaction-forms.ts", find: "if (commentLine.text === text && from >= commentLine.from && from < commentLine.line.end) return commentLine.line;", replace: "", tests: ["tests/unit/review-round7-linear.test.ts"], filter: "block header after" },
  { id: "r7-linear-backslash-run", property: "R7 P1: a run of backslashes is passed once by the bare pair scan", file: "src/domain/redaction-pairs.ts", find: "      if (c === 92) i = slashEnd(text, i) - 1;", replace: "", tests: ["tests/unit/review-round7-linear.test.ts"], filter: "bare pair scan" },
  { id: "r7-flags-inside-value", property: "R7 P1: the scan goes on inside the value a flag takes, so a second flag behind an unclosed quote is hidden too", file: "src/domain/redaction-forms.ts", find: "    take(at);\n  }", replace: "    LONG_FLAG.lastIndex = Math.max(LONG_FLAG.lastIndex, take(at));\n  }", tests: ["tests/unit/review-round7-shapes.test.ts"], filter: "first quote is not closed" },
  { id: "r7-key-redacted-cap", property: "R7 (test review P2-a): an object key that redaction lengthens past the cap is a bundle rejection", file: "src/services/bundle-bounds.ts", find: "if (key.length >= 6 && redactSecrets(key).length > TEXT_CAP)", replace: "if (false)", tests: ["tests/integration/review-round7-bounds.test.ts"], filter: "LENGTHENS" },
  { id: "r8-key-redacted-every-key", property: "R8 (logic and conformance P2): every key of six characters or more is redacted for the cap, not only the keys above 1,000 characters", file: "src/services/bundle-bounds.ts", find: "if (key.length >= 6 && redactSecrets(key).length > TEXT_CAP)", replace: "if (key.length > 1000 && redactSecrets(key).length > TEXT_CAP)", tests: ["tests/integration/review-round8-key-redaction.test.ts"], filter: "994 characters" },
  { id: "r8-key-redacted-cap", property: "R8 (logic and conformance P2): the redacted form of a key is what the cap applies to", file: "src/services/bundle-bounds.ts", find: "if (key.length >= 6 && redactSecrets(key).length > TEXT_CAP)", replace: "if (key.length >= 6 && key.length > TEXT_CAP)", tests: ["tests/integration/review-round8-key-redaction.test.ts"], filter: "994 characters" },
  { id: "r7-site-warnings-cut-after", property: "R7 (test review P2-b): snapshot warnings are cut after redaction", file: "src/services/evidence.ts", find: "warnings: capLeaves(redactDeep(s.warnings)) as unknown[]", replace: "warnings: redactDeep(capLeaves(s.warnings)) as unknown[]", tests: ["tests/integration/review-round7-bounds.test.ts"], filter: "every text of an export" },
  { id: "r7-site-error-detail-cut-after", property: "R7 (test review P2-b): an error detail is cut after redaction", file: "src/services/evidence.ts", find: "(capText(redactDeep(r.error_detail) as string) as string)", replace: "(redactDeep(capText(r.error_detail) as string) as string)", tests: ["tests/integration/review-round7-bounds.test.ts"], filter: "every text of an export" },
  { id: "r7-site-assessment-cut-after", property: "R7 (test review P2-b): the assessment detail is cut after redaction", file: "src/services/evidence.ts", find: "(capLeaves(redactDeep(r.assessment_detail)) as Record<string, unknown>)", replace: "(redactDeep(capLeaves(r.assessment_detail)) as Record<string, unknown>)", tests: ["tests/integration/review-round7-bounds.test.ts"], filter: "every text of an export" },
  { id: "r7-site-event-note-cut-after", property: "R7 (test review P2-b): an event note is cut after redaction", file: "src/services/evidence.ts", find: "(capText(redactDeep(ev.note) as string) as string)", replace: "(redactDeep(capText(ev.note) as string) as string)", tests: ["tests/integration/review-round7-bounds.test.ts"], filter: "every text of an export" },
  { id: "r7-site-check-definition-cut-after", property: "R7 (test review P2-b): a check definition is cut after redaction", file: "src/services/evidence.ts", find: "definition: capLeaves(redactDeep(c.definition)),", replace: "definition: redactDeep(capLeaves(c.definition)),", tests: ["tests/integration/review-round7-bounds.test.ts"], filter: "every text of an export" },
  { id: "r7-site-check-result-cut-after", property: "R7 (test review P2-b): a check result is cut after redaction", file: "src/services/evidence.ts", find: "capLeaves(redactDeep(c.result))", replace: "redactDeep(capLeaves(c.result))", tests: ["tests/integration/review-round7-bounds.test.ts"], filter: "every text of an export" },
  { id: "r7-hash-word-floor", property: "R7 (test review h08): a # word of six characters is a value", file: "src/domain/redaction.ts", find: "if (word - k >= 6) out.push({ start: k, end: word, kind: \"credential_assignment\", low: true });", replace: "if (word - k >= 7) out.push({ start: k, end: word, kind: \"credential_assignment\", low: true });", tests: ["tests/unit/review-round7-rules.test.ts"], filter: "floor is six, not seven" },
  { id: "r7-glued-word-floor", property: "R7 (test review h20): a word of six characters glued in front of a key separator is hidden", file: "src/domain/redaction.ts", find: "if (glued.length >= 6)", replace: "if (glued.length >= 7)", tests: ["tests/unit/review-round7-rules.test.ts"], filter: "glued in front of a key separator" },
  { id: "r7-bracket-group-bound", property: "R7 (test review h32): a bracket group glued to a key belongs to the key up to 128 characters", file: "src/domain/redaction.ts", find: "j - i <= 128 && text[j] !== close", replace: "j - i <= 16 && text[j] !== close", tests: ["tests/unit/review-round7-rules.test.ts"], filter: "bracket group glued to a key" },
  { id: "r7-surrogate-high-start", property: "R7 (test review b02): a lone U+D800 is a lone surrogate", file: "src/services/bundle-bounds.ts", find: "c >= 0xd800 && c <= 0xdbff", replace: "c >= 0xd801 && c <= 0xdbff", tests: ["tests/integration/review-round7-bounds.test.ts"], filter: "surrogate ranges" },
  { id: "r7-surrogate-high-end", property: "R7 (test review b05): a lone U+DBFF is a lone surrogate", file: "src/services/bundle-bounds.ts", find: "c >= 0xd800 && c <= 0xdbff", replace: "c >= 0xd800 && c <= 0xdbfe", tests: ["tests/integration/review-round7-bounds.test.ts"], filter: "surrogate ranges" },
  { id: "r7-surrogate-low-start", property: "R7 (test review b06): U+DC00 completes a pair", file: "src/services/bundle-bounds.ts", find: "next >= 0xdc00 && next <= 0xdfff", replace: "next >= 0xdc01 && next <= 0xdfff", tests: ["tests/integration/review-round7-bounds.test.ts"], filter: "surrogate ranges" },
  { id: "r7-surrogate-low-end", property: "R7 (test review b07): a lone U+DFFF is a lone surrogate", file: "src/services/bundle-bounds.ts", find: "else if (c >= 0xdc00 && c <= 0xdfff)", replace: "else if (c >= 0xdc00 && c <= 0xdffe)", tests: ["tests/integration/review-round7-bounds.test.ts"], filter: "surrogate ranges" },
  { id: "r7-memo-cleared-after-call", property: "R7: what a scan remembers is cleared when the call ends (no reference to a scanned text outlives it)", file: "src/domain/redaction.ts", find: "    startScan(0);\n    hashScanned = { text: \"\", from: 0, to: 0 };", replace: "", tests: ["tests/unit/review-round7-state.test.ts"], filter: "nothing a scan remembers outlives" },
  { id: "r7-memo-cleared-at-start", property: "R7: a scan starts with every memo empty", file: "src/domain/redaction-pairs.ts", find: "  for (const memo of memos) memo.clear();\n  workLeft", replace: "  workLeft", tests: ["tests/unit/review-round7-state.test.ts"], filter: "nothing a scan remembers outlives" },
  { id: "r7-validator-span-slice", property: "R7 (cross-check): the validator's check of a low-confidence span is one memoised pass, not a slice and a search per span (quadratic on -p= repeated)", file: "src/domain/redaction.ts", find: "!looksRandomAt(scanned, span.start, span.end, digit, letter)", replace: "!(/[0-9]/.test(scanned.slice(span.start, span.end)) && /[A-Za-z]/.test(scanned.slice(span.start, span.end)))", tests: ["tests/unit/review-round7-flag-scaling.test.ts"], filter: '"-p="' },
  { id: "r7-forms-long-flag-uncounted", property: "R7 (cross-check): every match of the long-flag reader is a counted step of the scan", file: "src/domain/redaction-forms.ts", find: "  while ((m = LONG_FLAG.exec(text)) !== null) {\n    spend(1);\n", replace: "  while ((m = LONG_FLAG.exec(text)) !== null) {\n", tests: ["tests/unit/review-round7-flag-scaling.test.ts"], filter: "plain flags, 1000 repeats" },
  { id: "r7-forms-env-uncounted", property: "R7 (cross-check): every match of the ENV/ARG reader is a counted step of the scan", file: "src/domain/redaction-forms.ts", find: "  while ((m = ENV_DECLARATION.exec(text)) !== null) {\n    spend(1);\n", replace: "  while ((m = ENV_DECLARATION.exec(text)) !== null) {\n", tests: ["tests/unit/review-round7-flag-scaling.test.ts"], filter: "env flags, 1000 repeats" },
  { id: "r7-validator-end-bound", property: "R7 (cross-check): a span holds a digit only when the digit lies before the span's end", file: "src/domain/redaction.ts", find: "nextMark(text, start, isDigitCode, digit) < end", replace: "nextMark(text, start, isDigitCode, digit) <= end", tests: ["tests/unit/review-round7-validator-equivalence.test.ts"], filter: "agrees on every span" },
  { id: "r7-validator-memo-start", property: "R7 (cross-check): an answer remembered for a start serves only starts at or after it", file: "src/domain/redaction.ts", find: "memo.text === text && from >= memo.from && from <= memo.at", replace: "memo.text === text && from <= memo.at", tests: ["tests/unit/review-round7-validator-equivalence.test.ts"], filter: "falling starts" },
  { id: "r7-validator-letter-range", property: "R7 (cross-check): the letters are A-Z and a-z only (the old expression), nothing next to the ranges", file: "src/domain/redaction.ts", find: "(code >= 65 && code <= 90) || (code >= 97 && code <= 122)", replace: "(code >= 65 && code <= 91) || (code >= 96 && code <= 123)", tests: ["tests/unit/review-round7-validator-equivalence.test.ts"], filter: "agrees on every span" },
  { id: "r7-validator-digit-range", property: "R7 (cross-check): the digits are 0-9 only (the old expression), nothing next to the range", file: "src/domain/redaction.ts", find: "code >= 48 && code <= 57;", replace: "code >= 47 && code <= 58;", tests: ["tests/unit/review-round7-validator-equivalence.test.ts"], filter: "agrees on every span" },
  { id: "r7-barrel-export-star", property: "R7 (cross-check): the barrel names the redaction exports, so a test hook of redaction.ts never joins the public surface", file: "src/index.ts", find: 'export { containsSecret, detectSecretKinds, escapeHtml, OVERSIZE_REDACTED, REDACTED, redactDeep, redactIdentifier, redactIdentifiers, redactSecrets, safeReportText } from "./domain/redaction.js";', replace: 'export * from "./domain/redaction.js";', tests: ["tests/unit/review-round7-barrel.test.ts"], filter: "no test hook of redaction.ts is on the barrel" },
  { id: "r7-classify-expected-received-pair", property: "R7 (repaired classifier): an error thrown with Expected/Received lines is not a Playwright expect failure (the pair alternative on any line of the message is gone)", file: "scripts/mutation-classify.mjs", find: "Call log:|Timeout:|- Expected|\\+ Received)/.test(text);\n", replace: "Call log:|Timeout:|- Expected|\\+ Received)/.test(text) || (/^Expected(?: [a-z]+)?:/m.test(text) && /^Received(?: [a-z]+)?:/m.test(text));\n", tests: ["tests/unit/review-round7-classifier.test.ts"], filter: "repaired" },
  { id: "r7-classify-load-ignored", property: "R7 (repaired classifier): a mutant whose module does not load is INSTRUMENT_ERROR", file: "scripts/mutation-classify.mjs", find: '(baselineStatus === 0 && mutatedStatus !== 0 ? "INSTRUMENT_ERROR" : null)', replace: "null", tests: ["tests/unit/review-round7-classifier.test.ts"], filter: "classifyLoad" },
  { id: "r7-classify-load-baseline", property: "R7 (repaired classifier): a probe that failed on the unmutated copy too says nothing about the mutant", file: "scripts/mutation-classify.mjs", find: 'baselineStatus === 0 && mutatedStatus !== 0 ? "INSTRUMENT_ERROR"', replace: 'mutatedStatus !== 0 ? "INSTRUMENT_ERROR"', tests: ["tests/unit/review-round7-classifier.test.ts"], filter: "classifyLoad" },
  { id: "r7-classify-load-probe-status", property: "R7 (repaired classifier): the load probe returns the exit status of the probe process", file: "scripts/mutation-classify.mjs", find: "return { status: run.status, stderr:", replace: "return { status: 0, stderr:", tests: ["tests/unit/review-round7-classifier.test.ts"], filter: "loadProbe on a copy" },
  { id: "r7-classify-rejects-matcher", property: "R7 (repaired classifier): a failed `.rejects.toMatchObject` (vitest's own matcher frame) is an assertion failure", file: "scripts/mutation-classify.mjs", find: "MATCHER_ERROR.test(message) || REJECTS_MATCHER.test(message) ||", replace: "MATCHER_ERROR.test(message) ||", tests: ["tests/unit/review-round7-classifier.test.ts"], filter: "rejects" },
  { id: "r7-closed-group-paren", property: "R7 (ruled P1): a value that opens with a parenthesis is a group whose glued tail belongs to it", file: "src/domain/redaction-forms.ts", find: 'if (quote === "[" || quote === "{" || quote === "(") {', replace: 'if (quote === "[" || quote === "{") {', tests: ["tests/unit/review-round7-closed-groups.test.ts"], filter: "shape" },
  { id: "r7-closed-group-glued-word", property: "R7 (ruled P1): the word that the closing character of a brace, bracket or parenthesis group is glued to is part of the value", file: "src/domain/redaction-forms.ts", find: "Math.max(group, gluedWordEnd(text, group, ends), ends.unquotedEnd(text, i))", replace: "Math.max(group, ends.unquotedEnd(text, i))", tests: ["tests/unit/review-round7-closed-groups.test.ts"], filter: "shape" },
  { id: "r7-closed-group-closers", property: "R7 (ruled P1): closers behind a group that are glued to a word belong to the value (`{a}}S`)", file: "src/domain/redaction-forms.ts", find: 'while (text[k] === "}" || text[k] === ")" || text[k] === "]") k += 1;', replace: "", tests: ["tests/unit/review-round7-closed-groups.test.ts"], filter: "shape" },
  { id: "r7-closed-group-keep-closers", property: "R7 (ruled P1): the closers of the enclosing structure behind a group stay out of the value", file: "src/domain/redaction-forms.ts", find: "return k > from && after === k ? from : after;", replace: "return after;", tests: ["tests/unit/review-round7-closed-groups.test.ts"], filter: "what stays as it was" },
  { id: "r7-closed-group-paren-depth", property: "R7 (ruled P1): a parenthesis group is closed by its own parenthesis (nested groups are counted)", file: "src/domain/redaction-forms.ts", find: "if (depth === 0) {\n        spend(i - start + 1);", replace: "if (depth <= 1) {\n        spend(i - start + 1);", tests: ["tests/unit/review-round7-closed-groups.test.ts"], filter: "nested parentheses" },
  { id: "r8-masked-start-anchor", property: "R8 (logic P1): the first visible fragment of a record is anchored at the start of the derived text", file: "src/domain/derived-text.ts", find: "if (!derived.startsWith(first)) return false;", replace: "", tests: ["tests/unit/review-round8-masked-equality.test.ts"], filter: "refuses a record" },
  { id: "r8-masked-end-anchor", property: "R8 (logic P1): the last visible fragment of a record is anchored at the end of the derived text", file: "src/domain/derived-text.ts", find: "return derived.length - last.length >= at + 1 && derived.endsWith(last);", replace: "return derived.length - last.length >= at + 1;", tests: ["tests/unit/review-round8-masked-equality.test.ts"], filter: "refuses a record" },
  { id: "r8-masked-non-empty", property: "R8 (logic P1): a marker stands for a non-empty span", file: "src/domain/derived-text.ts", find: "const found = derived.indexOf(fragment, at + 1);", replace: "const found = derived.indexOf(fragment, at);", tests: ["tests/unit/review-round8-masked-equality.test.ts"], filter: "refuses a record" },
  { id: "r8-masked-third-reading", property: "R8 (logic P1): verification tries masked equality when the two redaction readings fail", file: "src/services/evidence.ts", find: "return maskedEqualDeep(d, r, free) || maskedEqualDeep(capLeaves(d), r, free);", replace: "return false;", tests: ["tests/integration/review-round8-legacy-credential-ids.test.ts"], filter: "two credential-shaped ids" },
  { id: "r8-cut-fixed-point", property: "R8 (logic P1): a cut of redacted text drops the partial word glued to the last marker, so the stored text is a fixed point of the redactor", file: "src/domain/derived-text.ts", find: "if (mark >= 0 && mark + MARKER.length < out.length && redactSecrets(out) !== out) return out.slice(0, mark + MARKER.length);", replace: "", tests: ["tests/unit/review-round8-cut-fixed-point.test.ts"], filter: "fixed point" },
  { id: "r8-cut-tail-kept", property: "R8 (logic P1): a tail behind the last marker that redaction leaves alone is kept by the cut", file: "src/domain/derived-text.ts", find: "mark + MARKER.length < out.length && redactSecrets(out) !== out)", replace: "mark + MARKER.length < out.length)", tests: ["tests/unit/review-round8-cut-fixed-point.test.ts"], filter: "kept" },
  { id: "r8-bang-word-is-value", property: "R8 (ruled P1): a `!` word glued to more text is a value, not a tag", file: "src/domain/redaction.ts", find: 'if (text[start] === "!" && i < text.length && text[i] !== " " && text[i] !== "\\t" && text[i] !== "\\n" && text[i] !== "\\r" && text[i] !== "\\\\") return start;', replace: "", tests: ["tests/unit/review-round8-bang-values.test.ts"], filter: "R8" },
  { id: "r8-bang-verbatim-tag", property: "R8 (ruled P1): a verbatim tag ends at its closing angle bracket, commas and colons inside it included", file: "src/domain/redaction.ts", find: "if (close > 0 && close - i <= 256) i = close + 1;", replace: "", tests: ["tests/unit/review-round8-bang-values.test.ts"], filter: "tags stay tags" },
  { id: "r8-bang-line-break", property: "R8 (ruled P1): a tag followed by a line break is still a tag", file: "src/domain/redaction.ts", find: 'text[i] !== "\\t" && text[i] !== "\\n" && text[i] !== "\\r" && text[i] !== "\\\\") return start;', replace: 'text[i] !== "\\t" && text[i] !== "\\r" && text[i] !== "\\\\") return start;', tests: ["tests/unit/review-round8-bang-values.test.ts"], filter: "end of the line" },
  { id: "r8b7-cut-prefix-mode", property: "R8 B7 (logic P1): a record that is a cut of the derivation is matched as a masked prefix (no end anchor)", file: "src/domain/derived-text.ts", find: "if (prefix) return derived.indexOf(last, at + 1) >= at + 1;", replace: "", tests: ["tests/unit/review-round8-masked-strict.test.ts"], filter: "prefix mode" },
  { id: "r8b7-prefix-last-behind-span", property: "R8 B7 (logic P1): in prefix mode the last visible fragment stands behind the last hidden span", file: "src/domain/derived-text.ts", find: "if (prefix) return derived.indexOf(last, at + 1) >= at + 1;", replace: "if (prefix) return derived.includes(last);", tests: ["tests/unit/review-round8-masked-strict.test.ts"], filter: "prefix mode" },
  { id: "r8b7-prefix-no-marker-anchor", property: "R8 B7 (logic P1): a cut record without a marker is a prefix of the derivation (anchored at its start)", file: "src/domain/derived-text.ts", find: "return prefix ? derived.startsWith(recorded) : derived === recorded;", replace: "return prefix ? derived.includes(recorded) : derived === recorded;", tests: ["tests/unit/review-round8-masked-strict.test.ts"], filter: "prefix mode" },
  { id: "r8b7-cut-window-upper", property: "R8 B7 (logic P1): a record longer than the cap is not a cut", file: "src/domain/derived-text.ts", find: "return recorded.length <= TEXT_CAP && recorded.length > TEXT_CAP - MARKER.length;", replace: "return recorded.length > TEXT_CAP - MARKER.length;", tests: ["tests/unit/review-round8-masked-strict.test.ts"], filter: "uses the prefix mode only" },
  { id: "r8b7-cut-window-lower", property: "R8 B7 (logic P1): a record far below the cap is not a cut, so a truncated record keeps both anchors", file: "src/domain/derived-text.ts", find: "return recorded.length <= TEXT_CAP && recorded.length > TEXT_CAP - MARKER.length;", replace: "return recorded.length <= TEXT_CAP && recorded.length > 0;", tests: ["tests/unit/review-round8-masked-strict.test.ts"], filter: "uses the prefix mode only" },
  { id: "r8b7-cut-window-edge", property: "R8 B7 (logic P1): the window of a cut is the cap and the nine characters below it (a split marker or surrogate pair)", file: "src/domain/derived-text.ts", find: "return recorded.length <= TEXT_CAP && recorded.length > TEXT_CAP - MARKER.length;", replace: "return recorded.length <= TEXT_CAP && recorded.length >= TEXT_CAP - MARKER.length;", tests: ["tests/unit/review-round8-masked-strict.test.ts"], filter: "uses the prefix mode only" },
  { id: "r8b7-cut-looks-cut-call", property: "R8 B7 (logic P1): the masked reading of a free text uses the prefix mode for a record that looks cut", file: "src/domain/derived-text.ts", find: "maskedEqual(derived, recorded, looksCut(recorded))", replace: "maskedEqual(derived, recorded, false)", tests: ["tests/unit/review-round8-masked-strict.test.ts"], filter: "prefix mode" },
  { id: "r8b7-shape-check", property: "R8 B7 (logic P2): a marker of a record stands behind a credential-shaped word and its separator", file: "src/domain/derived-text.ts", find: "if (!AFTER_WORD.test(parts[i] as string)) return false;", replace: ";", tests: ["tests/unit/review-round8-masked-strict.test.ts"], filter: "credential-shaped word" },
  { id: "r8b7-shape-word-char", property: "R8 B7 (logic P2): a separator needs a word character in front of it", file: "src/domain/derived-text.ts", find: "const AFTER_WORD = /[A-Za-z0-9_.-][:=]$/;", replace: "const AFTER_WORD = /[:=]$/;", tests: ["tests/unit/review-round8-masked-strict.test.ts"], filter: "credential-shaped word" },
  { id: "r8b7-shape-at-end", property: "R8 B7 (logic P2): the separator stands right in front of the marker", file: "src/domain/derived-text.ts", find: "const AFTER_WORD = /[A-Za-z0-9_.-][:=]$/;", replace: "const AFTER_WORD = /[A-Za-z0-9_.-][:=]/;", tests: ["tests/unit/review-round8-masked-strict.test.ts"], filter: "credential-shaped word" },
  { id: "r8b7-free-only", property: "R8 B7 (logic P2): the masked reading applies to free text members only", file: "src/domain/derived-text.ts", find: "(free ? maskedEqual(derived, recorded, looksCut(recorded)) : derived === recorded)", replace: "maskedEqual(derived, recorded, looksCut(recorded))", tests: ["tests/unit/review-round8-masked-strict.test.ts"], filter: "free text members only" },
  { id: "r8b7-free-message", property: "R8 B7 (logic P2): `message` is a free text member", file: "src/domain/derived-text.ts", find: 'new Set(["message", "reason", "description"])', replace: 'new Set(["reason", "description"])', tests: ["tests/unit/review-round8-masked-strict.test.ts"], filter: "free text members only" },
  { id: "r8b7-free-reason", property: "R8 B7 (logic P2): `reason` is a free text member", file: "src/domain/derived-text.ts", find: 'new Set(["message", "reason", "description"])', replace: 'new Set(["message", "description"])', tests: ["tests/unit/review-round8-masked-strict.test.ts"], filter: "free text members only" },
  { id: "r8b7-free-description", property: "R8 B7 (logic P2): `description` is a free text member", file: "src/domain/derived-text.ts", find: 'new Set(["message", "reason", "description"])', replace: 'new Set(["message", "reason"])', tests: ["tests/unit/review-round8-masked-strict.test.ts"], filter: "free text members only" },
  { id: "r8b7-free-array", property: "R8 B7 (logic P2): the strings of an array take the member name of the array", file: "src/domain/derived-text.ts", find: "recorded.every((item, i) => maskedEqualDeep(derived[i], item, free))", replace: "recorded.every((item, i) => maskedEqualDeep(derived[i], item))", tests: ["tests/unit/review-round8-masked-strict.test.ts"], filter: "free text members only" },
  { id: "r8b7-free-by-derived-key", property: "R8 B7 (logic P2): a member is free text by its name, not by the name of a masked key", file: "src/domain/derived-text.ts", find: "FREE_TEXT.has(match))", replace: "true)", tests: ["tests/unit/review-round8-masked-strict.test.ts"], filter: "free text members only" },
  { id: "r8b7-reason-free", property: "R8 B7 (logic P2): the reason of a finding is read by masked equality", file: "src/services/evidence.ts", find: "sameReading(f.reason, row.reason, true)", replace: "sameReading(f.reason, row.reason)", tests: ["tests/integration/review-round8-legacy-cut-and-forgery.test.ts"], filter: "masked reading still applies to a finding reason" },
  { id: "r8b7-forgery-shape-integration", property: "R8 B7 (logic P2): a resealed bundle that blanks a code, an id, an edge, a hash, the assessment or a text is refused", file: "src/domain/derived-text.ts", find: "(free ? maskedEqual(derived, recorded, looksCut(recorded)) : derived === recorded)", replace: "(true ? maskedEqual(derived, recorded, looksCut(recorded)) : derived === recorded)", tests: ["tests/integration/review-round8-legacy-cut-and-forgery.test.ts"], filter: "every forgery of the recorded report" },
  { id: "r8b7-legacy-cut-integration", property: "R8 B7 (logic P1): a legacy message that a restore cuts at the cap verifies, restores and exports again", file: "src/domain/derived-text.ts", find: "maskedEqual(derived, recorded, looksCut(recorded))", replace: "maskedEqual(derived, recorded, recorded.length > TEXT_CAP)", tests: ["tests/integration/review-round8-legacy-cut-and-forgery.test.ts"], filter: "17 fields of 124 characters" },
  { id: "r8b7-bang-span-length", property: "R8 B7 (logic P1): a `!` value of six characters is hidden", file: "src/domain/redaction.ts", find: 'if (end - i >= 6) out.push({ start: i, end, kind: "credential_assignment", low: true });', replace: 'if (end - i >= 7) out.push({ start: i, end, kind: "credential_assignment", low: true });', tests: ["tests/unit/review-round8-bang-values.test.ts"], filter: "R8" },
  { id: "r8b7-bang-behind", property: "R8 B7 (logic P1): a `!` value is read from the character behind the bang (a bracket, a brace, a quote)", file: "src/domain/redaction.ts", find: "const end = Math.max(readValue(text, i + 1, ASSIGN_ENDS).end, word);", replace: "const end = Math.max(i + 1, word);", tests: ["tests/unit/review-round8-bang-values.test.ts"], filter: "R8" },
  { id: "r8b7-bang-word", property: "R8 B7 (logic P1): a `!` value is hidden to the end of the word up to a blank, a comma, a closing bracket, a backslash or a quote", file: "src/domain/redaction.ts", find: "const end = Math.max(readValue(text, i + 1, ASSIGN_ENDS).end, word);", replace: "const end = Math.max(readValue(text, i + 1, ASSIGN_ENDS).end, i + 1);", tests: ["tests/unit/review-round8-bang-values.test.ts"], filter: "R8" },
  { id: "r8b7-bang-advance", property: "R8 B7 (logic P1): the value behind a `!` word that ends at a quote is read as any other", file: "src/domain/redaction.ts", find: 'out.push({ start: i, end, kind: "credential_assignment", low: true });\n        i = end;', replace: 'out.push({ start: i, end, kind: "credential_assignment", low: true });', tests: ["tests/unit/review-round8-bang-values.test.ts"], filter: "R8" },
  { id: "r8b7-bang-backslash-guard", property: "R8 B7 (logic P1): a short word that a backslash ends is read as a bare value from the bang, with the key inside it kept", file: "src/domain/redaction.ts", find: 'if (text[word] !== "\\\\") {', replace: "if (true) {", tests: ["tests/unit/review-round6-security.test.ts"], filter: "the key word and its separator stay readable" },
  { id: "r5-long-flag", property: "R5 P2: a long flag with a secret last word takes the value after a space", file: "src/domain/redaction-forms.ts", find: 'if (!FLAG_SECRET_WORD.test(m[1] as string) || text[at] === "-") continue;', replace: "continue;", tests: ["tests/unit/review-round5-redaction.test.ts"], filter: "assignment operators, flags" },
];

const vitest = join(repo, "node_modules", "vitest", "vitest.mjs");
function runTests(cwd, tests, filter) {
  // The JSON report makes the kill rule structural (per failing test); the text output is kept for build errors.
  const reportFile = join(cwd, ".mutation-report.json");
  rmSync(reportFile, { force: true });
  const result = spawnSync(process.execPath, [vitest, "run", ...tests, ...(filter ? ["-t", filter] : []), "--reporter=default", "--reporter=json", `--outputFile.json=${reportFile}`], {
    cwd,
    encoding: "utf8",
    timeout: 300_000,
    maxBuffer: 64 * 1024 * 1024,
    detached: true,
    // FORCE_COLOR is set to 0 whatever the caller has: an inherited value makes node print a warning line in front of a crash marker of a spawned CLI
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", CHANGERADAR_TEST_DATABASE_URL: process.env.CHANGERADAR_TEST_DATABASE_URL ?? "" },
  });
  killProcessGroup(result.pid);
  let report = null;
  try {
    report = JSON.parse(readFileSync(reportFile, "utf8"));
  } catch {
    /* no report: the run crashed before vitest could write one */
  }
  return { status: result.status, output: `${result.stdout}\n${result.stderr}`, report };
}

const selected = MUTANTS.filter((m) => !only || m.id.includes(only));
if (checkOnly) {
  let broken = 0;
  const ids = new Set();
  for (const mutant of selected) {
    const occurrences = readFileSync(join(repo, mutant.file), "utf8").split(mutant.find).length - 1;
    const duplicate = ids.has(mutant.id) || MUTANTS.some((m) => m !== mutant && m.file === mutant.file && m.find === mutant.find && m.replace === mutant.replace);
    ids.add(mutant.id);
    if (occurrences !== 1 || duplicate) {
      broken += 1;
      console.log(JSON.stringify({ id: mutant.id, file: mutant.file, occurrences, duplicate }));
    }
  }
  console.log(JSON.stringify({ mutants: selected.length, broken }));
  process.exit(broken === 0 ? 0 : 1);
}
const temp = mkdtempSync(join(tmpdir(), "changeradar-mutation-"));
const report = [];
try {
  cpSync(repo, temp, {
    recursive: true,
    filter: (src) => {
      const rel = src.slice(repo.length + 1);
      return !["node_modules", ".git", ".claude", "coverage", "dist", ".changeradar"].some((skip) => rel === skip || rel.startsWith(`${skip}${sep}`));
    },
  });
  symlinkSync(join(repo, "node_modules"), join(temp, "node_modules"), "dir");

  const baselineCache = new Map();
  const loadBaselines = new Map();
  for (const mutant of selected) {
    const key = `${mutant.tests.join(",")}|${mutant.filter ?? ""}`;
    if (!baselineCache.has(key)) {
      const baseline = runTests(temp, mutant.tests, mutant.filter);
      baselineCache.set(key, baseline.status);
      if (baseline.status !== 0) throw new Error(`baseline for ${key} must pass before mutating:\n${baseline.output.slice(-2000)}`);
    }
    const path = join(temp, mutant.file);
    const original = readFileSync(path, "utf8");
    const occurrences = original.split(mutant.find).length - 1;
    if (occurrences !== 1) throw new Error(`INSTRUMENT_BROKEN ${mutant.id}: expected exactly one occurrence in ${mutant.file}, found ${occurrences}`);
    // Does the module that this mutant changes still load? (unmutated probe once per file, then the mutated copy): a mutant that breaks the load is
    // INSTRUMENT_ERROR and no test runs (a load-time crash of a spawned CLI reads like a failed expectation in the text of vitest).
    if (!loadBaselines.has(mutant.file)) loadBaselines.set(mutant.file, loadProbe(temp, mutant.file).status);
    writeFileSync(path, original.replace(mutant.find, () => mutant.replace));
    const probe = loadProbe(temp, mutant.file);
    const notLoading = classifyLoad(loadBaselines.get(mutant.file), probe.status);
    const mutated = notLoading ? { status: probe.status, output: probe.stderr, report: null } : runTests(temp, mutant.tests, mutant.filter);
    writeFileSync(path, original);
    // KILLED only by a FAILING TEST that failed on an assertion; a crash with no failing test is SUSPECT (see mutation-classify.mjs).
    const { result, failedTests } = notLoading ? { result: notLoading, failedTests: 0 } : classifyMutantRun(mutated.status, mutated.output, mutated.report);
    // The first failing assertion's text is recorded for EVERY result (a kill is evidence only with its message), and the load probe's stderr for a mutant that does not load.
    const firstFailure = (notLoading ? probe.stderr : mutated.report?.testResults?.flatMap((f) => f.assertionResults ?? []).find((t) => t.status === "failed")?.failureMessages?.[0])?.replace(/\u001b\[[0-9;]*m/g, "").slice(0, 300);
    report.push({ id: mutant.id, property: mutant.property, file: mutant.file, tests: mutant.tests, result, failed_tests: failedTests, ...(firstFailure ? { first_failure: firstFailure } : {}) });
    const restored = runTests(temp, mutant.tests, mutant.filter);
    if (restored.status !== 0) throw new Error(`restored ${mutant.id} must pass again:\n${restored.output.slice(-2000)}`);
    console.log(JSON.stringify(report.at(-1)));
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
const survivors = report.filter((r) => r.result !== "KILLED");
console.log(JSON.stringify({ mutants: report.length, killed: report.length - survivors.length, survivors: survivors.map((s) => s.id) }));
if (survivors.length > 0 || report.length === 0) process.exit(1);
