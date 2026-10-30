import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { ARM_DIMENSIONS as d, hardwareMotion, linkagePose } from '../src/components/hardwareKinematics.ts';
import { createRobotModel } from '../src/components/RobotScene.ts';
import { pendingCalibration, pinPlaceholder, servoCommand, hardwareDescription } from '../src/lib/hardware.ts';
import { createExampleWorkspace, loadWorkspace, getActiveTask, makeFile, updateHardware } from '../src/lib/workflow.ts';
const distance=(a:{x:number;y:number},b:{x:number;y:number})=>Math.hypot(a.x-b.x,a.y-b.y);
const near=(a:number,b:number)=>assert.ok(Math.abs(a-b)<1e-9,`${a} != ${b}`);

test('all three closed linkage loops retain rigid lengths throughout the pose envelope',()=>{
  for(const shoulder of [55,65,82,100,108])for(const forearm of [-32,-24,0,13,24]){
    const k=linkagePose({yaw:0,shoulder,forearm,grip:.5});
    for(const [a,b,length] of [[k.A,k.B,d.upper],[k.D,k.C,d.upper],[k.A,k.D,d.driveCrank],[k.B,k.C,d.driveCrank],[k.F,k.G,d.upper],[k.A,k.F,d.referenceOffset],[k.B,k.G,d.referenceOffset],[k.B,k.E,d.forearm],[k.H,k.I,d.forearm],[k.B,k.H,d.toolBracket],[k.E,k.I,d.toolBracket]] as const)near(distance(a,b),length);
    near(k.I.x,k.E.x);near(k.toolPitch,0);
  }
});
test('forearm and shoulder are independent drives, while wrist and both jaws are coupled',()=>{
  const a=linkagePose({yaw:0,shoulder:80,forearm:0,grip:.4});
  const b=linkagePose({yaw:0,shoulder:80,forearm:20,grip:.8});
  assert.deepEqual(a.B,b.B);assert.notDeepEqual(a.E,b.E);
  const c=linkagePose({yaw:0,shoulder:100,forearm:0,grip:.4});
  near(a.E.y-a.B.y,c.E.y-c.B.y);near(a.E.x-a.B.x,c.E.x-c.B.x);
  near(b.jawAngles[0],-b.jawAngles[1]);near(b.toolPitch,a.toolPitch);
});
test('the hardware rig contains exactly four motors and a mechanically leveled tool',()=>{
  const m=createRobotModel('arm');try{
    const motors:string[]=[];m.scene.traverse(o=>{if(o.name.startsWith('hardware-servo-'))motors.push(o.name);});
    assert.deepEqual(motors.sort(),['hardware-servo-J1','hardware-servo-J2','hardware-servo-J3','hardware-servo-J4']);
    for(let t=0;t<=7.2;t+=.12){m.update(t,'J4');assert.equal(m.jointAnchors.length,4);
      const tool=m.scene.getObjectByName('hardware-passive-tool-mount')!;
      const y=new Vector3(0,1,0).transformDirection(tool.matrixWorld);near(y.y,1);
    }
    assert.deepEqual(hardwareMotion(0),hardwareMotion(7.2));
  }finally{m.dispose();}
});
test('unprovided servo limits are never guessed; calibrated commands respect range, zero and reversal',()=>{
  const limits=pendingCalibration();assert.throws(()=>servoCommand('J1',0,limits),/calibration/);
  limits.J1={min:32,max:147,zero:88,direction:-1};
  near(servoCommand('J1',12,limits),76);near(servoCommand('J1',200,limits),32);near(servoCommand('J1',-200,limits),147);
  assert.throws(()=>servoCommand('J1',NaN,limits));
  limits.J2={min:90,max:30,zero:60,direction:1};assert.throws(()=>servoCommand('J2',0,limits));
  const description=hardwareDescription();assert.equal(description.servoCount,4);assert.equal(description.independentWrist,false);
  assert.deepEqual(description.servoCalibration,pendingCalibration());
});
test('old arm presets migrate to four channels without losing uploaded files or previous rounds',()=>{
  const old=createExampleWorkspace(),arm=getActiveTask(old);delete arm.hardware.profile;delete arm.hardware.servoCalibration;
  arm.rounds[0].observation.joint='J2';arm.rounds[1].observation.joint='J3';
  const uploaded=makeFile('calibration.json','{"J4":{"min":30,"max":120}}','hardware');arm.files.push(uploaded);
  const migrated=getActiveTask(loadWorkspace({getItem:()=>JSON.stringify(old),setItem:()=>{}}));
  assert.equal(migrated.rounds[0].observation.joint,'J3');assert.equal(migrated.rounds[1].observation.joint,'J4');
  assert.equal(migrated.rounds.length,arm.rounds.length);assert.deepEqual(migrated.files.find(f=>f.id===uploaded.id),uploaded);
  assert.deepEqual(migrated.hardware.servoCalibration,pendingCalibration());
});

test('controller changes update generated context while retaining user hardware files',()=>{
 const initial=createExampleWorkspace();const userFile=makeFile('my-hardware.json','original','hardware');getActiveTask(initial).files.push(userFile);
 const task=getActiveTask(updateHardware(initial,{controller:'STM32F103C8T6'}));
 assert.equal(JSON.parse(task.files.find(f=>f.name==='hardware.json')!.content).controller,task.hardware.controller);
 assert.deepEqual(task.files.find(f=>f.id===userFile.id),userFile);
});
test('choosing Arduino Uno puts its board facts in the generated context without inventing calibration',()=>{
 const task=getActiveTask(updateHardware(createExampleWorkspace(),{controller:'Arduino Uno'}));
 const context=JSON.parse(task.files.find(f=>f.name==='hardware.json')!.content);
 assert.equal(context.controller,'Arduino Uno');assert.equal(context.controllerProfile.mcu,'ATmega328P');assert.equal(context.controllerProfile.fqbn,'arduino:avr:uno');
 assert.match(context.controllerProfile.pins.serial,/D0.*D1/);assert.deepEqual(context.servoCalibration,pendingCalibration());
 assert.equal(hardwareDescription('ESP32').controllerProfile,undefined);
 assert.equal(JSON.parse(getActiveTask(updateHardware(createExampleWorkspace(),{controller:'ESP32'})).files.find(f=>f.name==='hardware.json')!.content).controllerProfile,undefined);
 assert.equal(pinPlaceholder('Arduino Uno'),'e.g. D9');assert.equal(pinPlaceholder('ESP32'),'e.g. GPIO 18');assert.equal(pinPlaceholder(''),'e.g. D9 or GPIO 18');
});
