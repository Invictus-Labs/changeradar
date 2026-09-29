# ChangeRadar development boundary

- Independent, self-hostable open-source product. Contract: `docs/prd/changeradar.md`.
- Preserve pass/fail/unknown distinctions; uncertainty must never become success.
- No client data, private infrastructure, credentials or real prompts in source, fixtures or logs.
- No mandatory vendor, telemetry, paid provider or private fleet dependency.
- No GitHub Actions workflows. The local gate is `scripts/verify-quality.sh`.
- Work on `codex/` branches; changes reach `main` by pull request after the gate and independent review.
