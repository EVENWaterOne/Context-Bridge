/** Manual browser fixture. Never imported by the production service. No real inference or credentials. */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../server/app.ts';
import { createExampleWorkspace } from '../../src/lib/workflow.ts';
import type { CodexProvider, CodexRunRequest } from '../../server/provider.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const directory = mkdtempSync(join(tmpdir(), 'context-bridge-ui-'));
const project = join(directory, 'fixture-project');
mkdirSync(project);
const original = 'return_duration = 0.6\r\n';
writeFileSync(join(project, 'motion.py'), original);
const provider: CodexProvider = {
  async status() { return { available: true, authenticated: true, version: 'UI FIXTURE (no model)', account: { type: 'fixture', email: 'UI fixture — no real inference' }, models: [{ id: 'fixture', displayName: 'Fixture model', isDefault: true }] }; },
  async login() { throw new Error('No authentication in this test-only fixture.'); },
  async run(request: CodexRunRequest) {
    request.onEvent({ type: 'status', text: 'UI fixture: exercising the real local API and file service' });
    await new Promise<void>((yes, no) => { const timer = setTimeout(yes, 200); request.signal.addEventListener('abort', () => { clearTimeout(timer); no(new DOMException('Cancelled', 'AbortError')); }, { once: true }); });
    const text = request.outputSchema ? JSON.stringify({ outcome: 'proposal', title: 'Review the return duration', summary: 'UI fixture: a reversible single-file change.', rationale: 'Exercise review, explicit Apply, and Undo on an isolated test file.', evidence: ['motion.py: return_duration = 0.6'], questions: [], risk: 'Fixture only; no real inference or hardware test.', changes: [{ path: 'motion.py', afterContent: 'return_duration = 1.2\n' }] }) : 'UI fixture response: this is read-only chat. No model or hardware was called.';
    request.onEvent({ type: 'delta', text });
    return { text, threadId: 'fixture-thread' };
  },
  async close() {},
};
const app = await createApp({ dataDir: join(directory, 'data'), staticDir: join(root, 'dist'), provider });
const state = createExampleWorkspace();
state.tasks = state.tasks.slice(0,1);
state.tasks[0].name = 'UI verification fixture';
state.tasks[0].files = [];
state.tasks[0].hardware.configured = true;
const round = state.tasks[0].rounds.find(r => r.id === state.tasks[0].activeRoundId)!;
round.observation.issues = ['Too fast'];
round.observation.detail = 'Fixture observation: the return feels abrupt.';
state.stage = 'observe';
app.bridge.store.save(state, app.bridge.store.envelope().revision);
const scan = app.bridge.files.scan(state.activeTaskId, project);
app.bridge.files.bind(state.activeTaskId, scan.rootId, ['motion.py']);
await app.listen({ host: '127.0.0.1', port: 4175 });
process.stdout.write(`TEST-ONLY workbench: http://localhost:4175\nFixture project: ${project}\n`);
process.once('SIGINT', () => { void app.close(); });
process.once('SIGTERM', () => { void app.close(); });
