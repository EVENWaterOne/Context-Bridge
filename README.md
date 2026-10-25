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

All BIT routes share the same corrected robot body, upper-right band gap, hollow base rings, materials, and articulated rig. The robot is a shared Three.js solid model with bevelled geometry, matte grey materials, an acrylic light band, neutral studio lighting, and a continuous inverse-kinematics rig. Inspection moves a transparent lens across evidence; construction reaches, grips, lifts, carries, lowers, and releases a block. Browsers without WebGL play a rendered video of the identical geometry and animation. Reduced motion and hidden-tab behavior are supported. The arm preview is illustrative, not a hardware-specific digital twin.

Observation keys support multiple selections, including 1–6 keyboard toggles. Legacy single-choice workspace data is migrated without losing tasks or history. Ask BIT opens a non-modal panel at the right edge, leaving the workbench interactive. Progress markers use one SVG hexagon with a black face and a step number, with no overlaid square.

Optional offline asset generation: `node --experimental-strip-types scripts/export-robot-scenes.mjs`, then run `scripts/render-robot-fallback.py` in a Python 3.11 environment with `bpy==4.3.0` and `numpy<2`. These tools are not required for the web build; fallback assets are included.

## Agent integration boundary

`src/lib/agent.ts` defines `AgentAdapter`, `AgentContext`, progress and cancellation contracts. The default is `mockAgent`. `createHttpAgent('/api/agent')` is available for a future same-origin authenticated backend:

- `POST /api/agent/investigate` → `Suggestion`
- `POST /api/agent/apply` → `ApplyResult`

Request body: `{ version: 1, task, round }`. Keep all provider API keys on the server. The frontend does not include or request API keys. This version does not authenticate remote users, synchronize accounts, or communicate with real hardware; the login form only opens the local demo and never persists passwords.

## Deploy on Vercel

Framework: Vite. Install: `npm ci`. Build: `npm run build`. Output: `dist`.

Import the dedicated `ruizewang875-glitch/Context-Bridge` repository and select its `main` branch. Keep **Root Directory** at the repository root (`./`). The included `vercel.json` configures the Vite build and single-page application routing.

Design source: the project's approved Light Industrial design.
