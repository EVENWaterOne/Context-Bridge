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
- Diagnosis and Ask BIT call the connected provider (Codex or Claude Code) with selected context only. Diagnosis returns a validated multi-file proposal by default: when the observation and code point to a plausible cause, BIT proposes the smallest reversible change and lists what is uncertain, because the user's own hardware test is the verification. It is told to ask only for real blockers (no relevant code selected, a physical value such as a servo limit that the context does not give, or a contradiction), at most three questions at a time. When BIT asks, any draft edit it attached is discarded.
- Answer BIT's questions directly on the review page, or leave the answer empty and choose **Propose without answering**. Answers are saved with the round by the service and included in every later diagnosis of that round, even after the observation is revised, and in later rounds that bring the previous round. With history included, the Ask BIT conversation is sent too. An unsent answer is kept when you leave the review page and goes with the next request.
- Before review, the service parses each proposed JSON, JavaScript (`node --check`) and Python (`ast.parse`) file and checks the bracket balance of C/C++ (`.ino`, `.c`, `.cpp`, `.h` …) files. These checks never run or compile project code. If a proposed file fails a check that its current version passes, or the answer cannot be used (for example a proposal that changes nothing), the problem goes back to the provider once, while at least half of the time limit is left. A corrected proposal replaces the first; if the correction fails, the first proposal is kept. A remaining failure is shown in review and the Apply button says so. TypeScript and other file types are listed as not checked.
- Review the complete before/after text, then confirm Apply. The backend checks the context and source hashes, writes exactly the reviewed contents, and saves a reversible operation. Neither diagnosis nor chat writes your project.
- Undo refuses to overwrite later manual changes or a different project binding. Failed multi-file writes are rolled back; interrupted operations are recovered on startup.
- Motion previews are illustrative. In local mode, a task whose controller is an Arduino board and whose sketch folder is linked gets an **Arm** panel (header button next to Ask BIT). It compiles and uploads the linked sketch with `arduino-cli`, shows the sketch's serial output, and sends it short commands: for the bundled arm sketches `x` stops and releases every servo, `g` runs again, `s` prints status. Opening the serial connection holds DTR low, so it does not restart the board. Nothing is uploaded or sent unless you press the button, and an upload asks for confirmation first because the arm moves after it. Configure it with `BRIDGE_ARDUINO_CLI`, `BRIDGE_ARDUINO_CONFIG`, `BRIDGE_ARDUINO_PORT` and `BRIDGE_ARDUINO_FQBN` (see [docs/LOCAL_BACKEND.md](docs/LOCAL_BACKEND.md)); by default arduino-cli is found on PATH or inside an Arduino IDE 2 install, and the one connected board of type `arduino:avr:uno` is used.

The service listens only on `127.0.0.1`, with localhost Host/Origin checks and a same-origin session cookie. Keep it local. Do not publish or tunnel this personal backend as a multi-user service.

## Experience

- Public landing page with BIT and the product slogan; demonstration login/registration opens a browser-local workspace. The local backend enters its own saved workbench directly.
- Hidden task sidebar, task search, round history, new/switch task, and context folders.
- Guided hardware assembly (category → base → shoulder → forearm → gripper → connection review) → baseline → observe → request → investigation → review → apply → test → feedback.
- Saving feedback starts the next observation round in the same task. New/switch task enters hardware setup.
- Files can be imported, previewed, removed, downloaded, and exported with a complete task. The demo accepts code/JSON/log/CSV/text files up to 1 MB each.
- Local Apply updates the reviewed task copies or selected real project files; demonstration Apply only updates example browser state. Undo restores the exact pre-change source file and protects later edits. Real hardware is never contacted.
- Local cancellation interrupts the actual Codex turn or Claude Code process; job status and data survive refresh. Demonstration data remains in localStorage; the backend uses a version-2 SQLite envelope around the compatible workspace format.

