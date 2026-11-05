import test from 'node:test';
import assert from 'node:assert/strict';
import { mockAgent, createHttpAgent, type RunResult } from '../src/lib/agent.ts';
import { createExampleWorkspace, getActiveTask, getActiveRound } from '../src/lib/workflow.ts';

function context() {
  const workspace = createExampleWorkspace();
  return { task: getActiveTask(workspace), round: getActiveRound(workspace) };
}

test('demo Run is explicit simulation and does not modify code or mark an observation', async () => {
  const input = context(), before = structuredClone(input), milestones: number[] = [];
  const result = await mockAgent.runMotion(input, { durationMs: 4, onProgress: p => milestones.push(p.progress) });
  assert.equal(result.status, 'completed');
  assert.equal(result.mode, 'simulated');
  assert.match(result.message, /No code was executed on physical hardware/);
  assert.deepEqual(input, before);
  assert.deepEqual(milestones, [0, 50, 100]);
});

test('cancelled demo Run cannot report a completed run', async () => {
  const controller = new AbortController(), milestones: number[] = [];
  const pending = mockAgent.runMotion(context(), { durationMs: 100, signal: controller.signal, onProgress: p => milestones.push(p.progress) });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(milestones.includes(100), false);
  await assert.rejects(mockAgent.runMotion(context(), { signal: controller.signal }), { name: 'AbortError' });
});

test('HTTP Run sends current context to its own execution endpoint and preserves cancellation', async () => {
  const input = context(), controller = new AbortController();
  const result: RunResult = { status: 'completed', mode: 'hardware', message: 'Device run finished.' };
  let calls = 0;
  const transport = (async (url: string | URL | Request, init?: RequestInit) => {
    calls++;
    assert.equal(String(url), '/api/agent/run');
    assert.equal(init?.method, 'POST');
    assert.equal(init?.credentials, 'same-origin');
    assert.equal(init?.signal, controller.signal);
    assert.deepEqual(JSON.parse(String(init?.body)), { version: 1, ...input });
    return new Response(JSON.stringify(result), { status: 200 });
  }) as typeof fetch;
  const adapter = createHttpAgent('/api/agent/', transport);
  assert.deepEqual(await adapter.runMotion(input, { signal: controller.signal }), result);
  controller.abort();
  await assert.rejects(adapter.runMotion(input, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls, 1);
  const unavailable = createHttpAgent('/api/agent', (async () => new Response('', { status: 503 })) as typeof fetch);
  await assert.rejects(unavailable.runMotion(input), /503/);
});
