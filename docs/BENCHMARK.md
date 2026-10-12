# Performance experiment: deterministic core at the MVP limits

Status: an experiment, not an SLA. It records what the pure domain layer (`src/services/graph.ts`, `diff.ts`, `assess.ts`) does on synthetic input at and below the documented limits. PRD section 6 asks for a benchmark of the deterministic core on 2 CPU / 4 GB ("1,000 records should finish within 30 seconds excluding provider I/O and VM setup") and says to record it as a performance experiment before fixing an external SLA. No external SLA is claimed here.

## What was measured

Script: `scripts/benchmark.ts` (`npm run bench -- --runs 5`). For each size it generates a synthetic manifest (deterministic PRNG seed, layered DAG with about 0.2% back edges so cycles exist, 80% `consumes` and 20% `requires` edges, contract nodes with 12 fields, 40 owners), then five times:

1. **import**: `buildGraphFromJson(text)` on the baseline text. This covers the byte check, `JSON.parse`, zod validation, the secret scan of every string, uniqueness and dangling-edge checks, normalization, sorting, dependents index, cycle detection (iterative Tarjan) and both SHA-256 hashes.
2. **diff+assess**: `assess(...)` with a proposal that bumps the major version of the root contract `n0`. That is a wide single-origin fan-out: essentially every node depends on it transitively, so nearly every node is a consumer. It is NOT the worst case for output size (review round 1 showed that long chains, many changed origins and many fields on many consumers are far larger: see "Adversarial shapes" below). The proposal's own import is done outside the timed region (it costs about the same as the baseline import).

The table reports median / min / max in milliseconds over the runs.

## Environments

Both runs use the same source. Time is wall clock from `performance.now()`.

- **Host run**: Node v25.8.2, macOS arm64, Apple M4 Pro (14 logical CPUs), 24 GB RAM, no resource limits. This is a developer machine, not the PRD reference machine.
- **Constrained run**: the `node:22-alpine` image (Node v22.23.3, Linux arm64) started with `--cpus=2 --memory=4g --memory-swap=4g --network none`, with the TypeScript output compiled by `tsc` and mounted read-only. Inside the container `cpu.max` is `200000 100000` (two CPUs of quota) and `memory.max` is 4294967296 (4 GiB). The benchmark's own header still prints the host CPU count because `os.cpus()` does not reflect cgroup quotas, and it prints the VM's total memory; the cgroup values above are the effective limits. The container is a Linux VM on the same Apple silicon host, so single-thread speed is still much higher than a typical 2 vCPU cloud instance. `--network none` also shows the run needs no network.

## Results

Host (no limits), re-measured after review round 1 (`npm run bench -- --runs 3`, Node v25.8.2, three runs, so the spread is wide). Output is now bounded (at most 1,000 findings per changed node, 5,000 per run), so the two larger single-origin rows record 1,000 findings and are `INCOMPLETE` with the unknown `FINDINGS_TRUNCATED` (the consumers found number 4,963 and 9,924; only the closest 1,000 are listed). Before the bounds existed they listed all of them and were `AFFECTED`:

| scenario | manifest size | import (median / min / max ms) | diff+assess (median / min / max ms) | findings recorded | verdict | RSS after (MB) |
| --- | --- | --- | --- | --- | --- | --- |
| 1,000 nodes / 5,000 edges | 0.91 MB | 67 / 66 / 92 | 15 / 15 / 20 | 991 | AFFECTED | 205 |
| 5,000 nodes / 25,000 edges | 4.63 MB | 281 / 279 / 291 | 81 / 63 / 87 | 1000 | INCOMPLETE | 388 |
| 10,000 nodes / 50,000 edges (limit) | 9.28 MB | 689 / 636 / 733 | 205 / 144 / 253 | 1000 | INCOMPLETE | 596 |

### Adversarial shapes (host, after review round 1)

A valid manifest can imply a quadratic number of (changed node, consumer) pairs. Measured with `npm run bench` on the same machine and run count. Before the bounds, a 200 node chain with every node bumped produced 19,900 findings and a 199.6 MB document, a 300 node one could not be serialised at all, and a 10,000 node chain aborted the process; a 900 node lattice with every node bumped produced 391,500 findings in 9.9 s; 1,000 fields on 1,000 consumers produced an 83 MB document from a 260 KB manifest (all figures from the independent review of the previous revision, measured on the same kind of host).

