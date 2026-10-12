# ChangeRadar operations guide

Installation, configuration, users, backup and restore, upgrade, retention, failure diagnosis and the reason and error code table for the API, worker and CLI. To prove an installation works on synthetic data, follow `docs/RUNBOOK-SMOKE.md` (an independent person records the result on `docs/HUMAN-DRILL.md`; nothing in this repository claims that drill has been done).

ChangeRadar needs no account, license server, telemetry endpoint or outbound network access. Everything below runs on one machine. What it can and cannot tell you is stated in `README.md`: it reasons only about dependencies your manifests declare, manifests go stale, and an unknown is reported as INCOMPLETE, never as safe.

## Requirements

- Node.js 22.12 or newer (the supported floor; the local gate checks it on `node:22.12`).
- One of: the embedded PostgreSQL engine (default for one machine: a data directory, nothing to install) or PostgreSQL 17 (compose and larger installs). Both run the same migrations and the same test suite.

## Try it in one command (synthetic data, no account)

```bash
npx changeradar demo            # from an installed package; or: npm run build && node dist/src/cli.js demo
```

`demo` builds its own private configuration (an embedded database in `./changeradar-demo`, a one-off encryption key, a loopback bind address, an empty egress allowlist), creates an administrator and a viewer with generated one-time passwords printed once, imports a synthetic multi-service manifest, requests three runs (AFFECTED, NO_KNOWN_IMPACT, INCOMPLETE) and prints `http://localhost:8797/` URLs. It reads none of your environment, refuses to touch a directory that is not a previous demo, and `--reset` starts over. Stop it with Ctrl+C. `sample-manifests --out DIR` writes the same synthetic manifests as files.

## Install from a package file (one machine, embedded database)

```bash
npm install ./changeradar-0.1.0.tgz           # or, from a checkout: npm ci && npm run build && npm pack
export CHANGERADAR_DATABASE_URL="pglite:$PWD/data/db"      # a directory, created with owner-only permissions
export CHANGERADAR_ENCRYPTION_KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")"
# Keep that key: it seals stored credential values. Losing it does not lose evidence, only those values.

npx changeradar migrate
npx changeradar admin create --email you@example.test --workspace "My team" --generate-password
# The password is printed once. There is no default password and no open registration.
npx changeradar serve
```

From a checkout, use `node dist/src/cli.js` in place of `npx changeradar`.

`serve` listens on `127.0.0.1:8797`, serves the web UI at `/` and the API under `/api/v1`, and runs the job worker in the same process. Check it: `curl http://localhost:8797/api/v1/health/ready` answers `{"status":"ready",...}`. Use `serve --no-worker` plus a separate `worker` process to split them (this needs PostgreSQL 17).

**The embedded database belongs to one process at a time.** A second process (another `serve`, a `worker`, or a CLI command such as `admin create` or `export`) on the same data directory is refused with `the embedded database at <dir> is in use by process <pid>`: stop the first process, then run the command. The guard is a lock file `<dir>.lock` holding the owner's process id; a lock left by a crashed or killed process is recognized as stale and taken over. If the message names a process that no longer exists (for example a recycled process id), delete the named lock file.

### Bind address

`CHANGERADAR_HOST=127.0.0.1` (the default) means "this machine only": nothing on the network can reach the server. `0.0.0.0` means every network interface: only use it behind a TLS reverse proxy or a firewall you control, because the server itself speaks plain HTTP. Session cookies get the `Secure` flag unless `CHANGERADAR_PUBLIC_URL` starts with `http://`. Rate limiting keys on the socket address, so behind a proxy every client shares one per-address budget (login, and requests before authentication) and one client can use it up for everybody; per-user budgets (exports, bundles, requests after authentication) are unaffected. A trusted-proxy setting is not part of the MVP, deliberately: honouring `X-Forwarded-For` without a verified proxy chain would let any client choose its own address and defeat the limit. Until then, apply per-client limits at the proxy itself, and do not put the server behind a shared proxy for untrusted users. In `compose.yaml` the container listens on all container interfaces and the port is published to the host's `127.0.0.1` only.

## Install with Docker Compose (PostgreSQL 17)

```bash
cp .env.example .env                           # replace every <placeholder>
docker compose up -d --build                   # postgres:17-alpine + the API, worker and UI (image built from ./Dockerfile)
docker compose exec changeradar node dist/src/cli.js admin create --email you@example.test --workspace "My team" --generate-password
```

Set `POSTGRES_PASSWORD` and `CHANGERADAR_ENCRYPTION_KEY` in `.env`; compose refuses to start without them, and there are no default passwords. The database is not published to the host at all; the application is published on `127.0.0.1:8797` only. The image runs as an unprivileged user on `node:22.12-alpine`, contains no secret, and reports its own health (`/api/v1/health/ready`). Use `-p <name>` to give a throwaway project its own containers and volume, and `docker compose -p <name> down -v` to remove them.

