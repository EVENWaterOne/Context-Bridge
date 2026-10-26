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
- Guided hardware assembly (category → base → shoulder → forearm → gripper → connection review) → baseline → observe → request → investigation → review → apply → test → feedback.
- Saving feedback starts the next observation round in the same task. New/switch task enters hardware setup.
- Files can be imported, previewed, removed, downloaded, and exported with a complete task. The demo accepts code/JSON/log/CSV/text files up to 1 MB each.
- Applying a suggestion updates the example source file in local state. Undo restores the prior parameter. Real hardware is never contacted.
- Cancellation stops mock work, and refreshing interrupted work returns to a retryable screen. Workspace data is versioned and persisted in localStorage.

## Visual fidelity and motion

Palette and layout follow Figma page `04 · BIT / Light Industrial`: #F3F3EF, neutral matte surfaces, yellow human actions, four-color AI accents. Brand and feedback assets are exported directly from the current Figma components.

All BIT routes share the same corrected robot body, upper-right band gap, hollow base rings, materials, and articulated rig. The robot is a shared Three.js solid model with bevelled geometry, matte grey materials, an acrylic light band, neutral studio lighting without a ground shadow, detailed bearing housings, inset arm castings, slotted grippers, a rotary mounting saddle, and a continuous inverse-kinematics rig. The acrylic diffuser distributes purple, cyan, yellow and orange around the rim, using hue-preserving intermediate colors so cyan-to-yellow never turns white. The recessed face is derived from the same inner contour as the diffuser and overlaps beneath its lip to close corner gaps. Both waiting poses turn toward the work at the right front, with an independent rotary arm mount preserving precise tool and block contacts. Inspection moves a transparent lens across evidence; construction reaches, grips, lifts, carries, lowers, and releases a block. Browsers without WebGL play a rendered video of the identical geometry and animation. Reduced motion and hidden-tab behavior are supported. The separate hardware arm uses the four-SG90 linkage topology documented below; unmeasured dimensions and unprovided servo calibration remain explicitly illustrative.

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

New tasks begin with an empty workbench. Selecting the robot-arm category opens four consecutive actuator forms; only confirming a part reveals its corresponding geometry. Servo model, optional control pin/channel, optional measured angle limits and draft form inputs persist with the task. Duplicate assigned pins, missing calibration fields and inverted limits are rejected. Existing tasks open their saved assembly for inspection rather than rebuilding it.

The current category is explicitly the owner's four-servo linkage arm, not a general-purpose arbitrary robot builder. Completing setup requires all four parts plus controller and connection. It generates a hardware context file while preserving uploaded files. The downstream mock workflow continues to simulate motion without driving physical hardware.

`HardwareArm.ts` assigns meshes to the same four assembly stages; the completed geometry is unchanged. Compatibility stills are rendered from these exact stages, with one fixed camera so parts connect without jumping between views. They are bundled at `public/assets/robot/arm-assembly-1.png` through `arm-assembly-4.png`. To regenerate them, export with `ROBOT_ASSEMBLY_STILLS=1 ROBOT_RENDER_MODES=arm ROBOT_RENDER_CACHE=.render-cache/assembly`, then render those four frames with `scripts/render-robot-fallback.py arm --animation` using the same cache and copy the numbered PNGs. Normal motion exports still generate the complete rig and joint track.

## Agent integration boundary

`src/lib/agent.ts` defines `AgentAdapter`, `AgentContext`, progress and cancellation contracts. The default is `mockAgent`. `createHttpAgent('/api/agent')` is available for a future same-origin authenticated backend:

- `POST /api/agent/investigate` → `Suggestion`
- `POST /api/agent/apply` → `ApplyResult`

Request body: `{ version: 1, task, round }`. Keep all provider API keys on the server. The frontend does not include or request API keys. This version does not authenticate remote users, synchronize accounts, or communicate with real hardware; the login form only opens the local demo and never persists passwords.

## Deploy on Vercel

Framework: Vite. Install: `npm ci`. Build: `npm run build`. Output: `dist`.

Import the dedicated `ruizewang875-glitch/Context-Bridge` repository and select its `main` branch. Keep **Root Directory** at the repository root (`./`). The included `vercel.json` configures the Vite build and single-page application routing.

Design source: the project's approved Light Industrial design.
