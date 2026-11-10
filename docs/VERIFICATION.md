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

## Arm panel: upload and serial — 2026-11-10

| Boundary | Result | Evidence |
| --- | --- | --- |
| Frontend/backend compile | Passed | `npm run build` |
| Automated tests | Passed | `npm test`: 204 passed. `tests/arduino.test.ts` (23 tests) drives the service with fake arduino-cli and serial-bridge processes: compile then upload arguments, Stop available while compiling, `x` sent before flashing, upload then reconnect, failed compile leaves the board alone, concurrent connects share one bridge, a connection closed while starting, busy port, open timeout, bridge failing later, sending to a dead bridge, shutdown during an upload, port detection, route checks (non-Arduino task, folder without a matching `.ino`, no session), SSE start and shutdown, GBK system messages. An adversarial review (3 lenses, each finding re-checked) found 15 real issues; all were fixed before the second hardware round |
| Real arduino-cli compile | Passed without a board | Browser → Upload with `BRIDGE_ARDUINO_PORT=COM99`: the linked sketch compiled, avrdude then failed on the missing port and the panel reported it |
| Real serial bridge | Passed without a board | Connect on COM99 reported the Windows reason (the port does not exist) |
| Physical board: connect | Passed, owner watching | Arduino Uno on COM14 (found by `board list`) running the arm demo sketch, Windows. Connect at 17:44: the owner saw no movement, so opening the port did not reset the board; with live reads, no READY line followed and `s` got its STATUS line back at once |
| Physical board: upload, stop, run | Passed, owner watching | Upload from the panel compiled and flashed the linked sketch (7714 bytes), the connection reopened by itself and showed STEP 1–8 live; Stop sent `x` and the sketch answered RELEASED / ABORTED within 50 ms; `g` then ran all 20 steps to DONE. The owner confirmed on the arm: it ran, stopped at once and went limp on Stop, and ran a full pass on `g` |
| Physical board: reviewed upload flow | Passed, owner watching | After the review fixes (17:56): the connection stayed open while compiling, `x` went out before flashing (the sketch answered RELEASED), the upload finished and the connection reopened 3.7 s later, the arm ran, and the header Stop button sent `x` at STEP 8 with RELEASED / ABORTED in the same instant. The owner confirmed it on the arm. A restart of the service while connected (process killed) did not reset the board |
| Known artefact | Harmless for this sketch | When the port opens, the Uno receives a few garbage bytes (the sketch prints `UNKNOWN ����` and ignores them). It happens before anything is sent and does not run a command. Boot text from the two resets avrdude causes during an upload arrives buffered right after the connection reopens |

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