## Configuration

Everything is an environment variable; `.env.example` lists them with comments.

| Variable | Default | Meaning |
| --- | --- | --- |
| `CHANGERADAR_DATABASE_URL` | required | `postgres://...`, `postgresql://...`, `pglite:/dir` or `pglite:memory` |
| `CHANGERADAR_DATABASE_PASSWORD` | unset | literal password merged into a PostgreSQL URL (compose uses it) |
| `CHANGERADAR_ENCRYPTION_KEY` | required | base64 of 32 random bytes; seals credential values and keys CSRF and rate limit MACs |
| `CHANGERADAR_HOST`, `CHANGERADAR_PORT` | `127.0.0.1`, `8797` | bind address and port |
| `CHANGERADAR_PUBLIC_URL` | unset | `Secure` cookies unless it starts with `http://`. Leave it unset (or `http://localhost:8797`) for a local try-out; some browsers refuse a Secure cookie on plain http. Compose defaults it to `http://localhost:8797` |
| `CHANGERADAR_HOST_PORT` | `8797` | Compose only: the host port published on `127.0.0.1` |
| `CHANGERADAR_CHECK_MAX_BODY_BYTES`, `CHANGERADAR_CHECK_MAX_TIMEOUT_MS` | 1 MiB, 30000 | largest response a contract check reads, and the largest `timeout_ms` a check may configure (at most 120000) |
| `CHANGERADAR_WEB_ROOT` | unset | directory of the built web UI (normally found next to the compiled server) |
| `CHANGERADAR_CHECK_ALLOWED_HOSTS` | empty | egress allowlist (`host`, `host:port`, `*.suffix`). Empty means the server never makes an outbound request |
| `CHANGERADAR_CHECK_ALLOW_PRIVATE_NETWORK` | off | TEST ONLY: allow allowlisted hosts to resolve to loopback and private ranges. Never set it in production |
| `CHANGERADAR_EVENT_SINK_URL` | unset | optional at-least-once push of outbox events (must be on the allowlist) |
| `CHANGERADAR_MAX_MANIFEST_BYTES`, `..._MAX_NODES`, `..._MAX_EDGES`, `..._MAX_BUNDLE_BYTES` | 25 MB, 10,000, 50,000, 64 MiB | limits; may be lowered, not raised above the PRD maximums (bundle cap excepted). The bundle cap is the largest file `restore` and `verify-bundle` accept and the largest bundle an export will produce (`BUNDLE_TOO_LARGE`, HTTP 413). Memory is about 40 times the bundle size for ordinary text (measured: a 44.5 MB bundle took 1.4 GB to export, 0.7 GB to verify and 1.6 GB to restore), and up to about 130 times for a bundle made of numbers or one-key objects (measured: verify 52 to 90 times, restore 121 times the added size); at the 64 MiB default a bundle of that kind can need several GB, so size the host for the worst case (about 8 GB) or lower the cap; raise it only on a host with that much free, because beyond it the process fails closed (out of memory) instead of restoring |
| `CHANGERADAR_RATE_LIMIT_PER_MINUTE`, `..._SESSION_TTL_SECONDS`, `..._JOB_LEASE_SECONDS`, `..._IDEMPOTENCY_RETENTION_DAYS` | 1200, 43200, 60, 7 | throttle, session lifetime, worker lease (5 s to 1 h), idempotency retention (never below 7 days) |
| `CHANGERADAR_RETENTION_EVIDENCE_DAYS`, `..._DELETION_HOURS`, `..._BACKUP_DAYS` | 90, 24, 30 | proposed retention defaults (see Retention) |
| `CHANGERADAR_LOG` | 0 | `1` adds request and worker diagnostics; cookies, authorization headers, bodies and query strings are never logged in any mode |

## Users, roles, credentials and contract checks