## Motion filming scenarios

Open the task sidebar → **Motion examples**. Each option creates a fresh task without replacing existing projects:

- **Steadier motion**: play the initial movement → select **Shaking** and **Smoother motion** → Prepare request → Send to BIT → compare **Before / Proposed** → Apply change → Run → Continue to feedback → Better → next observation round.
- **Slower return**: select **Too fast** and **Slower return**. The reviewed change doubles only `return_duration` (1.5 → 3.0 seconds in the new example); other movements keep their original timing. Existing 0.6 → 1.2 second examples continue to work.

The supplied reference sequence is visually reconstructed as Home → Reach → Grip & pause → Lift & turn → Return & settle (about 9.57 seconds). First run always shows a stable reference of the intended motion, including in the stability example. It does not infer the physical result from the code. Only after the user reports Shaking do the observation replay and Before comparison illustrate joint oscillation; the proposed stable version uses minimum-jerk transitions. The video provides visual poses, not measured servo calibration.

`motion.py`, the hardware configuration, the motion reference and the current round observation travel together in the request. The request viewer uses the same payload as the HTTP adapter, including its previous-round filter. The stability change is `motion_easing = "linear"` → `"minimum_jerk"`; Apply changes the file and playback profile together. Both initial and post-change runs play once, stop, and wait for a manual Continue. Replay never advances the workflow.

## Visual fidelity and motion

Palette and layout follow Figma page `04 · BIT / Light Industrial`: #F3F3EF, neutral matte surfaces, yellow human actions, four-color AI accents. Brand and feedback assets are exported directly from the current Figma components.

All BIT routes share the same corrected robot body, upper-right band gap, hollow base rings, materials, and articulated rig. The robot is a shared Three.js solid model with bevelled geometry, matte grey materials, an acrylic light band, neutral studio lighting without a ground shadow, detailed bearing housings, inset arm castings, slotted grippers, a rotary mounting saddle, and a continuous inverse-kinematics rig. The acrylic diffuser distributes purple, cyan, yellow and orange around the rim, using hue-preserving intermediate colors so cyan-to-yellow never turns white. The recessed face is derived from the same inner contour as the diffuser and overlaps beneath its lip to close corner gaps. Both waiting poses turn toward the work at the right front. Their bodies gently follow each reach and placement with a small yaw, lean and float; the first arm joint swivels toward depth-varying tool targets while inverse kinematics preserves exact pickup and placement contacts. Short asymmetric eye blinks use unequal intervals, and all waiting motion shares one periodic clock to avoid a jump at the loop boundary. The matching compatibility videos render at 24 fps. Inspection moves a transparent lens across evidence; construction reaches, grips, lifts, carries, lowers, and releases a block. Browsers without WebGL play a rendered video of the identical geometry and animation. Reduced motion and hidden-tab behavior are supported. The separate hardware arm uses the four-SG90 linkage topology documented below; unmeasured dimensions and preview poses remain explicitly illustrative, and servo calibration exists only as the by-eye record for the Arduino Uno sketch.

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

**Recorded on the Arduino Uno sketch (2026-10-30, joint limits updated 2026-11-06):** `MEASURED_UNO_ARM` in `src/lib/hardware.ts` holds the owner's arm as driven by `Arduino_Uno_Arm_Test` firmware `ARDUINO_UNO_ARM_V4`. The Uno held one joint at a time and the owner judged the result by eye; no angle was measured with an instrument.

| Channel | Uno pin | Home | Limits | Larger angle | Original ESP32 firmware home |
| --- | --- | --- | --- | --- | --- |
| J1 base | D9 | 90° (faces straight ahead) | 10–170°, hand-tested (it turns 0–180°; this keeps a margin) | Not recorded | 90° |
| J2 shoulder | D10 | 145° (upper arm vertical) | 120–180°, hand-tested | Upper arm tilts forward | 140° |
| J3 forearm | D11 | 100° (137° holds the forearm level) | 68–150°, minimum hand-tested, maximum from the original firmware | Gripper rises | 90° |
| J4 gripper | D12 | 98° (closed) | 98–170°, observed | Jaws open | 0° (range 0–80°) |

