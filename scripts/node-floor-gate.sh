#!/usr/bin/env bash
# Run the local gate on the supported Node floor (22.12) inside a throwaway container.
#
#   bash scripts/node-floor-gate.sh [log-directory [command]]
#
# The repository is mounted read-only and copied (without node_modules, dist, coverage or version control data) into
# the container, dependencies are installed there for the container's own platform, and scripts/verify-quality.sh runs
# with the steps that need the host skipped: the PostgreSQL 17 suite and the Compose smoke need Docker (not available
# inside the container) and the browser suite needs a Chromium build. The summary says GREEN WITH SKIPS and names them;
# the host gate (bash scripts/verify-quality.sh) runs everything. Exit code is the gate's.
# A second argument (or CR_FLOOR_CMD) replaces the command run in the container (for example one test file while
# investigating a failure). The container runs at most 4 test workers (CR_FLOOR_WORKERS): with one worker per host core the
# container's memory (each embedded database instance is a WebAssembly PostgreSQL) thrashes and tests time out.
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
LOGS="${1:-${TMPDIR:-/tmp}/changeradar-node-floor-$(date -u +%Y%m%dT%H%M%SZ)}"
COMMAND="${2:-${CR_FLOOR_CMD:-bash scripts/verify-quality.sh}}"
mkdir -p "$LOGS"
command -v docker >/dev/null 2>&1 || { echo "Docker is required for the Node floor check"; exit 1; }
echo "node floor gate: image node:22.12, logs in $LOGS"
docker run --rm \
  --name "changeradar-node-floor-$$" \
  -v "$ROOT":/src:ro \
  -v "$LOGS":/logs \
  -e CR_SKIP="${CR_FLOOR_SKIP:-pg17,browser,compose}" \
  -e CR_GATE_LOG_DIR=/logs \
  -e VITEST_MAX_WORKERS="${CR_FLOOR_WORKERS:-4}" \
  -e VITEST_MAX_FORKS="${CR_FLOOR_WORKERS:-4}" \
  -e CR_FLOOR_CMD="$COMMAND" \
  node:22.12 bash -c '
    set -e
    node -v
    mkdir /work
    cd /src
    tar --exclude=./node_modules --exclude=./dist --exclude=./coverage --exclude=./.git --exclude=./.claude --exclude=./test-results --exclude=./playwright-report -cf - . | tar -C /work -xf -
    cd /work
    npm ci --no-audit --no-fund
    eval "$CR_FLOOR_CMD"
  '
code=$?
echo "node floor gate exit code: $code (logs: $LOGS)"
exit $code
