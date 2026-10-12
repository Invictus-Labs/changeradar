#!/usr/bin/env bash
# ChangeRadar local quality gate. No remote CI: this script is the release verdict.
#
#   bash scripts/verify-quality.sh              the full gate (about 10 to 20 minutes; needs Node 22.12+, npm, Docker, Chromium)
#   bash scripts/verify-quality.sh --list       list the steps
#   bash scripts/verify-quality.sh --seeded-failure
#                                               run ONLY a deliberately failing mandatory step: it must print GATE RED and exit 1
#                                               (proof that a failure turns the verdict red; the gate also runs this as a step)
#
# Steps: install check, typecheck (server, tests, web), build, server suite with enforced coverage on the embedded
# database, the same suite against a real PostgreSQL 17 (throwaway container on 127.0.0.1), web suite with enforced
# coverage, seeded mutation controls (server, web and end to end), schema drift, dependency licenses, secret and content hygiene,
# packaged end to end (npm tarball in a fresh directory), browser end to end (real Chromium), the runbook harness, a
# real Docker Compose startup with PostgreSQL 17 and a smoke against it (throwaway project, torn down afterwards), and
# the gate's own red-on-failure control.
#
# Exit 0 only when every step passed. A failed step never stops later steps from running, so one run reports everything.
# Skips exist for machines that cannot run a step (for example a container without Docker or a browser):
#   CR_SKIP=pg17,browser,compose bash scripts/verify-quality.sh
# A skipped step is named in the summary, and the verdict says "GREEN WITH SKIPS", never plain "GREEN".
#
# Environment: CR_GATE_LOG_DIR (default: a new directory under $TMPDIR) receives one log per step and summary.txt.
set -u -o pipefail
cd "$(dirname "$0")/.."

export NO_COLOR=1
unset FORCE_COLOR
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
LOG_DIR="${CR_GATE_LOG_DIR:-${TMPDIR:-/tmp}/changeradar-gate-$STAMP}"
mkdir -p "$LOG_DIR"
utc() { date -u +%Y-%m-%dT%H:%M:%SZ; }

NAMES=(); STATUS=(); CODES=(); STARTS=(); ENDS=(); NOTES=()
FAILED=0
SKIPPED_NAMES=""
PG_NAME=""

cleanup() {
  if [ -n "$PG_NAME" ] && command -v docker >/dev/null 2>&1; then docker rm -f "$PG_NAME" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT INT TERM

skipped() { case ",${CR_SKIP:-}," in *",$1,"*) return 0 ;; *) return 1 ;; esac; }

# Test counts and coverage found in a step's log, for the summary.
notes_of() {
  local log="$1" files tests pw cov
  files="$(grep -E '^ *Test Files ' "$log" | tail -1 | sed -E 's/^ *Test Files +//; s/ \([0-9]+\)//')"
  tests="$(grep -E '^ *Tests ' "$log" | tail -1 | sed -E 's/^ *Tests +//; s/ \([0-9]+\)//')"
  pw="$(grep -E '^ +[0-9]+ (passed|failed|skipped)' "$log" | tr -s ' ' | tr '\n' ',' | sed 's/^ //; s/,$//')"
  cov="$(grep -E '^All files' "$log" | tail -1 | awk -F'|' '{gsub(/ /,"",$2); gsub(/ /,"",$3); gsub(/ /,"",$5); printf "coverage: lines %s%% branches %s%%", $5, $3}')"
  local out=""
  [ -n "$files" ] && out="files: $files"
  [ -n "$tests" ] && out="$out${out:+; }tests: $tests"
  [ -n "$pw" ] && out="$out${out:+; }playwright: $pw"
  [ -n "$cov" ] && out="$out${out:+; }$cov"
  printf '%s' "$out"
}

