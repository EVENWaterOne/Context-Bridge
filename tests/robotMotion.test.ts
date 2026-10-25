import test from 'node:test';
import assert from 'node:assert/strict';
import { solveArm, motionPose, BUILD_DURATION, ARM_DURATION } from '../src/components/robotMotion.ts';
test('the shared articulated chain reaches targets with fixed, connected link lengths', () => {
  for (const mode of ['hero', 'inspect', 'build', 'arm'] as const) for (let t = 0; t < 12; t += .04) {
    const pose = motionPose(mode, t), scale = mode === 'arm' ? 1.1 : 1;
    const upper = 1.55 * scale, lower = 1.7 * scale;
    const p = solveArm(pose.x, pose.y - (mode === 'arm' ? .95 : 3.51 + Math.sin(t*.9)*.035), upper, lower);
    const elbow = {x:upper*Math.cos(p.shoulder),y:upper*Math.sin(p.shoulder)};
    const tip = {x:elbow.x+lower*Math.cos(p.shoulder+p.elbow),y:elbow.y+lower*Math.sin(p.shoulder+p.elbow)};
    assert.ok(Math.abs(Math.hypot(elbow.x,elbow.y)-upper)<1e-8);
    assert.ok(Math.abs(Math.hypot(tip.x-elbow.x,tip.y-elbow.y)-lower)<1e-8);
    assert.ok(Math.hypot(tip.x-p.x,tip.y-p.y)<1e-8);
    assert.ok(Math.hypot(p.x-pose.x,p.y-(pose.y-(mode==='arm'?.95:3.51+Math.sin(t*.9)*.035)))<.01, `${mode}: target is outside reach at ${t}`);
  }
});
test('all action loops are continuous and the inspection/build movements cover useful distance', () => {
  for (const [mode,duration] of [['hero',9],['inspect',10],['build',BUILD_DURATION],['arm',ARM_DURATION]] as const) {
    const start=motionPose(mode,0),end=motionPose(mode,duration-.0001);
    assert.ok(Math.hypot(start.x-end.x,start.y-end.y)<.001);
    const poses=Array.from({length:120},(_,i)=>motionPose(mode,i/120*duration));
    const travel=Math.max(...poses.map(p=>p.y))-Math.min(...poses.map(p=>p.y));
    assert.ok(travel>(mode==='hero'?.25:.9));
  }
});
