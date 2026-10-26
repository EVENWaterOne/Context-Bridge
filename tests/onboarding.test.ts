import test from 'node:test';
import assert from 'node:assert/strict';
import {createExampleWorkspace,createInitialWorkspace,getActiveTask,getActiveRound,loadWorkspace,saveWorkspace,updateHardware,type StorageLike} from '../src/lib/workflow.ts';
import {assembledCount,servoDraft} from '../src/lib/assembly.ts';

function storage():StorageLike{const data=new Map<string,string>();return {getItem:key=>data.get(key)??null,setItem:(key,value)=>{data.set(key,value)}};}

test('first homepage entry starts at category selection with no model, files or example history',()=>{
  for(const workspace of [createInitialWorkspace(),loadWorkspace(storage())]){
    const task=getActiveTask(workspace);
    assert.equal(workspace.stage,'setup');assert.equal(workspace.tasks.length,1);
    assert.equal(task.name,'My first build');assert.equal(task.rounds.length,1);assert.equal(getActiveRound(workspace).number,1);
    assert.equal(task.files.length,0);assert.equal(task.hardware.configured,false);
    assert.equal(task.hardware.assembly!.category,null);assert.equal(task.hardware.assembly!.step,0);
    assert.equal(assembledCount(task.hardware.assembly!),0);assert.deepEqual(task.hardware.assembly!.parts,{});
    assert.equal(task.hardware.controller,'');assert.equal(task.hardware.connection,'');
  }
});

test('landing reload and returning login preserve the first task and partially entered assembly',()=>{
  const saved=storage();let workspace=loadWorkspace(saved);const firstTaskId=workspace.activeTaskId;
  saveWorkspace(workspace,saved);workspace=loadWorkspace(saved);
  assert.equal(workspace.activeTaskId,firstTaskId);assert.equal(workspace.tasks.length,1);
  const assembly=getActiveTask(workspace).hardware.assembly!;
  workspace=updateHardware(workspace,{assembly:{...assembly,category:'robot-arm',step:2,parts:{J1:{model:'SG90',pin:'18'}},drafts:{J2:{...servoDraft(),pin:'19'}}}});
  saveWorkspace(workspace,saved);
  assert.deepEqual(loadWorkspace(saved),workspace);
});

test('example projects remain opt-in and existing project histories are not reset by the update',()=>{
  const saved=storage(),example=createExampleWorkspace();saveWorkspace(example,saved);
  assert.deepEqual(loadWorkspace(saved),example);
  const first=createInitialWorkspace();
  assert.equal(first.tasks.length,1);assert.equal(getActiveTask(first).files.length,0);
  assert.equal(getActiveTask(example).files.length,3);assert.equal(getActiveRound(example).number,7);
});
