import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { createRobotModel } from '../src/components/RobotScene.ts';
import { BUILD_DURATION } from '../src/components/robotMotion.ts';

test('turning BIT toward the work preserves exact pickup and placement contacts', () => {
  const model = createRobotModel('build');
  try {
    const position = (name: string) => model.scene.getObjectByName(name)!.getWorldPosition(new Vector3());
    const head = model.scene.getObjectByName('bit-head')!;
    model.update(BUILD_DURATION * .23, 'J2');
    assert.ok(head.rotation.y > .4, 'BIT faces right toward the working area');
    assert.ok(position('block-held').distanceTo(position('block-source')) < .00001);
    model.update(BUILD_DURATION * .72, 'J2');
    assert.ok(position('block-held').distanceTo(position('block-placed')) < .00001);
  } finally { model.dispose(); }
});
