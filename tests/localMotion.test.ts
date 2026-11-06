import test from 'node:test';
import assert from 'node:assert/strict';
import {createTask,createInitialWorkspace,updateHardware,completeHardwareSetup,getActiveTask,getActiveRound,makeFile,updateRound,upsertFiles,reviseObservation,applyRoundChange,createExampleWorkspace,readMotionSettings,illustratedMotion,excludeDemoGeneratedFiles,prepareAgentRequest,prepareDemoScenario,DEFAULT_RETURN_DURATION} from '../src/lib/workflow.ts';
import {emptyAssembly} from '../src/lib/assembly.ts';
import {JOINT_IDS} from '../src/lib/hardware.ts';
import {buildSuggestion,mockAgent} from '../src/lib/agent.ts';
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
  const fixed={variant:'stable',returnDuration:DEFAULT_RETURN_DURATION};
  let state=createExampleWorkspace();
  const reference=()=>readMotionSettings(getActiveTask(state),getActiveRound(state),'reference').variant;
  // Everything the local app animates: currentMotion, referenceMotion and the first-run step list.
  const local=()=>(['current','reference'] as const).map(version=>illustratedMotion(getActiveTask(state),getActiveRound(state),'local',version));
  assert.deepEqual(local(),[fixed,fixed]);
  state=reviseObservation(state,{issues:['Shaking']});
  assert.equal(readMotionSettings(getActiveTask(state),getActiveRound(state)).variant,'shaking');
  assert.equal(reference(),'stable');
  assert.deepEqual(local(),[fixed,fixed]);
  state=updateRound(state,{suggestion:buildSuggestion({task:getActiveTask(state),round:getActiveRound(state)})});
  state=applyRoundChange(state);
  assert.equal(reference(),'stable');
  assert.deepEqual(local(),[fixed,fixed]);
  // A return_duration change applied to the user's code, as a backend Apply writes it.
  state=reviseObservation(createExampleWorkspace(),{issues:['Too fast']});
  state=updateRound(state,{suggestion:buildSuggestion({task:getActiveTask(state),round:getActiveRound(state)})});
  assert.deepEqual(readMotionSettings(getActiveTask(state),getActiveRound(state),'reference'),{variant:'stable',returnDuration:.6});
  assert.deepEqual(local(),[fixed,fixed]);
  state=applyRoundChange(state);
  assert.match(getActiveTask(state).files.find(f=>f.name==='motion.py')!.content,/^return_duration = 1\.2$/m);
  assert.deepEqual(readMotionSettings(getActiveTask(state),getActiveRound(state),'reference'),{variant:'stable',returnDuration:1.2});
  assert.deepEqual(local(),[fixed,fixed]);
  // The demo keeps animating its own example files.
  assert.deepEqual(illustratedMotion(getActiveTask(state),getActiveRound(state),'demo','reference'),{variant:'stable',returnDuration:1.2});
});

test('legacy apply appends only a missing motion_easing line and refuses a contradicting, repeated or other missing one',()=>{
  const ready=(content:string)=>{
    let state=reviseObservation(createExampleWorkspace(),{issues:['Shaking']});
    state=updateRound(state,{suggestion:buildSuggestion({task:getActiveTask(state),round:getActiveRound(state)})});
    const file=getActiveTask(state).files.find(f=>f.name==='motion.py')!;
    return upsertFiles(state,[makeFile('motion.py',content,file.kind,'sample')]);
  };
  assert.match(getActiveTask(applyRoundChange(ready('servo_direction = 1\n'))).files.find(f=>f.name==='motion.py')!.content,/motion_easing = "minimum_jerk"\n$/);
  assert.throws(()=>applyRoundChange(ready('motion_easing = "ease_out"\n')),/changed after this suggestion/);
  assert.throws(()=>applyRoundChange(ready('motion_easing = "linear"\nmotion_easing = "linear"\n')),/ambiguous/);
  // The example motion.py has no serial_timeout: an Error message proposal must not append one.
  let state=reviseObservation(createExampleWorkspace(),{issues:['Error message']});
  state=updateRound(state,{suggestion:buildSuggestion({task:getActiveTask(state),round:getActiveRound(state)})});
  assert.equal(getActiveRound(state).suggestion!.parameter,'serial_timeout');
  assert.throws(()=>applyRoundChange(state),/source changed/);
});

test('the demo diagnosis refuses a change it could not apply, instead of proposing one that Apply then rejects',async()=>{
  const ask=(issues:string[])=>{const state=reviseObservation(createExampleWorkspace(),{issues});return mockAgent.investigate({task:getActiveTask(state),round:getActiveRound(state)},{durationMs:0})};
  // The example motion.py has no serial_timeout line.
  await assert.rejects(ask(['Error message']),/has no serial_timeout setting/);
  // A missing motion_easing line is the one exception Apply accepts.
  assert.equal((await ask(['Shaking'])).parameter,'motion_easing');
  assert.equal((await ask(['Too fast'])).parameter,'return_duration');
});

test('an old browser workspace is imported with the demo files unchecked and the user files as they were',()=>{
  let state=completeHardwareSetup(configured());
  state=prepareAgentRequest(reviseObservation(state,{issues:['Too fast']}));
  state=upsertFiles(state,[makeFile('notes.md','User notes','note','uploaded')]);
  state=prepareAgentRequest(reviseObservation(prepareDemoScenario(state,'shaking'),{issues:['Shaking']}));
  const imported=validateWorkspace(excludeDemoGeneratedFiles(state));
  const included=(name:string,taskIndex:number)=>imported.tasks[taskIndex].files.find(f=>f.name===name)!.includeInContext!==false;
  const real=imported.tasks.findIndex(t=>t.name==='Real arm'),demo=imported.tasks.findIndex(t=>t.name==='Desktop arm · stable movement');
  assert.ok(real>=0&&demo>=0);
  for(const name of ['motion.py','motion-reference.json','round-01-observation.md'])assert.equal(included(name,real),false,name);
  for(const name of ['motion-reference.json','round-01-observation.md'])assert.equal(included(name,demo),false,name);
  assert.equal(included('context-bridge-hardware.json',real),true);
  assert.equal(included('notes.md',real),true);
  // The scenario's own motion.py and hardware.json are visible example files, like local "Use example project files".
  assert.equal(included('motion.py',demo),true);
  assert.deepEqual(imported.tasks.map(t=>t.files.length),state.tasks.map(t=>t.files.length));
});
