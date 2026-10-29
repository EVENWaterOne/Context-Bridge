# Context Bridge implementation log

## 2026-10-27 — Local Codex backend

### Approved plan

Build a single-user, localhost-only service for the existing React/Vite workbench. Use official Codex app-server over stdio, an isolated Codex home and a normal ChatGPT sign-in. Support imported copies and explicitly linked local projects. Diagnose read-only, review exact multi-file changes, then apply deterministically with hash checks, backups and undo. Persist workspace, conversations, jobs and operations in SQLite. Keep hardware execution and project shell commands outside v1.

### Baseline and sequence

- Repository: `ruizewang875-glitch/Context-Bridge`, baseline `52011533d4ed0b8f17fb02408acca4b05ab35b4e`.
- Branch: `feat/local-codex-backend`; dedicated checkout in `Context-Bridge/`. Existing coursework is untouched.
- Environment verified: Node 24.14.0, npm 11.9.0, Git 2.38.1; native `node:sqlite` works (experimental in this Node release). No Codex CLI found on PATH.
- Sequence: shared API contracts → local store/files/API and Codex provider in parallel with UI → integration and failure/recovery tests → browser checks and real-provider smoke check → documentation.
- Official references: https://learn.chatgpt.com/docs/app-server , https://learn.chatgpt.com/docs/auth , https://learn.chatgpt.com/docs/config-file/config-reference .

### Execution

- Completed read-only repository and environment investigation, then cloned the user-selected repository. Initial sandbox DNS failed; the authorized clone succeeded with network escalation.
- Work is in progress. Validation results and any external authentication limits will be recorded below; simulated-provider tests will not be described as real Codex inference.

### Implemented

- Added Fastify local API, SQLite workspace/revision store, task chats, persistent jobs and operation journal. Loopback binding, same-origin/session guards, non-canonical URL rejection and port-specific cookies protect the API.
- Added pinned Codex 0.164.0 stdio provider, isolated home/config, managed ChatGPT login, dynamic model catalog, output schemas, tool-event rejection, actual turn interruption and bounded child-process shutdown.
- Added selected-file snapshots, imported copies and explicit local-project binding. UTF-8 validation, relative-path identity, excluded secrets/build paths, file-size limits and junction/traversal checks run before context is sent.
- Added full-content multi-file review, server-owned proposals, selected-context/source hash checks, deterministic Apply, original-byte backups, failure rollback, durable recovery and guarded Undo.
- Connected existing UI to the service, with SSE/status recovery, task chat persistence, model/login settings, context checkboxes, project picker, JSON/old-browser migration and revision-conflict recovery drafts.
- Added Windows startup script, developer/doctor scripts, typechecking and Chinese local-backend documentation. Preserved public demonstration and hardware assembly/preview assets.

### Review findings resolved

- No fallback append when a legacy source snippet cannot be matched exactly.
- An external edit to any selected linked evidence invalidates the proposal, including files not being modified.
- Completed/inactive rounds cannot replay an old proposal; rebinding an engineering task prevents Undo from targeting the old root.
- Undo recovery keeps its rollback direction across multiple restarts and external-edit conflicts.
- Decoded/encoded API aliases cannot bypass raw URL session/origin checks.
- Browser QA exposed host-wide cookies colliding across localhost ports. Sessions now include the host/port in their cookie names; a two-instance browser-cookie regression covers this.
- Browser text imports reject malformed UTF-8 rather than silently inserting replacement characters.
- Shutdown interrupts jobs before draining SSE connections; oversized local files are checked before reading them into memory.
- Installation audit found a vulnerable static-file plugin version. Updated the newly introduced plugin to compatible 10.1.7; npm reports zero vulnerabilities after installation.

### Verification evidence

- `npm test`: **89 passed, 0 failed, 0 skipped**. This includes 26 backend integration tests, 19 fake-process Codex protocol tests, revision/client-stream tests, UTF-8 import tests and existing workflow/hardware/geometry tests.
- File-replacement and junction tests were run with normal Windows host permissions. The restricted process sandbox rejected overwrite-rename/junction operations with EPERM; no protection was weakened to accommodate that environment restriction.
- `npm run build`: passed frontend and backend TypeScript checks and Vite production build. The existing Three.js scene chunk still produces a size advisory (about 549 kB before gzip).
- `git diff --check`: passed before final staging.
- `npm run doctor` against the actual official native binary: Node v24.14.0, Codex 0.164.0, `available: true`, `authenticated: false`. This verified process startup, protocol initialization, effective isolated config and clean shutdown; it did not perform inference.
- Browser QA: production local workbench renders; Codex settings report the real CLI; normal sign-in link can be started. The user chose **deliver code now; sign in later**, so no real model call was made.
- Browser QA against an explicitly labelled test-only provider and isolated engineering file: Observe → Request → streamed job → Review → full text diff → Apply → Undo → Ask BIT → reload persisted chat. The physical file stayed `return_duration = 0.6\r\n` before confirmation, became `1.2\r\n` after Apply, and byte equality with the original was `true` after Undo. No hardware was contacted.
- Screenshot evidence: `.test-data/verification/review.png` (isolated fixture, not a real inference). `tests/fixtures/ui-server.ts` reproduces the manual fixture separately from production.

### Delivery and remaining user step

- Local checkout/branch: `Context-Bridge/`, `feat/local-codex-backend`. No remote push or Vercel deployment was performed.
- Open http://localhost:4173 while the service is running; otherwise double-click `start-local.cmd` or run `npm start` after building.
- Use Connect Codex → Sign in with ChatGPT to complete the remaining account connection. Real inference availability and entitlement will be confirmed by the first completed model turn after login.
- This release does not run project shell commands, compile/upload firmware or drive hardware. Previews remain explicitly illustrative.

## 2026-10-29 — Authorized GitHub publication

- User explicitly requested committing and pushing the completed local backend to GitHub.
- Preflight: the 36 implementation/documentation files are staged, there are no unstaged source changes, and the staged whitespace check passes. `.data/`, Codex credentials, local SQLite, screenshots and test runtime artifacts are ignored and are not tracked.
- Publish the implementation from `feat/local-codex-backend` to `origin/feat/local-codex-backend` and verify the remote commit ID after pushing. Existing verification above remains the implementation baseline; this publication step changes only this work record.

### Corrected destination: the user's fork

- Implementation committed as `5287d9f29eb5301732438e99d8528805fa0c6129` (`feat: add local Codex backend and reviewable file workflow`). The first push to the original repository was rejected because the active GitHub account did not have write access; that attempt changed no upstream refs.
- The user then supplied `https://github.com/EVENWaterOne/Context-Bridge`. Verified that this is a fork of `ruizewang875-glitch/Context-Bridge`, with write permission for the active account and no existing `feat/local-codex-backend` branch.
- Local `origin` now points to the user's fork; the original repository is preserved as `upstream`. The publication target is `origin/feat/local-codex-backend`. No source changes or new inference calls were made during this destination correction.

## 2026-10-29 — Merge into the fork's main

- User explicitly requested merging the backend branch into `EVENWaterOne/Context-Bridge` main.
- Merged `feat/local-codex-backend` at `371c955` with the latest fork main at `0ce170a`. Retained the existing body-follow, swivel, natural-blink animations, rendering scripts and fallback media unchanged.
- Resolved package/lock version-only conflicts as `2.0.0`, preserving all backend dependencies and commands.
- Merged result verification: `npm test` passed 90/90 with zero failures/skips; `npm run build` passed frontend/server typechecks and production build; whitespace and package/lock consistency checks passed. No new inference or hardware operation was performed.
