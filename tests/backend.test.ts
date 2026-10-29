import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join, dirname, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { createApp } from '../server/app.ts';
import type { CodexProvider, CodexRunRequest, CodexRunResult } from '../server/provider.ts';
import type { Store, OperationRecord } from '../server/store.ts';
import type { ApplyResponse, JobView, ProjectScan, Proposal, WorkspaceEnvelope } from '../src/lib/backend-types.ts';
import { makeFile, newRound, type Task } from '../src/lib/workflow.ts';

const origin = 'http://localhost:4173';
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 10));

async function contents(directory: string): Promise<string> {
  let result = '';
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result += await contents(path);
    else if (entry.isFile()) result += `\n${entry.name}\n${await readFile(path, 'utf8')}`;
  }
  return result;
}

class FakeProvider implements CodexProvider {
  replies: string[] = [];
  requests: CodexRunRequest[] = [];
  inputs: string[] = [];
  block = false;
  hold?: Promise<void>;
  aborted = false;
  authenticated = true;
  async status() {
    return { available: true, authenticated: this.authenticated, version: 'fixture', account: this.authenticated ? { type: 'chatgpt' } : null, models: [{ id: 'fixture-model', displayName: 'Fixture model', isDefault: true }] };
  }
  async login() { return { loginId: 'fixture-login', authUrl: 'https://auth.openai.com/fixture' }; }
  async run(request: CodexRunRequest): Promise<CodexRunResult> {
    this.requests.push(request);
    this.inputs.push(`${request.prompt}\n${await contents(request.snapshotDir)}`);
    request.onEvent({ type: 'status', text: 'Reading selected context' });
    if (this.hold) await this.hold;
    if (this.block) {
      await new Promise<void>((_resolve, reject) => {
        const stop = () => { this.aborted = true; reject(new DOMException('Cancelled', 'AbortError')); };
        if (request.signal.aborted) stop();
        else request.signal.addEventListener('abort', stop, { once: true });
      });
    }
    const text = this.replies.shift() ?? 'The selected file controls the return duration.';
    request.onEvent({ type: 'delta', text });
    return { text, threadId: `fixture-thread-${this.requests.length}` };
  }
  async close() {}
  proposal(changes: { path: string; afterContent: string }[]) {
    this.replies.push(JSON.stringify({
      outcome: 'proposal', title: 'Make the return gentler', summary: 'Increase the return duration.',
      rationale: 'The observed return is abrupt. This is a reversible experiment, not hardware verification.',
      evidence: ['motion.py: return_duration'], questions: [], risk: 'Verify actual hardware limits separately.', changes,
    }));
  }
}

