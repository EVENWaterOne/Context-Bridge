# Context Bridge · BIT

Context Bridge is a React + TypeScript workbench with a single-user local backend that calls an AI coding agent: the official Codex app-server by default, or Claude Code through the official Claude Agent SDK. It keeps hardware observations, project files, diagnostic proposals and feedback together. The public Vercel build remains an explicitly labelled browser demonstration.

## Run

```sh
npm ci
npm run dev
```

Requires Node.js 24.14+ in the Node 24 release line. Development opens at **http://localhost:5173** with the local API on port 4173. For the complete production workbench run `npm run build` followed by `npm start`, then open **http://localhost:4173**. Windows users can double-click `start-local.cmd`.

Open the connection link in the top banner to choose the AI provider. Diagnosis, review, Apply and Undo work the same way with either one.

- **Connect Codex** (default): choose **Sign in with ChatGPT**, follow the sign-in link and finish the normal login using your own account. This application uses its own `.data/codex` home; credentials are managed by Codex and never sent to the frontend. A compatible Codex entitlement and internet access are required. Model availability comes from the signed-in account.
- **Connect Claude Code**: paste an [Anthropic API key](https://console.anthropic.com/settings/keys) and save it, or start the service with `ANTHROPIC_API_KEY` set. The key is sent only to the local service, stored in `.data/claude/auth.json` (owner-only on macOS and Linux; on Windows it inherits the data folder's permissions, so keep the data folder inside your user profile) and never shown again. Usage is billed to that key. Claude Code runs from the bundled, pinned Agent SDK with an isolated configuration, no tools and no file access.

The choice is saved in the local database. `BRIDGE_PROVIDER=claude` makes Claude Code the default until someone chooses in the workbench. For personal use on your own computer only, `BRIDGE_CLAUDE_LOCAL_LOGIN=1` adds a **Use local Claude Code login** option that reuses the account already signed in to the `claude` command. Anthropic does not allow Claude subscription logins in products offered to other people, so it is off by default and shared or hosted setups should use an API key.

`npm test` runs workflow, API, file-recovery, Codex protocol and Claude Code tests using isolated fixtures and a local stand-in for the Anthropic API, not paid inference. `npm run doctor` checks the installed real Codex and Claude Code processes and their login state without calling a model. `npm run dev:demo` explicitly starts the browser-only demonstration. [本机版使用与接口说明](docs/LOCAL_BACKEND.md) explains setup, migration, cancellation, recovery and the API.

## Local backend v2

- Tasks, files, rounds, chats, jobs and original-byte operation backups are persisted in local SQLite under `.data/` (excluded from Git).
- Import text **copies**, or scan a local project folder and explicitly bind selected **real files**. The UI labels the backing source and lets you exclude individual files from context.
- Diagnosis and Ask BIT call the connected provider (Codex or Claude Code) with selected context only. Diagnosis returns a validated multi-file proposal or questions when information is missing.
- Review the complete before/after text, then confirm Apply. The backend checks the context and source hashes, writes exactly the reviewed contents, and saves a reversible operation. Neither diagnosis nor chat writes your project.
- Undo refuses to overwrite later manual changes or a different project binding. Failed multi-file writes are rolled back; interrupted operations are recovered on startup.
- Motion previews are illustrative. This version does not run project commands, compile/upload firmware, use a serial port or operate hardware.

The service listens only on `127.0.0.1`, with localhost Host/Origin checks and a same-origin session cookie. Keep it local. Do not publish or tunnel this personal backend as a multi-user service.

## Experience

- Public landing page with BIT and the product slogan; demonstration login/registration opens a browser-local workspace. The local backend enters its own saved workbench directly.
- Hidden task sidebar, task search, round history, new/switch task, and context folders.
- Guided hardware assembly (category → base → shoulder → forearm → gripper → connection review) → baseline → observe → request → investigation → review → apply → test → feedback.
- Saving feedback starts the next observation round in the same task. New/switch task enters hardware setup.
- Files can be imported, previewed, removed, downloaded, and exported with a complete task. The demo accepts code/JSON/log/CSV/text files up to 1 MB each.
- Local Apply updates the reviewed task copies or selected real project files; demonstration Apply only updates example browser state. Real hardware is never contacted.
- Local cancellation interrupts the actual Codex turn or Claude Code process; job status and data survive refresh. Demonstration data remains in localStorage; the backend uses a version-2 SQLite envelope around the compatible workspace format.

## Visual fidelity and motion

Palette and layout follow Figma page `04 · BIT / Light Industrial`: #F3F3EF, neutral matte surfaces, yellow human actions, four-color AI accents. Brand and feedback assets are exported directly from the current Figma components.

All BIT routes share the same corrected robot body, upper-right band gap, hollow base rings, materials, and articulated rig. The robot is a shared Three.js solid model with bevelled geometry, matte grey materials, an acrylic light band, neutral studio lighting without a ground shadow, detailed bearing housings, inset arm castings, slotted grippers, a rotary mounting saddle, and a continuous inverse-kinematics rig. The acrylic diffuser distributes purple, cyan, yellow and orange around the rim, using hue-preserving intermediate colors so cyan-to-yellow never turns white. The recessed face is derived from the same inner contour as the diffuser and overlaps beneath its lip to close corner gaps. Both waiting poses turn toward the work at the right front. Their bodies gently follow each reach and placement with a small yaw, lean and float; the first arm joint swivels toward depth-varying tool targets while inverse kinematics preserves exact pickup and placement contacts. Short asymmetric eye blinks use unequal intervals, and all waiting motion shares one periodic clock to avoid a jump at the loop boundary. The matching compatibility videos render at 24 fps. Inspection moves a transparent lens across evidence; construction reaches, grips, lifts, carries, lowers, and releases a block. Browsers without WebGL play a rendered video of the identical geometry and animation. Reduced motion and hidden-tab behavior are supported. The separate hardware arm uses the four-SG90 linkage topology documented below; unmeasured dimensions and unprovided servo calibration remain explicitly illustrative.

Arm previews have their own padded viewport with no negative margins. Joint callouts are projected from the actual animated pivots; compatibility videos use a generated frame track from the identical rig. Labels remain beside their joints and stay inside the model area.

Observation keys support multiple selections, including 1–6 keyboard toggles. Legacy single-choice workspace data is migrated without losing tasks or history. Ask BIT opens a non-modal panel at the right edge, leaving the workbench interactive. Account settings are anchored below the avatar; outside clicks and Escape dismiss them, and settings and chat never overlap. Progress markers use one SVG hexagon with a black face and a step number, with no overlaid square.

Optional offline asset generation: run `python scripts/build-robot-fallbacks.py` from the project root in a Python 3.11 environment with `bpy==4.3.0`, `numpy<2`, Mesa EGL and `ffmpeg`. This exports the same rig, renders compatibility videos, and keeps generated frames in a source-fingerprinted cache. These tools are not required for the web build; fallback assets are included.

## Physical arm profile (v1.3.0)

The owner supplied assembly photos and a product specification on 2026-10-26. Hardware views now use one shared, separate rig (`HardwareArm.ts`), while BIT keeps its established mascot geometry.

| Channel | Motor location | Independent action |
| --- | --- | --- |
| J1 | Inside the stationary pedestal; vertical output axis | Rotate the entire turntable |
| J2 | One side of the shoulder / base; horizontal output axis | Raise / lower the main arm |
| J3 | Opposite shoulder side; coaxial horizontal output | Drive the forearm through the lower crank and rear connecting rod |
| J4 | On the end tool plate | Open / close both geared jaws together |

This is **3 arm DOF + 1 gripper DOF**, using four SG90 servos. Passive elbow and tool pivots are not additional motors. The reference parallelogram, elbow triangle and upper connecting rod carry the base reference to the gripper support, which has no independent pitch or roll control. Rod endpoints share physical axles. Closed linkage lengths and tool leveling are tested throughout the preview envelope.

Confirmed product claims: home envelope 18 × 9.5 × 18 cm, maximum extended length 25 cm, weight 160 g, and “maximum claw opening 180°”. These are not CAD link dimensions or servo calibration values. Model proportions are estimated from photos. The software does **not** interpret the claw-opening claim as 0–180° travel for every servo.

**Still needed for calibrated hardware limits:** per-channel minimum command angle, maximum command angle, neutral / horn zero and direction from the actual controller, plus measured linkage geometry if accurate workspace or collision checking is required. `servoCalibration` starts as `null` per axis; the guided setup accepts user-provided min/max, zero and command direction, or keeps the channel marked “Limits pending”. `servoCommand()` refuses an uncalibrated axis, and clamps calibrated commands with the supplied zero and reversal. `DEMO_POSE_BOUNDS` only bounds drawing-space presentation poses; it must never be sent to the physical controller. No real hardware is connected.

Old arm presets migrate J2 (formerly elbow) → J3 and J3 (formerly wrist / end effector) → J4. Uploaded files and completed round history are retained; only the obsolete sample hardware description is replaced. Examples retain the four-actuator profile. New tasks start with no assembled parts and add that profile one actuator at a time. Existing unrelated task data is preserved.

To rebuild only the hardware compatibility movie and its projected four-motor label track:

```sh
ROBOT_RENDER_MODES=arm python scripts/build-robot-fallbacks.py
```

Assembly topology was cross-checked against [the original EEZYbotARM assembly guide](https://www.instructables.com/EEZYbotARM/) and [the manufacturer's four-servo assembly photos](https://www.xiaodingchui.com/52549). These are structural references, not confirmation of the owner's servo calibration or an assertion of an exact kit identity.

## Guided assembly (v1.4.0)

First-time homepage login / registration and new tasks begin with an empty workbench, one round and no preloaded project files. Returning visitors resume their saved work. The category chooser also shows Mobile robot, Soft robot and Biped robot as disabled “Not in demo” options; only Robot arm is available. Selecting it opens four consecutive actuator forms; only confirming a part reveals its corresponding geometry. Servo model, optional control pin/channel, optional measured angle limits and draft form inputs persist with the task. Duplicate assigned pins, missing calibration fields and inverted limits are rejected; the duplicate check treats `GPIO 18`, `IO18` and `18` as one pin, and `D9`, `Pin 9` and `9` as another. The pin hint follows the chosen controller. Choosing **Arduino Uno (ATmega328P)** adds the board's published facts (memory, pin roles, `analogWrite` frequency, the Servo library's Timer1 conflict, 10-bit `analogRead`, 16-bit `int`, serial auto-reset, USB current limit) to the generated hardware context, so diagnosis does not assume ESP32 behaviour. These describe the board, not the owner's wiring or calibration; other controllers get no such profile. Existing tasks open their saved assembly for inspection rather than rebuilding it.

The current category is explicitly the owner's four-servo linkage arm, not a general-purpose arbitrary robot builder. Completing setup requires all four parts plus controller and connection. It generates a hardware context file while preserving uploaded files. The downstream mock workflow continues to simulate motion without driving physical hardware.

`HardwareArm.ts` assigns meshes to the same four assembly stages; the completed geometry is unchanged. Compatibility stills are rendered from these exact stages, with one fixed camera so parts connect without jumping between views. They are bundled at `public/assets/robot/arm-assembly-1.png` through `arm-assembly-4.png`. To regenerate them, export with `ROBOT_ASSEMBLY_STILLS=1 ROBOT_RENDER_MODES=arm ROBOT_RENDER_CACHE=.render-cache/assembly`, then render those four frames with `scripts/render-robot-fallback.py arm --animation` using the same cache and copy the numbered PNGs. Normal motion exports still generate the complete rig and joint track.

## Agent integration boundary

`server/` implements the local backend. `src/lib/local-api.ts` provides the same-origin client, serialized revision saves and streaming job adapter. `src/lib/backend-types.ts` is the shared API contract. Local mode uses `/api/agent/investigate`, `/api/agent/chat` and `/api/agent/apply` with server-owned task/round/proposal IDs. The original mock and v1 HTTP adapters remain for explicitly selected demonstrations and compatibility tests; local mode never falls back to mocked responses.

Codex runs through the pinned official npm CLI over stdio, using an isolated home, read-only policy and disabled command/external tools. The adapter rejects unexpected tool or approval events. All project writes go through a separate deterministic, user-confirmed file service. [Official Codex app-server documentation](https://learn.chatgpt.com/docs/app-server).

Claude Code runs through the pinned official `@anthropic-ai/claude-agent-sdk` (`server/claude.ts`). Every request disables built-in tools, MCP servers, plugins, settings files, session persistence and `@file` expansion, and uses its own system prompt. Only the structured-output tool is offered when a schema is needed. The adapter checks the reported tools and permission mode, stops on any other tool call, fails within seconds on rejected credentials or billing errors instead of retrying for minutes, turns off Claude Code's refusal retry and fallback model so a declined request is sent once and never answered by a model the user did not choose, and cancels by aborting the process. Inherited `ANTHROPIC_*`/`CLAUDE_*` variables are removed except a few connection settings (Git Bash path, client certificate, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`); API-key mode also uses an isolated `CLAUDE_CONFIG_DIR`, and local-login mode keeps an inherited `CLAUDE_CONFIG_DIR`. Claude Code always adds a short environment note to each request (its working folder, platform, shell, OS version and the date) that a custom system prompt cannot remove; the adapter runs it in an empty temporary folder, which also holds Claude Code's own scratch files and is removed on shutdown, so project and data paths stay out of that note. Requests carry the provider shown on the page, and the service refuses one that another window has since switched away from. Both adapters implement the same `CodexProvider` interface, so jobs, proposals, review, Apply and Undo are shared. [Claude Agent SDK documentation](https://code.claude.com/docs/en/agent-sdk/overview).

There is no remote account system or multi-user synchronization. The public demonstration login never authenticates a backend and never persists passwords.

## Deploy on Vercel

Framework: Vite. Install: `npm ci`. Build: `npm run build`. Output: `dist`.

Import the dedicated `ruizewang875-glitch/Context-Bridge` repository and select its `main` branch. Keep **Root Directory** at the repository root (`./`). The included `vercel.json` configures the Vite build and single-page application routing.

Design source: the project's approved Light Industrial design.
