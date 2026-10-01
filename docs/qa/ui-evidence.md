# Stage C-1 evidence (web UI and static report): commands, results, controls

Implementer's record for stage C-1 (UI and report). It is **not** an independent review or QA receipt, and it does not edit `docs/qa/ac-matrix.md`: stage C-2 QA reconciles that file. Rows below say what the implementer's own tests show; none of them is an independent PASS.

## Tested revision

| Item | Value |
| --- | --- |
| Base | stage C-1, cut from the stage B revision and rebased onto a later stage B revision (documents only: the consolidated `docs/qa/ac-matrix.md` and `stage-b-evidence.md`). The suites were run before the rebase; the rebase changed docs only, and the final run of `tests/integration/static.test.ts` after it is noted in the final report |
| Code under test | see the final report for the full SHA; the working tree was clean for every run listed here |
| Run window | 2026-09-29T07:30Z to 2026-09-29T08:40Z (system clock, `date -u`) |
| Environment | Node v25.8.2, macOS arm64, machine busy with unrelated work; embedded PostgreSQL (PGlite) for every suite; real PostgreSQL was not used in this stage |
| Real browser | headless Google Chrome (system install) driven over the DevTools protocol against the packaged build (`node dist/src/cli.js serve`) on `localhost` |
| Fixture version | synthetic manifests from `tests/helpers/builders.ts` and `tests/helpers/scenario.ts`, plus `tests/web/global-setup.ts` (eight synthetic workspaces) |

## What was built

| Area | Files |
| --- | --- |
| Single page app (React 19, react-router) | `src/web/{main,app,api,hooks,components,graph,types}.ts(x)`, `src/web/pages/{snapshots,runs,admin}.tsx`, `src/web/styles.css`, `src/web/index.html` |
| Static HTML report renderer (`ReportRenderer`) | `src/report/html-report.ts`, shared wording in `src/report/wording.ts` (used by the report and the SPA so both say the same thing about a verdict) |
| Build and test config | `vite.config.ts`, `tsconfig.web.json`, `vitest.web.config.ts`, `package.json` scripts (`build:web`, `dev:web`, `test:web`, `test:web:coverage`, `mutation:web`), `scripts/web-mutation-controls.mjs` |
| Tests | `tests/web/*` (jsdom render tests, real-API tests, report tests, golden files) and `tests/integration/static.test.ts` (server suite) |

### Minimum server wiring (files touched outside the UI territory)

| File | Change |
| --- | --- |
| `src/api/static.ts` (new) | serves `dist/web` with a single page app fallback; same origin, CSP `default-src 'none'; script-src 'self'; style-src 'self'; ...; frame-ancestors 'none'`, real-path containment (no traversal, no symlink escape), extension-less paths only fall back to `index.html` |
| `src/api/server.ts` | `AppOptions.webRoot` implemented: the not-found handler calls the static handler; when a web root is set, non-`/api` requests skip the readiness gate so the UI loads and shows a "service unavailable" state |
| `src/api/bootstrap.ts` | `startServer` passes `webRoot` through |
| `src/commands/run.ts` | `serve` serves the UI from `CHANGERADAR_WEB_ROOT` or from `dist/web` next to the compiled server when it has been built; running from source serves the API only and says so on stderr |
| `src/platform/config.ts` | `ServerConfig.webRoot` (`CHANGERADAR_WEB_ROOT`, optional) and `ctx.reportRenderer = htmlReportRenderer` in `contextFromConfig` |
| `scripts/dependency-licenses.mjs` | `MIT-0` accepted as permissive (transitive dependency of jsdom); policy text otherwise unchanged |

No stage B test needed a change; the full server suite is green with these edits (see below).

## Commands and results

| Command | Exit | Result |
| --- | --- | --- |
| `npm run typecheck` | 0 | server, test and web configs clean (`tsc -p tsconfig.json`, `tsconfig.test.json`, `tsconfig.web.json`) |
| `npm run build` | 0 | `tsc` server build and `vite build` (`dist/web/index.html`, one JS and one CSS asset, no inline script) |
| `npx vitest run` (server suite, PGlite) | 0 | 33 test files, **637 tests passed** (stage B: 626; +11 in `tests/integration/static.test.ts`); coverage thresholds enforced per area and met: all files 98.43% lines / 94.66% branches, `src/api/static.ts` 100% / 93.33% |
| `npx vitest run -c vitest.web.config.ts --coverage` (web suite) | 0 | 9 test files, **220 tests passed**; thresholds met (see below) |
| `node scripts/web-mutation-controls.mjs` | 0 | 14 seeded mutants, 14 killed, 0 survivors (run on the final code) |
| `node scripts/dependency-licenses.mjs --check` | 0 | 246 packages, none non-permissive; new packages are development-only (react, react-dom, react-router-dom, vite, @vitejs/plugin-react, jsdom, @testing-library/react and dom, type packages), all pinned exact; MIT, plus MIT-0 for two transitive packages of jsdom; runtime dependencies unchanged (65 packages) |
| `sanitize-content --scope public <changed paths>` | 0 | 128 files (src, tests, docs/qa/ui-evidence.md, docs/DEPENDENCY-LICENSES.md, configs): 0 PII, 0 codenames. `.mjs` scripts are outside the scanner's extension set and were reviewed by hand |
| `sec-scan .` | 1 | 5 PASS, 1 WARN, 0 FAIL; the one warning is the SSRF deny-list literals in `src/workers/ssrf.ts` (unchanged since stage B) |

