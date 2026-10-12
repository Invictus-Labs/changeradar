# ChangeRadar

**See which consumers a proposed change can break.**

An API field, secret alias or artifact path changes in one service while downstream jobs silently keep assuming the old shape. ChangeRadar builds a dependency graph from explicit, versioned JSON manifests that you write or export, and assesses a proposed manifest change against the known consumers before you roll it out: direct and transitive consumers, an ordered path from the changed contract to each consumer, and the owner to talk to.

Self-hosted and standalone: no account, license server, telemetry or paid provider, and no outbound network access unless you explicitly allow one host for a read-only contract check. MIT licensed.

**Status: pre-release (0.1.0 MVP), not yet published.** The build implements its product requirements ([docs/prd/changeradar.md](docs/prd/changeradar.md)) except where the acceptance matrix says otherwise: AC-13 is PARTIAL (a worker `kill -9` and restart and restore from an evidence bundle are proven on the embedded database; a worker `kill -9`, a PostgreSQL restart and a `pg_dump` restore on PostgreSQL 17 have a script but have not been executed, so no database restart or dump restore is proven), AC-09 is PARTIAL (secret detection is best effort; independent confirmation is outstanding; about 46 percent of random printable passwords leak part of their tail because an unquoted value ends at a blank, a quote or a delimiter: a documented limit, see `docs/MANIFEST.md` and `SECURITY.md`), AC-06 is proven against a local fixture server only, and AC-11 (an independent human run of the smoke runbook) is pending. Independent review and the full gate at the final revision are also still outstanding. Evidence bundles are **integrity-checked, not authenticated**: they are hashed and their derived results re-derived, but not signed, so restore only bundles you trust. Nothing here has been used on real customer data. **Open decisions for the product owner** (no review resolves them, and none is waived here): the run view lists `changes` and `cycles` unpaged although the requirements say lists cap at 100; the evidence bundle limit is 64 MiB (memory is about 40 times the bundle for ordinary text and up to about 130 times for one made of numbers or one-key objects) where the requirements say 250 MB; the documented limits of secret detection (AC-09 stays PARTIAL); one bundle build at the largest size occupies the server's single thread for about three seconds (bounded by budgets and a cap, not removed); rate limiting behind a proxy has no trusted-proxy setting; finding ids are content-derived text and not UUIDs; the security contact channel; the licence holder line. See [docs/qa/ac-matrix.md](docs/qa/ac-matrix.md) for the status of every acceptance criterion.

## What it can and cannot tell you

Read this before you rely on a verdict.

- It answers one question: **which declared consumers can this proposed change break, and through which path?** It knows only what your manifests declare.
- **Manifests go stale.** They are written by people. Adoption depends on a low-maintenance ownership and update workflow, and each edge carries a `verified_at` time so staleness is visible: an edge unverified for more than 30 days is a stale unknown.
- **Static analysis cannot establish runtime completeness.** A consumer nobody declared is not known, and its absence is not evidence that it does not exist. ChangeRadar never infers that an undeclared dependency does not exist.
- **Unknown means INCOMPLETE, never safe.** A missing owner, a stale or never-verified edge, a placeholder node, an undeclared contract on the affected path, or a live check that did not pass makes the verdict `INCOMPLETE`; the known breaks stay listed next to it. `NO_KNOWN_IMPACT` means only "no declared consumer is affected" and always prints its coverage limits. There is no verdict called "safe".
- **Reading a verdict from a script.** Only `assessment == "NO_KNOWN_IMPACT"` on a run of the current engine means no known impact. `null`, `INCOMPLETE` and `AFFECTED` are all "not safe", and `null` on a finished (`complete`) run means it was assessed by an older decision engine: request a new run (the old verdict is in `recorded_assessment`, as history). The UI, the JSON and HTML exports and the list follow the same rule ([docs/API.md](docs/API.md) lists every surface).
- **Contract checking is a subset.** It compares required fields and types that you declare for `contract` nodes. It does not evaluate arbitrary JSON Schema, OpenAPI or protobuf compatibility, nested structure, enums, formats or value ranges.
- **Scale in this release:** 25 MB, 10,000 nodes and 50,000 edges per snapshot, checked before any processing. The output of a run is bounded too, because a valid manifest can imply a quadratic number of (changed node, consumer) pairs: at most 5,000 findings per run (1,000 per changed node, closest consumers first), stored paths keep their first and last 12 hops, and a run that reaches a limit says so with a `FINDINGS_TRUNCATED` unknown, which makes it INCOMPLETE (never a safe verdict). `docs/BENCHMARK.md` records measured timings; it is an experiment, not an SLA.
- **Not applicable to this release:** the product requirements mention a 1,000 file import limit, archive and symlink limits and a capacity precheck. Import is one JSON document (`POST /snapshots`), so there are no files, archives or symlinks to limit; the document limits above apply instead. Disk capacity is not pre-checked: a full disk makes the write fail (CLI output files exit 73 and the partial file is removed; a database write that fails rolls its transaction back), it is not detected beforehand.
- **Demand is unproven.** The product hypothesis has not been validated with pilot users. No claim is made about time saved or willingness to pay.