async function harness(t: TestContext, provider = new FakeProvider(), options: { fileFault?: (phase: 'after-write', index: number) => void } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'context-bridge-test-'));
  const dataDir = join(directory, 'data');
  let app = await createApp({ dataDir, provider, ...options });
  let cookie = '';
  t.after(async () => {
    await app.close();
    // This is the exact directory returned by mkdtemp for this test, never a project path.
    assert.equal(dirname(resolve(directory)).toLowerCase(), resolve(tmpdir()).toLowerCase());
    assert.ok(basename(directory).startsWith('context-bridge-test-'));
    await rm(directory, { recursive: true, force: true });
  });
  async function session() {
    const response = await app.inject({ method: 'GET', url: '/api/workspace', headers: { host: 'localhost:4173' } });
    assert.equal(response.statusCode, 200, response.body);
    const value = response.headers['set-cookie'];
    const cookies = Array.isArray(value) ? value : value ? [String(value)] : [];
    if (cookies.length) cookie = cookies.map(item => item.split(';')[0]).join('; ');
    assert.ok(cookie, 'A browser-local session must be issued before authenticated mutations');
    return response.json() as WorkspaceEnvelope;
  }
  await session();
  const api = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => app.inject({
    method, url, headers: { host: 'localhost:4173', origin, cookie },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
  async function workspace() {
    const response = await api('GET', '/api/workspace');
    assert.equal(response.statusCode, 200, response.body);
    return response.json() as WorkspaceEnvelope;
  }
  async function seed(files = [makeFile('motion.py', 'return_duration = 0.6\n', 'code')]) {
    const envelope = await workspace();
    const state = structuredClone(envelope.workspace);
    const task = state.tasks.find(item => item.id === state.activeTaskId)!;
    const round = newRound(1);
    round.observation.issues = ['Too fast'];
    round.observation.detail = 'The return is abrupt.';
    task.files = files;
    task.rounds = [round];
    task.activeRoundId = round.id;
    task.hardware.configured = true;
    state.stage = 'request';
    const response = await api('PUT', '/api/workspace', { workspace: state, expectedRevision: envelope.revision });
    assert.equal(response.statusCode, 200, response.body);
    return (response.json() as WorkspaceEnvelope).workspace.tasks.find(item => item.id === task.id)!;
  }
  async function terminal(id: string) {
    for (let i = 0; i < 150; i++) {
      const response = await api('GET', `/api/jobs/${id}`);
      assert.equal(response.statusCode, 200, response.body);
      const job = response.json() as JobView;
      if (job.status !== 'running') return job;
      await tick();
    }
    assert.fail('The bounded fake-provider job did not terminate');
  }
  async function investigate(task: Task) {
    const response = await api('POST', '/api/agent/investigate', { taskId: task.id, roundId: task.activeRoundId });
    assert.equal(response.statusCode, 202, response.body);
    const job = await terminal((response.json() as JobView).id);
    assert.equal(job.status, 'completed', JSON.stringify(job));
    return job.result as Proposal;
  }
  async function apply(task: Task, proposal: Proposal, key = 'apply-once') {
    return api('POST', '/api/agent/apply', { taskId: task.id, roundId: task.activeRoundId, suggestionId: proposal.id, idempotencyKey: key });
  }
  async function bind(task: Task, root: string, paths: string[]) {
    const scanResponse = await api('POST', `/api/tasks/${task.id}/project/scan`, { path: root });
    assert.equal(scanResponse.statusCode, 200, scanResponse.body);
    const scan = scanResponse.json() as ProjectScan;
    const response = await api('POST', `/api/tasks/${task.id}/project/bind`, { rootId: scan.rootId, paths });
    assert.equal(response.statusCode, 200, response.body);
    return { scan, task: (response.json() as WorkspaceEnvelope).workspace.tasks.find(item => item.id === task.id)! };
  }
  return { directory, dataDir, provider, api, workspace, seed, terminal, investigate, apply, bind,
    get app() { return app; }, get cookie() { return cookie; },
    async restart() { await app.close(); app = await createApp({ dataDir, provider, ...options }); await session(); },
  };
}

test('localhost session and origin checks reject a remote website and DNS rebinding', async t => {
  const h = await harness(t);
  const envelope = await h.workspace();
  const payload = { workspace: envelope.workspace, expectedRevision: envelope.revision };
  for (const headers of [
    { host: 'localhost:4173', origin },
    { host: 'localhost:4173', origin: 'https://malicious.example', cookie: h.cookie },
    { host: 'localhost:4173', cookie: h.cookie },
    { host: 'attacker.example:4173', origin: 'http://attacker.example:4173', cookie: h.cookie },
  ]) {
    const response = await h.app.inject({ method: 'PUT', url: '/api/workspace', headers, payload });
    assert.ok(response.statusCode >= 400, response.body);
  }
  for (const url of ['/api/workspace', '/api/status', '/api/jobs/nonexistent/events']) {
    const crossOrigin = await h.app.inject({ method: 'GET', url, headers: { host: 'localhost:4173', origin: 'https://malicious.example', cookie: h.cookie } });
    assert.equal(crossOrigin.statusCode, 403, crossOrigin.body);
  }
  const unpairedStream = await h.app.inject({ method: 'GET', url: '/api/jobs/nonexistent/events', headers: { host: 'localhost:4173' } });
  assert.equal(unpairedStream.statusCode, 401, unpairedStream.body);
  const encodedWrite = await h.app.inject({ method: 'PUT', url: '/%61pi/workspace', headers: { host: 'localhost:4173', origin: 'https://malicious.example' }, payload });
  assert.ok(encodedWrite.statusCode >= 400, 'Encoded API writes require the same session and origin checks');
  for (const url of ['/%61pi/workspace', '/api%2Fworkspace', '//api/workspace', '/api/../api/workspace']) {
    const encoded = await h.app.inject({ method: 'GET', url, headers: { host: 'localhost:4173', origin: 'https://malicious.example' } });
    assert.ok(encoded.statusCode >= 400, `Encoded URL must not bypass the API boundary: ${url} ${encoded.body}`);
  }
  assert.equal((await h.workspace()).revision, envelope.revision);
});

test('two localhost workbenches on different ports keep independent browser sessions', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'context-bridge-test-'));
  const primary = await createApp({ dataDir: join(directory, 'primary'), provider: new FakeProvider() });
  const parallel = await createApp({ dataDir: join(directory, 'parallel'), provider: new FakeProvider() });
  t.after(async () => {
    await primary.close(); await parallel.close();
    assert.equal(dirname(resolve(directory)).toLowerCase(), resolve(tmpdir()).toLowerCase());
    assert.ok(basename(directory).startsWith('context-bridge-test-'));
    await rm(directory, { recursive: true, force: true });
  });
  // Browser cookies are scoped to the hostname, not the port. Both apps therefore
  // receive every localhost cookie; a later Set-Cookie replaces the same name.
  const jar = new Map<string, string>();
  async function browserRequest(app: typeof primary, port: number, method: 'GET' | 'PUT', url: string, payload?: object) {
    const host = `localhost:${port}`;
    const response = await app.inject({ method, url, headers: { host, origin: `http://${host}`, cookie: [...jar.values()].join('; ') }, ...(payload === undefined ? {} : { payload }) });
    const header = response.headers['set-cookie'];
    for (const value of Array.isArray(header) ? header : header ? [String(header)] : []) {
      const pair = value.split(';')[0];
      jar.set(pair.slice(0, pair.indexOf('=')), pair);
    }
    return response;
  }
  const first = await browserRequest(primary, 4173, 'GET', '/api/workspace');
  const second = await browserRequest(parallel, 4175, 'GET', '/api/workspace');
  assert.equal(first.statusCode, 200, first.body); assert.equal(second.statusCode, 200, second.body);
  const primaryState = first.json() as WorkspaceEnvelope, parallelState = second.json() as WorkspaceEnvelope;
  primaryState.workspace.tasks[0].name = 'Primary local workspace';
  parallelState.workspace.tasks[0].name = 'Parallel QA workspace';
  // The production status poll must not invalidate a session just established
  // on the parallel workbench, and vice versa.
  const status = await browserRequest(primary, 4173, 'GET', '/api/status');
  assert.equal(status.statusCode, 200, status.body);
  const saveParallel = await browserRequest(parallel, 4175, 'PUT', '/api/workspace', { workspace: parallelState.workspace, expectedRevision: parallelState.revision });
  assert.equal(saveParallel.statusCode, 200, saveParallel.body);
  const savePrimary = await browserRequest(primary, 4173, 'PUT', '/api/workspace', { workspace: primaryState.workspace, expectedRevision: primaryState.revision });
  assert.equal(savePrimary.statusCode, 200, savePrimary.body);
  assert.equal(jar.size, 2, 'Distinct local listeners need distinct cookie names');
  const loadedPrimary = await browserRequest(primary, 4173, 'GET', '/api/workspace');
  const loadedParallel = await browserRequest(parallel, 4175, 'GET', '/api/workspace');
  assert.equal((loadedPrimary.json() as WorkspaceEnvelope).workspace.tasks[0].name, 'Primary local workspace');
  assert.equal((loadedParallel.json() as WorkspaceEnvelope).workspace.tasks[0].name, 'Parallel QA workspace');
});

