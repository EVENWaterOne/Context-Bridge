export type MotionMode = 'hero' | 'inspect' | 'build' | 'arm';
export interface Pose { x: number; y: number; open: number; phase: string }
type Key = readonly [time: number, x: number, y: number, open: number];
export const BUILD_DURATION = 12;
export const INSPECT_DURATION = 10;
export const ARM_DURATION = 7.2;
export const smooth = (t: number) => { const k = Math.max(0, Math.min(1, t)); return k * k * k * (k * (k * 6 - 15) + 10); };
export const mix = (a: number, b: number, t: number) => a + (b - a) * t;
/** Zero velocity and acceleration at the waypoints keeps grip/release deliberate. */
export function sampleKeys(keys: readonly Key[], t: number) {
  let i = 0;
  while (i < keys.length - 2 && t > keys[i + 1][0]) i++;
  const a = keys[i], b = keys[i + 1], k = smooth((t - a[0]) / (b[0] - a[0]));
  return { x: mix(a[1], b[1], k), y: mix(a[2], b[2], k), open: mix(a[3], b[3], k) };
}
const buildKeys: readonly Key[] = [
  [0, 1.8, 3.65, 1], [.16, 2.62, 1.83, 1], [.23, 2.62, 1.83, 0],
  [.41, 2.35, 3.9, 0], [.56, 1.9, 3.65, 0], [.72, 1.9, 2.56, 0],
  [.79, 1.9, 2.56, 1], [.88, 1.8, 3.65, 1], [1, 1.8, 3.65, 1],
];
const inspectKeys: readonly Key[] = [
  [0, 2.0, 3.1, 0], [.22, 2.65, 2.34, 0], [.44, 2.15, 1.86, 0],
  [.65, 1.8, 2.6, 0], [.82, 2.4, 3.0, 0], [1, 2.0, 3.1, 0],
];
const armKeys: readonly Key[] = [
  [0, 1.38, 2.5, .55], [.12, 1.38, 2.5, .55], [.40, 2.45, 1.15, 1],
  [.52, 2.45, 1.15, 0], [.69, 2.05, 2.8, 0], [.90, 1.38, 2.5, .55], [1, 1.38, 2.5, .55],
];
export function motionPose(mode: MotionMode, seconds: number): Pose {
  if (mode === 'build') {
    const t = (seconds % BUILD_DURATION) / BUILD_DURATION;
    return { ...sampleKeys(buildKeys, t), phase: t < .16 ? 'Reaching for a block' : t < .23 ? 'Closing the gripper' : t < .41 ? 'Lifting the change' : t < .56 ? 'Moving into position' : t < .72 ? 'Placing it carefully' : t < .79 ? 'Releasing the block' : 'Ready for the next piece' };
  }
  if (mode === 'inspect') return { ...sampleKeys(inspectKeys, (seconds % INSPECT_DURATION) / INSPECT_DURATION), phase: 'Looking through your evidence' };
  if (mode === 'arm') return { ...sampleKeys(armKeys, (seconds % ARM_DURATION) / ARM_DURATION), phase: 'Reach · pause · return' };
  const t = (seconds % 9) / 9;
  return { ...sampleKeys([[0,-1.15,4.65,.72],[.25,-1.35,4.78,1],[.38,-1.18,4.91,.30],[.50,-1.35,4.78,1],[.65,-.95,4.58,.60],[1,-1.15,4.65,.72]], t), phase: 'Ready to build with you' };
}

type WaitingMode = 'inspect' | 'build';
// Time, body yaw, sideways lean, tool depth. These follow the work rather than
// adding unrelated idle wiggles. Depth is zero throughout pickup and release.
type FollowKey = readonly [number, number, number, number];
const followKeys: Record<WaitingMode, readonly FollowKey[]> = {
  inspect: [
    [0, .48, -.03, .16], [.22, .64, .05, -.14], [.44, .61, .03, .20],
    [.65, .43, -.045, .30], [.82, .55, .025, -.05], [1, .48, -.03, .16],
  ],
  build: [
    [0, .47, -.025, 0], [.16, .62, .055, 0], [.23, .62, .055, 0],
    [.41, .58, .025, .32], [.56, .48, -.025, .25], [.72, .48, -.025, 0],
    [.79, .48, -.025, 0], [.88, .44, -.045, 0], [1, .47, -.025, 0],
  ],
};

/** Short, asymmetric blinks with unequal gaps, repeated on the action's own clock. */
export function waitingBlink(mode: WaitingMode, seconds: number) {
  const duration = mode === 'inspect' ? INSPECT_DURATION : BUILD_DURATION;
  const t = ((seconds % duration) + duration) % duration;
  const starts = mode === 'inspect' ? [1.05, 4.35, 8.2] : [1.15, 5.1, 9.65];
  for (const start of starts) {
    const dt = t - start;
    if (dt >= 0 && dt < .09) return mix(1, .075, smooth(dt / .09));
    if (dt >= .09 && dt < .135) return .075;
    if (dt >= .135 && dt < .30) return mix(.075, 1, smooth((dt - .135) / .165));
  }
  return 1;
}

/** Secondary motion stays periodic so live 3D and rendered video loop identically. */
export function waitingMotion(mode: WaitingMode, seconds: number) {
  const duration = mode === 'inspect' ? INSPECT_DURATION : BUILD_DURATION;
  const t = ((seconds % duration) + duration) % duration / duration, cycle = t * Math.PI * 2;
  const keys = followKeys[mode];
  let i = 0;
  while (i < keys.length - 2 && t > keys[i + 1][0]) i++;
  const a = keys[i], b = keys[i + 1], k = smooth((t - a[0]) / (b[0] - a[0]));
  return {
    bodyYaw: mix(a[1], b[1], k), bodyX: mix(a[2], b[2], k),
    bodyLift: Math.sin(cycle) * .065 + Math.sin(cycle * 2) * .012,
    toolDepth: mix(a[3], b[3], k), cycle,
    wristTilt: mode === 'inspect' ? Math.sin(cycle + .25) * .12 : 0,
    lensYaw: mode === 'inspect' ? Math.sin(cycle - .3) * .13 : 0,
    blink: waitingBlink(mode, seconds),
  };
}
/** A physical two-link chain: both links always share the same elbow pivot. */
export function solveArm(x: number, y: number, upper: number, lower: number, bend: -1 | 1 = -1) {
  const d = Math.hypot(x, y), distance = Math.max(Math.abs(upper - lower) + .001, Math.min(upper + lower - .001, d));
  const direction = Math.atan2(y, x);
  const elbow = bend * Math.acos(Math.max(-1, Math.min(1, (distance * distance - upper * upper - lower * lower) / (2 * upper * lower))));
  const shoulder = direction - Math.atan2(lower * Math.sin(elbow), upper + lower * Math.cos(elbow));
  return { shoulder, elbow, x: Math.cos(direction) * distance, y: Math.sin(direction) * distance };
}