# run_step <name> <function-or-command...>: run it, log it, record status, exit code, UTC start and end.
run_step() {
  local name="$1"; shift
  local index="${#NAMES[@]}" log start end code
  log="$LOG_DIR/$(printf '%02d' "$index")-$name.log"
  start="$(utc)"
  echo "[$start] START $name"
  { "$@"; } >"$log" 2>&1
  code=$?
  end="$(utc)"
  NAMES+=("$name"); CODES+=("$code"); STARTS+=("$start"); ENDS+=("$end"); NOTES+=("$(notes_of "$log")")
  if [ "$code" -eq 0 ]; then STATUS+=("PASS"); echo "[$end] PASS  $name"; else STATUS+=("FAIL"); FAILED=$((FAILED + 1)); echo "[$end] FAIL  $name (exit $code); log: $log"; tail -n 15 "$log" | sed 's/^/        /'; fi
}

skip_step() {
  local name="$1" why="$2"
  NAMES+=("$name"); STATUS+=("SKIPPED"); CODES+=("-"); STARTS+=("-"); ENDS+=("-"); NOTES+=("$why")
  SKIPPED_NAMES="${SKIPPED_NAMES:+$SKIPPED_NAMES, }$name"
  echo "[$(utc)] SKIP  $name ($why)"
}

summary() {
  local i verdict
  {
    echo
    echo "ChangeRadar quality gate: $(utc)"
    echo "node $(node -v 2>/dev/null) on $(uname -s) $(uname -m); logs: $LOG_DIR"
    printf '%-24s %-8s %-5s %-21s %-21s %s\n' STEP RESULT EXIT START_UTC END_UTC DETAIL
    for i in "${!NAMES[@]}"; do
      printf '%-24s %-8s %-5s %-21s %-21s %s\n' "${NAMES[$i]}" "${STATUS[$i]}" "${CODES[$i]}" "${STARTS[$i]}" "${ENDS[$i]}" "${NOTES[$i]}"
    done
    echo
    if [ "$FAILED" -gt 0 ]; then verdict="GATE RED: $FAILED step(s) failed"
    elif [ -n "$SKIPPED_NAMES" ]; then verdict="GATE GREEN WITH SKIPS (this is not the full gate; skipped: $SKIPPED_NAMES)"
    else verdict="GATE GREEN: every step passed"; fi
    echo "$verdict"
  } | tee "$LOG_DIR/summary.txt"
}

# ---------------------------------------------------------------------------------------------------------------- steps

step_install() {
  node -e 'const [a,b]=process.versions.node.split(".").map(Number); if (a<22||(a===22&&b<12)) { console.error("Node 22.12 or newer is required, found "+process.version); process.exit(1) } console.log("node", process.version)' || return 1
  if [ ! -d node_modules ]; then echo "node_modules missing: running npm ci"; npm ci || return 1; fi
  npm ls --all >/dev/null || { echo "installed packages do not match package-lock.json: run npm ci"; return 1; }
  echo "dependencies match the lockfile"
}

step_pg17() {
  command -v docker >/dev/null 2>&1 || { echo "Docker is required for the PostgreSQL 17 run (or skip it explicitly with CR_SKIP=pg17)"; return 1; }
  local pw port i
  PG_NAME="changeradar-gate-pg17-$$"
  pw="$(node -e 'console.log(require("crypto").randomBytes(16).toString("hex"))')"
  docker run -d --rm --name "$PG_NAME" -e POSTGRES_PASSWORD="$pw" -e POSTGRES_USER=cr -p 127.0.0.1::5432 postgres:17-alpine >/dev/null || return 1
  for i in $(seq 1 90); do
    docker exec "$PG_NAME" pg_isready -h 127.0.0.1 -U cr >/dev/null 2>&1 && break
    sleep 1
  done
  docker exec "$PG_NAME" pg_isready -h 127.0.0.1 -U cr || { echo "PostgreSQL did not become ready"; return 1; }
  docker exec "$PG_NAME" postgres --version
  port="$(docker port "$PG_NAME" 5432/tcp | head -1 | sed 's/.*://')"
  PGPASSWORD="$pw" CHANGERADAR_TEST_DATABASE_URL="postgres://cr@127.0.0.1:$port/postgres" npx vitest run
  local code=$?
  docker rm -f "$PG_NAME" >/dev/null 2>&1
  PG_NAME=""
  return $code
}

