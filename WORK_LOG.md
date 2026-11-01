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

## 2026-10-29 — Claude Code as a second AI provider

### Approved plan

The user asked to build the plan from the research thread and open a pull request. Add a `ClaudeProvider` that implements the existing `CodexProvider` interface through the official Claude Agent SDK, so diagnosis, review, Apply and Undo stay shared. Users choose **Connect Codex** or **Connect Claude Code** in the workbench; Codex stays the default and `BRIDGE_PROVIDER` can change that default. An Anthropic API key is the official sign-in. Reusing the local Claude Code login is an opt-in for personal local use only, not a public feature.

### Implemented

- `server/claude.ts`: Agent SDK `query()` adapter pinned to 0.3.312 (bundled Claude Code 2.1.312). Requests run with no built-in tools, MCP servers, plugins, settings sources, session persistence or `@file` expansion, a dedicated system prompt, and the structured-output tool only when a schema is needed. The adapter checks the reported tools and permission mode, rejects any other tool call, fails fast on rejected credentials and billing errors instead of waiting through retries, streams text deltas, enforces an output limit, allows one run at a time and aborts the process on cancel or timeout.
- Credentials: API key from the workbench (stored atomically in `.data/claude/auth.json`, mode 0600 on macOS/Linux, only a short hint returned) or `ANTHROPIC_API_KEY`. Subscription tokens and admin keys are refused with an explanation. Inherited `ANTHROPIC_*`/`CLAUDE_*` variables are removed except a few connection settings (Git Bash path, client certificate, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`); API-key mode uses an isolated `CLAUDE_CONFIG_DIR`, local-login mode keeps an inherited one. Local login requires `BRIDGE_CLAUDE_LOCAL_LOGIN=1`; otherwise the route returns 403 and a saved local-login choice is ignored.
- `server/providers.ts`: `ProviderSwitch` creates providers lazily, keeps the provider captured when a job starts, refuses switching while a job runs, and persists the choice in a new SQLite `preferences` table.
- API: `/api/status` now reports `provider`, `providers` and `agent` (renamed from `codex`); new `POST /api/agent/provider`, `PUT`/`DELETE /api/claude/api-key` and `PUT /api/claude/auth-method`. Job, proposal and error texts name the provider that actually ran.
- Workbench: the connection dialog is now **AI provider**, with provider choice, Claude API key form, the personal-use local-login section when enabled, and a model list remembered per provider. Review labels show which provider produced the diagnosis.
- `npm run doctor` reports both providers without inference.

### Review findings resolved

An independent review covered security, backend, frontend and the SDK contract; each finding was then checked by a separate skeptic. Ten low-severity findings were confirmed (none high or medium) and one was refuted.

- A window still showing the old provider could start a job on the newly selected one with the old provider's model. Job requests now carry the provider shown on the page; a mismatch returns 409 `PROVIDER_CHANGED` and the page refreshes its status. The provider choice is saved before the service switches.
- A status probe could start Claude Code after `close()` if shutdown arrived while the SDK was loading, and a synchronous `query()` failure (missing platform binary) left a 30-second timer running. Both paths are closed and tested.
- Damaged `auth.json`: status now keeps the repair options (paste a key, Remove saved key, local login when enabled), removing or changing the method rewrites the file, and the unrelated "run npm ci" hint is hidden.
- A refused request was reported as an invalid request with the wrong remedy. Claude Code's own explanation is now shown for refusals and other invalid requests.
- Claude Code adds its working folder, git state and OS details to each request, which a custom system prompt cannot remove. Runs now use an empty temporary folder, so project and data paths stay out of it; the docs describe the remaining note.
- `auth.json` is owner-only on macOS and Linux, but on Windows it inherits the data folder's permissions. The docs now say so instead of promising owner-only everywhere; restricting the Windows ACL is left as a follow-up because it cannot be tested here.
- Test gaps: the restart test reused a closed provider and could not detect a no-op key removal; the real-binary test disabled non-essential traffic, which hid a missing `title` option. Restarts now build new providers, and the binary test runs with non-essential traffic enabled (telemetry off, because Claude Code writes it after the test folder is removed) behind a local proxy that refuses every other connection (a mutation run without `title` fails it).
- The selected provider button no longer looks more disabled than the unselected one while a job runs.

A second, independent check confirmed each fix (mutation runs fail the new tests) and found more:

- A refused request made Claude Code resend the full context to the same model and then to an older fallback model, whose answer came back as a normal result. The adapter now sets `CLAUDE_CODE_DISABLE_REFUSAL_RETRY` and `CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK`, and stops the run if a fallback notice still appears. A real-binary test asserts one request and the declined message; it fails when the switches are removed.
- A page loaded before this change sends no provider; such requests are now treated as Codex, the only provider those pages knew.
- The temporary working folder is made again if the system's temp cleaner removed it, and Claude Code's own scratch files (`TMPDIR`/`TMP`/`TEMP`) go in the same folder so nothing accumulates in the system temp folder.
- The real-binary test compared Windows paths against JSON-escaped text; it now compares decoded strings. Several doc statements were corrected (doctor scope, fail-fast timing, environment exceptions, the Windows data-folder example).

### Verification evidence

- `npm test`: 133 passed (90 existing, 33 Claude adapter tests against a scripted SDK, 6 API integration tests through the shared flow, 4 real-binary tests). `npm run build` and `git diff --check` passed.
- `tests/claude-binary.test.ts` runs the real bundled Claude Code binary against a local stand-in for the Messages API with a fake key: exactly one model request, `x-api-key` only, `tools: []`, the system prompt present, an `@path` mention passed verbatim without reading the file, no data-folder path in the request, schema output through StructuredOutput, a refusal sent once with Claude's explanation, a 401 failing in seconds, and cancel ending the process.
- Browser QA on the test-only fixture (port 4175): switching providers, refusing a subscription token, saving a key (input cleared, hint only), per-provider models, banner and review labels, desktop and mobile layout.
- No Anthropic account, real API key or network inference was used. Real Claude Code inference will be confirmed by the first request after a key is added.

## 2026-11-01 — Diagnosis kept asking for more information

### Reported problem

The user reported that work could not move forward: Codex never ran a verification step, and whatever the user said, the agent replied that information was missing and sent the round back.

### Root causes found in the code

- The diagnosis prompt told the model to "explain uncertainty and ask for missing evidence", "never change calibration limits without explicit measured evidence" and, if evidence was insufficient, to return `needs_information`, without saying what counts as insufficient. Every task carries `null` servo calibration and no test results, so a careful model always qualified.
- The model cannot run anything (Codex has no shell tool and a read-only sandbox; Claude Code has no tools), and the prompt never said that the user's hardware test after Apply is the verification. Missing test results therefore read as missing information.
- The user's answers were lost. Revising the observation cleared the questions; a round only reaches `previousRounds` after Apply and feedback; and the Ask BIT conversation was never sent with a diagnosis. The next diagnosis started from the same context and asked again.
- The review page offered no way to answer: Apply was disabled and the only action was Revise observation.
- Small model slips failed the whole diagnosis: a `files/` prefix on a path, an unchanged file among real changes, or questions together with a concrete change.

### Changes

- Diagnosis prompt: a reversible proposal is the default; `needs_information` is reserved for three named blockers; missing calibration alone is not a blocker; the user's test is named as the verification; at most three questions; never repeat an answered one. `proceed` asks for a best-effort proposal. Both provider system prompts say the files are already in the request and no tools are needed.
- Answers: `POST /api/agent/investigate` accepts `answer` and `proceed`. The service records each question set and answer in `round.clarifications` (server-owned like suggestions, kept when the observation is revised, part of the context hash so the resulting proposal stays applicable). The Ask BIT conversation is sent with a diagnosis when the round includes history; it is not hashed, so chatting later does not invalidate a proposal.
- Verification: `server/verify.ts` parses proposed JSON, JavaScript (`node --check`) and Python (`ast.parse`) files in an empty temporary folder with a minimal environment and a 10 s limit, and checks the bracket balance of C/C++ files in process. Nothing from the project is executed or compiled. A file that fails while its current version passes, or an answer the service cannot use, is sent back to the provider once while at least half of the time limit is left. A corrected proposal replaces the first one, even if it still fails (the failure is shown); a failed correction (unusable answer, provider error or time limit) keeps the first proposal. Results are stored as `proposal.checks`.
- Parsing: path spellings are matched only against selected files (an ambiguous spelling is refused), unchanged files are dropped, the model's own outcome stands (a question round discards draft edits; a proposal needs at least one real change, and its questions are shown as things to watch during the test).
- Workbench: the review page shows BIT's questions with an answer box, **Send answers to BIT** or **Propose without answering**, earlier answers of the round, and the automatic checks; Apply reads **Apply despite failed check** when one failed. An unsent answer survives leaving the page and goes with the next request. A review page whose result was invalidated by a context change offers **Send to BIT** instead of an empty page. The request page warns when no code file is selected and says that answers are included.
- `tests/fixtures/ui-server.ts` starts with a question when run with `UI_FIXTURE_QUESTIONS=1`.

Running the project's own commands (tests, `arduino-cli compile`, PlatformIO) was left out on purpose: it would let the local page run programs on the user's computer, and Codex 0.164.0's read-only sandbox cannot limit which files a shell may read. It needs its own decision.

### Review findings resolved

An independent review covered backend correctness, security, the workbench flow and whether the change solves the reported problem; a separate skeptic checked each finding. 23 were confirmed (no high severity) and 5 refuted. Fixed:

- A correction cut off by the job time limit discarded the first, usable proposal and blamed the context size. The time limit now ends only the correction, and a correction starts only while half the limit is left.
- Answers did not reach later rounds; completed rounds now carry their answered questions in `previousRounds`.
- A typed answer was lost when the user went Back, or when a context change emptied the review page. The draft is kept until it is sent, any Send to BIT carries it, and an invalidated review page offers Send to BIT.
- A question round that came with a draft edit was turned into an applicable proposal. The model's own outcome now stands and the draft is discarded. A proposal that changes nothing is sent back for correction instead of being shown as a question round.
- The answer was saved before the request was accepted, retries could save it twice, unanswered question sets grew without a bound (past 50 every workspace save failed), and imported tasks could carry planted answers. Answers are now saved only after the snapshot is written, a repeated answer is recorded once, the list keeps the newest 20, and imports drop recorded answers.
- No context check followed the new check phase; one now runs right before the result is stored. A temporary-folder failure in a check no longer fails the diagnosis.
- `./files/x` could resolve to a different selected file `x`; ambiguous spellings are refused.
- C/C++ firmware had no check at all; a bracket-balance check now covers it. The no-code warning recognises `.mjs`, `.cjs` and `.hpp` and is hidden in the demo. Long paths wrap at 390 px. A double click no longer leaves a stale error.

### Verification evidence

- `npm test`: 152 passed, 0 failed, 0 skipped (133 existing, 7 new check tests, 12 new backend tests; the outside-context test now also covers `files/` and `./` spellings). Mutation runs confirm that removing the conversation hand-off, the server-owned answers, the next-round answers or the time-limit handling fails the new tests.
- `npm run build` passed. This container has Node 22.23 rather than the pinned Node 24; the suite and build ran on 22.23.
- Browser check on the UI fixture with `UI_FIXTURE_QUESTIONS=1` (port 4175, no model): question → answer in Chinese → proposal with "Python syntax passed"; question → **Propose without answering** → proposal; answer typed → Back → Send to BIT (double-clicked) → the answer is recorded once and no error is shown; unchecking a file on the question page → "Ask BIT again" with Send to BIT and the draft kept. Checked at 1360 px and 390 px without horizontal scrolling.
- No real Codex or Claude inference was run; how often a real model now asks questions will show in the user's next sessions.
