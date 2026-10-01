# Stage C-2 evidence (packaging, acceptance suite, end-to-end, operator documents): commands, results, controls

> **Superseded for the current revision.** Everything below records the gate at the stage C-2 tested revision, the revision that independent review round 1 examined and rejected (one P0 and several P1 findings). It is kept as history, not as evidence for any later revision. The code changed afterwards (`docs/qa/review-round1-ledger.md`), so the host gate, the PostgreSQL 17 run, the Node 22.12 floor gate, the Compose smoke and the runbook harness must be re-run on the final revision before any of these numbers is cited for it.

Implementer's record for stage C-2 (QA, packaging and integration). It is **not** an independent review or QA receipt: an independent reviewer must re-run the gate at the exact final revision. The criterion-by-criterion mapping to real test ids is `docs/qa/ac-matrix.md`. Earlier stage records: `docs/qa/stage-b-evidence.md`, `docs/qa/ui-evidence.md`.

## Tested revision

| Item | Value |
| --- | --- |
| Base | stage C-2, cut from stage C-1 (which contains stage B) |
| Tested revision (code under test, full gate run on exactly this revision, working tree clean) | the stage C-2 tested revision (identifiers are not kept in this public record) |
| Documentation-only differences after the tested revision | documentation only: this file is added after the tested revision |
| Host | macOS arm64 (Darwin 25.6), Node v25.8.2, Docker 29.8.0; the machine was in use for other work during the runs |
| Node floor environment | `node:22.12` container (Node v22.12.0 on Linux aarch64; logs: /logs) |
| PostgreSQL | `postgres:17-alpine` (PostgreSQL 17.11), throwaway container on 127.0.0.1, generated password, removed afterwards |
| Browser | Playwright 1.63.0 Chromium (host cache: macOS arm64; container: Linux arm64 installed with `npx playwright install --with-deps chromium`) |
| Fixture version | `fixtures/demo.json` `fixture_version` 1 (synthetic, opaque ids, no UUID literals; edges stamped one day before load because staleness is judged against the server's real clock; unit and acceptance tests load it with a fixed UTC clock) |
| Clock | every time below is from `date -u` / the system clock |

## Final host gate (`bash scripts/verify-quality.sh`, exit 0)

Started 2026-09-29T11:04:25Z, ended 2026-09-29T11:25:49Z. Logs are per step under the gate's log directory (not committed: they hold local paths).

| Step | Result | Exit | Start (UTC) | End (UTC) | Detail |
| --- | --- | --- | --- | --- | --- |
| `install` | PASS | 0 | 2026-09-29T11:04:25Z | 2026-09-29T11:04:25Z |  |
| `typecheck` | PASS | 0 | 2026-09-29T11:04:25Z | 2026-09-29T11:04:27Z |  |
| `build` | PASS | 0 | 2026-09-29T11:04:27Z | 2026-09-29T11:04:28Z |  |
| `server-suite-pglite` | PASS | 0 | 2026-09-29T11:04:28Z | 2026-09-29T11:05:53Z | files: 38 passed; tests: 689 passed; coverage: lines 99.21% branches 94.31% |
| `server-suite-pg17` | PASS | 0 | 2026-09-29T11:05:53Z | 2026-09-29T11:07:16Z | files: 38 passed; tests: 689 passed |
| `web-suite` | PASS | 0 | 2026-09-29T11:07:16Z | 2026-09-29T11:07:39Z | files: 9 passed; tests: 220 passed; coverage: lines 99.56% branches 95.33% |
| `mutation-server` | PASS | 0 | 2026-09-29T11:07:39Z | 2026-09-29T11:13:49Z |  |
| `mutation-web` | PASS | 0 | 2026-09-29T11:13:49Z | 2026-09-29T11:20:54Z |  |
| `schema-drift` | PASS | 0 | 2026-09-29T11:20:54Z | 2026-09-29T11:20:55Z |  |
| `licenses` | PASS | 0 | 2026-09-29T11:20:55Z | 2026-09-29T11:20:55Z |  |
| `hygiene` | PASS | 0 | 2026-09-29T11:20:55Z | 2026-09-29T11:20:56Z |  |
| `packaged-e2e` | PASS | 0 | 2026-09-29T11:20:56Z | 2026-09-29T11:22:02Z | playwright: 11 passed (1.1m) |
| `browser-e2e` | PASS | 0 | 2026-09-29T11:22:03Z | 2026-09-29T11:22:49Z | playwright: 11 passed (44.7s) |
| `mutation-e2e` | PASS | 0 | 2026-09-29T11:22:49Z | 2026-09-29T11:25:00Z |  |
| `runbook-harness` | PASS | 0 | 2026-09-29T11:25:00Z | 2026-09-29T11:25:23Z |  |
| `compose-smoke` | PASS | 0 | 2026-09-29T11:25:23Z | 2026-09-29T11:25:49Z |  |
| `red-control` | PASS | 0 | 2026-09-29T11:25:49Z | 2026-09-29T11:25:49Z |  |

Verdict line: `GATE GREEN: every step passed`

Coverage of the server suite (v8, thresholds 90% lines and branches enforced overall and per area, embedded engine):

| Area | Lines | Branches |
| --- | --- | --- |
| all files | 99.21% | 94.31% |
| `src/api` | 98.68% | 92.09% |
| `src/commands` | 97.37% | 92.72% |
| `src/db` | 96.9% | 90% |
| `src/domain` | 100% | 98.06% |
| `src/platform` | 100% | 100% |
| `src/services` | 99.8% | 94.13% |
| `src/workers` | 98.98% | 93.36% |

Web suite coverage (enforced 90%): lines 99.56%, branches 95.33%.

## Node 22.12 (throwaway `node:22.12` container, `bash scripts/node-floor-gate.sh`)

| Step | Result | Exit | Start (UTC) | End (UTC) | Detail |
| --- | --- | --- | --- | --- | --- |
| `install` | PASS | 0 | 2026-09-29T11:26:03Z | 2026-09-29T11:26:03Z |  |
| `typecheck` | PASS | 0 | 2026-09-29T11:26:03Z | 2026-09-29T11:26:05Z |  |
| `build` | PASS | 0 | 2026-09-29T11:26:05Z | 2026-09-29T11:26:13Z |  |
| `server-suite-pglite` | PASS | 0 | 2026-09-29T11:26:13Z | 2026-09-29T11:28:21Z | files: 38 passed; tests: 689 passed; coverage: lines 99.21% branches 94.31% |
| `server-suite-pg17` | SKIPPED | - | - | - | skipped by CR_SKIP |
| `web-suite` | PASS | 0 | 2026-09-29T11:28:21Z | 2026-09-29T11:28:39Z | files: 9 passed; tests: 220 passed; coverage: lines 99.56% branches 95.33% |
| `mutation-server` | PASS | 0 | 2026-09-29T11:28:39Z | 2026-09-29T11:39:07Z |  |
| `mutation-web` | PASS | 0 | 2026-09-29T11:39:07Z | 2026-09-29T11:45:15Z |  |
| `schema-drift` | PASS | 0 | 2026-09-29T11:45:15Z | 2026-09-29T11:45:17Z |  |
| `licenses` | PASS | 0 | 2026-09-29T11:45:17Z | 2026-09-29T11:45:17Z |  |
| `hygiene` | PASS | 0 | 2026-09-29T11:45:17Z | 2026-09-29T11:45:17Z |  |
| `packaged-e2e` | PASS | 0 | 2026-09-29T11:45:17Z | 2026-09-29T11:46:26Z | playwright: 11 passed (1.1m) |
| `browser-e2e` | SKIPPED | - | - | - | skipped by CR_SKIP |
| `mutation-e2e` | SKIPPED | - | - | - | skipped with browser |
| `runbook-harness` | PASS | 0 | 2026-09-29T11:46:26Z | 2026-09-29T11:46:39Z |  |
| `compose-smoke` | SKIPPED | - | - | - | skipped by CR_SKIP |
| `red-control` | PASS | 0 | 2026-09-29T11:46:39Z | 2026-09-29T11:46:40Z |  |

Verdict line: `GATE GREEN WITH SKIPS (this is not the full gate; skipped: server-suite-pg17, browser-e2e, mutation-e2e, compose-smoke)`

Skipped in the container, and why (the verdict says `GREEN WITH SKIPS`, never plain `GREEN`): the PostgreSQL 17 suite and the Compose smoke need Docker, which is not available inside the container; the browser suites (`browser-e2e`, `mutation-e2e`) need a Chromium build that the container does not have by default. **They were run separately on Node 22.12 in the same kind of container** with a Linux Chromium installed (ad hoc command `npx playwright install --with-deps chromium; npm run build; npx playwright test --project=browser`, via `node-floor-gate.sh <logs> "<command>"`): 11 passed in 35.3 s on Node v22.12.0, Linux aarch64, Chromium from `npx playwright install --with-deps chromium` (2026-09-29, after the gate above, at the same tested SHA). `mutation-e2e` was not run inside the container.

Notes on Node 22.12: `npm ci` warns `EBADENGINE` for development-only dependencies of `jsdom` (they ask for Node 22.13 or newer, or 22.22 for jsdom itself); no runtime dependency warns, and the whole web suite (jsdom) still passes on 22.12. The container runs at most four test workers (`CR_FLOOR_WORKERS`): the first attempt with one worker per host core (14) made every embedded-database test time out because the container's memory thrashed, which is a resource limit of the container, not a Node 22.12 incompatibility (a single test file passed in 27 s, the whole suite with four workers in about one to two minutes). That first attempt is recorded here because it happened; it was not masked or rerun until green without a change.

## Real Compose startup (`node scripts/compose-smoke.mjs`, also gate step `compose-smoke`)

```text
compose project changeradar-smoke-c89c92, application on http://localhost:63305 (127.0.0.1 only), started 2026-09-29T11:25:24.044Z
PASS  docker compose up --build (PostgreSQL 17 + application image): started
PASS  published ports are loopback only; the database publishes nothing: application 127.0.0.1:63305
PASS  the database is PostgreSQL 17: 17.11
PASS  readiness and the web UI: ready, UI served
PASS  admin create inside the container (no default password; generated password printed once): workspace <id>
PASS  sign in: admin
PASS  sample-manifests inside the container: 5 files
PASS  import, run with a seeded breaking removal, worker completes it: AFFECTED with direct and transitive consumers and owners: direct:job.invoice-export:team-data; direct:svc.ledger-sync:team-finance; transitive:artifact.invoice
PASS  INCOMPLETE and NO_KNOWN_IMPACT on PostgreSQL 17: INCOMPLETE with unknowns; stale hash is 409
PASS  evidence bundle: export, verify, and the data survives an application restart: report hash sha256:030e3b737fbd unchanged
teardown: docker compose down -v exit 0; leftover containers: 0; leftover volumes: 0
finished 2026-09-29T11:25:49.635Z: all compose checks passed
```

## Other runs

| Command | Exit | Result |
| --- | --- | --- |
| `npx playwright test --project=packaged` (inside the gate) | 0 | 11 passed (1.1m): network denier control, tarball contents, CLI basics, offline lifecycle with restore, rejected bundles, limits, failed migration, `kill -9` mid-job, port in use, packaged demo, seeded red gate |
| `npx playwright test --project=browser` (inside the gate) | 0 | 11 passed (44.7s) in real Chromium |
| `node scripts/runbook-harness.mjs` (inside the gate) | 0 | runbook-harness: all 13 runbook steps matched (supplemental evidence; AC-11 still needs the human receipt) |
| `bash scripts/verify-quality.sh --seeded-failure` (inside the gate as `red-control`) | 1 (expected) | prints `GATE RED`, never `GATE GREEN` |

## What was built in C-2

| Area | Files |
| --- | --- |
| Demo and sample data | `src/commands/demo.ts`, `src/commands/demo-fixture.ts`, `fixtures/demo.json`, CLI commands `demo` and `sample-manifests` in `src/commands/run.ts` |
| Acceptance suite indexed by the PRD flows | `tests/changeradar.spec.ts` (34 tests: a happy and a sad path per PRD 5b flow, real API, real persistence, real worker, fixed clock) |
| Browser end to end (real Chromium, no route mocks) | `tests/e2e/smoke.spec.ts` (11 tests), `tests/e2e/support/stack.ts`, `playwright.config.ts` |
| Packaged end to end (npm tarball in a fresh directory) | `tests/e2e/packaged.spec.ts` (11 tests), `tests/e2e/support/deny-network.cjs` |
| Gate and controls | `scripts/verify-quality.sh`, `scripts/hygiene-scan.mjs`, `scripts/e2e-mutation-controls.mjs`, `scripts/runbook-harness.mjs`, `scripts/compose-smoke.mjs`, `scripts/node-floor-gate.sh`, three C-2 mutants in `scripts/mutation-controls.mjs` |
| Packaging | `Dockerfile`, `.dockerignore`, `compose.yaml` (loopback-only port with a variable host port, `no-new-privileges`), `.env.example` (`CHANGERADAR_WEB_ROOT`), `package.json` (`files`, pinned `@playwright/test` 1.63.0, `e2e` scripts) |
| Documents | `README.md`, `docs/OPERATIONS.md` (finalized), `docs/RUNBOOK-SMOKE.md`, `docs/HUMAN-DRILL.md`, `SECURITY.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `docs/DEPENDENCY-LICENSES.md` (regenerated), this file and `docs/qa/ac-matrix.md` |

## Seeded controls run in C-2

| Control | Result |
| --- | --- |
| Server mutants (`scripts/mutation-controls.mjs`, 16 stage B mutants plus 3 C-2 mutants that only the acceptance suite can kill) | 19 of 19 killed, 0 survivors |
| Web mutants (`scripts/web-mutation-controls.mjs`) | 14 of 14 killed, 0 survivors |
| End-to-end mutants (`scripts/e2e-mutation-controls.mjs`: CSRF header not sent and stale baseline accepted through real Chromium, unsupported bundle version accepted through the installed tarball) | 3 of 3 killed, 0 survivors |
| First attempt at the packaged mutant "bundle hash check removed" | **SURVIVED**: the whole-bundle hash is defense in depth behind section hashes, snapshot rebuild and run re-derivation, so removing it alone is not visible to a black-box tamper test. It stays covered by the integration mutant `bundle-hash-check` (killed); the packaged mutant was replaced by "unsupported bundle version accepted" (killed). Recorded, not hidden |
| The gate turns red on a seeded mandatory failure | `bash scripts/verify-quality.sh --seeded-failure` exits 1 and prints `GATE RED`; gate step `red-control` and `packaged.spec.ts` assert it |
| A corrupted bundle turns the installed binary red | `packaged.spec.ts` (exit 2) |
| The runbook harness fails on a wrong expectation | `CR_RUNBOOK_FILE=<runbook with "assessment: SAFE" in place of "assessment: AFFECTED"> node scripts/runbook-harness.mjs` printed `step 7/13: FAIL, missing: "assessment: SAFE"` and exited 1 (run at 2026-09-29T11:26:03Z to 11:26:24Z) |
| The browser monitor bites | with the stale-baseline test's allowed statuses narrowed to `[401]`, the suite failed with `unexpected HTTP error responses seen by the browser: 409` |
| The network denier bites | `packaged.spec.ts :: the network denier bites (positive control)` |
| The hygiene scan bites | `hygiene.test.ts :: SEEDED NEGATIVE CONTROL` |

## Defects found by C-2 (all fixed)

1. **`serve` on a taken port hung.** `startServer` left the job worker polling when `listen` failed, so the process stayed alive after printing the error. It now stops the worker and closes the app. Test: `packaged.spec.ts :: serve on a port that is already taken exits non-zero and does not hang`; `demo-failures.test.ts`.
2. **Two processes on one embedded data directory were accepted silently.** A running `serve` and a second `serve`, `worker` or CLI command (`admin create`, `export`) each loaded their own copy of the database files and could diverge or corrupt it. Found by trying to run `serve --no-worker` beside `worker` for the operations guide. The embedded adapter now refuses a second opener with the owner's process id (lock file `<dir>.lock`) and takes over a lock left by a crashed or killed process. Tests: `pglite-lock.test.ts` (3, including a real second process), `packaged.spec.ts` (`kill -9` restart takes over the stale lock).
3. **The stage B `readiness-gate` mutant had been broken by C-1.** The static UI serving changed the guarded line, so `mutation-controls.mjs` aborted with `INSTRUMENT_BROKEN` and the mutants after it never ran. The gate reported it as a failed step (`GATE RED`); the find string was updated and all 19 mutants now run.
4. **Two end-to-end test races found on Linux and Node 22.12**: the run list badges were read before the list loaded, and layout was measured before loading states cleared. Both now wait explicitly.
5. **Compose smoke script** read the HTML export as JSON (its own bug, found by its first run).

## Limits of this evidence

- Everything network related ran against local FIXTURE servers over real sockets. No live provider was used and none is claimed.
- The `kill -9` proof is on the embedded database (one process). On PostgreSQL 17, worker crashes are simulated (`SimulatedCrash` hooks) in the integration and acceptance suites (both database runs), and the Compose smoke restarts the application container; a `kill -9` of a separate `worker` process on PostgreSQL 17 was not run.
- The human drill (AC-11) has not been done. `scripts/runbook-harness.mjs` is an automated run of the same commands and is supplemental only.
- Chromium only; no Firefox, Safari, screen reader, forced-colors or touch testing.
- The machine was in use for other work during these runs; timing-sensitive steps ran at different loads (the first host gate run took about 23 minutes, later runs less). No failure was masked; the only red step in the earlier host run (mutation-server) was a real defect (item 3 above), fixed before the final run.
- No independent code review or QA has been done on this revision.
