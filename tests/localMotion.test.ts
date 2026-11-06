import test from 'node:test';
import assert from 'node:assert/strict';
import {createTask,createInitialWorkspace,updateHardware,completeHardwareSetup,getActiveTask,getActiveRound,makeFile,updateRound,upsertFiles,reviseObservation,applyRoundChange,createExampleWorkspace,readMotionSettings} from '../src/lib/workflow.ts';
import {emptyAssembly} from '../src/lib/assembly.ts';
import {JOINT_IDS} from '../src/lib/hardware.ts';
import {buildSuggestion} from '../src/lib/agent.ts';
import {validateWorkspace} from '../server/validation.ts';

function configured(){
  const assembly={...emptyAssembly(),category:'robot-arm' as const,step:5,parts:Object.fromEntries(JOINT_IDS.map((id,i)=>[id,{model:'SG90',pin:`D${9+i}`}]))};
  return updateHardware(createTask(createInitialWorkspace(),'Real arm'),{assembly,controller:'Arduino Uno',connection:'USB serial · 115200 baud'});
}

test('a real task finishes setup without the demo motion files, which would otherwise reach the model',()=>{
  const names=getActiveTask(completeHardwareSetup(configured(),{motionContext:false})).files.map(f=>f.name);
  assert.equal(names.includes('motion.py'),false);
  assert.equal(names.includes('motion-reference.json'),false);
  assert.equal(names.includes('context-bridge-hardware.json'),true);
});

test('a demo task still gets its motion files by default',()=>{
  const names=getActiveTask(completeHardwareSetup(configured())).files.map(f=>f.name);
  assert.equal(names.includes('motion.py'),true);
  assert.equal(names.includes('motion-reference.json'),true);
});

test('the local service accepts the Turn phase the observation screen now offers',()=>{
  const state=reviseObservation(createExampleWorkspace(),{phase:'Turn'});
  assert.equal(getActiveRound(validateWorkspace(state)).observation.phase,'Turn');
});

test('the reference animation stays the same after a shaking report and an applied change',()=>{
  let state=reviseObservation(createExampleWorkspace(),{issues:['Shaking']});
  const reference=()=>readMotionSettings(getActiveTask(state),getActiveRound(state),'reference').variant;
  assert.equal(reference(),'stable');
  state=updateRound(state,{suggestion:buildSuggestion({task:getActiveTask(state),round:getActiveRound(state)})});
  state=applyRoundChange(state);
  assert.equal(reference(),'stable');
});

test('legacy apply still appends a missing parameter but refuses a contradicting or repeated one',()=>{
  const ready=(content:string)=>{
    let state=reviseObservation(createExampleWorkspace(),{issues:['Shaking']});
    state=updateRound(state,{suggestion:buildSuggestion({task:getActiveTask(state),round:getActiveRound(state)})});
    const file=getActiveTask(state).files.find(f=>f.name==='motion.py')!;
    return upsertFiles(state,[makeFile('motion.py',content,file.kind,'sample')]);
  };
  assert.match(getActiveTask(applyRoundChange(ready('servo_direction = 1\n'))).files.find(f=>f.name==='motion.py')!.content,/motion_easing = "minimum_jerk"\n$/);
  assert.throws(()=>applyRoundChange(ready('motion_easing = "ease_out"\n')),/changed after this suggestion/);
  assert.throws(()=>applyRoundChange(ready('motion_easing = "linear"\nmotion_easing = "linear"\n')),/ambiguous/);
});