| shape | nodes / edges | diff+assess (median / min / max ms) | findings recorded | verdict | assessment JSON (MB) |
| --- | --- | --- | --- | --- | --- |
| chain 2,000, head bumped | 2000 / 1999 | 16 / 14 / 16 | 1000 | INCOMPLETE | 3.6 |
| chain 10,000, head bumped | 10000 / 9999 | 28 / 24 / 32 | 1000 | INCOMPLETE | 3.6 |
| chain 10,000, every node bumped | 10000 / 9999 | 1155 / 938 / 1225 | 4420 | INCOMPLETE | 18.9 |
| lattice 30 x 30, every node bumped | 900 / 2552 | 277 / 275 / 465 | 5000 | INCOMPLETE | 14.4 |
| 1,000 fields x 1,000 consumers, all fields removed | 1001 / 1000 | 295 / 270 / 350 | 1000 | AFFECTED | 1.4 |

The same shapes are proven bounded in a small V8 heap by `tests/unit/review-round1-scale.test.ts` (a 10,000 node chain in a 384 MB heap). The pure core is what is timed here; persisting, serving and exporting a 19 MB assessment cost more (the export itself is capped by the same bounds). The Docker Compose service now carries the 2 CPU / 4 GB profile as real limits (`compose.yaml`), so this document's constrained profile is what Compose runs.

Constrained (2 CPU quota, 4 GiB, no network). **These rows were measured on the revision BEFORE review round 1 and have not been re-measured**; the bounded output makes the two larger single-origin rows list 1,000 findings instead of all of them, so treat them as the pre-bounds record of import cost, which did not change materially:

| scenario | manifest size | import (median / min / max ms) | diff+assess (median / min / max ms) | findings | verdict | RSS after (MB) |
| --- | --- | --- | --- | --- | --- | --- |
| 1,000 nodes / 5,000 edges | 0.91 MB | 79 / 69 / 146 | 27 / 13 / 32 | 991 | AFFECTED | 162 |
| 5,000 nodes / 25,000 edges | 4.63 MB | 390 / 359 / 400 | 101 / 89 / 117 | 4963 | AFFECTED | 341 |
| 10,000 nodes / 50,000 edges (limit) | 9.28 MB | 824 / 737 / 904 | 200 / 186 / 253 | 9924 | AFFECTED | 486 |

RSS is the process resident set after the scenario (it accumulates across scenarios within one process, so it is an upper bound per scenario, not an isolated peak).

## Reading the numbers

- At the documented limit (10,000 nodes, 50,000 edges, a 9.3 MB manifest) import took about 0.5 s on the host and about 0.8 s under the 2 CPU / 4 GiB container limits; assessing a change that reaches nearly every node took about 0.1 to 0.2 s more. For the PRD's "1,000 records" target the measured time was under 0.2 s in total under the constrained profile, against a 30 s target. The PRD target is met by a wide margin for the pure core in this environment.
- At 10,000 nodes and 50,000 edges this synthetic manifest is 9.3 MB, under the 25 MB byte cap (about 0.93 KB per node including its five edges). The byte cap only becomes the binding limit when per-item strings are roughly 2.7 times longer than here.
- Memory grew to roughly 0.5 GB for the largest constrained scenario, far below the 4 GiB limit.
- The core is single threaded. Nothing here exercised parallel imports.

## Caveats and what this does not show

- Synthetic data only, one generator, one seed. Real manifests with longer strings, different fan-out or many cycles may behave differently; the cycle and long-chain cases are covered functionally by tests (`tests/unit/graph.test.ts`, `tests/unit/properties.test.ts`, `tests/unit/limits-scale.test.ts`) but are not separately timed.
- The measurements exclude everything outside the pure core: database reads and writes, HTTP, JSON body transfer, the worker, contract check network I/O and report rendering. End-to-end latency will be higher.
- The host and the container share fast Apple silicon cores. A 2 vCPU cloud VM will be slower; treat the constrained numbers as a lower bound for that profile until repeated there.
- Five runs per scenario, with the first run including JIT warm-up. Min/max are reported so the spread is visible; no statistical claim is made.
- No external SLA is proposed. Re-run `npm run bench` on the intended deployment hardware before committing to one.

## Reproduce

```bash
npm ci
npm run bench -- --runs 5            # host run

# constrained run (needs Docker and the node:22-alpine image)
npx tsc -p tsconfig.test.json --noEmit false --outDir /tmp/changeradar-bench
docker run --rm --network none --cpus=2 --memory=4g --memory-swap=4g \
  -v /tmp/changeradar-bench:/app/dist:ro -v "$PWD/node_modules":/app/node_modules:ro \
  -v "$PWD/package.json":/app/package.json:ro -w /app \
  node:22-alpine node dist/scripts/benchmark.js --runs 5
```

---

# Stage B: end to end through the real API

Status: an experiment, not an SLA. The section above measures the pure core. This section measures the whole server path that stage B added: real HTTP requests (`fetch` against a listening Fastify server on `127.0.0.1`), JSON parsing, validation, the database, the job worker, exports and restore.

## What was measured