- Roles: `viewer` (read redacted reports), `operator` (import, run, download evidence), `admin` (everything, plus checks, members, audit, settings). Create users with `admin create --workspace-id <id> --role <role> --password-stdin` (or `--generate-password`).
- Revoke access: `admin revoke --email <email> --workspace-id <id>` ends every session of that member at once (the next request answers 401); add `--remove-member` to also remove the membership so the account can no longer log in to that workspace. Both are recorded in the audit trail (`member.sessions_revoked`, `member.removed`). There is no password reset command: to change a password, remove the member and create them again.
- Login throttling is per account AND address (so a stranger's failed guesses cannot lock a member out from their own address) plus a per address budget (a known trade-off: ten wrong passwords for one account from one address lock that account and address pair for the window, even against the correct password, and `retry-after` says how long); requests without a valid session are limited per address too (300 a minute, then 429). Passwords must be at least 12 characters and are stored as salted scrypt hashes. Sessions are HttpOnly, SameSite=Strict cookies with a CSRF token on every mutation.
- A workspace admin registers read-only contract checks through the API (`POST /api/v1/contract-checks`, see `docs/API.md`) or the Contract checks page. The URL must be on `CHANGERADAR_CHECK_ALLOWED_HOSTS`. If the endpoint needs a bearer credential, the check names an alias and the value is stored sealed with `credential set --workspace-id <id> --alias <alias>` (value on stdin, never on the command line). The API never accepts or returns a credential value.
- Outbound requests are GET or HEAD only, every redirect hop and DNS answer is checked against the allowlist, and loopback, private, link-local and metadata addresses are refused.
- A live contract check is a probe of one field/type subset against a real endpoint; it is not a compatibility proof. Anything other than PASSED becomes an unknown and forces INCOMPLETE.

## Backup and restore

Take two kinds of backup: the database (your normal `pg_dump`, or a copy of the embedded data directory with the server stopped) and a portable, verifiable **evidence bundle**:

```bash
npx changeradar export --workspace-id <id> --out backups/changeradar-2026-09-29.json    # one workspace, owner-only file (0600)
npx changeradar export --workspace-id <id> --run <run-id> --out backups/one-run.json     # one run and its baseline
npx changeradar verify-bundle --in backups/changeradar-2026-09-29.json                   # no database needed
```

`export` refuses to overwrite an existing file. The bundle contains snapshots, runs, findings, check results and check definitions with their hashes; it does NOT contain users, sessions, password hashes, credential values or idempotency keys. Store the encryption key separately from backups; rotated backups should expire after the approved period (default proposal 30 days).

Restore into a **clean** installation (migrated, no workspace with the same id):

```bash
npx changeradar restore --in backups/changeradar-2026-09-29.json
npx changeradar admin create --email you@example.test --workspace-id <restored-id> --generate-password
```

Restore verifies the whole bundle in memory first (hashes, every snapshot rebuilt and re-hashed, every finished run re-derived so its findings must reproduce) and then writes everything in one transaction: a truncated, edited or unsupported bundle, or any failure in the middle, leaves the database untouched. Exit code 2 means the bundle was rejected or the target is not clean. Snapshot, run and finding ids are preserved. Runs that were unfinished when the backup was taken come back as `failed` (`RESTORED_UNFINISHED`) and their open checks as `UNKNOWN`: request new runs. A restored database cannot undo anything that happened elsewhere; reconcile outside effects before relying on old runs. A bundle's hashes detect corruption and accidental edits; they are not a signature, so treat a bundle from an untrusted source like any other untrusted input. A bundle whose hashes are consistent but whose values the database would refuse (a timestamp that is not a real date and time, a NUL character, an integer past its column, a check timeout, retry count or status outside the table's range, a finding id that is not `fnd_` and 20 hex digits, an object key longer than 2,000 characters (or whose redacted form is: a key of six characters or more is redacted for the check, and a repeated short credential-shaped unit can grow 2.1 times, so a key of 994 characters can be refused with "once redacted"), an unpaired surrogate anywhere in the bundle, two contract check keys or two check result keys of one run that are the same after restore's cut to 2,000 characters) is rejected with `BUNDLE_SCHEMA_INVALID` at verification, and any database data or constraint error during the write is reported under the same code (exit 2, nothing written), never as a database message with exit 1.

**What verification proves, exactly.** For every finished run the bundle's findings (every field), unknowns, assessment detail and verdict are re-derived with the decision code of THIS build from the recorded manifests and check results and compared field by field. Snapshots are rebuilt and re-hashed. Everything is also covered by the section and bundle hashes. Fields outside that re-derivation are protected by the hashes only, so an edit that recomputes the hashes is not detected: workspace name, snapshot revision and warnings, run events, timestamps (also the bundle's and the workspace's `created_at` and a snapshot's `imported_at`), `error_code` and `error_detail`, `expected_hash`, `check_keys`, `baseline_version`, `allow_superseded`, `producer`, `scope`, the bundle's `baseline.version`, the baseline version inside the assessment detail, injected `PASSED` check rows (the recorded check results are inputs of the re-derivation, not outputs), and contract check definitions. Finding positions are verified (0, 1, 2, ...) and the `position` of every finding row is compared. A run assessed by an OLDER decision engine is not re-derived at all (see Upgrade): it is protected by the hashes only, and marked stale.

**What is redacted in a bundle.** Export redacts free text: workspace name, snapshot revision and warnings, run error code and detail, check keys, unknowns, assessment detail, event notes, check definitions and results, and the contract check definitions (key, node, URL, required field names, alias). Manifests and findings (ids, paths, reasons) are kept verbatim because the hashes and the re-derivation depend on them; they were checked at import against the recognised secret shapes only, best effort (docs/MANIFEST.md lists what is recognised and what is not): a plain-word or unrecognised credential in a manifest is stored and exported as written, while views and reports redact it. A bundle proves integrity, not authenticity (it is not signed); do not restore a bundle from a source you do not trust. `export` verifies the bundle it just built with the same code and reports failure (nothing is written) instead of a file that could not be restored. A bundle from a NEWER decision engine than this build is refused with `BUNDLE_ENGINE_VERSION` (see Upgrade); one from an older engine is accepted and its runs are reported as stale. The input must be a regular file (a pipe or device is refused).

