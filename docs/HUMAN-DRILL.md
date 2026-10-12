# Independent human drill (AC-11): record sheet

**This sheet is the only thing that can close AC-11.** No automated run, no agent run and no builder run counts. Until a person who did not build ChangeRadar completes this drill and the receipt below is filed, AC-11 stays `PENDING_HUMAN_RECEIPT` in `docs/qa/ac-matrix.md`. There is no waiver.

The drill: a fresh operator follows `docs/RUNBOOK-SMOKE.md`, command for command, on a clean machine with synthetic data, and records everything below. About 15 minutes.

## Who may do it

Someone who took no part in writing or reviewing ChangeRadar and has not run the runbook before. They may not ask the builders for help; if they need help anyway, that is recorded as assistance (below) and the drill is judged on how much was needed.

## What the maintainer must provide (and what makes a drill not count)

The maintainer, not the operator and not a builder, prepares the material, from the FINAL revision only:

1. **The package file.** `changeradar-<version>.tgz`, built by the maintainer with `npm ci && npm run build && npm pack` from a clean checkout of the final commit (a clean tree matters: the package records whether it was built dirty).
2. **The final commit.** The full 40-character hash of that commit, given as text.
3. **The checksum.** The tarball's sha256 (`shasum -a 256 <file>`), computed by the maintainer and delivered to the operator by a different route than the file itself (for example the file by download and the checksum by message), so a swapped file cannot carry its own checksum.

**A drill counts only if all of these hold, and a receipt that fails any of them is filed as invalid:**

- The commit the package reports (`changeradar version`, step 1 of the runbook) is exactly the final commit the maintainer named, and it does not say `dirty` or `unknown`.
- The operator verified the checksum before installing (`shasum -a 256 -c`, see "Before you start" in the runbook) and it printed `OK`.
- The final commit is the commit that received independent code review and QA and the full gate. **A drill on any other revision does not count, including a later commit that only changes documents:** a docs-only difference still changes what the operator reads, so the drill is repeated on the final one. Rule for the maintainer: publish exactly the gated and drilled SHA. If a docs-only evidence commit (receipts under `docs/qa/`) is added afterwards, the drilled package must be built from a tree in which every file the operator reads (`README.md`, `docs/RUNBOOK-SMOKE.md`, `docs/HUMAN-DRILL.md`, `docs/OPERATIONS.md`) is byte for byte identical to the published SHA, and the receipt says which files differ; otherwise the drill is repeated.
- The whole terminal transcript is kept (see below).

## Prerequisites

- A machine (laptop, VM or container) with Node.js 22.12 or newer, `npm`, `curl` and a POSIX shell, and no existing ChangeRadar install or data.
- The package file, the final commit hash and the checksum from the maintainer (above).
- Nothing else: no account, no license, no network access beyond `npm install` fetching the package's dependencies.

## Steps

1. Start recording the terminal (for example `script -q drill-transcript.txt`) and note the start time in UTC (`date -u`).
2. Set `CHANGERADAR_TARBALL` and verify the checksum as the runbook's "Before you start" section says. Stop if `shasum` does not print `OK`.
3. Open `docs/RUNBOOK-SMOKE.md` (it ships inside the package) and run its 13 steps in order in the same shell. Each step says what the output must contain. Step 1 prints `changeradar 0.1.0 commit <hash>`: compare that hash with the maintainer's.
4. After step 4, open the address printed by your `CHANGERADAR_PORT` (default `http://localhost:8797/`) in a browser, sign in with the email and password from step 3, and look at the Snapshots and Impact runs pages. Record anything confusing.
5. Finish with step 13 (clean up), stop the recording, then note the end time in UTC.

## What to record

| Item | Record |
| --- | --- |
| Your name or handle, role, and how you relate to the project (must not be a builder or reviewer) | |
| Start time and end time, both UTC (`date -u`) | |
| **Source commit** the package reports (`changeradar version`, 40 characters, no `dirty`) and the commit the maintainer named: identical? | |
| **Checksum**: the sha256 you were given, and the result of `shasum -a 256 -c` (must be `OK`) | |
| Machine (OS and version, CPU architecture), Node.js version (`node -v`), `npm -v` | |
| Every piece of assistance you received or looked up (who, what, when, in what channel), or "none" | |
| For each of the 13 steps: done as written / done with a change (what) / failed (output) / skipped (why) | |
| Anything in the documents that was wrong, missing or unclear | |
| Anything in the browser that was wrong, missing or unclear | |
| Cleanup receipt: after step 13, `ls "$SMOKE_DIR"` fails (directory gone), no `changeradar` process is running (`ps` or `pgrep -f changeradar`), and nothing is listening on your `CHANGERADAR_PORT` | |
| **Transcript retention**: the complete terminal transcript file name, its sha256, and the channel it was sent through (it goes to the maintainer together with this sheet) | |
| Your conclusion: could a fresh operator install, run and back up ChangeRadar from these documents alone? Yes / No / Yes with help | |

Do not paste passwords, encryption keys or file contents from your own systems into the receipt. The synthetic password printed in step 3 is single-use test data, and it will appear in the transcript; that is fine, but do not run the drill on a machine or in a session whose transcript would show anything else private.

## Where to send it

Return the completed sheet and the transcript, unedited, to the maintainer who asked you to run the drill, for example as a pull request that adds them as `docs/qa/human-drill-receipt-<UTC date>.md` and `docs/qa/human-drill-transcript-<UTC date>.txt`, or in the channel the maintainer named. The maintainer keeps the transcript for as long as the receipt is cited, files the sheet next to `docs/qa/ac-matrix.md`, and only then may change AC-11. A receipt that lists assistance is still valid evidence; it is judged on the assistance listed, and a receipt from a builder is not valid.

## What this drill does not show

It does not show that ChangeRadar knows your real dependencies: it knows only what manifests declare, manifests go stale, and static declarations cannot establish what happens at runtime. It uses synthetic data on one machine and is not a load, security or upgrade test.