test('workspace revision conflicts preserve the latest saved observation', async t => {
  const h = await harness(t);
  const original = await h.workspace();
  const first = structuredClone(original.workspace);
  first.tasks[0].name = 'Latest task name';
  const saved = await h.api('PUT', '/api/workspace', { workspace: first, expectedRevision: original.revision });
  assert.equal(saved.statusCode, 200, saved.body);
  const stale = await h.api('PUT', '/api/workspace', { workspace: original.workspace, expectedRevision: original.revision });
  assert.equal(stale.statusCode, 409, stale.body);
  assert.equal((await h.workspace()).workspace.tasks[0].name, 'Latest task name');
});

test('task import is idempotent and preserves old rounds without applying them', async t => {
  const h = await harness(t);
  const imported = structuredClone((await h.workspace()).workspace.tasks[0]);
  imported.id = 'legacy-task';
  imported.name = 'Imported legacy project';
  imported.files = [makeFile('legacy.py', 'unchanged = True\n', 'code')];
  imported.rounds[0].completedAt = '2026-10-25T10:00:00.000Z';
  imported.rounds[0].applied = true;
  const body = { task: imported, sourceId: 'legacy-export-fixture' };
  const first = await h.api('POST', '/api/workspace/import', body);
  assert.equal(first.statusCode, 200, first.body);
  const repeated = await h.api('POST', '/api/workspace/import', body);
  assert.equal(repeated.statusCode, 200, repeated.body);
  const tasks = (repeated.json() as WorkspaceEnvelope).workspace.tasks.filter(item => item.name === imported.name);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].files[0].content, 'unchanged = True\n');
  assert.equal(tasks[0].rounds[0].completedAt, imported.rounds[0].completedAt);
});

test('imported file diagnosis, exact apply, idempotent retry, restart and undo form a durable loop', async t => {
  const h = await harness(t);
  const task = await h.seed();
  h.provider.proposal([{ path: 'motion.py', afterContent: 'return_duration = 1.2\n' }]);
  const proposal = await h.investigate(task);
  assert.equal(proposal.version, 2);
  assert.equal(proposal.changes.length, 1);
  assert.equal(proposal.changes[0].beforeContent, 'return_duration = 0.6\n');
  assert.match(proposal.changes[0].beforeHash, /^[a-f0-9]{64}$/);
  assert.equal((await h.workspace()).workspace.tasks[0].files[0].content, 'return_duration = 0.6\n', 'Review must not change files');
  const applied = await h.apply(task, proposal);
  assert.equal(applied.statusCode, 200, applied.body);
  const result = applied.json() as ApplyResponse;
  assert.equal(result.workspace.tasks[0].files[0].content, 'return_duration = 1.2\n');
  const retry = await h.apply(task, proposal);
  assert.equal(retry.statusCode, 200, retry.body);
  assert.equal((retry.json() as ApplyResponse).operationId, result.operationId);
  await h.restart();
  assert.equal((await h.workspace()).workspace.tasks[0].files[0].content, 'return_duration = 1.2\n');
  const undone = await h.api('POST', `/api/operations/${result.operationId}/undo`, { idempotencyKey: 'undo-once' });
  assert.equal(undone.statusCode, 200, undone.body);
  assert.equal((undone.json() as ApplyResponse).workspace.tasks[0].files[0].content, 'return_duration = 0.6\n');
  const undoRetry = await h.api('POST', `/api/operations/${result.operationId}/undo`, { idempotencyKey: 'undo-once' });
  assert.equal(undoRetry.statusCode, 200, undoRetry.body);
  assert.equal((await h.workspace()).workspace.tasks[0].files[0].content, 'return_duration = 0.6\n');
});