**What restore does not bring back live.** Contract check definitions are restored **disabled**: a bundle is not authenticated, so it never re-arms a network check. To re-arm one, POST `/api/v1/contract-checks` with the SAME key and the definition you want: the disabled check is replaced (same id, enabled again, audit action `contract_check.reenabled`) after the egress allowlist and secret rules have run; a key that is already enabled is still a 409 `CHECK_EXISTS`. Free text from the bundle (workspace name, revision, snapshot warnings, run error code and detail, event notes, unknown and assessment text, check definitions and results) is cut to 2,000 characters per string. Restore yields to the event loop between snapshots and runs, so Ctrl+C or SIGTERM is honoured during a restore (exit 130 or 143; the transaction rolls back).

Test your restore before you need it: run it against a throwaway data directory and compare `GET /api/v1/impact-runs/{id}/export?format=json` `report_hash` values with the original.

## Upgrade

1. Stop the worker (`serve` includes it; or stop `worker`), so no job is claimed while the schema changes.
2. Back up: database plus an evidence bundle (above).
3. Install the new version and start it. `serve` applies migrations itself before it reports ready; or run `migrate` explicitly first.
4. Confirm `GET /api/v1/health/ready` is 200 and the job queue drains.
5. Read "Upgrading across decision engine versions" below if the release notes change any decision rule.

### Upgrading across decision engine versions

Every assessment records the version of the decision engine that produced it (`engine_version`, currently 3; the run view and the JSON and HTML reports show it as `engine`). Three things follow when the rules change between builds:

- **Old runs keep the verdict they were given, and say so everywhere.** Migration 004 adds columns and does not recompute anything. A run assessed by an older engine has `engine.rerun_required: true` (and `rerun_required: true` in the run list) with the sentence "assessed by an older decision engine (version N, this build is M): re-run required; the recorded verdict is history and must not be read as a current answer". Such a run has NO current assessment: `assessment` is `null` in the run view, the list and the JSON export, and the old verdict is in `recorded_assessment` (a script that gates on `assessment == "NO_KNOWN_IMPACT"` cannot accept it). The run page shows a "RE-RUN REQUIRED" banner, the list shows "Re-run required", and the HTML report shows a "RE-RUN REQUIRED" block instead of a verdict block, with every count, coverage statement and list below it labelled as the older engine's. Runs stored before the stamp existed count as version 1. Request a new run for anything you still rely on; do not trust an old `NO_KNOWN_IMPACT` across an upgrade that changed the rules (version 2 fixed cases in which a consumer was silently excluded, and version 3 makes a newly required field reach every consumer of the contract, so an old `NO_KNOWN_IMPACT` can be wrong today).
- **Exports keep working across engine versions; one limit.** A snapshot whose stored manifest the CURRENT validator rejects (the validator was widened after the manifest was accepted: for example an owner such as `on-call pin: 4821abc`, `sms otp: 9f3k2m1` or `primary dsn: prod1a2b3c`, which an earlier build stored) makes `changeradar export`, `verify-bundle` and `restore` refuse, fail-closed and with nothing written: `BUNDLE_SNAPSHOT_MISMATCH` (exit 2) naming the snapshot id, the JSON locations (`/nodes/3/owner`) and the rule (`SECRET_VALUE_REJECTED`), never the value. The source data is not rewritten. What to do: import the source manifest again through the current importer (the rejected value is then refused at the source, where it can be fixed), or keep the previous build for exports until then. `GET /api/v1/snapshots/{id}/manifest` (operator, admin) serves such a stored manifest redacted, with the header `x-changeradar-manifest-redacted` naming the stored document's hash; views and run exports redact as always. A sanitized, hash-bound export representation for such snapshots is a deferred decision (recorded as an open owner decision in the review ledger). A workspace or run export that contains runs from an older engine still succeeds. Those runs are not re-derived (the old rules are gone from this build); they are protected by the hashes only and listed as stale: `verify-bundle` and `restore` print the number of stale runs and their ids, and `restore` returns them as `stale_runs`. Restored stale runs are marked re-run required like any other. A bundle written by this build also carries the same ids in a top-level `stale_runs` member that is outside every hash (a hint next to the evidence: the recorded `verdict` of such a run is history although it stays hashed evidence, so a script that gates on the bundle's `verdict` must look at `stale_runs` first). `GET /api/v1/impact-runs/{id}/bundle` answers the header `x-changeradar-stale-runs` with the count (0 for a current run), and `changeradar export` says how many exported runs are history. Verification checks the member against the runs it names and refuses one that does not match; a bundle from an earlier build has no member and verifies as before. A workspace restored by an earlier build may hold a derived message that the restore had cut to 2,000 characters; this build derives every message within that bound, so such a workspace verifies again.
- **Bundles from a NEWER build do not restore into an older one.** A run whose engine version is newer than this build's, or is not a whole number, is refused with `BUNDLE_ENGINE_VERSION` (exit 2, nothing written), which is not the same as `BUNDLE_RUN_INCONSISTENT` (an edited bundle). Keep the database backup of the old version for a rollback.

