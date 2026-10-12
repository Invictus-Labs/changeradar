# Synthetic smoke runbook (fresh operator)

This is the procedure a person who did not build ChangeRadar follows to prove an installation works: install, sign in, import a synthetic manifest, see a seeded breaking change reach its consumers, export, back up, restore, and see a corrupted backup refused. It uses only synthetic data and needs no account or license server. Installing the package (step 1) downloads its dependencies from the npm registry once; after that nothing needs network access. It takes about 15 minutes.

Prerequisites: Node.js 22.12 or newer with `npm`, `curl`, a shell (bash or zsh) and a package file `changeradar-<version>.tgz`. If you have a checkout instead of a package file, build one first: `npm ci && npm run build && npm pack` (it prints the file name).

## Before you start: name the package file and check it

The commands need to know where the package file is. Set this once in the shell you will use for every step (replace the path with the real one; this block is deliberately not run by the automated harness):

```text
export CHANGERADAR_TARBALL=/full/path/to/changeradar-0.1.0.tgz
echo "<sha256 you were given>  $CHANGERADAR_TARBALL" | shasum -a 256 -c -
```

`shasum` must print `OK`. (`shasum` ships with macOS and most Linux desktops but not with minimal Linux images; there use `sha256sum -c -` with the same input, which prints the same `OK`.) The checksum comes from the person who handed you the package, by a different route than the package itself (not from inside it). If you are the independent person doing the human drill, `docs/HUMAN-DRILL.md` lists what else to record and what makes a drill not count.

How to read the rest of this page: every `bash` block is run in ONE shell session, in order (variables persist between blocks). The block after it, marked `expect`, lists text that the previous block must have printed. `docs/HUMAN-DRILL.md` says what an independent person records while doing this; `scripts/runbook-harness.mjs` runs these exact blocks automatically as supplemental evidence (it is not the human drill and does not satisfy AC-11).

Two things to know before you start. **Timestamps:** the sample manifests mark every dependency edge as verified one day before the moment you create them; ChangeRadar treats an edge as stale after 30 days, so create the samples in step 6, not weeks earlier. **`localhost`:** the server listens on `127.0.0.1` (this machine only). Nothing else on your network can reach it.

## 1. Install into an empty directory

```bash
test -f "${CHANGERADAR_TARBALL:-}" || echo "STOP: CHANGERADAR_TARBALL must be the full path of an existing package file (see Before you start)"
test -f "${CHANGERADAR_TARBALL:-}" && CHANGERADAR_TARBALL="$(cd "$(dirname "$CHANGERADAR_TARBALL")" && pwd)/$(basename "$CHANGERADAR_TARBALL")"
export SMOKE_DIR="$(mktemp -d)"
cd "$SMOKE_DIR"
npm init -y >/dev/null
npm install "${CHANGERADAR_TARBALL:?set CHANGERADAR_TARBALL to the package file path (see Before you start)}" --no-audit --no-fund
CR="$SMOKE_DIR/node_modules/.bin/changeradar"
"$CR" version
"$CR" help 2>&1 | head -n 3
```

```expect
changeradar 0.1.0
changeradar <command>
```

`version` prints the package version and the source commit the package was built from (`commit unknown` means it was not built from a git checkout). Compare the commit with the one you were given; if it differs, or says `dirty`, stop: this is not the package to drill.

## 2. Configure (embedded database, one machine)

The embedded database is a directory; nothing to install. The encryption key seals stored credential values. Keep it if you keep the data.

```bash
export CHANGERADAR_DATABASE_URL="pglite:$SMOKE_DIR/data/db"
export CHANGERADAR_ENCRYPTION_KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")"
export CHANGERADAR_PORT="${CHANGERADAR_PORT:-8797}"
BASE="http://localhost:$CHANGERADAR_PORT"
export CHANGERADAR_PUBLIC_URL="$BASE"
"$CR" migrate
```

```expect
applied: 001_identity.sql
```

## 3. Create the first administrator (there is no default password)

```bash
"$CR" admin create --email operator@example.test --workspace "Smoke test" --generate-password | tee admin.txt
WS="$(sed -n 's/.* in workspace \([0-9a-f-]*\).*/\1/p' admin.txt)"
PW="$(sed -n 's/^password (shown once): //p' admin.txt)"
echo "workspace id: $WS"
```

```expect
created admin operator@example.test
password (shown once):
workspace id:
```

## 4. Start the server (API, worker and web UI in one process)