### Web coverage (measured separately from the server suite, v8, threshold 90% lines and branches enforced)

| Scope | Lines | Branches | Statements | Functions |
| --- | --- | --- | --- | --- |
| `src/web` (single page app) | 99.51% (607/610) | 94.95% (695/732) | 98.22% | 98.58% |
| `src/report` (HTML renderer and wording) | 100.00% (81/81) | 98.78% (81/82) | 100.00% | 100.00% |
| both | 99.57% (688/691) | 95.33% (776/814) | 98.43% | 98.74% |

Per file branch coverage: `hooks.ts` 89.18% is the lowest (the rest are 91% or higher); the enforced floor is on the total, and the criterion evidence is the table below, not coverage.

Exclusions: `src/web/main.tsx` (mounts `<App/>`) and `src/web/env.d.ts` (a type declaration). One defensive guard in `src/web/pages/runs.tsx` is marked `v8 ignore` (a listed snapshot is always selected by the effect above it; the guard only satisfies the type checker). The server suite's own coverage thresholds still hold with `src/api/static.ts` included (98.43% lines / 94.66% branches overall).

## Acceptance criteria touched by this stage

Test ids are `file :: group > test`. "Real API" means the test drives the UI (or fetches the export) against the real Fastify server, embedded PostgreSQL and the real job worker started by `tests/web/global-setup.ts`; nothing there is a route mock. Mocked-fetch tests are used only for states a real server cannot be made to produce on demand (429, 503, 413, unreadable bodies, unreachable server).

