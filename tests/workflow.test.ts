import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialWorkspace, getActiveTask, getActiveRound, updateRound, updateTask, switchTask, createTask, completeRound, applyRoundChange, loadWorkspace, saveWorkspace, STORAGE_KEY, makeFile } from '../src/lib/workflow.ts';
import { buildSuggestion, mockAgent, createHttpAgent } from '../src/lib/agent.ts';
import type { Workspace, StorageLike } from '../src/lib/workflow.ts';
function observed(): Workspace {
  let state = createInitialWorkspace();
  state = updateRound(state, { observation: { ...getActiveRound(state).observation, issues: ['Too fast'], detail: 'The elbow snaps back.' } });
  const suggestion = buildSuggestion({ task: getActiveTask(state), round: getActiveRound(state) });
  return updateRound(state, { suggestion });
}
function memory(initial?: string): StorageLike {
  const data = new Map<string, string>(); if (initial) data.set(STORAGE_KEY, initial);
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); } };
}
test('feedback creates a new observation round without returning to hardware setup', () => {
  let state = observed(); const taskId = state.activeTaskId; const old = getActiveRound(state);
  state = { ...applyRoundChange(state), stage: 'feedback' };
  state = completeRound(state, 'Better', 'A smoother return.');
  assert.equal(state.stage, 'observe'); assert.equal(state.activeTaskId, taskId);
  assert.equal(getActiveRound(state).number, 8); assert.deepEqual(getActiveRound(state).observation.issues, []);
  const completed = getActiveTask(state).rounds.find(r => r.id === old.id)!;
  assert.equal(completed.result, 'Better'); assert.equal(completed.note, 'A smoother return.'); assert.ok(completed.completedAt);
});
test('only task switch or create deliberately returns to setup, preserving the previous task', () => {
  const original = observed(), previous = getActiveTask(original);
  let state = switchTask({ ...original, stage: 'review' }, 'task-desktop-pet');
  assert.equal(state.stage, 'setup'); assert.equal(getActiveTask(state).name, 'Desktop pet · tail response');
  assert.deepEqual(state.tasks.find(t => t.id === previous.id), previous);
  state = createTask(state, '  New arm  '); assert.equal(state.stage, 'setup'); assert.equal(getActiveTask(state).name, 'New arm');
  assert.equal(getActiveRound(state).number, 1); assert.equal(getActiveTask(state).files.length, 0);
  assert.throws(() => createTask(state, '   ')); assert.throws(() => switchTask(state, 'missing'));
});
test('applying updates only the requested local file and is idempotent', () => {
  const before = observed(), source = getActiveTask(before).files.find(f => f.name === 'motion.py')!;
  const state = applyRoundChange(before), edited = getActiveTask(state).files.find(f => f.name === 'motion.py')!;
  assert.match(source.content, /return_duration = 0.6/); assert.match(edited.content, /return_duration = 1.2/);
  assert.equal(getActiveRound(state).applied, true); assert.equal(edited.size, new TextEncoder().encode(edited.content).length);
  assert.equal(applyRoundChange(state), state);
  assert.deepEqual(getActiveTask(state).files.filter(f => f.name !== 'motion.py'), getActiveTask(before).files.filter(f => f.name !== 'motion.py'));
});
test('cannot complete an unapplied or already-completed round', () => {
  assert.throws(() => completeRound(observed(), 'Better'), /Apply and test/);
  const state = updateRound(applyRoundChange(observed()), { completedAt: new Date().toISOString() });
  assert.throws(() => completeRound(state, 'Better'), /already complete/);
});
test('storage roundtrip preserves files, history, and current observation', () => {
  const storage = memory(), state = observed(); assert.equal(saveWorkspace(state, storage).ok, true);
  assert.deepEqual(loadWorkspace(storage), state);
});
test('corrupt, malformed, and obsolete stored state resets safely', () => {
  for (const value of ['broken{', '{}', '{"version":9}', JSON.stringify({ ...createInitialWorkspace(), activeTaskId: 'missing' })]) {
    assert.equal(getActiveTask(loadWorkspace(memory(value))).id, 'task-desk-arm');
  }
  const state = createInitialWorkspace(); (state.tasks[0].rounds[0].observation as unknown as { desired: unknown }).desired = 'bad';
  assert.equal(loadWorkspace(memory(JSON.stringify(state))).stage, 'setup');
});
test('interrupted Agent operations recover to a safe retry screen', () => {
  const state = observed();
  assert.equal(loadWorkspace(memory(JSON.stringify({ ...state, stage: 'investigating' }))).stage, 'request');
  assert.equal(loadWorkspace(memory(JSON.stringify({ ...state, stage: 'applying' }))).stage, 'review');
});
test('storage quota failures are visible and do not throw away memory state', () => {
  const storage: StorageLike = { getItem: () => null, setItem: () => { throw new Error('Quota exceeded'); } };
  assert.equal(saveWorkspace(observed(), storage).ok, false);
});
test('mock suggestion uses the chosen issue, joint, files, and optional history', () => {
  let state = observed();
  state = updateRound(state, { observation: { ...getActiveRound(state).observation, issues: ['Wrong way'], joint: 'J3', includePrevious: false } });
  const suggestion = buildSuggestion({ task: getActiveTask(state), round: getActiveRound(state) });
  assert.equal(suggestion.parameter, 'servo_direction'); assert.equal(suggestion.after, '-1');
  assert.match(suggestion.summary, /J3/); assert.equal(suggestion.evidence.length, 2);
  state = updateTask(state, { files: [makeFile('tail.py', 'return_duration = 1.2\n', 'code')] });
  state = updateRound(state, { observation: { ...getActiveRound(state).observation, issues: ['Too fast'] } });
  const second = buildSuggestion({ task: getActiveTask(state), round: getActiveRound(state) });
  assert.equal(second.fileName, 'tail.py'); assert.equal(second.before, '1.2'); assert.equal(second.after, '2.4');
});
test('mock Agent sends progress and supports cancellation without applying changes', async () => {
  const state = observed(), context = { task: getActiveTask(state), round: getActiveRound(state) }, milestones: number[] = [];
  const suggestion = await mockAgent.investigate(context, { durationMs: 8, onProgress: p => milestones.push(p.progress) });
  assert.equal(suggestion.after, '1.2'); assert.deepEqual(milestones, [0, 25, 50, 75, 100]);
  const controller = new AbortController(); const promise = mockAgent.applySuggestion(context, { durationMs: 100, signal: controller.signal }); controller.abort();
  await assert.rejects(promise, { name: 'AbortError' }); assert.equal(context.round.applied, false);
});
test('HTTP adapter preserves server boundary, handles errors, and never embeds credentials', async () => {
  const state = observed(), context = { task: getActiveTask(state), round: getActiveRound(state) };
  assert.throws(() => createHttpAgent('http://insecure.test'), /HTTPS/);
  let requestPath = '';
  const transport = (async (url: string | URL | Request, init?: RequestInit) => { requestPath = String(url); assert.equal(init?.method, 'POST'); assert.equal(init?.credentials, 'same-origin'); return new Response(JSON.stringify(buildSuggestion(context)), { status: 200 }); }) as typeof fetch;
  assert.equal((await createHttpAgent('/api/agent', transport).investigate(context)).after, '1.2'); assert.equal(requestPath, '/api/agent/investigate');
  const failure = createHttpAgent('/api/agent', (async () => new Response('', { status: 503 })) as typeof fetch);
  await assert.rejects(failure.investigate(context), /503/);
});