What to do after an upgrade that changed the decision rules: (1) export a fresh bundle (it works, stale runs included) and keep it with the pre-upgrade backup; (2) list the runs (`rerun_required` is true for the stale ones) and request new runs for the changes you still care about, against the current baseline; (3) treat the old runs as history: their findings and hashes are intact, their verdicts are not current.

Migrations are additive (expand only), run in ONE transaction under an advisory lock (so two starting instances serialize), are checksum-verified once applied (a modified applied migration, or a database that is ahead of the build, refuses to start), and either all apply or none does. Schema downgrades are not supported: to roll back, stop the new version, restore the verified database backup, and start the old version. A contract (destructive) migration will only ship after every supported version has stopped reading the old shape. With Compose: `git pull` (or fetch the new package), `docker compose up -d --build`; the named volume keeps the database.

### Readiness and a failed migration

`GET /api/v1/health/live` is 200 whenever the process runs. `GET /api/v1/health/ready` is 200 only when the schema is current and the database answers; otherwise it is 503 `NOT_READY` with a reason (`migration_failed`, `database_unavailable`, `starting`). **A failed migration stops readiness:** the process keeps answering liveness, prints `NOT READY: migrations failed` at startup, answers 503 `NOT_READY` to every other route, and does not start the worker. Nothing was half applied (the failing migration and everything after it rolled back). Read the startup error, fix the cause (or restore the previous database and version), and restart; the server does not retry a failed migration into a half state. A lost database connection at runtime also turns readiness to `database_unavailable`, and it recovers by itself once the database answers.

### Stopping the server

`SIGINT` or `SIGTERM` stops `serve` cleanly: the worker stops claiming jobs, requests in flight get up to 5 seconds, and then every remaining connection (a client trickling a request body, or holding a keep-alive open) is closed, so a slow client cannot keep the process alive. A one-shot command that is interrupted exits 130 or 143 and never 0. Standard input of `credential set` and `admin create --password-stdin` is read up to 64 KiB.

### Worker restart

Jobs are claimed with a bounded lease (default 60 s) that a heartbeat extends. If the worker (or the whole `serve` process) dies, the lease simply expires (a real `kill -9` of `serve` was exercised on the embedded database; on PostgreSQL 17 worker crashes are simulated in the test suite, and a PostgreSQL server restart, a `pg_dump` restore and a separate `worker` process being killed were NOT exercised in the recorded evidence: `npm run durability:pg17` (`scripts/durability-proof-pg17.mjs`, needs Docker and `npm run build`) performs exactly those three on a throwaway PostgreSQL 17 container and prints one receipt line per step; it has been authored and dry-run checked but its execution receipt is not yet recorded, so prove them in your own environment before relying on them); on restart the next worker reclaims the job and the run goes RUNNING, back to QUEUED, RUNNING again, with the history saying so. A worker that lost its lease cannot commit anything. **Uncertain external outcomes are never discarded or invented:** a live contract check that was in flight when the worker died ends `UNKNOWN` (not re-run, never passed), and the run finishes INCOMPLETE. A job that keeps crashing its worker ends `failed` with `WORKER_EXHAUSTED` after its attempt budget. Nothing to do but start the process again; request a new run if you want the check to run again.

## Retention (operator approval required)

The proposed defaults (PRD section 6) are: redacted evidence kept 90 days, primary deletion completing within 24 hours of an approved request, rotated backups expiring within 30 days, idempotency keys kept at least 7 days. **The production operator must approve these before customer data is ingested.** They are reported by `GET /api/v1/settings` with `retention.enforced: false` and are never applied by a timer.

```bash
npx changeradar retention report --days 90                 # what would be deleted (read only)
npx changeradar retention apply --days 90 --approve        # delete it; needs the explicit flag
npx changeradar idempotency prune --older-than-days 7      # never accepts less than 7
```

`apply` removes finished runs (with findings, check results and history) older than the window and snapshots that are not the current baseline and are not referenced by a kept run, in one transaction, and records the purge in the audit trail (which it never deletes). Append-only history is otherwise protected by database triggers; only this transaction sets the purge flag they require. Backups are your own files and are not touched.

## Failure diagnosis