Script: `scripts/benchmark-api.ts` (`npm run bench:api -- --runs 3`). It generates the same layered synthetic graph as `scripts/benchmark.ts` (every node depends on a lower numbered node, about 0.2% back edges, contract nodes with 12 fields), logs in, and repeats three times per size:

| step | what it does |
| --- | --- |
| import | `POST /api/v1/snapshots` with the whole manifest (validate, hash, store canonical text, insert every node and edge, move the baseline, write event and audit rows) |
| request run | `POST /api/v1/impact-runs` with the proposed manifest (validate, hash check, baseline lock, insert, enqueue) |
| worker | `runWorkerOnce` until idle: claim, rebuild and re-verify both graphs, diff, assess, persist all findings, complete |
| get run | `GET /api/v1/impact-runs/{id}` |
| all findings pages | every page of `GET /api/v1/impact-runs/{id}/findings?limit=100` |
| export json / html | `GET .../export?format=json` and `...format=html` |
| bundle export | `GET .../bundle` (versioned, hashed evidence bundle of the run and its snapshot) |
| restore | `restoreBundle` into an empty installation: full verification (including re-deriving the assessment) plus the transactional write |

**Measured BEFORE the output bounds of review round 1; the tables of this section (findings, restore, export, memory) are superseded and are kept only as the record of that measurement.** Since round 1 a run records at most 1,000 findings per changed node and 5,000 per run, so the 10,000 node run below is `INCOMPLETE` with `FINDINGS_TRUNCATED` and records 1,000 findings, not 9,999; the bounded behaviour is measured in the sections that mention the caps, and the re-measured rows carry no receipt until the gate at the final revision records one (date UTC, command, exit code, SHA).

