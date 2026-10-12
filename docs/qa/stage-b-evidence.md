# Stage B evidence (API, persistence, worker): commands, results, controls

Implementer's record for stage B. It is **not** an independent review or QA receipt. The criterion-by-criterion mapping to test ids is `docs/qa/ac-matrix.md`; this file records what was run, on what, with what result.

`docs/qa/ac-matrix.md` was reconciled with this file in one consolidated rewrite (real test ids, no stale stage A result tables; the stage A manual mutation check is kept as a labelled historical note).

## Tested revision

| Item | Value |
| --- | --- |
| Base | stage B, built on stage A plus one documents-only change that records AC-11 as PENDING_HUMAN_RECEIPT |
| Tested tree | the stage B tree (working tree clean at the time of the runs; revision identifiers are not kept in this public record) |
| Run started | 2026-09-29T07:21:48Z (system clock, `date -u`) |
| Environment | Node v25.8.2, macOS arm64 (Apple M4 Pro, 24 GB), machine heavily loaded by unrelated work (load average above 100) during the runs; PostgreSQL 17.11 (`postgres:17-alpine`, throwaway container on 127.0.0.1, random port, generated password, removed afterwards) |
| Fixture version | synthetic manifests built by `tests/helpers/builders.ts` and `tests/helpers/scenario.ts`; local FIXTURE HTTP server `tests/helpers/fixture-server.ts` |
| Documentation-only differences | the commit that adds this file (and later docs-only edits, if any) differs from the tested tree in `docs/` only |

## Commands and results

| Command | Exit | Result |
| --- | --- | --- |
| `npm run typecheck` | 0 | `tsc -p tsconfig.json --noEmit` and `tsc -p tsconfig.test.json --noEmit` clean (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) |
| `npm run build` | 0 | `tsc -p tsconfig.json`; the compiled entry `node dist/src/cli.js` was also run by hand (migrate, admin create, serve, health, login, import, run, export, verify-bundle, restore): the sequence in `docs/OPERATIONS.md` |
| `npx vitest run --coverage` (embedded engine, default target) | 0 | 32 test files, **626 tests passed**; coverage thresholds enforced per area, see below |
| `PGPASSWORD=... CHANGERADAR_TEST_DATABASE_URL=postgres://cr@127.0.0.1:<port>/postgres npx vitest run` (real PostgreSQL 17.11) | 0 | 32 test files, **626 tests passed**: the same suite, unchanged, on a real server. Each suite creates and drops its own database on that server |
| `npm run schema:check` | 0 | `schemas/dependencies.json` up to date |
| `node scripts/dependency-licenses.mjs --check` | 0 | 189 packages, none non-permissive; the three stage B runtime additions are `fastify` (MIT), `pg` (MIT), `@electric-sql/pglite` (Apache-2.0) |
| `node scripts/mutation-controls.mjs` (also `npm run mutation`) | 0 | 16 seeded mutants, 16 killed, 0 survivors |
| `sanitize-content --scope public src tests docs migrations scripts compose.yaml package.json vitest.config.ts` | 0 | 112 files, 0 PII, 0 codenames. `.env.example` and the `.mjs` script are outside the scanner's extension set, so `.txt` and `.js` copies were scanned instead: clean |
| `sec-scan .` | 1 | 5 PASS, 1 WARN, 0 FAIL. The warning is the SSRF deny-list in `src/workers/ssrf.ts` (documentation, metadata and reserved IPv4 ranges written as literals on purpose). An earlier scan failed on test password constants and `user:password@` connection strings in docs; both were removed (credentials are generated at runtime, docs use `PGPASSWORD`) |

Not run by stage B (owned by stage C): `scripts/verify-quality.sh` (still the stage A stub), browser tests, the Docker image build, the human drill.

## Coverage (embedded run, v8, thresholds 90% lines and branches enforced overall and per area)

| Area | Lines | Branches |
| --- | --- | --- |
| all files | 99.18% | 94.61% |
| `src/services` (domain services and persistence services) | 99.8% | 94.13% |
| `src/domain` | 100% | 98.06% |
| `src/workers` (worker, HTTP check runner, egress guard) | 98.98% | 93.36% |
| `src/api` | 98.43% | 91.11% |
| `src/platform` | 100% | 100% |
| `src/commands` (CLI commands, run in process) | 95.94% | 94.84% |
| `src/db` (migrator, adapters) | 95.16% | 95.83% |

Exclusions (documented, in `vitest.config.ts`): `src/cli.ts` (the roughly 65 line process entry: the stdin reader and its cap, signal wiring, exit codes; it is covered by spawned-process tests, not by the in-process coverage number, and the `serve` entry point by a spawned smoke test); `src/db/pg.ts` (the node-postgres adapter: it cannot run on the embedded target, and the entire integration suite runs through it in the PostgreSQL 17 run above); one defensive branch in the worker marked `v8 ignore` (an `assess()` refusal that cannot occur because both hashes were verified just before). Individual files below 90% branch coverage exist (for example `worker.ts` 85.96%, `report.ts` 87.5%, `http.ts` 85.71%, `retention.ts` 83.33%); the enforced floor is per area, and the criterion evidence is the matrix, not coverage.