test('applied rounds cannot silently be rewritten through backward navigation', async () => {
  const { setStage, reviseObservation } = await import('../src/lib/workflow.ts');
  const state = applyRoundChange(observed());
  assert.equal(setStage(state, 'observe').stage, 'feedback');
  assert.equal(setStage(state, 'request').stage, 'feedback');
  assert.equal(reviseObservation(state, { issues: ['Wrong way'] }), state);
  const editable = observed(), revised = reviseObservation(editable, { issues: ['Wrong way'] });
  assert.equal(getActiveRound(revised).suggestion, undefined);
  assert.deepEqual(getActiveRound(revised).observation.issues, ['Wrong way']);
});
test('file import replaces duplicate names and remains bound to its original task', async () => {
  const { upsertFiles } = await import('../src/lib/workflow.ts');
  const initial = createInitialWorkspace();
  const originalFileId = getActiveTask(initial).files.find(f => f.name === 'motion.py')!.id;
  const switched = switchTask(initial, 'task-desktop-pet');
  const state = upsertFiles(switched, [makeFile('motion.py', '# replacement\n', 'code'), makeFile('notes.txt', 'first'), makeFile('notes.txt', 'last')], 'task-desk-arm');
  assert.equal(state.activeTaskId, 'task-desktop-pet');
  assert.deepEqual(getActiveTask(state).files, getActiveTask(switched).files);
  const files = state.tasks.find(t => t.id === 'task-desk-arm')!.files;
  assert.equal(files.filter(f => f.name === 'motion.py').length, 1);
  assert.equal(files.find(f => f.name === 'motion.py')!.id, originalFileId);
  assert.equal(files.find(f => f.name === 'notes.txt')!.content, 'last');
});
test('configured hardware is only reopened by an explicit task switch', async () => {
  const { setStage } = await import('../src/lib/workflow.ts');
  let state = observed();
  state = updateTask(state, { hardware: { ...getActiveTask(state).hardware, configured: true } });
  state = setStage(state, 'observe');
  assert.equal(setStage(state, 'setup').stage, 'observe');
  assert.equal(switchTask(state, state.activeTaskId).stage, 'setup');
  assert.equal(createTask(state, 'Next build').stage, 'setup');
});