The owner hand-tested the limits by eye on 2026-11-06: the shoulder reaches about 120° with the forearm at 95° or above, and the forearm reaches about 68° with the shoulder at 140°. The forearm minimum depends on the shoulder, so the Debug, Show, Pick, Pick_Rough and OneByOne sketches use forearm >= 98 - 1.35 × (shoulder - 120) with a floor of 68°. Only those two points were tested: the line is an estimate, the 68° floor above 140° is untested, and the forearm was only taken to 145°. At 95° and below the gripper clamps and its servo buzzes (stall); 170° is open and 180° looks about the same. The reach / retract coupling copies the original firmware's `robot_back`, whose strict comparisons skip the shoulder on the step where the forearm lands exactly on 90°, so one reach-and-retract across 90° leaves the shoulder 3° higher. These angles are the sketch's command angles (500–2500 µs over 0–180°) and do not apply to other firmware. Choosing Arduino Uno adds this record to the generated context as `measuredArm`. It reaches a task's `servoCalibration` only when **Use recorded limits** is pressed on the setup review step (shown for Arduino Uno); that copies all four channels, which stay editable per part, and the generated note then says they came from `measuredArm`. If the controller is later changed, the note warns that these angles do not carry over.

Old arm presets migrate J2 (formerly elbow) → J3 and J3 (formerly wrist / end effector) → J4. Uploaded files and completed round history are retained; only the obsolete sample hardware description is replaced. Examples retain the four-actuator profile. New tasks start with no assembled parts and add that profile one actuator at a time. Existing unrelated task data is preserved.

To rebuild only the hardware compatibility movie and its projected four-motor label track:

```sh
ROBOT_RENDER_MODES=arm-stable,arm-shaking python scripts/build-robot-fallbacks.py
```

Assembly topology was cross-checked against [the original EEZYbotARM assembly guide](https://www.instructables.com/EEZYbotARM/) and [the manufacturer's four-servo assembly photos](https://www.xiaodingchui.com/52549). These are structural references, not confirmation of the owner's servo calibration or an assertion of an exact kit identity.

## Guided assembly (v1.4.0)

First-time homepage login / registration and new tasks begin with an empty workbench, one round and no preloaded project files. Returning visitors resume their saved work. The category chooser also shows Mobile robot, Soft robot and Biped robot as disabled “Not in demo” options; only Robot arm is available. Selecting it opens four consecutive actuator forms; only confirming a part reveals its corresponding geometry. Servo model, optional control pin/channel, optional measured angle limits and draft form inputs persist with the task. Duplicate assigned pins, missing calibration fields and inverted limits are rejected; the duplicate check treats `GPIO 18`, `IO18` and `18` as one pin, and `D9`, `Pin 9` and `9` as another. The pin hint follows the chosen controller. Choosing **Arduino Uno (ATmega328P)** adds the board's published facts (memory, pin roles, `analogWrite` frequency, the Servo library's Timer1 conflict, 10-bit `analogRead`, 16-bit `int`, serial auto-reset, USB current limit) to the generated hardware context, so diagnosis does not assume ESP32 behaviour. These describe the board, not the owner's wiring or calibration; other controllers get no such profile. The owner's arm on the Uno sketch is added separately as `measuredArm` (see the hardware section above). Existing tasks open their saved assembly for inspection rather than rebuilding it.

The current category is explicitly the owner's four-servo linkage arm, not a general-purpose arbitrary robot builder. Completing setup requires all four parts plus controller and connection. It generates a hardware context file while preserving uploaded files. The downstream mock workflow continues to simulate motion without driving physical hardware.

