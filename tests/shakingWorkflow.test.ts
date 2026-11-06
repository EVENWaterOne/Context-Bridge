import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createInitialWorkspace,createExampleWorkspace,getActiveTask,getActiveRound,prepareDemoScenario,
  reviseObservation,prepareAgentRequest,readMotionSettings,updateRound,applyRoundChange,undoRoundChange,
  completeRound,makeFile,upsertFiles,updateTask,ensureMotionContext,saveWorkspace,loadWorkspace,
} from '../src/lib/workflow.ts';
import {buildSuggestion,buildAgentRequest,createHttpAgent,mockAgent} from '../src/lib/agent.ts';

function shaking(){
  let state=prepareDemoScenario(createInitialWorkspace(),'shaking');
  state=reviseObservation(state,{issues:['Shaking'],detail:'The arm trembles when lifting and turning.',desired:['Smoother motion']});
  return prepareAgentRequest(state);
}
const context=(state:ReturnType<typeof shaking>)=>({task:getActiveTask(state),round:getActiveRound(state)});

test('a fresh filming task preserves previous projects and begins before any observation is selected',()=>{
  const original=createExampleWorkspace(),state=prepareDemoScenario(original,'shaking');
  assert.deepEqual(state.tasks.slice(0,-1),original.tasks);
  assert.equal(state.stage,'first-run');assert.equal(getActiveTask(state).hardware.configured,true);
  assert.deepEqual(getActiveRound(state).observation.issues,[]);
  assert.deepEqual(getActiveRound(state).observation.desired,['Smoother motion']);
  assert.equal(getActiveRound(state).observation.phase,'Turn');
  assert.deepEqual(readMotionSettings(getActiveTask(state),getActiveRound(state)),{variant:'stable',returnDuration:1.5});
  assert.deepEqual(readMotionSettings(getActiveTask(state),getActiveRound(state),'reference'),{variant:'stable',returnDuration:1.5});
});

test('the ideal reference stays stable while shaking is introduced only by a user observation',()=>{
  let state=prepareDemoScenario(createInitialWorkspace(),'shaking');
  const originalFiles=structuredClone(getActiveTask(state).files);
  state=reviseObservation(state,{issues:['Shaking'],desired:['Smoother motion']});
  assert.equal(readMotionSettings(getActiveTask(state),getActiveRound(state)).variant,'shaking');
  assert.equal(readMotionSettings(getActiveTask(state),getActiveRound(state),'before').variant,'shaking');
  assert.equal(readMotionSettings(getActiveTask(state),getActiveRound(state),'reference').variant,'stable');
  state=updateRound(state,{suggestion:buildSuggestion(context(state))});
  assert.equal(readMotionSettings(getActiveTask(state),getActiveRound(state),'after').variant,'stable');
  assert.equal(readMotionSettings(getActiveTask(state),getActiveRound(state)).variant,'shaking');
  assert.equal(readMotionSettings(getActiveTask(state),getActiveRound(state),'reference').variant,'stable');
  assert.deepEqual(getActiveTask(state).files,originalFiles);
  state=reviseObservation(state,{issues:[]});
  assert.equal(readMotionSettings(getActiveTask(state),getActiveRound(state)).variant,'stable');
});

test('shaking request, reviewed code, applied animation and exact undo share one motion profile',async()=>{
  let state=shaking();const originalCode=getActiveTask(state).files.find(f=>f.name==='motion.py')!.content;
  const request=buildAgentRequest(context(state));
  assert.deepEqual(request.round.observation.issues,['Shaking']);
  assert.deepEqual(request.round.observation.desired,['Smoother motion']);
  assert.match(request.task.files.find(f=>f.name==='round-01-observation.md')!.content,/Observed: Shaking/);
  assert.match(request.task.files.find(f=>f.name==='motion.py')!.content,/def progress_curve/);
  const suggestion=await mockAgent.investigate(context(state),{durationMs:0});
  assert.equal(suggestion.parameter,'motion_easing');assert.equal(suggestion.before,'linear');assert.equal(suggestion.after,'minimum_jerk');
  state=updateRound(state,{suggestion});
  assert.deepEqual(readMotionSettings(getActiveTask(state),getActiveRound(state),'before'),{variant:'shaking',returnDuration:1.5});
  assert.deepEqual(readMotionSettings(getActiveTask(state),getActiveRound(state),'after'),{variant:'stable',returnDuration:1.5});
  await mockAgent.applySuggestion(context(state),{durationMs:0});state=applyRoundChange(state);
  assert.deepEqual(readMotionSettings(getActiveTask(state),getActiveRound(state)),{variant:'stable',returnDuration:1.5});
  assert.deepEqual(readMotionSettings(getActiveTask(state),getActiveRound(state),'before'),{variant:'shaking',returnDuration:1.5});
  assert.equal(getActiveTask(state).files.find(f=>f.name==='motion.py')!.content,originalCode.replace('motion_easing = "linear"','motion_easing = "minimum_jerk"'));
  state=undoRoundChange(state);assert.equal(state.stage,'review');assert.equal(getActiveRound(state).applied,false);
  assert.equal(getActiveTask(state).files.find(f=>f.name==='motion.py')!.content,originalCode);
});

