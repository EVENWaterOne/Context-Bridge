import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, followJob, localApi, WorkspaceSaveQueue } from '../src/lib/local-api.ts';
import { applyRoundChange, createExampleWorkspace, getActiveTask, getActiveRound, updateRound, updateTask } from '../src/lib/workflow.ts';
import { buildSuggestion } from '../src/lib/agent.ts';
import type { Workspace } from '../src/lib/workflow.ts';
import type { WorkspaceEnvelope, JobView } from '../src/lib/backend-types.ts';

const envelope = (workspace: Workspace, revision = 1): WorkspaceEnvelope => ({ version: 2, workspace, revision, activeJobs: [] });
const renamed = (state: Workspace, name: string) => updateTask(state, { name });

test('workspace writes are serial, coalesced, and use the latest server revision', async () => {
  const initial = createExampleWorkspace(), calls: { name: string; revision: number }[] = [];
  let release: (() => void) | undefined;
  let concurrent = 0, maximum = 0;
  const queue = new WorkspaceSaveQueue(envelope(initial), async (state, revision) => {
    concurrent++; maximum = Math.max(maximum, concurrent);
    calls.push({ name: getActiveTask(state).name, revision });
    if (calls.length === 1) await new Promise<void>(resolve => { release = resolve; });
    concurrent--; return envelope(state, revision + 1);
  });
  const first = queue.save(renamed(initial, 'First'));
  await Promise.resolve();
  const second = queue.save(renamed(initial, 'Second'));
  const last = queue.save(renamed(initial, 'Final'));
  assert.ok(release); release();
  await Promise.all([first, second, last]);
  assert.equal(maximum, 1);
  assert.deepEqual(calls, [{ name: 'First', revision: 1 }, { name: 'Final', revision: 2 }]);
});

test('a no-op flush cannot swallow a simultaneous edit and adoption prevents redundant writes', async () => {
  const initial = createExampleWorkspace(), names: string[] = [];
  const queue = new WorkspaceSaveQueue(envelope(initial), async (state, revision) => { names.push(getActiveTask(state).name); return envelope(state, revision + 1); });
  await Promise.all([queue.save(initial), queue.save(renamed(initial, 'Latest draft'))]);
  assert.deepEqual(names, ['Latest draft']);
  const authoritative = renamed(initial, 'Server result'); queue.adopt(envelope(authoritative, 8));
  await queue.save(authoritative); assert.equal(names.length, 1);
});

test('legacy apply rejects missing or ambiguous source and backend proposals cannot mutate in browser', () => {
  let state = createExampleWorkspace();
  state = updateRound(state, { observation: { ...getActiveRound(state).observation, issues: ['Too fast'] } });
  const suggestion = buildSuggestion({ task: getActiveTask(state), round: getActiveRound(state) });
  state = updateRound(state, { suggestion });
  const before = JSON.stringify(state);
  const missing = updateTask(state, { files: [] });
  assert.throws(() => applyRoundChange(missing), /source changed/);
  const file = getActiveTask(state).files.find(f => f.name === suggestion.fileName)!;
  const ambiguous = updateTask(state, { files: [{ ...file, content: `${file.content}\n${suggestion.codeBefore}` }] });
  assert.throws(() => applyRoundChange(ambiguous), /ambiguous/);
  assert.throws(() => applyRoundChange(updateRound(state, { suggestion: { ...suggestion, version: 2, outcome: 'proposal', changes: [] } })), /local backend/);
  assert.equal(JSON.stringify(state), before);
});

test('API preserves structured backend conflict errors', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: { code: 'STALE_WORKSPACE', message: 'Another tab changed this workspace.' } }), { status: 409 })) as typeof fetch;
  try { await assert.rejects(localApi('/api/workspace'), (error: unknown) => error instanceof ApiError && error.status === 409 && error.code === 'STALE_WORKSPACE' && /Another tab/.test(error.message)); }
  finally { globalThis.fetch = original; }
});

test('SSE job events handle chunk boundaries and stop at a persisted terminal result', async () => {
  const original = globalThis.fetch;
  const job: JobView = { id: 'job-1', taskId: 'task-1', roundId: 'round-1', kind: 'investigate', status: 'running', message: 'Reading files', text: '', createdAt: new Date().toISOString() };
  const done: JobView = { ...job, status: 'completed', message: 'Ready' };
  const stream = `event: job\ndata: ${JSON.stringify(job)}\n\nevent: job\ndata: ${JSON.stringify(done)}\n\n`;
  const encoder = new TextEncoder();
  globalThis.fetch = (async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(stream.slice(0, 57))); controller.enqueue(encoder.encode(stream.slice(57))); controller.close(); } }), { headers: { 'Content-Type': 'text/event-stream' } })) as typeof fetch;
  try { const events: string[] = []; const result = await followJob('job-1', item => events.push(item.status)); assert.deepEqual(events, ['running', 'completed']); assert.equal(result.status, 'completed'); }
  finally { globalThis.fetch = original; }
});