The proposal removes a required field of the root contract, so nearly every node becomes a finding (999 findings at 1,000 nodes, 9,999 at 10,000 nodes, before the caps): a deliberate worst case for fan-out. Sizes: 1,000 nodes / 5,000 edges (the PRD's "1,000 records" scenario, matching the stage A benchmark) and 10,000 nodes / 50,000 edges (the documented limit). Manifest sizes on the wire: 0.91 MB and 9.2 MB (the byte cap is 25 MB). The at-limit evidence bundle is 27 MB (the default bundle cap is 64 MiB, `CHANGERADAR_MAX_BUNDLE_BYTES`).

## Environments

- **PGlite, host**: embedded engine in the server process, Node v25.8.2, macOS arm64, Apple M4 Pro (14 logical CPUs), 24 GB RAM, no limits.
- **PostgreSQL 17, host**: a throwaway `postgres:17-alpine` container (PostgreSQL 17.11, default configuration) reached through Docker Desktop's published loopback port; the server process runs on the same host. Every statement crosses the Docker Desktop VM boundary, which adds latency per round trip. This is a developer laptop setup, not a tuned database host.
- **PGlite, constrained**: the `node:22-alpine` image (Node v22.23.3, Linux arm64) with `--cpus=2 --memory=4g --memory-swap=4g --network none`. The compiled output and `node_modules` are mounted read-only. It exercises the PRD reference profile (2 CPU, 4 GB, no network). The container is a Linux VM on the same Apple silicon host, so single thread speed is still higher than a typical 2 vCPU cloud instance.

## Results (median / min / max milliseconds over 3 runs)

**1,000 nodes / 5,000 edges, 999 findings**

| step | PGlite host | PostgreSQL 17 host | PGlite 2 CPU / 4 GB |
| --- | --- | --- | --- |
| import | 235 / 225 / 364 | 721 / 639 / 1,926 | 432 / 329 / 585 |
| request run | 145 / 94 / 207 | 443 / 154 / 604 | 229 / 142 / 411 |
| worker | 227 / 151 / 251 | 1,257 / 911 / 2,486 | 480 / 237 / 639 |
| get run | 11 / 11 / 16 | 43 / 42 / 149 | 30 / 25 / 50 |
| all findings pages | 86 / 78 / 137 | 292 / 284 / 1,051 | 281 / 154 / 295 |
| export json | 74 / 70 / 87 | 125 / 123 / 398 | 160 / 109 / 183 |
| export html | 117 / 96 / 132 | 137 / 91 / 300 | 138 / 119 / 155 |
| bundle export | 103 / 98 / 155 | 354 / 327 / 834 | 220 / 173 / 516 |
| restore | 650 / 464 / 751 | 2,150 / 1,284 / 3,135 | 820 / 660 / 1,048 |
| **sum of medians** | **1.6 s** | **5.5 s** | **2.8 s** |

**10,000 nodes / 50,000 edges (limit), 9,999 findings**

| step | PGlite host | PostgreSQL 17 host | PGlite 2 CPU / 4 GB |
| --- | --- | --- | --- |
| import | 2,323 / 2,282 / 2,390 | 6,987 / 6,477 / 7,990 | 4,657 / 4,367 / 5,042 |
| request run | 965 / 835 / 971 | 2,594 / 2,221 / 2,650 | 2,156 / 2,109 / 2,915 |
| worker | 2,198 / 2,020 / 2,273 | 6,493 / 4,997 / 8,487 | 5,049 / 4,324 / 6,064 |
| get run | 17 / 17 / 24 | 65 / 21 / 68 | 62 / 46 / 158 |
| all findings pages | 1,216 / 1,160 / 1,324 | 2,539 / 1,813 / 4,102 | 2,728 / 2,220 / 3,726 |
| export json | 927 / 853 / 968 | 1,227 / 1,139 / 1,356 | 1,936 / 1,659 / 2,170 |
| export html | 1,043 / 851 / 1,079 | 1,269 / 861 / 1,518 | 1,660 / 1,644 / 2,363 |
| bundle export | 1,277 / 1,262 / 1,346 | 1,281 / 1,254 / 2,828 | 3,625 / 3,007 / 4,255 |
| restore | 5,313 / 5,219 / 5,347 | 11,815 / 10,863 / 16,107 | 10,057 / 9,776 / 10,629 |
| **sum of medians** | **15.3 s** | **34.3 s** | **31.9 s** |

Process RSS after the whole run: 1.1 GB (PGlite host), 1.5 GB (PGlite, constrained container, limit 4 GiB), 74 MB (PostgreSQL 17 run: the database memory lives in the container, not measured here).

## Reading the numbers

- **PRD target.** "1,000 records should finish within 30 seconds excluding provider I/O and VM setup." Import, request, worker and read of the 1,000 node scenario took about 0.6 s (embedded), 2.5 s (PostgreSQL 17 through Docker Desktop) and 1.2 s (constrained). The target is met by a wide margin in these environments. At the documented limit, import plus request plus worker took about 5.5 s (embedded host), 16 s (PostgreSQL 17) and 12 s (constrained). These are single measurements of one synthetic generator, not a promise.
- **Where the time goes.** Import is dominated by inserting 60,000 rows (50,000 edges with three foreign keys each) and by the canonical hash; the worker by rebuilding and verifying both graphs and persisting 9,999 findings with their paths. Restore is the most expensive step because it verifies everything (rebuilds every graph, re-derives every assessment) before writing.
- **PostgreSQL slower than the embedded engine here.** The embedded engine runs in the same process with no network hop. The PostgreSQL 17 numbers include a Docker Desktop VM boundary for every statement and an untuned default configuration; they are a lower bound for a real deployment, and the ordering (embedded faster) should not be read as a property of PostgreSQL.
- **Outliers.** In a first embedded run at the limit, one import took 21.5 s and one restore 24 s (the other two runs of each were 2.1 s and 5 s to 6 s); two later embedded runs did not reproduce it. Most likely embedded engine memory growth on a 27 MB working set, but the cause was not investigated. Treat the embedded engine's tail latency at the limit as unproven.
- **Memory.** About 1.5 GB resident for the embedded engine plus server at the limit, inside the 4 GiB profile. A 27 MB bundle and 8 MB report are built in memory; there is no streaming export yet. Bundles for workspaces with many large snapshots must go through the CLI, which writes a file.

## Caveats

- Synthetic data, one seed, three runs per size, first run includes JIT warm-up; no statistical claim.
- A single client and a single worker. No concurrency benchmark was run (concurrent behaviour is covered functionally by the race and worker tests).
- Timings are wall clock at the client for HTTP steps and inside the process for worker and restore.
- Contract check network I/O is not part of this experiment (no checks configured).
- No external SLA is proposed. Re-run on the intended hardware before committing to one.

## Reproduce

```bash
npm ci
npm run bench:api -- --runs 3                      # embedded engine, host

# PostgreSQL 17 (throwaway container on loopback, random port and password)
docker run -d --name changeradar-bench-pg -e POSTGRES_PASSWORD=<generated> -e POSTGRES_USER=cr \
  -p 127.0.0.1::5432 postgres:17-alpine
PGPASSWORD=<generated> CHANGERADAR_BENCH_DATABASE_URL=postgres://cr@127.0.0.1:<port>/postgres npm run bench:api -- --runs 3
docker rm -f changeradar-bench-pg

# constrained embedded run
npx tsc -p tsconfig.test.json --noEmit false --outDir /tmp/changeradar-bench
docker run --rm --network none --cpus=2 --memory=4g --memory-swap=4g \
  -v /tmp/changeradar-bench:/app/dist:ro -v "$PWD/node_modules":/app/node_modules:ro \
  -v "$PWD/package.json":/app/package.json:ro -v "$PWD/migrations":/app/migrations:ro -w /app \
  node:22-alpine node dist/scripts/benchmark-api.js --runs 3
```