# The gate's own control: a step that is meant to fail must produce a red verdict and a non-zero exit.
step_red_control() {
  local out code
  out="$(CR_GATE_LOG_DIR="$LOG_DIR/red-control" bash scripts/verify-quality.sh --seeded-failure 2>&1)"
  code=$?
  echo "$out" | tail -n 5
  [ "$code" -eq 1 ] || { echo "expected exit 1 from the seeded failure, got $code"; return 1; }
  echo "$out" | grep -q "GATE RED" || { echo "expected GATE RED in the seeded failure output"; return 1; }
  if echo "$out" | grep -q "GATE GREEN"; then echo "a seeded failure must never print GATE GREEN"; return 1; fi
  echo "the seeded mandatory failure turned the verdict red (exit $code)"
}

seeded_failure() { echo "seeded mandatory failure: this step fails on purpose to prove the gate turns red"; return 1; }

# Dependency license audit, and the notices file for the packages bundled into the web UI (both must be current).
step_licenses() { node scripts/dependency-licenses.mjs --check && node scripts/third-party-notices.mjs --check; }

# ------------------------------------------------------------------------------------------------------------- drivers

case "${1:-}" in
  --list)
    echo "install typecheck build server-suite-pglite server-suite-pg17 web-suite mutation-instruments mutation-server mutation-web schema-drift licenses hygiene packaged-e2e browser-e2e mutation-e2e runbook-harness compose-smoke durability-pg17 red-control"
    exit 0
    ;;
  --seeded-failure)
    run_step "seeded-mandatory-failure" seeded_failure
    summary
    [ "$FAILED" -gt 0 ] && exit 1
    exit 0
    ;;
  "") ;;
  *) echo "usage: bash scripts/verify-quality.sh [--list | --seeded-failure]" >&2; exit 64 ;;
esac

run_step install step_install
run_step typecheck npm run typecheck
run_step build npm run build
run_step server-suite-pglite npx vitest run --coverage
if skipped pg17; then skip_step server-suite-pg17 "skipped by CR_SKIP"; else run_step server-suite-pg17 step_pg17; fi
run_step web-suite npm run test:web:coverage
# Before any mutation step: every mutant of all three harnesses must still match the code exactly once.
run_step mutation-instruments node scripts/check-mutant-instruments.mjs
run_step mutation-server node scripts/mutation-controls.mjs
run_step mutation-web node scripts/web-mutation-controls.mjs
run_step schema-drift npm run schema:check
run_step licenses step_licenses
run_step hygiene node scripts/hygiene-scan.mjs
run_step packaged-e2e npx playwright test --project=packaged
if skipped browser; then skip_step browser-e2e "skipped by CR_SKIP"; else run_step browser-e2e npx playwright test --project=browser; fi
if skipped browser; then skip_step mutation-e2e "skipped with browser"; else run_step mutation-e2e node scripts/e2e-mutation-controls.mjs; fi
run_step runbook-harness node scripts/runbook-harness.mjs
if skipped compose; then skip_step compose-smoke "skipped by CR_SKIP"; else run_step compose-smoke node scripts/compose-smoke.mjs; fi
# AC-13 on a real PostgreSQL 17: kill -9 of a separate worker, a PostgreSQL restart, a pg_dump restore. Without a usable
# Docker daemon the step is SKIPPED-no-docker (never a pass, and AC-13 stays PARTIAL).
if skipped durability; then skip_step durability-pg17 "skipped by CR_SKIP; AC-13 stays PARTIAL"
elif ! docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then skip_step durability-pg17 "SKIPPED-no-docker: Docker daemon not usable, so AC-13 stays PARTIAL"
else run_step durability-pg17 node scripts/durability-proof-pg17.mjs; fi
run_step red-control step_red_control

summary
[ "$FAILED" -gt 0 ] && exit 1
exit 0