| AC | UI and report behavior | Proven by (implementer's tests) |
| --- | --- | --- |
| AC-01 | import form shows the domain's 422 issues (JSON pointer and code) and leaves no state; secret-looking values are refused and never shown back | `write-pages.test.tsx :: import snapshot (real API) > a manifest the domain rejects (dangling edge) ...`; `... > a manifest containing a secret-looking value is refused and the value is never shown back (AC-09)` |
| AC-02 | ordered source-to-consumer paths with owner, direct and transitive | `read-pages.test.tsx :: impact runs ... > AFFECTED: verdict, owners, ordered source-to-consumer paths, stable ids equal to the JSON export, graph, exports` |
| AC-03 | cycles reported once, marked in list and drawing; the run terminates; finding ids are stable across the JSON and HTML exports | `read-pages.test.tsx :: ... > a cycle is reported once, marked in the list and in the drawing, and the run still terminates`; `report-render.test.tsx :: static HTML report: deterministic output (golden files)` (four goldens: affected, incomplete, no known impact, hostile) |
| AC-04 | AFFECTED, INCOMPLETE and NO_KNOWN_IMPACT are distinct (label, glyph, border style, class); INCOMPLETE and NO_KNOWN_IMPACT always show coverage limits and unknowns; nothing reads as safe | `read-pages.test.tsx :: ... > INCOMPLETE is visibly not safe: ...`, `... > NO_KNOWN_IMPACT states its limits and does not read as safe`; `report-render.test.tsx :: ... the three verdicts ... > AFFECTED, INCOMPLETE and NO_KNOWN_IMPACT use different labels, classes and border treatments; none says safe`, `... > INCOMPLETE and NO_KNOWN_IMPACT always show coverage limits; ...`; `states.test.tsx :: run detail: states and polling` |
| AC-05 | a baseline that moved while the form was open is a 409: the UI names the current baseline, sends nothing stale, offers "Use the current baseline"; a superseded snapshot needs an explicit opt-in | `write-pages.test.tsx :: new impact run (real API) > a baseline that moved while the form was open is a 409 ... (AC-05)`, `... > assessing against a superseded snapshot needs an explicit opt-in ...` |
| AC-06 | a failing live check is visible in the run (state ERROR with the real ECONNREFUSED detail), the verdict is INCOMPLETE and the check is never styled as a pass | `write-pages.test.tsx :: contract checks and administration (real API) > an admin creates a check, a failing live check makes the run INCOMPLETE and visible, and disabling works`; `states.test.tsx :: run detail > shows cycles, changes, contract checks in every state, ...` |
| AC-07 | every page has loading, empty, denied and failed states; JSON and HTML exports carry the same finding ids (real service, six scenarios including 250 findings) | `states.test.tsx :: snapshots: loading, empty, denied and failed states (AC-07)`, `... :: snapshot detail: loading, empty, denied and failed states (AC-07)`, `... :: impact runs: loading, empty, denied and failed states (AC-07)`, `... :: new run: loading, empty, denied and failed states (AC-07)`, `... :: run detail: loading, empty, denied and failed states (AC-07)`, `... :: checks: loading, empty, denied and failed states (AC-07)`, `... :: events: loading, empty, denied and failed states (AC-07)`, `... :: administration: loading, empty, denied and failed states (AC-07)` (8 pages x loading, 401, 403, 404, 409, 413, 422, 429, 503, network); `states.test.tsx :: empty states`; `report-service.test.ts :: AC-07: the JSON export and the HTML export of a real run list the same finding ids` |
| AC-09 | hostile manifest strings render as text in the SPA and in the report; planted secrets are redacted in the report; the report has no script, no external resource, a hash-pinned style CSP | `read-pages.test.tsx :: AC-09 in the UI > snapshot, node and run pages show payloads literally and execute nothing`; `report-render.test.tsx :: ... hostile strings render as text and secrets are redacted (AC-09)`; `report-service.test.ts :: ... > hostile manifest strings reach the real HTML export only as escaped text (AC-09)`; `report-render.test.tsx :: ... structure and self-containment > has no script, no external resource, ...`, `... > carries a strict content security policy ...` |
| AC-10 | JSON and HTML report downloads for every role, evidence bundle only for operator and admin | `read-pages.test.tsx :: ... > AFFECTED: ...` (viewer controls), `... > an operator additionally gets the evidence bundle` |
| AC-12 | viewers see no mutation controls and are denied before any request; operator and admin controls follow the API roles; cross-workspace ids look exactly like missing ones; CSRF header on every mutation | `read-pages.test.tsx :: snapshots ... > a viewer sees ...`, `... > an operator gets ...`, `... > an admin sees every destination`, `... > another workspace's snapshot is 'not found', worded exactly like a missing one, ...`, `impact runs ... > another workspace's run is 'not found' ...`; `write-pages.test.tsx :: import snapshot > a viewer is denied before any request is made`, `new impact run > a viewer is denied ...`, `... administration: an operator is denied ...`, `... events: ...`; `session.test.tsx :: session lifecycle > the CSRF token is sent on every mutation and a wrong one is refused by the server`; `units.test.tsx :: api client > sends the CSRF token and idempotency key on mutations only, ...`; `states.test.tsx :: ErrorView > 401, 403 and 404 are 'denied' ...` |
| AC-08, AC-11, AC-13 | not touched by the UI beyond serving it from the same process; AC-11 remains `PENDING_HUMAN_RECEIPT` (a human runs the runbook; this stage adds no agent claim) | none from this stage |

Other behavior with tests: session and workspace selection (`session.test.tsx`), theme and storage failure tolerance (`session.test.tsx :: theme`, `... works when browser storage is unavailable`), retry and idempotency-key reuse (`states.test.tsx :: import and new-run forms: every failure the API can answer, with the same idempotency key on retry`), polling of queued and running runs (`states.test.tsx :: run detail > follows a run from queued through running to complete and stops polling once it is terminal`), paging and graph degradation on large inputs (`read-pages.test.tsx :: ... > a big run pages its findings and degrades the drawing instead of drawing everything`, `units.test.tsx :: graph model and drawing`), contrast (`contrast.test.ts`), static serving (`tests/integration/static.test.ts`).

## Real browser check (automated supplemental evidence, not an independent gate)

The packaged build was started on `localhost` with synthetic data (an AFFECTED, a NO_KNOWN_IMPACT and an INCOMPLETE run), and a headless Chrome was driven over the DevTools protocol: light and dark (`prefers-color-scheme` emulation), 1440 px and 375 px wide (mobile emulation), print media for the report, page scroll width against viewport width, and security-policy violations from the browser log.

| Check | Result |
| --- | --- |
| 20 page loads (run pages and reports for three verdicts at 1440 and 375 px, light and dark; run list, snapshot list and import form at 375 px; report in print media) | horizontal page overflow: none in any; CSP violations: 0 in any; light and dark backgrounds applied; print background white |
| Defects found by this check and fixed | (1) long hashes in plain text did not wrap, (2) the visually hidden `thead` of the stacked table layout stayed a table row group, so its cells widened the page (both broke 375 px: page width 660 to 670 px); (3) narrow desktop columns broke identifiers mid-word (column widths adjusted). Goldens were regenerated and layout guards added to `contrast.test.ts` and `report-render.test.tsx` |
| Not covered | Firefox and Safari; a screen reader; forced-colors mode; touch input. The automated browser smoke (Playwright, `tests/e2e`) is stage C-2's |

The check scripts drove a throwaway database under the job's temporary directory and are not committed (they hold local paths); stage C-2's browser smoke supersedes them.

## Seeded mutation controls (web and report)

`scripts/web-mutation-controls.mjs` (same method as `scripts/mutation-controls.mjs`): copies the tree to a disposable directory, requires the named tests to pass, applies ONE textual mutation that must match exactly once, requires the same tests to FAIL on assertions (not on a build error), restores it, and requires them to pass again. It never edits the checkout.

| Mutant | Property removed | Killed by (failing tests) |
| --- | --- | --- |
| `report-escape` | AC-09: report free text is escaped and redacted | `report-render.test.tsx` (5) |
| `report-finding-id` | AC-07: the HTML prints the same finding ids as the JSON | `report-render.test.tsx`, `report-service.test.ts` (11) |
| `report-csp` | AC-09: strict, hash-pinned style policy in the report | `report-render.test.tsx` (5) |
| `verdict-incomplete-as-noknown` | AC-04: INCOMPLETE looks different from NO_KNOWN_IMPACT | `read-pages.test.tsx` (1) |
| `coverage-limits-hidden` | AC-04: coverage limits always shown on a finished run | `read-pages.test.tsx` (3) |
| `unknowns-hidden` | AC-04: every unknown listed on an INCOMPLETE run | `read-pages.test.tsx` (1) |
| `check-failure-looks-fine` | AC-06: a non-PASSED check is never styled like a pass | `states.test.tsx` (1) |
| `csrf-header` | AC-12: CSRF token on every UI mutation | `write-pages.test.tsx`, `units.test.tsx` (10) |
| `viewer-mutation-controls` | AC-12: viewers get no mutation controls | `read-pages.test.tsx`, `write-pages.test.tsx` (8) |
| `not-found-leak` | AC-12: fixed 404 wording (no existence oracle) | `states.test.tsx` (9) |
| `superseded-without-opt-in` | AC-05: superseded snapshot only with explicit opt-in | `write-pages.test.tsx` (1) |
| `idempotency-key-reuse` | a changed body never reuses an Idempotency-Key | `units.test.tsx` (1) |
| `double-click-double-append` | two clicks on "Load more" append once | `units.test.tsx` (1) |
| `static-traversal` | the static server never serves outside the web root | `tests/integration/static.test.ts` (1) |

An earlier run of the same script on the tree one commit earlier (before golden and stylesheet tweaks) also killed 14 of 14.

## Defects the tests and the browser check found while building (all fixed)

1. `usePaged`: two clicks on "Load more" in one tick fetched the same page twice and appended it twice (found by the unit test; a ref now guards the fetch).
2. The remembered-workspace list carried along any extra field found in browser storage when it rewrote it (found by the storage test; it now keeps `id` and `name` only).
3. 375 px overflow on run pages and reports (see the browser check above).
4. The run form could hold a snapshot id that was not in the list (a stale link); it now falls back to the baseline.

## Known limits and deviations

- Workspace selection: the API has no "list my workspaces" endpoint, so the sign-in form takes an optional workspace id and offers the ids and names this browser used before (kept in local storage; no credential, token or email). A user who has never signed in to a workspace must know its id.
- The server's HTML export response header allows `style-src 'unsafe-inline'` (stage B). The document's own hash-pinned policy is the stricter of the two, so the effective policy is the hash; the header was left alone (not this stage's file).
- `CHANGERADAR_WEB_ROOT` is new and optional; `.env.example`, `README.md`, the Dockerfile (it must copy `dist/web`) and `scripts/verify-quality.sh` (it must run `npm run test:web` and `npm run mutation:web`) are stage C-2's.
- `npm test` now runs the server suite and then the web suite; `npm run test:coverage` runs both with their own thresholds.
- Contract-check creation in the UI cannot be shown succeeding against the default deployment (the egress allowlist is empty); the tests allowlist one loopback port through the test-only setting.
