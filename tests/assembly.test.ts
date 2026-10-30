import test from 'node:test';
import assert from 'node:assert/strict';
import {Mesh} from 'three';
import {createHardwareArmModel} from '../src/components/HardwareArm.ts';
import {assembledCount,emptyAssembly,parseServoDraft,servoDraft} from '../src/lib/assembly.ts';
import {JOINT_IDS,pendingCalibration} from '../src/lib/hardware.ts';
import {createTask,createInitialWorkspace,getActiveTask,updateHardware,completeHardwareSetup,saveWorkspace,loadWorkspace,makeFile} from '../src/lib/workflow.ts';

test('new tasks start empty; a partial build and unfinished form survive reload and cannot run',()=>{
  let state=createTask(createInitialWorkspace(),'Assembly test');
  const assembly=getActiveTask(state).hardware.assembly!;
  assert.equal(assembledCount(assembly),0);assert.equal(getActiveTask(state).hardware.joints,0);
  assert.throws(()=>completeHardwareSetup(state),/Finish adding/);
  state=updateHardware(state,{assembly:{...assembly,category:'robot-arm',step:2,parts:{J1:{model:'SG90',pin:'18'}},drafts:{J2:{...servoDraft(),pin:'19',calibrate:true,min:'25'}}}});
  let value='';const storage={getItem:()=>value,setItem:(_key:string,v:string)=>{value=v}};
  saveWorkspace(state,storage);state=loadWorkspace(storage);
  assert.equal(assembledCount(getActiveTask(state).hardware.assembly!),1);
  assert.equal(getActiveTask(state).hardware.assembly!.drafts.J2!.min,'25');
  assert.equal(getActiveTask(state).hardware.gripper,false);
  assert.throws(()=>completeHardwareSetup(state),/Finish adding/);
});
test('servo forms reject reused channels and incomplete or inverted calibration without inventing limits',()=>{
  const assembly={...emptyAssembly(),category:'robot-arm' as const,parts:{J1:{model:'SG90',pin:'GPIO 18'}}};
  assert.ok('error' in parseServoDraft({...servoDraft(),pin:'18'},'J2',assembly));
  assert.ok('error' in parseServoDraft({...servoDraft(),calibrate:true,min:'20'},'J2',assembly));
  assert.ok('error' in parseServoDraft({...servoDraft(),calibrate:true,min:'90',max:'30',zero:'60'},'J2',assembly));
  const parsed=parseServoDraft({...servoDraft(),pin:'19',calibrate:true,min:'25',max:'140',zero:'80',direction:-1},'J2',assembly);
  assert.deepEqual(parsed,{part:{model:'SG90',pin:'19'},calibration:{min:25,max:140,zero:80,direction:-1}});
  assert.deepEqual(parseServoDraft(servoDraft(),'J2',assembly),{part:{model:'SG90',pin:''},calibration:null});
});
test('pin names from Arduino and ESP32 boards collide only when they name the same pin',()=>{
  const assembly={...emptyAssembly(),category:'robot-arm' as const,parts:{J1:{model:'SG90',pin:'D9'},J2:{model:'SG90',pin:'IO18'},J3:{model:'SG90',pin:'A0'}}};
  for(const pin of ['9','d9','Pin 9','D 9','GPIO 18','18'])assert.ok('error' in parseServoDraft({...servoDraft(),pin},'J4',assembly),pin);
  for(const pin of ['D10','A1','D0','PA8','19'])assert.ok(!('error' in parseServoDraft({...servoDraft(),pin},'J4',assembly)),pin);
  assert.ok(!('error' in parseServoDraft({...servoDraft(),pin:'D9'},'J1',assembly)));
});
test('completed assembly generates actual hardware context and preserves uploaded files and existing tasks',()=>{
  const initial=createInitialWorkspace();let state=createTask(initial,'New build');
  const assembly={...emptyAssembly(),category:'robot-arm' as const,step:5,parts:Object.fromEntries(JOINT_IDS.map((id,i)=>[id,{model:i===3?'MG90S':'SG90',pin:String(18+i)}]))};
  const limits=pendingCalibration();limits.J1={min:30,max:150,zero:90,direction:1};
  const uploaded=makeFile('hardware.json','User notes','hardware');getActiveTask(state).files.push(uploaded);
  state=updateHardware(state,{assembly,controller:'ESP32',connection:'USB serial · 115200 baud',servoCalibration:limits});
  state=completeHardwareSetup(state);
  assert.equal(state.stage,'first-run');assert.equal(getActiveTask(state).hardware.configured,true);
  const task=getActiveTask(state),context=JSON.parse(task.files.find(f=>f.name==='context-bridge-hardware.json')!.content);
  assert.equal(context.servoCount,4);assert.equal(context.armDOF,3);assert.equal(context.gripperDOF,1);
  assert.equal(context.axes.J4.model,'MG90S');assert.equal(context.axes.J4.pin,'21');assert.deepEqual(context.servoCalibration,limits);
  assert.deepEqual(task.files.find(f=>f.id===uploaded.id),uploaded);assert.deepEqual(state.tasks[0],initial.tasks[0]);
  assert.equal(completeHardwareSetup(state).tasks.at(-1)!.files.length,task.files.length);
});
test('progressive render reveals only added geometry and ends with the unchanged four-servo rig',()=>{
  const model=createHardwareArmModel(0);const meshes:Mesh[]=[];model.scene.traverse(o=>{if(o instanceof Mesh)meshes.push(o)});
  try{
    assert.ok(meshes.every(mesh=>!mesh.visible));
    let previous=0;
    for(let count=1;count<=4;count++){
      model.setAssembly(count);model.update(0,'J1');
      const visible=meshes.filter(mesh=>mesh.visible);assert.ok(visible.length>previous);
      assert.ok(visible.every(mesh=>mesh.userData.assemblyStage<=count));previous=visible.length;
      for(let i=1;i<=4;i++){const servo=model.scene.getObjectByName(`hardware-servo-J${i}`)!;assert.ok(servo);assert.equal((servo.children[0] as Mesh).visible,i<=count);}
    }
    assert.equal(previous,meshes.length);
    assert.equal(assembledCount({...emptyAssembly(),category:'robot-arm',parts:{J4:{model:'SG90',pin:''}}}),0);
  }finally{model.dispose()}
});
