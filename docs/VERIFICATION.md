# Verification record — 2026-10-27

The implemented user story is: local workbench → selected context → local API/SQLite → Codex diagnostic proposal → review → explicit deterministic file application → reversible backup. Chat follows the same context and event flow with read-only output.

| Boundary | Result | Evidence |
| --- | --- | --- |
| Frontend/backend compile | Passed | `npm run build`, frontend and server TypeScript plus Vite |
| Automated tests | Passed | `npm test`: 89 passed, zero failures/skips |
| Localhost/session boundary | Passed | Host/Origin rejection, encoded-path rejection, per-port browser-cookie regression |
| API → SQLite | Passed | Revision conflict, import idempotency, restart, chat and job persistence tests |
| API → physical files | Passed | Selected linked files, original hashes, CRLF, Apply, Undo, external-edit conflict and multi-file rollback/recovery tests |
| Browser → API → file → UI | Passed with test provider | Browser Observe/Request/Review/Apply/Undo; actual isolated file bytes verified after each boundary |
| SSE → browser/chat recovery | Passed | Chunked-stream test plus browser chat/reload check |
| Real Codex process | Passed without inference | Doctor: official 0.164.0, available true, authenticated false; isolated config verified |
| Real model inference | Deferred by user | User chose to log in later; no paid or subscription inference was performed |
| Physical hardware | Outside v1 | No serial, firmware upload, compilation or actuator operation |

The manual browser fixture is `tests/fixtures/ui-server.ts`, uses an explicitly fake account/provider, and runs separately on port 4175. It is never imported by the production service. The proof screenshot is generated at `.test-data/verification/review.png`; that evidence directory is ignored by Git.

On Windows, file-system tests require ordinary host permissions for atomic replacement and junction checks. Restricted sandbox EPERM results were verified as environment restrictions, then the full suite was run successfully with host permissions. No tests were skipped, and safe file operations were retained.

The pinned Node 24.14 runtime emits an experimental warning for its built-in SQLite module. The production build also reports the pre-existing large Three.js scene chunk. Neither warning is a failed check. The dependency installation's final audit reports zero vulnerabilities.

## Claude Code provider — 2026-10-29

| Boundary | Result | Evidence |
| --- | --- | --- |
| Frontend/backend compile | Passed | `npm run build` |
| Automated tests | Passed | `npm test`: 133 passed, zero failures/skips |
| Provider switch and shared flow | Passed with scripted SDK | Diagnose → review → Apply → Undo → chat through Claude Code; switch refused while a job runs; choice survives restart |
| Credential handling | Passed | Key never returned; mode 0600 on macOS/Linux (Windows inherits the data folder ACL); subscription/admin tokens refused; local login 403 unless `BRIDGE_CLAUDE_LOCAL_LOGIN=1` |
| Stale window | Passed | A request naming a provider another window switched away from gets 409 `PROVIDER_CHANGED`; neither provider receives the context |
| Real Claude Code binary | Passed without inference | `tests/claude-binary.test.ts` against a local mock Messages API, with non-essential traffic enabled (telemetry off) and every other connection refused by a local proxy: no tools, no `@file` read, data path absent, exactly one request (a mutation run without `title` fails), a refusal sent once with no retry or fallback model (fails without the switches), 401 failure within seconds, cancel |
| Browser → API → UI | Passed with test provider | Fixture on port 4175: provider choice, key save, model list, review label, mobile layout |
| Real Anthropic inference | Not performed | No Anthropic account or real key was used |

## Diagnosis that moves forward — 2026-11-01