## Try it in two minutes (synthetic data)

Requires Node.js 22.12 or newer. These commands run from a source checkout of the repository; from a package file (`npm pack` output) use `changeradar demo` after the install in `docs/OPERATIONS.md`, "Install from a package file" (the package holds no lockfile and no sources, so `npm ci` and `npm run build` do not apply to it).

```bash
npm ci && npm run build
node dist/src/cli.js demo
```

`demo` creates an embedded database in `./changeradar-demo`, an administrator and a viewer with one-time passwords printed once, imports a synthetic multi-service billing manifest, and requests three impact runs. Open the printed `http://localhost:8797/` URLs and sign in. You will see one run that is AFFECTED (a removed required field reaching two direct and three transitive consumers, with owners), one NO_KNOWN_IMPACT, and one INCOMPLETE (an unverified edge). The server listens on `127.0.0.1` only. Press Ctrl+C to stop; delete the directory to remove everything.

## Install for real

- **One machine, embedded database:** `docs/OPERATIONS.md`, "Install from a package file".
- **Docker Compose with PostgreSQL 17:** `cp .env.example .env`, replace every `<placeholder>` (compose refuses to start without a database password and an encryption key), then `docker compose up -d --build`. The application is published on `127.0.0.1:8797` only.
- **Prove it works:** follow [docs/RUNBOOK-SMOKE.md](docs/RUNBOOK-SMOKE.md) (13 steps, about 15 minutes, synthetic data). An independent person records the result on [docs/HUMAN-DRILL.md](docs/HUMAN-DRILL.md).

There is no default password and no open registration: the first administrator is created locally with `changeradar admin create ... --generate-password`.

## Using it