test('unchecked context and excluded round history never reach the provider', async t => {
  const h = await harness(t);
  const file = { ...makeFile('private.log', 'UNCHECKED_FILE_SENTINEL', 'log'), includeInContext: false };
  const task = await h.seed([makeFile('motion.py', 'return_duration = 0.6\n', 'code'), file]);
  const envelope = await h.workspace();
  const state = structuredClone(envelope.workspace);
  const current = state.tasks.find(item => item.id === task.id)!;
  const previous = newRound(1);
  previous.completedAt = '2026-10-25T10:00:00.000Z';
  previous.observation.detail = 'EXCLUDED_HISTORY_SENTINEL';
  current.rounds.unshift(previous);
  current.rounds.at(-1)!.number = 2;
  current.rounds.at(-1)!.observation.includePrevious = false;
  const saved = await h.api('PUT', '/api/workspace', { workspace: state, expectedRevision: envelope.revision });
  assert.equal(saved.statusCode, 200, saved.body);
  h.provider.proposal([{ path: 'motion.py', afterContent: 'return_duration = 1.2\n' }]);
  await h.investigate(task);
  assert.ok(h.provider.inputs[0].includes('return_duration'));
  assert.ok(!h.provider.inputs[0].includes('UNCHECKED_FILE_SENTINEL'));
  assert.ok(!h.provider.inputs[0].includes('EXCLUDED_HISTORY_SENTINEL'));
});

test('missing-information results are reviewable but cannot be applied', async t => {
  const h = await harness(t);
  const task = await h.seed();
  h.provider.replies.push(JSON.stringify({ outcome: 'needs_information', title: 'Need the actual log', summary: 'The cause is not established.', rationale: 'There is no controller trace.', evidence: [], questions: ['What error does the controller report?'], risk: 'Do not guess limits.', changes: [] }));
  const proposal = await h.investigate(task);
  assert.equal(proposal.outcome, 'needs_information');
  assert.deepEqual(proposal.questions, ['What error does the controller report?']);
  const response = await h.apply(task, proposal);
  assert.ok(response.statusCode >= 400, response.body);
  assert.equal((await h.workspace()).workspace.tasks[0].files[0].content, 'return_duration = 0.6\n');
});

test('linked projects keep same basenames distinct and modify only the reviewed selected file', async t => {
  const h = await harness(t);
  const root = join(h.directory, 'project');
  for (const path of ['src/config.py', 'tests/config.py', '.env', 'node_modules/ignored.py']) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), path.endsWith('.py') ? 'duration = 0.6\r\n' : 'TOKEN=never-import\n');
  }
  const task = await h.seed([]);
  const linked = await h.bind(task, root, ['src/config.py', 'tests/config.py']);
  assert.deepEqual(linked.scan.files.map(file => file.path).sort(), ['src/config.py', 'tests/config.py']);
  assert.equal(linked.task.files.filter(file => file.linked).length, 2);
  h.provider.proposal([{ path: 'src/config.py', afterContent: 'duration = 1.2\n' }]);
  const proposal = await h.investigate(linked.task);
  const response = await h.apply(linked.task, proposal);
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(await readFile(join(root, 'src/config.py'), 'utf8'), 'duration = 1.2\r\n', 'Original CRLF style must be preserved');
  assert.equal(await readFile(join(root, 'tests/config.py'), 'utf8'), 'duration = 0.6\r\n');
});

test('external linked-file edits invalidate proposals and protect later manual work from undo', async t => {
  const h = await harness(t);
  const root = join(h.directory, 'project');
  await mkdir(root);
  const path = join(root, 'motion.py');
  await writeFile(path, 'return_duration = 0.6\n');
  const linked = await h.bind(await h.seed([]), root, ['motion.py']);
  h.provider.proposal([{ path: 'motion.py', afterContent: 'return_duration = 1.2\n' }]);
  const old = await h.investigate(linked.task);
  await writeFile(path, 'return_duration = 0.9\n');
  const conflict = await h.apply(linked.task, old, 'stale-apply');
  assert.equal(conflict.statusCode, 409, conflict.body);
  assert.equal(await readFile(path, 'utf8'), 'return_duration = 0.9\n');
  const refreshed = await h.api('POST', `/api/tasks/${linked.task.id}/project/refresh`);
  assert.equal(refreshed.statusCode, 200, refreshed.body);
  h.provider.proposal([{ path: 'motion.py', afterContent: 'return_duration = 1.2\n' }]);
  const proposal = await h.investigate(linked.task);
  const applied = await h.apply(linked.task, proposal, 'fresh-apply');
  assert.equal(applied.statusCode, 200, applied.body);
  const operation = (applied.json() as ApplyResponse).operationId;
  await writeFile(path, 'return_duration = 2.0 # manual edit\n');
  const undo = await h.api('POST', `/api/operations/${operation}/undo`, { idempotencyKey: 'conflicted-undo' });
  assert.equal(undo.statusCode, 409, undo.body);
  assert.equal(await readFile(path, 'utf8'), 'return_duration = 2.0 # manual edit\n');
});