```bash
"$CR" serve > server.log 2>&1 &
echo $! > server.pid
READY=no
for i in $(seq 1 120); do
  if ! kill -0 "$(cat server.pid)" 2>/dev/null; then echo "the server exited; see server.log below"; break; fi
  if curl -fsS $BASE/api/v1/health/ready && grep -q "listening on" server.log; then READY=yes; break; fi
  sleep 1
done
echo
if [ "$READY" != yes ]; then echo "STOP: the server did not become ready (is another program using port $CHANGERADAR_PORT? set CHANGERADAR_PORT to a free port in step 2)"; tail -n 20 server.log; fi
curl -fsS $BASE/ | grep -c 'id="root"'
```

```expect
"status":"ready"
1
```

The loop ends after two minutes, stops as soon as the server process dies, and only counts a `ready` answer that came with the server's own `listening on` line, so another program on the port cannot be mistaken for ChangeRadar. A single `curl: (7) Failed to connect` line while the server starts is normal.

At this point you can open `http://localhost:8797/` (or your `CHANGERADAR_PORT`) in a browser and sign in with the email and password from step 3.

## 5. Sign in through the API

Every request after login carries the session cookie; every non-GET request also carries the CSRF token that login returned.

```bash
CSRF="$(curl -fsS -c jar.txt -H 'content-type: application/json' --data "{\"email\":\"operator@example.test\",\"password\":\"$PW\",\"workspace_id\":\"$WS\"}" $BASE/api/v1/auth/login | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).csrf_token')"
curl -fsS -b jar.txt $BASE/api/v1/auth/session | node -pe 'const s=JSON.parse(require("fs").readFileSync(0,"utf8")); "signed in as " + s.user.email + " (" + s.user.role + ") in " + s.user.workspace_name'
```

```expect
signed in as operator@example.test (admin) in Smoke test
```

## 6. Import the synthetic baseline

```bash
"$CR" sample-manifests --out samples
SNAP="$(curl -fsS -b jar.txt -H "x-csrf-token: $CSRF" -H 'content-type: application/json' --data @samples/snapshot-request.json $BASE/api/v1/snapshots)"
echo "$SNAP" | node -pe 'const s=JSON.parse(require("fs").readFileSync(0,"utf8")); "snapshot " + s.id + " hash " + s.hash + " nodes " + s.node_count + " edges " + s.edge_count'
```

```expect
wrote 5 synthetic files
nodes 10 edges 9
```

## 7. Assess a seeded breaking change

`proposal-breaking-removal.json` removes a required field (`amount`) from a contract. ChangeRadar is asked what it breaks; the answer must name direct and transitive consumers, each with an ordered path and an owner.

```bash
node -e 'const s=JSON.parse(process.argv[1]); const m=JSON.parse(require("fs").readFileSync("samples/proposal-breaking-removal.json","utf8")); console.log(JSON.stringify({snapshot_id:s.id, expected_hash:s.hash, proposed_manifest:m}))' "$SNAP" > run-request.json
RUN="$(curl -fsS -b jar.txt -H "x-csrf-token: $CSRF" -H 'content-type: application/json' --data @run-request.json $BASE/api/v1/impact-runs)"
RID="$(echo "$RUN" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).id')"
until [ "$(curl -fsS -b jar.txt $BASE/api/v1/impact-runs/$RID | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).status')" = complete ]; do sleep 1; done
curl -fsS -b jar.txt $BASE/api/v1/impact-runs/$RID > run.json
node -e 'const r=JSON.parse(require("fs").readFileSync("run.json","utf8")); console.log("assessment: "+r.assessment); for (const f of r.affected) { const p=r.paths.find(x=>x.finding_id===f.id).path.join(" > "); console.log((f.direct?"direct     ":"transitive ")+f.consumer_id+"  owner "+f.consumer_owner+"  path "+p); }'
```

```expect
assessment: AFFECTED
direct     job.invoice-export  owner team-data  path contract.invoice > job.invoice-export
direct     svc.ledger-sync  owner team-finance  path contract.invoice > svc.ledger-sync
transitive svc.dashboard  owner team-web  path contract.invoice > job.invoice-export > artifact.invoice-report > svc.dashboard
```

The block prints one line per affected consumer (five: two direct and three transitive); the lines above are three of them and must be among them.

`svc.mailer` also consumes the contract, but only declared `invoice_id`, so removing `amount` does not reach it. That is correct, and it is only as complete as the manifests: a consumer nobody declared is not known.

## 8. Export the report and compare finding ids

The JSON and HTML reports must list the same finding ids as the run.