| Symptom | Likely cause | What to do |
| --- | --- | --- |
| `serve` prints `NOT READY: migrations failed`; `/health/ready` is 503 `NOT_READY (migration_failed)` | a migration failed, was modified, or the database is ahead of this build | read the startup error, fix or restore the previous database and version; nothing was half applied |
| `serve` exits with `EADDRINUSE` | the port is taken | choose another `CHANGERADAR_PORT` or stop the other process |
| 503 `NOT_READY (database_unavailable)` | the database is unreachable | check the URL, credentials, network and PostgreSQL logs; the server recovers by itself once the database answers |
| `missing required configuration` at start | `CHANGERADAR_DATABASE_URL` or `CHANGERADAR_ENCRYPTION_KEY` is unset | set them (see `.env.example`) |
| 401 on every call | no session, expired (default 12 h) or revoked | log in again; `GET /api/v1/auth/session` shows the current session |
| 403 `CSRF_INVALID` | mutation without `x-csrf-token` (use the token from login or `GET /auth/session`) | send the header on every non-GET request |
| 403 `FORBIDDEN` | the role is too low for the route | see the role table in `docs/API.md` |
| 404 for an id that exists | it belongs to another workspace (indistinguishable by design) or the id is malformed | check you are in the right workspace |
| 409 `STALE_BASELINE` on `POST /impact-runs` | another import moved the baseline, or `expected_hash` is not the snapshot's hash | `GET /baseline`, use its id and hash, retry (or `allow_superseded: true` to assess a historical snapshot on purpose) |
| 409 `IDEMPOTENCY_CONFLICT` | the same `Idempotency-Key` was used with a different body | use a new key for a new request |
| 413 `PAYLOAD_TOO_LARGE`, `TOO_MANY_NODES`, `TOO_MANY_EDGES` | over the limits (25 MB, 10,000, 50,000) | split the manifest; these are the MVP limits |
| 422 with `details.issues` | the manifest was rejected (dangling edge, duplicate, secret-looking value, schema) | the issues give JSON pointers and codes, never the submitted value |
| 429 `RATE_LIMITED` | too many logins or calls per minute | wait for `retry-after` seconds |
| run stays `queued` | no worker is running, or the job is waiting for its retry backoff | start `serve` (with worker) or `worker`; `GET /api/v1/events` shows activity |
| run `failed` with `WORKER_EXHAUSTED` | the job kept crashing or failing | check worker diagnostics (`CHANGERADAR_LOG=1`); request a new run once fixed |
| run `failed` with `OUTPUT_TOO_LARGE` | the assessment would be larger than the service stores (40 MB) even after the per-run limits | narrow the change (fewer changed nodes at once) and run again |
| run `INCOMPLETE` with unknown `FINDINGS_TRUNCATED` | a limit on the size of the output was reached (5,000 findings per run, 1,000 per changed node, 16 MB of findings, or the traversal budget): the listed consumers are the closest ones and more exist | narrow the change; never read the shortened list as the whole answer |
| 400 `DUPLICATE_JSON_KEY` or `JSON_TOO_COMPLEX` | the body repeats an object key (only one value would have been kept) or nests or repeats containers beyond any valid document | fix the producer of the JSON |
| run `INCOMPLETE` with unknown `CHECK_NOT_RUN` | a check named in `check_keys` was disabled or removed before the worker ran | enable it again and run again, or drop the key |
| run `failed` with `INTEGRITY_FAILURE` | stored manifest text no longer matches its hash: the database was modified outside the application | restore from a backup; do not trust the affected data |
| run `complete` but `assessment: INCOMPLETE` | not an error: an unknown exists (missing owner, unverified or stale edge, placeholder, undeclared contract, or a live check that did not pass) | read `unknowns[]` and `coverage.limits`; fill in the manifest or fix the check, then run again |
| check `ERROR` | transport failure, host not on the allowlist, address refused, missing credential value, body too large | `checks[].detail` names the class of problem (never a value) |
| check `TIMED_OUT` | no answer within `timeout_ms` | fix the endpoint or raise the check's timeout (at most the operator maximum) |
| check `UNKNOWN` | the worker died while the check was in flight; the outcome cannot be known and it is not retried | request a new run |
| restore exits 2 | `BUNDLE_*` (truncated, edited, unsupported, too large, `BUNDLE_ENGINE_VERSION` from a build with newer decision rules) or `RESTORE_CONFLICT` (not a clean installation) | the message says which; nothing was written |
| a run shows "assessed by an older decision engine" | it was assessed before an upgrade that changed the decision rules | request a new run; see Upgrading across decision engine versions |
| `429 RATE_LIMITED` on an export or bundle | exports have their own small per-user budget (12 exports and 4 bundle downloads per window, 2 built at once) because building one stalls the server's single thread (about three seconds for a bundle at the largest size) | wait for `Retry-After` |
| the browser shows a blank page or "service unavailable" | the UI was not built (`serve` printed `web UI not found`), or the server is not ready | run `npm run build`, or set `CHANGERADAR_WEB_ROOT`; check `/api/v1/health/ready` |

