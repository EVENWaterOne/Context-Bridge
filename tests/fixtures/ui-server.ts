/** Manual browser fixture. Never imported by the production service. No real inference or credentials. */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../server/app.ts';
import { ClaudeProvider } from '../../server/claude.ts';
import { fakeSdk, message } from './claude-sdk.ts';
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
    // Paced like a real turn so the page's progress, reasoning and streaming views can be checked by eye.
    const wait = (ms: number) => new Promise<void>((yes, no) => { const timer = setTimeout(yes, ms); request.signal.addEventListener('abort', () => { clearTimeout(timer); no(new DOMException('Cancelled', 'AbortError')); }, { once: true }); });
    request.onEvent({ type: 'status', text: 'UI fixture: exercising the real local API and file service' });
    await wait(1200);
    request.onEvent({ type: 'status', text: 'Codex is thinking…' });
    for (const part of ['UI fixture reasoning: reading motion.py', ' and the observation about the abrupt return.']) { request.onEvent({ type: 'reasoning', text: part }); await wait(900); }
    request.onEvent({ type: 'status', text: 'Codex is writing the response…' });
    // UI_FIXTURE_QUESTIONS=1 starts with a question, so the answer flow can be checked in the browser.
    if (request.outputSchema && process.env.UI_FIXTURE_QUESTIONS === '1' && !/"answer": "|continue without answering/.test(request.prompt)) {
      const text = JSON.stringify({ outcome: 'needs_information', title: 'One detail decides the change', summary: 'UI fixture: BIT asks before proposing.', rationale: 'Exercise the answer flow without a model.', evidence: ['motion.py: return_duration = 0.6'], questions: ['Does the arm stop cleanly at home, or does it bounce?'], risk: 'Fixture only.', changes: [] });
      request.onEvent({ type: 'delta', text });
      return { text, threadId: 'fixture-thread' };
    }
    const text = request.outputSchema ? JSON.stringify({ outcome: 'proposal', title: 'Review the return duration', summary: 'UI fixture: a reversible single-file change.', rationale: 'Exercise review, explicit Apply, and Undo on an isolated test file.', evidence: ['motion.py: return_duration = 0.6'], questions: [], risk: 'Fixture only; no real inference or hardware test.', changes: [{ path: 'motion.py', afterContent: 'return_duration = 1.2\n' }] }) : 'UI fixture response: this is read-only chat. No model or hardware was called.';
    for (let index = 0; index < text.length; index += 24) { request.onEvent({ type: 'delta', text: text.slice(index, index + 24) }); await wait(120); }
    return { text, threadId: 'fixture-thread' };
  },
  async close() {},
};
// Claude Code uses the real provider and settings flow with a scripted SDK: no binary, key check or model call.
const claudeProposal = { outcome: 'proposal', title: 'Review the return duration', summary: 'UI fixture (Claude Code): a reversible single-file change.', rationale: 'Exercise review, explicit Apply, and Undo on an isolated test file.', evidence: ['motion.py: return_duration = 0.6'], questions: [], risk: 'Fixture only; no real inference or hardware test.', changes: [{ path: 'motion.py', afterContent: 'return_duration = 1.2\n' }] };
const claudeSdk = fakeSdk(call => call.options.outputFormat
  ? [message.init(['StructuredOutput']), message.toolStart(), message.result(JSON.stringify(claudeProposal), { structured_output: claudeProposal })]
  : [message.init(), message.text('UI fixture (Claude Code): read-only chat. No model or hardware was called.'), message.result('UI fixture (Claude Code): read-only chat. No model or hardware was called.')]);
const claude = new ClaudeProvider({ dataDir: join(directory, 'data'), query: claudeSdk.query });
const app = await createApp({ dataDir: join(directory, 'data'), staticDir: join(root, 'dist'), providers: { codex: provider, claude } });
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