test('the parallel slow-return scenario changes only timing and remains stable',()=>{
  let state=prepareDemoScenario(createInitialWorkspace(),'slow-return');
  state=reviseObservation(state,{issues:['Too fast']});const suggestion=buildSuggestion(context(state));
  assert.equal(suggestion.parameter,'return_duration');assert.equal(suggestion.before,'1.5');assert.equal(suggestion.after,'3.0');
  state=updateRound(state,{suggestion});
  assert.deepEqual(readMotionSettings(getActiveTask(state),getActiveRound(state),'before'),{variant:'stable',returnDuration:1.5});
  assert.deepEqual(readMotionSettings(getActiveTask(state),getActiveRound(state),'after'),{variant:'stable',returnDuration:3});
  assert.deepEqual(readMotionSettings(getActiveTask(state),getActiveRound(state),'reference'),{variant:'stable',returnDuration:1.5});
});

test('legacy motion files and newly configured tasks can both enter the shaking branch without rewriting uploads',()=>{
  let legacy=createExampleWorkspace();legacy=reviseObservation(legacy,{issues:['Shaking']});
  const suggestion=buildSuggestion(context(legacy));assert.equal(suggestion.parameter,'motion_easing');assert.equal(suggestion.before,'linear');
  legacy=updateRound(legacy,{suggestion});legacy=applyRoundChange(legacy);
  assert.equal(readMotionSettings(getActiveTask(legacy),getActiveRound(legacy)).variant,'stable');
  const uploaded=makeFile('custom-arm.py','# User code\nreturn_duration = 2.0\n','code','uploaded');
  let state=prepareDemoScenario(createInitialWorkspace(),'shaking');state=updateTask(state,{files:[uploaded]});
  state=ensureMotionContext(state);assert.deepEqual(getActiveTask(state).files.find(f=>f.id===uploaded.id),uploaded);
  assert.equal(getActiveTask(state).files.filter(f=>f.kind==='code').length,1);
  assert.equal(readMotionSettings(getActiveTask(state),getActiveRound(state)).returnDuration,2);
});

test('apply refuses stale code; undo refuses to discard subsequent edits',()=>{
  let state=shaking();state=updateRound(state,{suggestion:buildSuggestion(context(state))});
  const original=getActiveTask(state).files.find(f=>f.name==='motion.py')!;
  const stale=upsertFiles(state,[{...original,content:original.content.replace('"linear"','"ease_out"')}]);
  assert.throws(()=>applyRoundChange(stale),/changed after this suggestion/);
  state=applyRoundChange(state);const file=getActiveTask(state).files.find(f=>f.name==='motion.py')!;
  state=upsertFiles(state,[{...file,content:file.content+'\n# newer edit'}]);
  assert.throws(()=>undoRoundChange(state),/newer edits/);
});

test('feedback and reload keep the fixed profile and exact checkpoint without reopening hardware',()=>{
  let state=shaking();state=updateRound(state,{suggestion:buildSuggestion(context(state))});state=applyRoundChange(state);
  let stored='';const storage={getItem:()=>stored,setItem:(_k:string,v:string)=>{stored=v}};
  saveWorkspace(state,storage);state=loadWorkspace(storage);
  assert.equal(readMotionSettings(getActiveTask(state),getActiveRound(state),'before').variant,'shaking');
  state=completeRound(state,'Better','The lift and turn are steady.');
  assert.equal(state.stage,'observe');assert.equal(getActiveRound(state).number,2);
  assert.equal(readMotionSettings(getActiveTask(state),getActiveRound(state)).variant,'stable');
  state=reviseObservation(state,{issues:['Shaking']});
  assert.throws(()=>buildSuggestion(context(state)),/already uses minimum-jerk/);
});

