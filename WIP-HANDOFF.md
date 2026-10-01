# Work in progress — not a release

This branch is a handoff snapshot, refreshed on 2026-10-01 from the most recent local repair tree. It is not a release and nothing here is merged to main. Do not infer release readiness from it.

What this refresh contains: the legacy capped-record restore and re-export repair, the bang-led password redaction repair, and the strict masked-field integrity repair, together with their tests and mutation-control entries.

Evidence so far (focused checks only):
- the four review-round-8 test files (bang values, masked strict, masked equality, legacy cut and forgery: 42 tests) pass under Node v26.8.1;
- the earlier published snapshot failed one of these tests (the bang-value property); this refresh does not;
- type-check, hygiene and public-content scans were clean on the local tree before this refresh.

Still open (incomplete, not waived):
- the full local quality gate, the Node 22.12 floor run, the browser, packaged, PostgreSQL 17, Compose and durability steps, and the full mutation replay have not been run on this tree;
- no independent review of the final repair has been completed;
- documented redaction limits remain (see SECURITY.md and docs/MANIFEST.md);
- the independent human drill (AC-11) has not been done and cannot be certified by an agent.

No deployment or main-branch merge is authorized by this snapshot.