`HardwareArm.ts` assigns meshes to the same four assembly stages; the completed geometry is unchanged. Compatibility stills are rendered from these exact stages, with one fixed camera so parts connect without jumping between views. They are bundled at `public/assets/robot/arm-assembly-1.png` through `arm-assembly-4.png`. To regenerate them, export with `ROBOT_ASSEMBLY_STILLS=1 ROBOT_RENDER_MODES=arm ROBOT_RENDER_CACHE=.render-cache/assembly`, then render those four frames with `scripts/render-robot-fallback.py arm --animation` using the same cache and copy the numbered PNGs. Normal motion exports still generate the complete rig and joint track.

## Agent integration boundary

`server/` implements the local backend. `src/lib/local-api.ts` provides the same-origin client, serialized revision saves and streaming job adapter. `src/lib/backend-types.ts` is the shared API contract. Local mode uses `/api/agent/investigate`, `/api/agent/chat` and `/api/agent/apply` with server-owned task/round/proposal IDs. The original mock and v1 HTTP adapters remain for explicitly selected demonstrations and compatibility tests; local mode never falls back to mocked responses.

Codex runs through the pinned official npm CLI over stdio, using an isolated home, read-only policy and disabled command/external tools. The adapter rejects unexpected tool or approval events. All project writes go through a separate deterministic, user-confirmed file service. [Official Codex app-server documentation](https://learn.chatgpt.com/docs/app-server).

Preview and Replay only play the browser animation, in both modes. The local application shows no Run button and Preview stays an animation. For an Arduino task, upload and watch the real arm from the Arm panel (the Test page links to it), then choose Continue; any other test you run yourself. Demo mode adds Run, which calls `runMotion`; the default mock simulates execution and reports that no physical hardware moved. A future hardware backend should resolve the request when its run has finished, not merely when it accepts the command. Neither animation completion nor a run result advances the page. Cancellation is passed through `AbortSignal`; a future hardware adapter must implement its own device stop protocol rather than treating an aborted HTTP request as proof that motion stopped.

Claude Code runs through the pinned official `@anthropic-ai/claude-agent-sdk` (`server/claude.ts`). Every request disables built-in tools, MCP servers, plugins, settings files, session persistence and `@file` expansion, and uses its own system prompt. Only the structured-output tool is offered when a schema is needed. The adapter checks the reported tools and permission mode, stops on any other tool call, fails within seconds on rejected credentials or billing errors instead of retrying for minutes, turns off Claude Code's refusal retry and fallback model so a declined request is sent once and never answered by a model the user did not choose, and cancels by aborting the process. Inherited `ANTHROPIC_*`/`CLAUDE_*` variables are removed except a few connection settings (Git Bash path, client certificate, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`); API-key mode also uses an isolated `CLAUDE_CONFIG_DIR`, and local-login mode keeps an inherited `CLAUDE_CONFIG_DIR`. Claude Code always adds a short environment note to each request (its working folder, platform, shell, OS version and the date) that a custom system prompt cannot remove; the adapter runs it in an empty temporary folder, which also holds Claude Code's own scratch files and is removed on shutdown, so project and data paths stay out of that note. Requests carry the provider shown on the page, and the service refuses one that another window has since switched away from. Both adapters implement the same `CodexProvider` interface, so jobs, proposals, review, Apply and Undo are shared. [Claude Agent SDK documentation](https://code.claude.com/docs/en/agent-sdk/overview).

There is no remote account system or multi-user synchronization. The public demonstration login never authenticates a backend and never persists passwords.

## Deploy on Vercel

Framework: Vite. Install: `npm ci`. Build: `npm run build`. Output: `dist`.

Import the dedicated `ruizewang875-glitch/Context-Bridge` repository and select its `main` branch. Keep **Root Directory** at the repository root (`./`). The included `vercel.json` configures the Vite build and single-page application routing.

Design source: the project's approved Light Industrial design.