test('the exact HTTP request respects the history switch and keeps explicitly uploaded evidence',async()=>{
  let state=createExampleWorkspace();state=reviseObservation(state,{issues:['Shaking'],includePrevious:false});
  state=upsertFiles(state,[makeFile('run-01.log','User-selected evidence','log','uploaded')]);
  const input=context(state),payload=buildAgentRequest(input);
  assert.equal(payload.task.rounds.length,1);assert.equal(payload.task.rounds[0].id,input.round.id);
  assert.equal(payload.task.files.some(f=>f.name==='run-06.log'),false);
  assert.equal(payload.task.files.some(f=>f.name==='run-01.log'),true);
  const transport=(async (_url:string|URL|Request,init?:RequestInit)=>{assert.deepEqual(JSON.parse(String(init?.body)),JSON.parse(JSON.stringify(payload)));return new Response(JSON.stringify(buildSuggestion(input)));}) as typeof fetch;
  await createHttpAgent('/api/agent',transport).investigate(input);
});

test('a file unchecked in the context folder is left out of the exact request and the demo diagnosis',async()=>{
  const uncheck=(state:ReturnType<typeof shaking>,pick:(f:ReturnType<typeof getActiveTask>['files'][number])=>boolean)=>updateTask(state,{files:getActiveTask(state).files.map(f=>pick(f)?{...f,includeInContext:false}:f)});
  const state=uncheck(shaking(),f=>f.name==='motion-reference.json'),payload=buildAgentRequest(context(state));
  assert.equal(payload.task.files.some(f=>f.name==='motion-reference.json'),false);
  assert.deepEqual(payload.task.files.map(f=>f.name),getActiveTask(state).files.filter(f=>f.name!=='motion-reference.json').map(f=>f.name));
  const transport=(async (_url:string|URL|Request,init?:RequestInit)=>{assert.equal(JSON.parse(String(init?.body)).task.files.some((f:{name:string})=>f.name==='motion-reference.json'),false);return new Response(JSON.stringify(buildSuggestion(context(state))));}) as typeof fetch;
  await createHttpAgent('/api/agent',transport).investigate(context(state));
  assert.equal((await mockAgent.investigate(context(state),{durationMs:0})).parameter,'motion_easing');
  const noCode=uncheck(state,f=>f.kind==='code');
  assert.equal(buildAgentRequest(context(noCode)).task.files.some(f=>f.kind==='code'),false);
  await assert.rejects(mockAgent.investigate(context(noCode),{durationMs:0}),/No code file is checked/);
});

test('reload retires only unapplied legacy shaking suggestions, including inactive tasks',()=>{
  let original=reviseObservation(createExampleWorkspace(),{issues:['Shaking'],desired:['Smoother motion']});
  const legacy={...buildSuggestion(context(original)),parameter:'step_interval',before:'0.02',after:'0.04',unit:'s',codeBefore:'step_interval = 0.02',codeAfter:'step_interval = 0.04'};
  original=updateRound(original,{suggestion:legacy});
  const active=getActiveRound(original);
  original=updateTask(original,{rounds:[
    ...getActiveTask(original).rounds,
    {...active,id:'legacy-applied',number:8,applied:true},
    {...active,id:'legacy-completed',number:9,completedAt:'2026-11-01T10:00:00.000Z'},
    {...active,id:'other-interval',number:10,observation:{...active.observation,issues:['Other']}},
  ]});
  const inactive=original.tasks[1];
  original=updateTask(original,{rounds:inactive.rounds.map(round=>round.id===inactive.activeRoundId?{...round,observation:{...round.observation,issues:['Shaking']},suggestion:legacy}:round)},inactive.id);
  for(const stage of ['review','applying'] as const){
    const saved={...original,stage};
    const loaded=loadWorkspace({getItem:()=>JSON.stringify(saved),setItem:()=>{}});
    assert.equal(loaded.stage,'request');
    assert.equal(getActiveRound(loaded).suggestion,undefined);
    assert.equal(loaded.tasks[1].rounds.find(round=>round.id===inactive.activeRoundId)!.suggestion,undefined);
    for(const task of loaded.tasks)assert.deepEqual(task.files,original.tasks.find(previous=>previous.id===task.id)!.files);
    for(const id of ['legacy-applied','legacy-completed','other-interval'])assert.deepEqual(getActiveTask(loaded).rounds.find(round=>round.id===id),JSON.parse(JSON.stringify(getActiveTask(original).rounds.find(round=>round.id===id))));
    assert.equal(buildSuggestion(context(loaded)).parameter,'motion_easing');
  }
});