1. Write manifests ([docs/MANIFEST.md](docs/MANIFEST.md): nodes are services, jobs, contracts, credential aliases and artifacts; edges are `consumes`, `requires` and `produces` with `source_file`, `source_line` and `verified_at`). `changeradar sample-manifests --out DIR` writes a worked example. Credential aliases are names, never values; a manifest containing a value in a recognised secret shape is rejected whole (best effort: detection is pattern based, and `docs/MANIFEST.md` lists what is recognised).
2. **Import** a snapshot (UI, or `POST /api/v1/snapshots`). The newest snapshot is the workspace baseline. Snapshots are immutable and content-hashed.
3. **Assess** a proposed manifest against the baseline (UI "New impact run", or `POST /api/v1/impact-runs` with the baseline's `expected_hash`). If the baseline moved in the meantime the request is refused with 409 rather than assessed against a stale view.
4. Read the verdict, the consumers, the paths, the owners, the unknowns and the coverage limits. Export the redacted JSON or self-contained HTML report (they list the same finding ids), or an integrity-checked (hashed and re-derived, not signed) **evidence bundle** you can restore into a clean installation. A bundle that holds a run from an older decision engine carries a `stale_runs` marker (and the `x-changeradar-stale-runs` header): that run's recorded verdict is history and it is marked re-run required.

The HTTP contract is [docs/API.md](docs/API.md); the domain rules (verdict precedence, unknowns, ids, hashing) are [docs/DOMAIN.md](docs/DOMAIN.md). Roles are viewer (read redacted reports), operator (import, run, download evidence) and admin (also checks, members, audit, settings), enforced on every read, write, job and export; another workspace's object ids answer 404.

## Command line

`changeradar help` (printed on standard output) lists everything: `migrate`, `serve`, `worker`, `admin create`, `admin revoke` (ends a member's sessions; `--remove-member` also removes the membership), `credential`, `export`, `verify-bundle`, `restore`, `retention`, `idempotency prune`, `demo`, `sample-manifests`. `changeradar version` prints the package version and the source commit it was built from. Exit codes: 0 success, 1 failure, 2 bundle rejected or restore conflict, 64 usage (unknown, repeated or value-less flags included), 66 input file missing or unreadable, 70 unexpected internal error, 73 output could not be written, 130 or 143 interrupted by SIGINT or SIGTERM (a one-shot command that did not finish never exits 0), 141 output pipe closed.

## Repository layout

| Path | Contents |
| --- | --- |
| `src/domain`, `src/services` | the pure decision code (graph, diff, assessment, redaction, contract checks) and persistence services |
| `src/api`, `src/workers`, `src/commands`, `src/db` | HTTP server, job worker and SSRF-safe check runner, CLI, database adapters and migrations runner |
| `src/web`, `src/report` | React web UI and the self-contained static HTML report |
| `migrations`, `schemas` | SQL migrations; JSON Schemas of manifests, request bodies and response bodies |
| `tests` | unit, integration (real persistence), web, acceptance (`tests/changeradar.spec.ts`), end-to-end (`tests/e2e`: real Chromium, and the npm tarball installed in a fresh directory) |
| `scripts` | the local gate `verify-quality.sh`, seeded mutation controls, hygiene scan, license audit, benchmarks, runbook harness |
| `docs` | operations, API, domain, manifest guide, benchmark, dependency licenses, QA matrix and evidence |

## Quality gate

There is no remote CI. `bash scripts/verify-quality.sh` is the release verdict: install check, typecheck, build, the server suite with enforced 90% line and branch coverage on the embedded database and again on real PostgreSQL 17, the web suite with enforced coverage, seeded mutation controls (single-line defects injected into a disposable copy must each make a test fail: server, web, and end to end through real Chromium and the installed package), schema drift, dependency licenses, secret and content hygiene, the packaged end-to-end run (the npm tarball installed in a fresh directory), the real-browser end-to-end run, the runbook harness, a real Docker Compose startup with PostgreSQL 17, and a control that a seeded failure turns the verdict red. It exits non-zero on any failure. `bash scripts/node-floor-gate.sh` runs it on the supported Node floor (22.12) in a container; steps that need Docker or a browser are skipped there and the verdict says `GREEN WITH SKIPS`. Coverage is supporting evidence; the criterion-by-criterion evidence, with real test ids and honest statuses, is [docs/qa/ac-matrix.md](docs/qa/ac-matrix.md), and the commands, times and counts are in [docs/qa/stage-c2-evidence.md](docs/qa/stage-c2-evidence.md).

## Security and contributing

[SECURITY.md](SECURITY.md) describes the security model and how to report a vulnerability. [CONTRIBUTING.md](CONTRIBUTING.md) describes how to work on the project. [CHANGELOG.md](CHANGELOG.md) lists what is in 0.1.0.

## License

MIT, see [LICENSE](LICENSE). **Why MIT and this copyright holder:** the license and the holder line are the same as the two earlier public projects by the same owner (RunProof and ScopeGuard), so the projects can share code and contributors under one convention; the choice was made when the repository was created and is recorded here because the product requirements left it as an open question. Dependency licenses are audited in [docs/DEPENDENCY-LICENSES.md](docs/DEPENDENCY-LICENSES.md) by `scripts/dependency-licenses.mjs` (every runtime dependency is MIT, ISC, BSD or Apache-2.0; the only non-permissive license, MPL-2.0 for `lightningcss`, belongs to a build-time tool and is not distributed). The web bundle inside the package includes React and its router; their MIT notices are in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

Documents inside the package refer to repository paths (`src`, `tests`, `scripts`) that exist in the source repository and not in the package; links to `docs/prd`, `docs/qa`, `SECURITY.md`, `CONTRIBUTING.md` and `CHANGELOG.md` resolve in both.