## Reason and error code reference

**HTTP error codes** (`{"error":{"code","message","request_id"}}`; the full status-by-status list is in `docs/API.md`): 400 `MALFORMED_JSON`, `DUPLICATE_JSON_KEY`, `JSON_TOO_COMPLEX`, `BAD_REQUEST`, `INVALID_COOKIE`, `INVALID_REQUEST`, `INVALID_LIMIT`, `INVALID_QUERY`, `INVALID_CURSOR`, `INVALID_FORMAT`, `INVALID_IDEMPOTENCY_KEY`; 401 `UNAUTHENTICATED`, `INVALID_CREDENTIALS`; 403 `FORBIDDEN`, `CSRF_INVALID`; 404 `NOT_FOUND`; 409 `STALE_BASELINE`, `IDEMPOTENCY_CONFLICT`, `CHECK_EXISTS`, and a `BUNDLE_*` code when a stored run cannot be exported; 413 `PAYLOAD_TOO_LARGE`, `TOO_MANY_NODES`, `TOO_MANY_EDGES`, `BUNDLE_TOO_LARGE`; 422 `SCHEMA_INVALID`, `UNSUPPORTED_SCHEMA_VERSION`, `SECRET_VALUE_REJECTED`, `DUPLICATE_NODE_ID`, `DUPLICATE_EDGE`, `DUPLICATE_CONTRACT_FIELD`, `DANGLING_EDGE`, `CONTRACT_ON_NON_CONTRACT_NODE`, `EDGE_FIELDS_ON_NON_CONTRACT_TARGET`, `INVALID_EXPECTED_HASH`, `UNKNOWN_CHECK`, `URL_NOT_ALLOWED`; 429 `RATE_LIMITED`; 500 `INTERNAL`, `INTEGRITY_FAILURE` (generic messages only); 503 `NOT_READY`.

