# ChangeRadar

Self-hosted change-impact analysis: see which known consumers a proposed manifest change can break.

## Stack
Node.js 22+ TypeScript API and worker, PostgreSQL, React graph and report view. Pin exact dependency versions. TypeScript strict, ESM.

## GitHub
NEVER commit to main directly. Always feature branch (`codex/`) -> PR -> merge. No GitHub Actions workflows.

## Quality Gate
- Coverage floor: 90% lines and branches on decision/service code.
- Local gate: `bash scripts/verify-quality.sh` (typecheck, build, tests, coverage, secret scan, negative controls).
- Every acceptance criterion in `docs/prd/changeradar.md` needs current, named test evidence; see `docs/qa/`.
- Independent code-review and QA at the exact final SHA with zero P0/P1 before merge.

## Hygiene
Public repository: synthetic data only, `localhost` in demo URLs, no personal paths, hostnames, IPs or secrets.