## Seeded mutation controls

`scripts/mutation-controls.mjs` copies the tree to a disposable directory, checks that the named tests pass, applies ONE textual mutation (which must match exactly once), requires the same tests to FAIL on assertions (not on a build error), restores it, and requires them to pass again. It never edits the checkout. Result: 16 of 16 killed.

| Mutant | Property removed | Killed by |
| --- | --- | --- |
| `auth-role-import` | role check on snapshot import | `auth.test.ts` (2 tests) |
| `auth-role-export` | role check on evidence bundle export | `auth.test.ts` (1) |
| `scope-snapshot-read` | workspace scoping on snapshot reads | `isolation.test.ts` (4) |
| `scope-run-read` | workspace scoping on run reads and exports | `isolation.test.ts` (1) |
| `baseline-moved-409` | run request against a superseded baseline is 409 | `impact.test.ts`, `idempotency.test.ts` (3) |
| `baseline-hash-409` | stale `expected_hash` is 409 | `impact.test.ts` (3) |
| `csrf` | CSRF token required on mutations | `auth.test.ts` (1) |
| `ssrf-private-address` | private and loopback destinations refused | `ssrf.test.ts`, `checks.test.ts` (9) |
| `check-failure-becomes-pass` | a failed live check is never converted to passed | `checks.test.ts` (3) |
| `uncertain-outcome-not-unknown` | an interrupted check ends UNKNOWN and is not re-run | `worker.test.ts` (1) |
| `lease-fencing` | a worker that lost its lease cannot commit | `worker.test.ts` (5) |
| `idempotency-body-conflict` | same key, changed body is 409 | `idempotency.test.ts` (2) |
| `bundle-hash-check` | edited or truncated bundle rejected by hash | `export-restore.test.ts` (1) |
| `bundle-rederivation` | a re-sealed bundle with edited findings is rejected | `export-restore.test.ts` (2) |
| `readiness-gate` | failed migration stops readiness | `migrations.test.ts` (1) |
| `payload-limit` | oversize bodies refused before processing | `snapshots.test.ts` (1) |

Hand-verified in the working tree as well (not through the script): removing `requireRole(principal, "operator")` from `importSnapshot` made `auth.test.ts` fail with `expected 201 to be 403` in "import snapshot: viewer 403, operator 201, admin 201" and "a denied write changes no state and enqueues no job" (2 failed, 35 passed); after restoring the file the same run was 37 passed.

## Defects the tests found while building (all fixed)

1. The egress classifier treated every public IPv4 address as blocked: node's `BlockList` matches IPv4 addresses against IPv4-mapped IPv6 rules, so a `::ffff:0:0/96` rule swallowed everything. Found by the address-vector unit test; IPv4-mapped and IPv4-compatible forms are now matched on their canonical text.
2. A request aborted before it was sent left an unhandled connection error (handler attached too late). Found by the abort test.
3. A per-check client timeout equal to the check deadline made the outcome ERROR instead of TIMED_OUT about one time in twenty. Found as a flake on PostgreSQL; the client limit is now deliberately longer than the domain deadline.
4. A retry of an accepted run request after the baseline had moved was answered 409 STALE_BASELINE instead of with its original receipt. Idempotency replay is now checked before any state-dependent validation.
5. `SecretBox` could not decrypt an empty plaintext, and its MAC input was ambiguous between purpose and value. Both fixed.
6. The migrator reported a lost database connection as a broken migration. Non-migration failures now propagate so readiness can say `database_unavailable`.

## Limits of this evidence

- Everything network related ran against a local FIXTURE HTTP server (a real socket and the real HTTP path). No live provider was used and none is claimed.
- Concurrency tests (parallel run requests racing imports, concurrent migrators, concurrent workers, concurrent identical Idempotency-Keys) ran on both databases. On the embedded engine the single connection serializes transactions, so genuine parallel-transaction interleaving is only exercised in the PostgreSQL run.
- The 25 MB limit was exercised precisely on a reduced limit (200,000 bytes, so the same code path runs on a small body). At-limit workloads (10,000 nodes, 50,000 edges, a 9.2 MB manifest, a 27 MB bundle) were run through the real API in the benchmark (`docs/BENCHMARK.md`), not as tests.
- The machine was heavily loaded during the runs (load average above 100). One timing-sensitive test exceeded its old 30 s limit once; the limit is now 60 s. No failure was masked or retried.
- No independent code review or QA has been done on this revision.
