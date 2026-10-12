# Contributing to ChangeRadar

Thank you for looking. A few rules keep the product honest.

## Ground rules

- **Uncertainty never becomes success.** Unknown, stale, partial, deferred and incomplete states stay visible and never pass a check, a gate or a verdict. A change that turns an unknown into a pass will not be merged.
- **Standalone and offline.** No mandatory account, license server, telemetry, paid provider or outbound network access in the deterministic core.
- **Synthetic data only.** No real customer data, hostnames, IP addresses, personal paths, emails or credentials in source, fixtures, docs, logs or test output. Demo URLs use `localhost`. Planted fake secrets are assembled at runtime from fragments (see `tests/helpers/fake-secrets.ts`).
- **No GitHub Actions.** The release gate is local: `bash scripts/verify-quality.sh`.

## Setup

```bash
node -v                    # 22.12 or newer (the runtime floor, checked by scripts/node-floor-gate.sh; some development dependencies declare a newer minimum, so `npm ci` on 22.12 prints EBADENGINE warnings for the test tooling only)
npm ci
npm run build
```

Dependencies are pinned to exact versions. A new dependency needs a permissive license (`node scripts/dependency-licenses.mjs` regenerates `docs/DEPENDENCY-LICENSES.md` and fails on a non-permissive one) and a reason.

## Making a change

1. Branch from `main` (no branch naming convention is required) and keep commits small.
2. Write the test first or with the change. Behavior tests go through the real API and real persistence (`tests/integration`); pure decision rules are unit tests (`tests/unit`); UI tests are in `tests/web`; browser and packaged end-to-end tests are in `tests/e2e`. `tests/changeradar.spec.ts` is the acceptance suite indexed by the PRD flows: a new behavior that belongs to a flow belongs there too. Do not mock a route for an API-backed page.
3. Run the fast checks while you work: `npm run typecheck`, `npx vitest run <file>`, `npm run test:web`.
4. Before you open a pull request run the whole gate: `bash scripts/verify-quality.sh`. It needs Docker (a throwaway PostgreSQL 17 container) and Chromium (`npx playwright install chromium`); `CR_SKIP=pg17,browser` skips them and the verdict then says `GREEN WITH SKIPS`, which is not enough to merge.
5. Coverage is at least 90% lines and branches on decision and service code and the gate enforces it, but coverage is supporting evidence, not a substitute for a test that names the behavior.
6. If you change a safety property (authorization, workspace scoping, CSRF, baseline 409, egress rules, lease fencing, bundle verification, readiness, limits, escaping), add or keep a seeded mutation control in `scripts/mutation-controls.mjs` (server) or `scripts/web-mutation-controls.mjs` (web) that fails when the property is removed.
7. Update `docs/qa/ac-matrix.md` when a criterion's evidence changes: name real test ids and give a truthful status. PASS means it ran and passed.

## Pull requests

Describe what changed, why, and how you verified it (commands and results). Do not include secrets or personal paths in the description. `main` is protected: changes arrive by pull request after the gate and a review.

## Security

Report vulnerabilities privately (see `SECURITY.md`), not in public issues.