test('multiple observations toggle independently and survive save/reload', async () => {
  const { toggleIssue } = await import('../src/lib/workflow.ts');
  let state = createInitialWorkspace();
  state = toggleIssue(toggleIssue(state, 'Too fast'), 'Shaking');
  assert.deepEqual(getActiveRound(state).observation.issues, ['Too fast', 'Shaking']);
  const storage = memory(); saveWorkspace(state, storage);
  state = loadWorkspace(storage);
  assert.deepEqual(getActiveRound(state).observation.issues, ['Too fast', 'Shaking']);
  const suggestion = buildSuggestion({task:getActiveTask(state),round:getActiveRound(state)});
  assert.match(suggestion.evidence[0], /Too fast \+ Shaking/);
  assert.match(suggestion.rationale, /other observations remain/);
  state = toggleIssue(state, 'Too fast');
  assert.deepEqual(getActiveRound(state).observation.issues, ['Shaking']);
  state = toggleIssue(state, 'Shaking');
  await assert.rejects(mockAgent.investigate({task:getActiveTask(state),round:getActiveRound(state)},{durationMs:0}), /Choose an observation/);
});

test('upgrading a legacy single-choice workspace preserves task, history and files', () => {
  const state = observed();
  const legacy = JSON.parse(JSON.stringify(state));
  for (const task of legacy.tasks) for (const round of task.rounds) {
    round.observation.issue = round.observation.issues[0] || null;
    delete round.observation.issues;
  }
  const restored = loadWorkspace(memory(JSON.stringify(legacy)));
  assert.deepEqual(restored, state);
});

test('a later round uses the current parameter and never proposes an unchanged value', () => {
  const state = observed(), task = getActiveTask(state), round = getActiveRound(state);
  const code = task.files.find(file => file.kind === 'code')!;
  round.observation.issues = ['Shaking'];
  code.content = 'step_interval = 0.04\n';
  const suggestion = buildSuggestion({ task, round });
  assert.equal(suggestion.before, '0.04');
  assert.equal(suggestion.after, '0.08');
  code.content = 'step_interval = 0.20\n';
  assert.throws(() => buildSuggestion({ task, round }), /already at its suggested setting/);
  round.observation.issues = ['Wrong way'];
  code.content = 'servo_direction = -1\n';
  assert.equal(buildSuggestion({ task, round }).after, '1');
});