```bash
curl -fsS -b jar.txt "$BASE/api/v1/impact-runs/$RID/export?format=json" > report.json
curl -fsS -b jar.txt "$BASE/api/v1/impact-runs/$RID/export?format=html" > report.html
node -e 'const j=JSON.parse(require("fs").readFileSync("report.json","utf8")).findings.map(f=>f.id).sort(); const h=[...new Set(require("fs").readFileSync("report.html","utf8").match(/fnd_[0-9a-f]+/g))].sort(); console.log("json findings "+j.length+", html findings "+h.length+", identical ids: "+(JSON.stringify(j)===JSON.stringify(h)))'
```

```expect
json findings 5, html findings 5, identical ids: true
```

Open `report.html` in a browser if you like: it is a single self-contained page (no script, no external resource).

## 9. Prove "unknown is never safe": an unverified edge makes the same change INCOMPLETE

```bash
SNAP2="$(node -e 'const fs=require("fs"); const m=JSON.parse(fs.readFileSync("samples/baseline-with-unverified-edge.json","utf8")); console.log(JSON.stringify({schema_version:1, revision:"smoke-unverified", manifest:m}))' | curl -fsS -b jar.txt -H "x-csrf-token: $CSRF" -H 'content-type: application/json' --data @- $BASE/api/v1/snapshots)"
node -e 'const s=JSON.parse(process.argv[1]); const m=JSON.parse(require("fs").readFileSync("samples/proposal-breaking-removal.json","utf8")); console.log(JSON.stringify({snapshot_id:s.id, expected_hash:s.hash, proposed_manifest:m}))' "$SNAP2" > run2-request.json
RID2="$(curl -fsS -b jar.txt -H "x-csrf-token: $CSRF" -H 'content-type: application/json' --data @run2-request.json $BASE/api/v1/impact-runs | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).id')"
until [ "$(curl -fsS -b jar.txt $BASE/api/v1/impact-runs/$RID2 | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).status')" = complete ]; do sleep 1; done
curl -fsS -b jar.txt $BASE/api/v1/impact-runs/$RID2 | node -e 'const r=JSON.parse(require("fs").readFileSync(0,"utf8")); console.log("assessment: "+r.assessment+", unknowns: "+r.unknowns.map(u=>u.code).join(",")+", known breaks still listed: "+r.affected.length)'
```

```expect
assessment: INCOMPLETE, unknowns: UNVERIFIED_CONTRACT, known breaks still listed: 5
```

## 10. Stop, back up, verify

The embedded database is used by one process at a time, so stop the server first.

```bash
kill "$(cat server.pid)"
wait "$(cat server.pid)" 2>/dev/null || true
"$CR" export --workspace-id "$WS" --out backups/smoke.json
"$CR" verify-bundle --in backups/smoke.json
```

```expect
exported 2 snapshot(s), 2 run(s)
bundle ok: 2 snapshot(s), 2 run(s)
```

## 11. Restore into a second, clean installation

```bash
CHANGERADAR_DATABASE_URL="pglite:$SMOKE_DIR/restored/db" "$CR" restore --in backups/smoke.json
```

```expect
restored workspace
2 snapshot(s), 2 run(s)
```

The restored installation has the same snapshot, run and finding ids and the same report hashes. Users and credentials are not part of a bundle: create an administrator for the restored workspace with `admin create --workspace-id`.

## 12. Failure diagnosis: a truncated backup is refused and nothing is restored

```bash
head -c 2000 backups/smoke.json > backups/truncated.json
"$CR" verify-bundle --in backups/truncated.json 2>&1 || echo "exit code: $?"
CHANGERADAR_DATABASE_URL="pglite:$SMOKE_DIR/second/db" "$CR" restore --in backups/truncated.json 2>&1 || echo "restore exit code: $?"
```

```expect
BUNDLE_
exit code: 2
restore exit code: 2
```

Exit code 2 means "the bundle was rejected or the target is not clean". `docs/OPERATIONS.md` lists every reason code and what to do.

## 13. Clean up

```bash
cd /
rm -rf "$SMOKE_DIR"
echo "cleaned up"
```

```expect
cleaned up
```

## What to conclude

If every `expect` block matched, the installation works end to end on synthetic data: install, no-default-password bootstrap, import, a seeded break reaching direct and transitive consumers with owners, an unverified edge turning the same change INCOMPLETE, matching exports, backup, restore and a refused corrupt backup.

It does **not** show that ChangeRadar knows your real dependencies. It only knows what the manifests you write declare, manifests go stale, and static declarations cannot establish what actually happens at runtime. An unknown is reported as INCOMPLETE, never as safe.
