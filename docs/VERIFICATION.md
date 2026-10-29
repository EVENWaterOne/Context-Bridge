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