test('project binding rejects traversal and a directory junction escaping the selected root', async t => {
  const h = await harness(t);
  const root = join(h.directory, 'project'), outside = join(h.directory, 'outside');
  await mkdir(root); await mkdir(outside);
  await writeFile(join(root, 'motion.py'), 'duration = 0.6\n');
  await writeFile(join(outside, 'secret.py'), 'OUTSIDE_PROJECT_SENTINEL\n');
  await symlink(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  const task = await h.seed([]);
  const response = await h.api('POST', `/api/tasks/${task.id}/project/scan`, { path: root });
  assert.equal(response.statusCode, 200, response.body);
  const scan = response.json() as ProjectScan;
  assert.ok(!scan.files.some(file => file.path.includes('secret.py')));
  for (const path of ['../outside/secret.py', 'escape/secret.py']) {
    const bound = await h.api('POST', `/api/tasks/${task.id}/project/bind`, { rootId: scan.rootId, paths: [path] });
    assert.ok(bound.statusCode >= 400, bound.body);
  }
  assert.equal(await readFile(join(outside, 'secret.py'), 'utf8'), 'OUTSIDE_PROJECT_SENTINEL\n');
});

test('cancelling an investigation aborts the actual provider and does not produce a suggestion', async t => {
  const h = await harness(t);
  h.provider.block = true;
  const task = await h.seed();
  const response = await h.api('POST', '/api/agent/investigate', { taskId: task.id, roundId: task.activeRoundId });
  assert.equal(response.statusCode, 202, response.body);
  const id = (response.json() as JobView).id;
  for (let i = 0; i < 100 && !h.provider.requests.length; i++) await tick();
  assert.equal(h.provider.requests.length, 1);
  const cancelled = await h.api('POST', `/api/jobs/${id}/cancel`);
  assert.equal(cancelled.statusCode, 200, cancelled.body);
  const job = await h.terminal(id);
  assert.equal(job.status, 'cancelled');
  assert.equal(h.provider.requests[0].signal.aborted, true);
  for (let i = 0; i < 50 && !h.provider.aborted; i++) await tick();
  assert.equal(h.provider.aborted, true);
  const state = (await h.workspace()).workspace;
  assert.equal(state.tasks[0].rounds.find(round => round.id === task.activeRoundId)?.suggestion, undefined);
});

test('chat is task-bound, persists across restart, and cannot write project files', async t => {
  const h = await harness(t);
  const task = await h.seed();
  const envelope = await h.workspace();
  const second = structuredClone(task);
  second.id = 'another-task';
  second.name = 'Another isolated task';
  const state = { ...envelope.workspace, tasks: [...envelope.workspace.tasks, second] };
  const added = await h.api('PUT', '/api/workspace', { workspace: state, expectedRevision: envelope.revision });
  assert.equal(added.statusCode, 200, added.body);
  h.provider.replies.push('I can explain this change; apply proposals from Review.');
  const response = await h.api('POST', '/api/agent/chat', { taskId: task.id, message: 'Please change the return duration.' });
  assert.equal(response.statusCode, 202, response.body);
  assert.equal((await h.terminal((response.json() as JobView).id)).status, 'completed');
  await h.restart();
  const messages = await h.api('GET', `/api/tasks/${task.id}/messages`);
  assert.equal(messages.statusCode, 200, messages.body);
  const saved = messages.json() as { role: string; text: string }[];
  assert.deepEqual(saved.map(message => message.role), ['you', 'bit']);
  assert.match(saved[1].text, /Review/);
  const other = await h.api('GET', `/api/tasks/${second.id}/messages`);
  assert.equal(other.statusCode, 200, other.body);
  assert.deepEqual(other.json(), []);
  assert.equal((await h.workspace()).workspace.tasks[0].files[0].content, 'return_duration = 0.6\n');
});

test('completed job event streams can be reattached without losing the terminal result', async t => {
  const h = await harness(t);
  const task = await h.seed();
  h.provider.proposal([{ path: 'motion.py', afterContent: 'return_duration = 1.2\n' }]);
  const started = await h.api('POST', '/api/agent/investigate', { taskId: task.id, roundId: task.activeRoundId });
  assert.equal(started.statusCode, 202, started.body);
  const id = (started.json() as JobView).id;
  await h.terminal(id);
  const response = await h.api('GET', `/api/jobs/${id}/events`);
  assert.equal(response.statusCode, 200, response.body);
  assert.match(String(response.headers['content-type']), /text\/event-stream/);
  const data = response.body.split('\n').find(line => line.startsWith('data:'));
  assert.ok(data, response.body);
  const event = JSON.parse(data.slice(5)) as JobView;
  assert.equal(event.id, id);
  assert.equal(event.status, 'completed');
  assert.equal((event.result as Proposal).changes[0].afterContent, 'return_duration = 1.2\n');
});

test('provider schema failures never become applicable suggestions', async t => {
  const h = await harness(t);
  const task = await h.seed();
  h.provider.replies.push('{"changes":"not a change list"}');
  const response = await h.api('POST', '/api/agent/investigate', { taskId: task.id, roundId: task.activeRoundId });
  assert.equal(response.statusCode, 202, response.body);
  const job = await h.terminal((response.json() as JobView).id);
  assert.equal(job.status, 'failed');
  assert.ok(job.error);
  assert.equal((await h.workspace()).workspace.tasks[0].files[0].content, 'return_duration = 0.6\n');
});

test('browser workspace saves cannot forge an approved proposal or applied state', async t => {
  const h = await harness(t);
  const task = await h.seed();
  h.provider.proposal([{ path: 'motion.py', afterContent: 'return_duration = 1.2\n' }]);
  const proposal = await h.investigate(task);
  const envelope = await h.workspace();
  const state = structuredClone(envelope.workspace);
  const round = state.tasks[0].rounds.find(item => item.id === task.activeRoundId)!;
  round.applied = true;
  round.operationId = 'forged-operation';
  round.suggestion = { ...proposal, changes: [{ ...proposal.changes[0], afterContent: 'malicious = True\n' }] };
  const response = await h.api('PUT', '/api/workspace', { workspace: state, expectedRevision: envelope.revision });
  assert.equal(response.statusCode, 200, response.body);
  const saved = (response.json() as WorkspaceEnvelope).workspace.tasks[0].rounds.find(item => item.id === task.activeRoundId)!;
  assert.equal(saved.applied, false);
  assert.equal(saved.operationId, undefined);
  assert.equal(saved.suggestion?.changes?.[0].afterContent, 'return_duration = 1.2\n');
  assert.equal((await h.workspace()).workspace.tasks[0].files[0].content, 'return_duration = 0.6\n');
});

test('a late diagnosis cannot overwrite a newer observation', async t => {
  const h = await harness(t);
  const task = await h.seed();
  let release!: () => void;
  h.provider.hold = new Promise<void>(resolve => { release = resolve; });
  h.provider.proposal([{ path: 'motion.py', afterContent: 'return_duration = 1.2\n' }]);
  const response = await h.api('POST', '/api/agent/investigate', { taskId: task.id, roundId: task.activeRoundId });
  assert.equal(response.statusCode, 202, response.body);
  for (let i = 0; i < 100 && !h.provider.requests.length; i++) await tick();
  const envelope = await h.workspace();
  const state = structuredClone(envelope.workspace);
  state.tasks[0].rounds.find(item => item.id === task.activeRoundId)!.observation.detail = 'A new, different observation.';
  const changed = await h.api('PUT', '/api/workspace', { workspace: state, expectedRevision: envelope.revision });
  assert.equal(changed.statusCode, 200, changed.body);
  release();
  const job = await h.terminal((response.json() as JobView).id);
  assert.notEqual(job.status, 'completed', 'The stale snapshot must not produce a current proposal');
  const saved = (await h.workspace()).workspace.tasks[0].rounds.find(item => item.id === task.activeRoundId)!;
  assert.equal(saved.observation.detail, 'A new, different observation.');
  assert.equal(saved.suggestion, undefined);
});

test('model output cannot target an unchecked file or a path outside the context', async t => {
  const h = await harness(t);
  const task = await h.seed([makeFile('motion.py', 'return_duration = 0.6\n', 'code'), { ...makeFile('private.py', 'secret = True\n', 'code'), includeInContext: false }]);
  for (const path of ['private.py', '../outside.py']) {
    h.provider.proposal([{ path, afterContent: 'overwritten = True\n' }]);
    const response = await h.api('POST', '/api/agent/investigate', { taskId: task.id, roundId: task.activeRoundId });
    assert.equal(response.statusCode, 202, response.body);
    const job = await h.terminal((response.json() as JobView).id);
    assert.equal(job.status, 'failed');
  }
  assert.equal((await h.workspace()).workspace.tasks[0].files.find(file => file.name === 'private.py')?.content, 'secret = True\n');
});

test('a multi-file write failure rolls back already-written files and survives restart', async t => {
  let failOnce = true;
  const h = await harness(t, new FakeProvider(), { fileFault: (_phase, index) => {
    if (failOnce && index === 0) { failOnce = false; throw new Error('Injected storage failure after first replacement'); }
  } });
  const root = join(h.directory, 'project');
  await mkdir(root);
  await writeFile(join(root, 'first.py'), 'duration = 0.6\n');
  await writeFile(join(root, 'second.py'), 'enabled = False\n');
  const linked = await h.bind(await h.seed([]), root, ['first.py', 'second.py']);
  h.provider.proposal([{ path: 'first.py', afterContent: 'duration = 1.2\n' }, { path: 'second.py', afterContent: 'enabled = True\n' }]);
  const proposal = await h.investigate(linked.task);
  const failed = await h.apply(linked.task, proposal);
  assert.ok(failed.statusCode >= 400, failed.body);
  assert.equal(failOnce, false, 'The failure must occur after an actual first-file replacement');
  assert.equal(await readFile(join(root, 'first.py'), 'utf8'), 'duration = 0.6\n');
  assert.equal(await readFile(join(root, 'second.py'), 'utf8'), 'enabled = False\n');
  await h.restart();
  const task = (await h.workspace()).workspace.tasks[0];
  assert.equal(task.rounds.find(item => item.id === task.activeRoundId)?.applied, false);
  assert.equal(task.files.find(file => file.relativePath === 'first.py')?.content, 'duration = 0.6\n');
});

test('startup recovers a process-death journal containing a partly applied physical change', async t => {
  const h = await harness(t);
  const root = join(h.directory, 'project');
  await mkdir(root);
  const before = Buffer.from('duration = 0.6\n'), after = Buffer.from('duration = 1.2\n');
  await writeFile(join(root, 'motion.py'), before);
  const linked = await h.bind(await h.seed([]), root, ['motion.py']);
  const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');
  const operation: OperationRecord = {
    id: `op-${randomUUID()}`, key: `crash-${randomUUID()}`, taskId: linked.task.id, roundId: linked.task.activeRoundId,
    suggestionId: 'fixture-proposal', state: 'applying', createdAt: new Date().toISOString(),
    files: [{ fileId: linked.task.files.find(file => file.linked)!.id, path: 'motion.py', linked: true,
      rootId: linked.scan.rootId, beforeBase64: before.toString('base64'), afterBase64: after.toString('base64'),
      beforeHash: digest(before), afterHash: digest(after) }],
  };
  const store = (h.app as unknown as { bridge: { store: Store } }).bridge.store;
  // A real process may die between replacement and committing workspace state.
  // Construct that durable on-disk boundary instead of pretending a SQLite transaction covers it.
  store.saveOperation(operation);
  store.mutate(state => ({ ...state, stage: 'applying' }));
  await writeFile(join(root, 'motion.py'), after);
  await h.restart();
  assert.deepEqual(await readFile(join(root, 'motion.py')), before);
  const reopened = (h.app as unknown as { bridge: { store: Store } }).bridge.store;
  assert.equal(reopened.operation(operation.id).state, 'failed');
  const state = (await h.workspace()).workspace;
  assert.equal(state.stage, 'review');
  assert.equal(state.tasks[0].files.find(file => file.linked)?.content, before.toString());
});

test('startup marks an unfinished persisted run interrupted and makes it retryable', async t => {
  const h = await harness(t);
  const task = await h.seed();
  const store = (h.app as unknown as { bridge: { store: Store } }).bridge.store;
  const job: JobView = { id: `job-${randomUUID()}`, taskId: task.id, roundId: task.activeRoundId, kind: 'investigate', status: 'running', message: 'Working before process death', text: '', createdAt: new Date().toISOString() };
  store.saveJob(job);
  store.mutate(state => ({ ...state, stage: 'investigating' }));
  await h.restart();
  const restored = await h.api('GET', `/api/jobs/${job.id}`);
  assert.equal(restored.statusCode, 200, restored.body);
  assert.equal((restored.json() as JobView).status, 'interrupted');
  const envelope = await h.workspace();
  assert.deepEqual(envelope.activeJobs, []);
  assert.equal(envelope.workspace.stage, 'request');
});

test('changing an observation invalidates its previously reviewed proposal', async t => {
  const h = await harness(t);
  const task = await h.seed();
  h.provider.proposal([{ path: 'motion.py', afterContent: 'return_duration = 1.2\n' }]);
  const proposal = await h.investigate(task);
  const envelope = await h.workspace();
  const state = structuredClone(envelope.workspace);
  state.tasks[0].rounds.find(round => round.id === task.activeRoundId)!.observation.detail = 'The observed problem has changed.';
  const saved = await h.api('PUT', '/api/workspace', { workspace: state, expectedRevision: envelope.revision });
  assert.equal(saved.statusCode, 200, saved.body);
  const applied = await h.apply(task, proposal);
  assert.equal(applied.statusCode, 409, applied.body);
  assert.equal((await h.workspace()).workspace.tasks[0].files[0].content, 'return_duration = 0.6\n');
});

test('an external edit to any selected linked evidence invalidates the reviewed proposal', async t => {
  const h = await harness(t);
  const root = join(h.directory, 'project');
  await mkdir(root);
  await writeFile(join(root, 'motion.py'), 'return_duration = 0.6\n');
  await writeFile(join(root, 'observed.log'), 'controller timeout\n');
  const linked = await h.bind(await h.seed([]), root, ['motion.py', 'observed.log']);
  h.provider.proposal([{ path: 'motion.py', afterContent: 'return_duration = 1.2\n' }]);
  const proposal = await h.investigate(linked.task);
  await writeFile(join(root, 'observed.log'), 'controller reports a different fault\n');
  const applied = await h.apply(linked.task, proposal);
  assert.equal(applied.statusCode, 409, 'The diagnosis was based on evidence that no longer matches');
  assert.equal(await readFile(join(root, 'motion.py'), 'utf8'), 'return_duration = 0.6\n');
});

test('a completed round cannot be replayed after undoing its old operation', async t => {
  const h = await harness(t);
  const task = await h.seed();
  h.provider.proposal([{ path: 'motion.py', afterContent: 'return_duration = 1.2\n' }]);
  const proposal = await h.investigate(task);
  const applied = await h.apply(task, proposal);
  assert.equal(applied.statusCode, 200, applied.body);
  const operationId = (applied.json() as ApplyResponse).operationId;
  const envelope = await h.workspace();
  const state = structuredClone(envelope.workspace);
  state.tasks[0].rounds.find(round => round.id === task.activeRoundId)!.completedAt = new Date().toISOString();
  const next = newRound(2);
  state.tasks[0].rounds.push(next);
  state.tasks[0].activeRoundId = next.id;
  state.stage = 'observe';
  const saved = await h.api('PUT', '/api/workspace', { workspace: state, expectedRevision: envelope.revision });
  assert.equal(saved.statusCode, 200, saved.body);
  const undone = await h.api('POST', `/api/operations/${operationId}/undo`, { idempotencyKey: 'undo-history' });
  assert.equal(undone.statusCode, 200, undone.body);
  const replay = await h.apply(task, proposal, 'replay-completed');
  assert.equal(replay.statusCode, 409, 'A completed, inactive round requires a new diagnosis in the current round');
});

test('an old operation cannot silently target the previous project after rebinding the task', async t => {
  const h = await harness(t);
  const oldRoot = join(h.directory, 'original-project'), nextRoot = join(h.directory, 'new-project');
  await mkdir(oldRoot); await mkdir(nextRoot);
  await writeFile(join(oldRoot, 'motion.py'), 'return_duration = 0.6\n');
  await writeFile(join(nextRoot, 'motion.py'), 'return_duration = 1.2\n');
  const linked = await h.bind(await h.seed([]), oldRoot, ['motion.py']);
  h.provider.proposal([{ path: 'motion.py', afterContent: 'return_duration = 1.2\n' }]);
  const proposal = await h.investigate(linked.task);
  const applied = await h.apply(linked.task, proposal);
  assert.equal(applied.statusCode, 200, applied.body);
  const operationId = (applied.json() as ApplyResponse).operationId;
  const envelope = await h.workspace();
  const state = structuredClone(envelope.workspace);
  state.tasks[0].rounds.find(round => round.id === linked.task.activeRoundId)!.completedAt = new Date().toISOString();
  const next = newRound(2);
  state.tasks[0].rounds.push(next); state.tasks[0].activeRoundId = next.id;
  const saved = await h.api('PUT', '/api/workspace', { workspace: state, expectedRevision: envelope.revision });
  assert.equal(saved.statusCode, 200, saved.body);
  await h.bind(linked.task, nextRoot, ['motion.py']);
  const undone = await h.api('POST', `/api/operations/${operationId}/undo`, { idempotencyKey: 'undo-after-rebind' });
  assert.equal(undone.statusCode, 409, 'Undo must not write a different root from the task currently displayed');
  assert.equal(await readFile(join(oldRoot, 'motion.py'), 'utf8'), 'return_duration = 1.2\n');
  assert.equal(await readFile(join(nextRoot, 'motion.py'), 'utf8'), 'return_duration = 1.2\n');
});

test('a forged new task cannot inherit a real-project binding or an applicable proposal', async t => {
  const h = await harness(t);
  const task = await h.seed();
  h.provider.proposal([{ path: 'motion.py', afterContent: 'return_duration = 1.2\n' }]);
  const proposal = await h.investigate(task);
  const envelope = await h.workspace();
  const state = structuredClone(envelope.workspace);
  const forged = structuredClone(state.tasks[0]);
  forged.id = 'forged-linked-task'; forged.rootId = 'forged-root'; forged.rootPath = join(h.directory, 'outside');
  forged.files[0].linked = true;
  state.tasks.push(forged);
  const saved = await h.api('PUT', '/api/workspace', { workspace: state, expectedRevision: envelope.revision });
  assert.equal(saved.statusCode, 200, saved.body);
  const clean = (saved.json() as WorkspaceEnvelope).workspace.tasks.find(item => item.id === forged.id)!;
  assert.equal(clean.rootId, undefined); assert.equal(clean.rootPath, undefined);
  assert.equal(clean.files[0].linked, false); assert.equal(clean.rounds[0].suggestion, undefined);
  const applied = await h.apply(forged, proposal, 'forged-apply');
  assert.equal(applied.statusCode, 409, applied.body);
});

test('undo recovery retains its rollback direction when an external edit delays recovery', async t => {
  const h = await harness(t);
  const root = join(h.directory, 'project');
  await mkdir(root);
  await writeFile(join(root, 'first.py'), 'duration = 0.6\n');
  await writeFile(join(root, 'second.py'), 'enabled = False\n');
  const linked = await h.bind(await h.seed([]), root, ['first.py', 'second.py']);
  h.provider.proposal([{ path: 'first.py', afterContent: 'duration = 1.2\n' }, { path: 'second.py', afterContent: 'enabled = True\n' }]);
  const proposal = await h.investigate(linked.task);
  const applied = await h.apply(linked.task, proposal);
  assert.equal(applied.statusCode, 200, applied.body);
  const operationId = (applied.json() as ApplyResponse).operationId;
  let store = (h.app as unknown as { bridge: { store: Store } }).bridge.store;
  const operation = store.operation(operationId);
  operation.state = 'undoing'; store.saveOperation(operation);
  // Process death during Undo: one file reverted, the other externally changed.
  await writeFile(join(root, 'first.py'), 'duration = 0.6\n');
  await writeFile(join(root, 'second.py'), 'enabled = manual_edit\n');
  await h.restart();
  store = (h.app as unknown as { bridge: { store: Store } }).bridge.store;
  assert.equal(store.operation(operationId).state, 'recovery_required');
  // The owner resolves their external edit to the last fully-applied bytes.
  await writeFile(join(root, 'second.py'), 'enabled = True\n');
  await h.restart();
  store = (h.app as unknown as { bridge: { store: Store } }).bridge.store;
  assert.equal(store.operation(operationId).state, 'applied', 'Interrupted Undo recovery must restore the previously applied state');
  assert.equal(await readFile(join(root, 'first.py'), 'utf8'), 'duration = 1.2\n');
  assert.equal(await readFile(join(root, 'second.py'), 'utf8'), 'enabled = True\n');
  const current = (await h.workspace()).workspace.tasks[0];
  assert.equal(current.rounds.find(round => round.id === linked.task.activeRoundId)?.applied, true);
  assert.equal(current.files.find(file => file.relativePath === 'first.py')?.content, 'duration = 1.2\n');
});