| Boundary | Result | Evidence |
| --- | --- | --- |
| Automated tests | Passed | `npm test`: 152 passed, zero failures/skips (Node 22.23 in the build container) |
| Prompt | Passed | The diagnosis prompt makes a reversible proposal the default, names the three blockers and no longer says "ask for missing evidence" |
| Answers → next diagnosis | Passed | Question recorded with the round; the answer reaches the next prompt and the next round; the resulting proposal applies; a revised observation keeps answers; browser saves and imports cannot plant them; a repeated answer is recorded once; at most 20 question sets per round |
| Conversation → diagnosis | Passed | Ask BIT text reaches the diagnosis with history on, never with "This round only" |
| Automatic checks | Passed | JSON, `node --check`, Python `ast.parse` and C/C++ bracket balance report errors with line numbers; nothing is executed (marker file test); an already-broken file is not blamed; a missing Python is reported |
| Check → correction | Passed with fake provider | A failing file, or a proposal that changes nothing, is sent back once with the problem; a corrected proposal replaces the first (a remaining failure is shown); a correction that fails or hits the time limit keeps the first proposal |
| Browser → API → UI | Passed with test provider | Fixture with `UI_FIXTURE_QUESTIONS=1`: answer flow, "Propose without answering", an unsent answer kept across Back, a context change on the question page, desktop and 390 px |
| Real model inference | Not performed | No real Codex or Anthropic account was used |

## Run code while diagnosing — 2026-11-02

| Boundary | Result | Evidence |
| --- | --- | --- |
| Frontend/backend compile | Passed | `npm run build` |
| Automated tests | Passed | `npm test`, 190 tests (Node 22.23 in the build container, with bubblewrap and socat on PATH so the Claude Code sandbox test ran) |
| Project copy | Passed | Folder name kept; `.env`, `.npmrc`, keys, service-account JSON, `node_modules`, links not copied; `arduino_secrets.h` copied with values emptied and `#include` kept; the selected text is what the agent saw; a selected file replaced by a symlink is refused without being read; every copy removed after the job |
| Verification command | Passed | Runs only once the user saved it (a detected command is a suggestion); runs inside `codex sandbox` from the pinned binary: Node output and exit code come back, a write outside the folder fails, a connection to a local port fails; before and after on exactly the proposed text; a change that breaks it goes back once in the same copy; with no sandbox it does not run (the job says so); a missing tool or pytest is "unavailable"; time limit kills the process tree; a leftover background process does not hold the result; model keys removed; no U+FFFD at the UTF-8 cut |
| Settings | Passed | Only `PUT /api/tasks/:id/execution` changes run mode; workspace saves and imports cannot; bad commands are refused; detection: PlatformIO uses `-t checkprogsize`, pytest needs its configuration or `import pytest`, the Arduino sketch holding a selected file is preferred, library examples and shell-unsafe folder names are skipped |
| Real Codex 0.164.0 binary | Passed with a local mock model | `tests/backend.test.ts`: two real commands ran in the copy and their output reached the mock, `apply_patch` edited the copy and became the proposal, a write to the real project was refused (read-only file system), a connection to the mock's port from a command failed (EPERM), verification passed before and after, Apply wrote the reviewed text |
| Real Claude Code 2.1.312 binary | Passed with a local mock model | `tests/claude-binary.test.ts` with bubblewrap and socat extracted to a scratch folder on PATH: commands ran in the copy, Edit changed the copy, writes to the real project (EROFS) and the network were blocked, saved keys in the data folder were unreadable, `ANTHROPIC_API_KEY` was absent from commands, Write and Read outside the copy were refused |
| Browser → API → UI | Passed with test provider | Fixture on port 4175 (`UI_FIXTURE_PACE` slows it for screenshots): run-code card suggests `npm test` and runs nothing until **Use this command**; with `UI_FIXTURE_SANDBOX=0` the card says the agent cannot run commands and that without a command the request works like Read only; the request preview says the agent can read the whole copied folder; live command list while running, review page with before/after results and the command list, 1360 px and 390 px without horizontal scrolling |
| Windows and macOS sandboxes | Not tested | Codex's `unelevated` Windows sandbox (for the agent and for the verification command), the macOS sandboxes and Claude Code's Windows behaviour were not run on those systems |
| arduino-cli / PlatformIO builds | Not tested | Neither tool was installed here; their builds inside the sandbox (no network, caches redirected to the check folder) are untested |
| Real model inference | Not performed | No real Codex or Anthropic account was used |
