# Context Bridge · BIT

An interactive React + TypeScript + Vite prototype of the Context Bridge light industrial Figma design.

## Run

```sh
npm ci
npm run dev
```

`npm run build` produces `dist/`. `npm test` runs the workflow and Agent adapter tests.

## Experience

- Public landing page with BIT and the product slogan; login/registration opens a browser-local demonstration workspace.
- Hidden task sidebar, task search, round history, new/switch task, and context folders.
- Hardware setup → baseline → observe → request → investigation → review → apply → test → feedback.
- Saving feedback starts the next observation round in the same task. New/switch task enters hardware setup.
- Files can be imported, previewed, removed, downloaded, and exported with a complete task. The demo accepts code/JSON/log/CSV/text files up to 1 MB each.
- Applying a suggestion updates the example source file in local state. Undo restores the prior parameter. Real hardware is never contacted.
- Cancellation stops mock work, and refreshing interrupted work returns to a retryable screen. Workspace data is versioned and persisted in localStorage.

## Visual fidelity and motion

Palette and layout follow Figma page `04 · BIT / Light Industrial`: #F3F3EF, neutral matte surfaces, yellow human actions, four-color AI accents. Brand and feedback assets are exported directly from the current Figma components.

All BIT routes share the same corrected robot body, upper-right band gap, hollow base rings, materials, and articulated rig. The robot uses layered high-resolution render assets with joint transforms and inverse kinematics. Inspection sweeps a transparent lens; construction reaches, grips, lifts, carries, lowers, and releases a block. These are 2.5D articulated renders, not a freely orbitable WebGL mesh. Reduced motion and hidden-tab behavior are supported.

## Agent integration boundary

`src/lib/agent.ts` defines `AgentAdapter`, `AgentContext`, progress and cancellation contracts. The default is `mockAgent`. `createHttpAgent('/api/agent')` is available for a future same-origin authenticated backend:

- `POST /api/agent/investigate` → `Suggestion`
- `POST /api/agent/apply` → `ApplyResult`

Request body: `{ version: 1, task, round }`. Keep all provider API keys on the server. The frontend does not include or request API keys. This version does not authenticate remote users, synchronize accounts, or communicate with real hardware; the login form only opens the local demo and never persists passwords.

## Deploy on Vercel

Framework: Vite. Install: `npm ci`. Build: `npm run build`. Output: `dist`.

If importing the dedicated `context-bridge-v1` branch of the `daily-focus` repository, set **Root Directory** to `context-bridge` and choose that branch. The original repository root is unrelated and preserved.

Design source: the project's approved Light Industrial design.