| Group | Code | Meaning |
| --- | --- | --- |
| Readiness reason | `migration_failed` / `database_unavailable` / `starting` / `ready` | why `/health/ready` is 503, or that it is 200 |
| Run status | `queued`, `running`, `complete`, `failed` | `complete` describes computation, never safety |
| Assessment | `AFFECTED`, `NO_KNOWN_IMPACT`, `INCOMPLETE` | the verdict; `INCOMPLETE` is never a pass; `NO_KNOWN_IMPACT` is limited to declared dependencies |
| Run error | `WORKER_EXHAUSTED`, `INTEGRITY_FAILURE`, `TOO_MANY_CHECKS`, `OUTPUT_TOO_LARGE`, `RESTORED_UNFINISHED` | why a run has no verdict |
| Check state | `STARTED`, `PASSED`, `FAILED`, `TIMED_OUT`, `ERROR`, `UNKNOWN` | only `PASSED` adds nothing to the verdict; every other final state is an unknown |
| Unknown code | `MISSING_OWNER`, `PLACEHOLDER_NODE`, `UNVERIFIED_CONTRACT`, `STALE_CONTRACT`, `FUTURE_VERIFIED_AT`, `UNDECLARED_CONTRACT`, `EDGE_FIELD_NOT_IN_CONTRACT` (a consumer edge, in the baseline or in the proposal, names a field the contract does not have: the declaration is unusable, the consumer is treated as relying on every required field, and the typo or stale name is reported), `CHECK_FAILED`, `CHECK_TIMED_OUT`, `CHECK_ERROR`, `CHECK_UNKNOWN`, `CHECK_NOT_RUN`, `FINDINGS_TRUNCATED`, `UNKNOWNS_TRUNCATED` | what could not be established (each forces INCOMPLETE) |
| Import warning | `CYCLE_DETECTED`, `MISSING_OWNER`, `PLACEHOLDER_NODE`, `UNVERIFIED_EDGE`, `EDGE_FIELD_NOT_IN_CONTRACT`, `EMPTY_FIELD_DECLARATION` (an edge declares `fields: []`: the consumer is exempt from every field change; omit `fields` if the fields it reads are not known) | accepted, but worth fixing |
| Coverage limit | `MANIFEST_DECLARED_ONLY`, `CONTRACT_SUBSET_ONLY`, `RUNTIME_NOT_OBSERVED`, `LIVE_CHECKS_NOT_RUN`, `NO_CHANGES_DETECTED`, `INFORMATIONAL_CHANGES_ONLY`, `NO_AFFECTED_CONSUMERS_DECLARED`, `FINDINGS_TRUNCATED`, `CHANGES_LIST_TRUNCATED`, `BASELINE_HAS_GAPS` | what the answer does not cover (every run lists the ones that apply) |
| Egress refusal (`URL_NOT_ALLOWED` `details.reason`, and the check error text) | `HOST_NOT_ALLOWED`, `SCHEME_NOT_ALLOWED`, `INVALID_URL`, `PRIVATE_ADDRESS`, `PORT_NOT_ALLOWED`, `RESOLUTION_FAILED`, `CREDENTIALS_IN_URL`, `BAD_REDIRECT`, `TOO_MANY_REDIRECTS`, `BODY_TOO_LARGE` | why a check URL or a redirect hop was refused; the allowlist is `CHANGERADAR_CHECK_ALLOWED_HOSTS` |
| Check `error_code` | `TIMEOUT`, `RUNNER_ERROR`, `UNRECOGNIZED_OUTCOME`, `INVALID_DEFINITION`, `RUNNER_NOT_READ_ONLY` | why a check is `TIMED_OUT` or `ERROR` (`TIMEOUT` also marks a check that was not run because the run's check time budget of 10 minutes was used up) |
| CLI error | `INVALID_EMAIL`, `WEAK_PASSWORD`, `UNKNOWN_WORKSPACE`, `ALREADY_MEMBER`, `UNKNOWN_MEMBER` | why `admin create` or `admin revoke` refused (exit 1) |
| Bundle | `BUNDLE_MALFORMED` (unreadable JSON; a truncated file usually lands here, not on the hash), `BUNDLE_DUPLICATE_KEY`, `BUNDLE_TOO_LARGE`, `BUNDLE_UNSUPPORTED_VERSION`, `BUNDLE_SCHEMA_INVALID`, `BUNDLE_HASH_MISMATCH` (content edited), `BUNDLE_SNAPSHOT_MISMATCH`, `BUNDLE_RUN_INCONSISTENT`, `BUNDLE_ENGINE_VERSION` (a run from a newer decision engine), `RESTORE_CONFLICT` | why `verify-bundle` or `restore` refused (exit 2); over HTTP an export answers 413 `BUNDLE_TOO_LARGE` or 409 with the code |
| CLI exit code | 0 success; 1 failure; 2 bundle rejected or restore conflict; 64 usage (unknown, repeated or value-less flags); 66 input file missing or unreadable; 70 unexpected internal error (a defect: report it); 73 output could not be written (permissions, read-only disk, no space, file exists); 130 or 143 interrupted by SIGINT or SIGTERM before a one-shot command finished; 141 output pipe closed | `serve`, `worker` and `demo` exit 0 on SIGINT or SIGTERM: that is how they are meant to stop |

## Running the test suites and the local gate

```bash
npm run typecheck
npm run test:coverage                                   # server suite on the embedded engine, then the web suite; enforce 90% lines and branches
bash scripts/verify-quality.sh                          # the whole gate: everything below in one run, non-zero on any failure
```

The gate (`scripts/verify-quality.sh`) runs: install check, typecheck, build, server suite with coverage thresholds, the same suite against a throwaway PostgreSQL 17 container (127.0.0.1 only, generated password, removed afterwards), web suite with coverage thresholds, both seeded mutation controls, schema drift, dependency license audit, secret and content hygiene, the packaged end-to-end run (the npm tarball installed in a fresh directory), the browser end-to-end run (real Chromium, real server, real worker), seeded end-to-end mutation controls, the runbook harness, a real Docker Compose startup with PostgreSQL 17 and a smoke against it (throwaway project, loopback-only port, torn down afterwards), and a control that a seeded failure turns the verdict red. `CR_SKIP=pg17,browser,compose` skips steps on a machine that cannot run them; the verdict then says `GREEN WITH SKIPS`. `bash scripts/node-floor-gate.sh` runs the gate on the Node 22.12 floor in a container (with those three skipped, and at most four test workers). To run the browser tests once, install a matching Chromium with `npx playwright install chromium`.

Real PostgreSQL 17 by hand (a throwaway container bound to loopback with a generated password; remove it afterwards):

```bash
PGPW="$(openssl rand -hex 16)"
docker run -d --name changeradar-pg17-test -e POSTGRES_PASSWORD="$PGPW" -e POSTGRES_USER=cr -p 127.0.0.1::5432 postgres:17-alpine
PORT="$(docker port changeradar-pg17-test 5432/tcp | head -1 | sed 's/.*://')"
PGPASSWORD="$PGPW" CHANGERADAR_TEST_DATABASE_URL="postgres://cr@127.0.0.1:$PORT/postgres" npx vitest run   # the driver reads PGPASSWORD
docker rm -f changeradar-pg17-test
```

The suite creates and drops its own databases on that server. `npm run mutation` re-runs the seeded mutation controls (single-line defects injected into a disposable copy; every one must make a test fail). `npm run bench:api` reproduces `docs/BENCHMARK.md`. Dependency licenses: `node scripts/dependency-licenses.mjs` regenerates `docs/DEPENDENCY-LICENSES.md` and `--check` fails on a non-permissive license.
