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
| Automated tests | Passed | `npm test`: 147 passed, zero failures/skips (Node 22.23 in the build container) |
| Prompt | Passed | The diagnosis prompt makes a reversible proposal the default, names the three blockers and no longer says "ask for missing evidence" |
| Answers → next diagnosis | Passed | Question recorded with the round; the answer reaches the next prompt; the resulting proposal applies; a revised observation keeps answers; browser saves cannot rewrite them |
| Conversation → diagnosis | Passed | Ask BIT text reaches the diagnosis with history on, never with "This round only" |
| Automatic checks | Passed | JSON, `node --check` and Python `ast.parse` report errors with line numbers; nothing is executed (marker file test); an already-broken file is not blamed; a missing Python is reported |
| Check → correction | Passed with fake provider | A failing file is sent back once with the error; the corrected proposal shows "passed"; a second failure or a failed correction keeps the first proposal with the failure shown |
| Browser → API → UI | Passed with test provider | Fixture with `UI_FIXTURE_QUESTIONS=1`: answer flow and "Propose without answering", desktop and 390 px |
| Real model inference | Not performed | No real Codex or Anthropic account was used |
