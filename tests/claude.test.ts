import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { ClaudeProvider } from '../server/claude.ts';
import type { CodexRunRequest } from '../server/provider.ts';
import { aborted, fakeSdk, message, type Script } from './fixtures/claude-sdk.ts';

const KEY = 'sk-ant-api03-test-key-0123456789-abcd';
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 5));

async function setup(t: TestContext, script?: Script, options: Partial<ConstructorParameters<typeof ClaudeProvider>[0]> = {}, init?: Parameters<typeof fakeSdk>[1]) {
  const dataDir = await mkdtemp(join(tmpdir(), 'context-bridge-claude-'));
  const sdk = fakeSdk(script, init);
  const provider = new ClaudeProvider({ dataDir, query: sdk.query, ...options });
  t.after(async () => { await provider.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { dataDir, sdk, provider };
}
function request(overrides: Partial<CodexRunRequest> = {}): CodexRunRequest & { events: { type: string; text: string }[] } {
  const events: { type: string; text: string }[] = [];
  return { prompt: 'Diagnose the selected context.', snapshotDir: '/unused', signal: new AbortController().signal, onEvent: event => events.push(event), events, ...overrides };
}

test('Claude Code starts unauthenticated and reports its catalog without calling a model', async t => {
  const { provider, sdk } = await setup(t);
  const status = await provider.status();
  assert.equal(status.available, true);
  assert.equal(status.authenticated, false);
  assert.equal(status.version, '2.1.312');
  assert.deepEqual(status.models.map(model => model.id), ['sonnet', 'opus'], 'The default alias is the empty model choice');
  assert.deepEqual(status.claude, { method: 'api_key', apiKey: null, localLoginAllowed: false });
  assert.equal(sdk.runs().length, 0);
  const probe = sdk.calls[0];
  assert.equal(typeof probe.prompt, 'object', 'The probe sends no prompt');
  assert.equal(probe.closed, true, 'The probe process is closed after initialize');
  await provider.status();
  assert.equal(sdk.calls.length, 1, 'Status is cached while the credential is unchanged');
});

test('an empty Claude Code catalog falls back to the stable model aliases', async t => {
  const { provider } = await setup(t, undefined, {}, { account: {}, models: [], claude_code_version: '2.1.312' });
  assert.deepEqual((await provider.status()).models.map(model => model.id), ['sonnet', 'opus', 'haiku']);
});

test('API keys are validated, saved owner-only, never echoed, and override the environment key', async t => {
  const { provider, dataDir } = await setup(t, undefined, { environmentApiKey: 'sk-ant-api03-environment-key-wxyz' });
  let status = await provider.status();
  assert.equal(status.authenticated, true);
  assert.deepEqual(status.claude?.apiKey, { source: 'environment', hint: 'sk-ant-…wxyz' });
  for (const bad of ['', 'short', 'sk-ant-oat01-subscription-token-value-123', 'sk-ant-admin01-administrator-key-value-123', 'sk-ant-api03 with spaces in the middle']) {
    assert.throws(() => provider.saveApiKey(bad), (error: Error & { statusCode?: number }) => error.statusCode === 400, bad);
  }
  provider.saveApiKey(`  ${KEY}\n`);
  status = await provider.status();
  assert.deepEqual(status.claude?.apiKey, { source: 'saved', hint: 'sk-ant-…abcd' });
  assert.deepEqual(status.account, { type: 'api_key' });
  assert.ok(!JSON.stringify(status).includes(KEY.slice(10)), 'Status never contains the key');
  const file = join(dataDir, 'claude', 'auth.json');
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { version: 1, method: 'api_key', apiKey: KEY });
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
  provider.removeApiKey();
  status = await provider.status();
  assert.equal(status.claude?.apiKey?.source, 'environment', 'Removing the saved key falls back to ANTHROPIC_API_KEY');
});

test('runs use the reviewed read-only, isolated Claude Code configuration', async t => {
  const previous = { base: process.env.ANTHROPIC_BASE_URL, token: process.env.CLAUDE_CODE_OAUTH_TOKEN, nested: process.env.CLAUDECODE, bash: process.env.CLAUDE_CODE_GIT_BASH_PATH };
  process.env.ANTHROPIC_BASE_URL = 'https://relay.invalid'; process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-other-session'; process.env.CLAUDECODE = '1'; process.env.CLAUDE_CODE_GIT_BASH_PATH = 'C:\\Git\\bin\\bash.exe';
  t.after(() => { for (const [name, value] of Object.entries({ ANTHROPIC_BASE_URL: previous.base, CLAUDE_CODE_OAUTH_TOKEN: previous.token, CLAUDECODE: previous.nested, CLAUDE_CODE_GIT_BASH_PATH: previous.bash })) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  const { provider, sdk, dataDir } = await setup(t, () => [message.init(), message.text('Check '), message.text('motion.py.', 'toolu_sub'), message.text('the return.'), message.result('Check the return.')]);
  provider.saveApiKey(KEY);
  assert.equal((await provider.status()).authenticated, true);
  const run = request({ model: 'opus' });
  const result = await provider.run(run);
  assert.deepEqual(result, { text: 'Check the return.', threadId: 'fake-session' });
  assert.deepEqual(run.events, [{ type: 'delta', text: 'Check ' }, { type: 'delta', text: 'the return.' }], 'Only top-level text is streamed');
  const call = sdk.runs()[0];
  const { env, abortController, stderr, ...options } = call.options;
  assert.ok(abortController instanceof AbortController);
  assert.equal(typeof stderr, 'function');
  assert.deepEqual(options, {
    cwd: options.cwd, tools: [], allowedTools: [], mcpServers: {}, strictMcpConfig: true, plugins: [],
    settingSources: [], persistSession: false, permissionMode: 'dontAsk', verbatimPrompts: true, title: 'Context Bridge',
    systemPrompt: options.systemPrompt, includePartialMessages: true, model: 'opus',
  });
  assert.match(String(options.systemPrompt), /untrusted data/);
  assert.equal(call.prompt, 'Diagnose the selected context.');
  assert.equal(env?.ANTHROPIC_API_KEY, KEY);
  assert.equal(env?.CLAUDE_CONFIG_DIR, join(dataDir, 'claude', 'config'), 'API-key runs use an isolated profile');
  assert.equal(env?.CLAUDE_AGENT_SDK_CLIENT_APP, 'context-bridge/2.0.0');
  assert.equal(env?.ANTHROPIC_BASE_URL, undefined, 'Requests go to the official API');
  assert.equal(env?.CLAUDE_CODE_OAUTH_TOKEN, undefined, 'Another session\'s login never leaks in');
  assert.equal(env?.CLAUDECODE, undefined);
  assert.equal(env?.CLAUDE_CODE_GIT_BASH_PATH, 'C:\\Git\\bin\\bash.exe');
  assert.equal(env?.PATH ?? env?.Path, process.env.PATH ?? process.env.Path);
  assert.equal(env?.CLAUDE_CODE_DISABLE_REFUSAL_RETRY, '1', 'A refusal is not resent');
  assert.equal(env?.CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK, '1', 'A refusal is not answered by another model');
  assert.equal(call.closed, true);
  // Claude Code describes its working folder to the model, so it runs in an empty temporary folder
  // that also holds Claude Code's own scratch files.
  const cwd = String(options.cwd), runtime = dirname(cwd);
  assert.equal(resolve(dirname(runtime)), resolve(tmpdir()));
  assert.ok(basename(runtime).startsWith('context-bridge-claude-') && !cwd.startsWith(dataDir), cwd);
  assert.deepEqual([env?.TMPDIR, env?.TMP, env?.TEMP], Array(3).fill(join(runtime, 'tmp')));
  const [probe] = sdk.calls;
  assert.equal(probe.probe, true);
  assert.equal(probe.options.cwd, cwd, 'Probes and runs share the folder');
  await provider.close();
  assert.equal(existsSync(runtime), false, 'The folder is removed on close');
});

test('a working folder removed by the system temp cleaner is made again', async t => {
  const { provider, sdk } = await setup(t);
  await provider.status();
  const first = dirname(String(sdk.calls[0].options.cwd));
  await rm(first, { recursive: true, force: true });
  provider.saveApiKey(KEY);
  assert.equal((await provider.status()).available, true);
  const second = String(sdk.calls[1].options.cwd);
  assert.ok(existsSync(second) && !second.startsWith(first), second);
});

test('diagnosis uses a JSON schema and returns the structured result as text', async t => {
  const proposal = { outcome: 'needs_information', title: 'More evidence', summary: '', rationale: '', evidence: [], questions: ['Which servo?'], risk: '', changes: [] };
  const { provider, sdk } = await setup(t, () => [message.init(['StructuredOutput']), message.toolStart(), message.toolUse('StructuredOutput', proposal), message.result(JSON.stringify(proposal), { structured_output: proposal })]);
  provider.saveApiKey(KEY);
  const schema = { type: 'object', properties: { outcome: { type: 'string' } } };
  const run = request({ outputSchema: schema });
  const result = await provider.run(run);
  assert.deepEqual(JSON.parse(result.text), proposal);
  assert.deepEqual(sdk.runs()[0].options.outputFormat, { type: 'json_schema', schema });
  assert.deepEqual(run.events, [{ type: 'status', text: 'Writing the structured proposal…' }]);
});

test('runs refuse to start without a credential', async t => {
  const { provider, sdk } = await setup(t);
  await assert.rejects(provider.run(request()), /Add an Anthropic API key/);
  assert.equal(sdk.runs().length, 0);
});

for (const [name, script, expected] of [
  ['an unexpected tool in the session', () => [message.init(['StructuredOutput', 'Bash'])], /safety configuration was not applied: tools/],
  ['an MCP server in the session', () => [message.init([], { mcp_servers: [{ name: 'other', status: 'connected' }] })], /MCP servers/],
  ['a permission mode other than dontAsk', () => [message.init([], { permissionMode: 'bypassPermissions' })], /permissions/],
  ['a disabled tool call', () => [message.init(), message.toolUse('Read', { file_path: '/etc/passwd' })], /attempted a disabled tool: Read/],
  ['an invalid key, without minutes of retries', () => [message.init(), message.retry('authentication_failed'), message.retry('authentication_failed', 2), message.result('late')], /Anthropic rejected the credentials/],
  ['a billing failure', () => [message.init(), message.apiError('billing_error'), message.result('API Error: 400 credit balance too low', { is_error: true })], /billing problem/],
  ['an API error result', () => [message.init(), message.result('API Error: 500 upstream', { is_error: true })], /request failed: API Error: 500 upstream/],
  ['a declined request, keeping the explanation', () => [message.init(), message.apiError('invalid_request'), message.result('API Error: the safeguards flagged this message. Try rephrasing the request.', { is_error: true, stop_reason: 'refusal' })], /Claude declined this request\. API Error: the safeguards flagged this message/],
  ['an answer from a fallback model after a refusal', () => [message.init(), message.refusalFallback(), message.text('Fallback answer.'), message.result('Fallback answer.')], /Claude declined this request/],
  ['an invalid request, keeping the explanation', () => [message.init(), message.apiError('invalid_request'), message.result('API Error: 400 prompt is too long', { is_error: true })], /Anthropic rejected the request: API Error: 400 prompt is too long$/],
  ['a structured output that never validates', () => [message.init(['StructuredOutput']), message.failure('error_max_structured_output_retries', ['invalid'])], /valid structured proposal/],
  ['an execution error', () => [message.init(), message.failure('error_during_execution', ['boom'])], /stopped \(error_during_execution\): boom/],
  ['a missing structured result', () => [message.init(['StructuredOutput']), message.result('plain text')], /without the requested structured result/],
  ['an empty answer', () => [message.init(), message.result('  ')], /without a response/],
  ['a stream without a result', () => [message.init()], /ended without a result/],
] as [string, Script, RegExp][]) {
  test(`Claude Code runs fail closed on ${name}`, async t => {
    const { provider, sdk } = await setup(t, script);
    provider.saveApiKey(KEY);
    await assert.rejects(provider.run(request({ outputSchema: /structured/.test(name) ? { type: 'object' } : undefined })), expected);
    assert.equal(sdk.runs()[0].closed, true, 'The Claude Code process is always closed');
  });
}

test('the retry notice is shown for transient API errors', async t => {
  const { provider } = await setup(t, () => [message.init(), message.retry('overloaded', 2), message.text('ok'), message.result('ok')]);
  provider.saveApiKey(KEY);
  const run = request();
  await provider.run(run);
  assert.deepEqual(run.events[0], { type: 'status', text: 'Anthropic API is busy; retrying (2/10)…' });
});

test('cancellation aborts the Claude Code process and only one run is active', async t => {
  let started!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  const { provider, sdk } = await setup(t, call => (async function* () { yield message.init(); started(); await aborted(call); })());
  provider.saveApiKey(KEY);
  const controller = new AbortController();
  const pending = provider.run(request({ signal: controller.signal }));
  await running;
  await assert.rejects(provider.run(request()), /already active/);
  controller.abort();
  await assert.rejects(pending, (error: Error) => error.name === 'AbortError');
  const call = sdk.runs()[0];
  assert.equal(call.options.abortController?.signal.aborted, true);
  assert.equal(call.closed, true);
  await assert.rejects(provider.run(request({ signal: controller.signal })), (error: Error) => error.name === 'AbortError');
});

test('closing the provider stops an active run', async t => {
  const { provider, sdk } = await setup(t, call => (async function* () { yield message.init(); await aborted(call); })());
  provider.saveApiKey(KEY);
  const pending = provider.run(request());
  for (let i = 0; i < 50 && !sdk.runs().length; i++) await tick();
  await provider.close();
  await assert.rejects(pending, /provider closed/);
  assert.equal(sdk.runs()[0].closed, true);
  await assert.rejects(provider.run(request()), /closed/);
});

test('oversized streamed answers are stopped', async t => {
  const { provider } = await setup(t, () => [message.init(), message.text('x'.repeat(5 * 1024 * 1024)), message.text('y'.repeat(4 * 1024 * 1024)), message.result('done')]);
  provider.saveApiKey(KEY);
  await assert.rejects(provider.run(request()), /size limit/);
});

test('local Claude Code login is personal-only and must be enabled by the service', async t => {
  const { provider } = await setup(t);
  await assert.rejects(async () => provider.setAuthMethod('local_login'), (error: Error & { statusCode?: number }) => error.statusCode === 403 && /personal use/.test(error.message));
  assert.throws(() => provider.setAuthMethod('oauth'), /Choose API key/);
});

test('local login uses this computer\'s Claude Code profile without any API key', async t => {
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = '/home/maker/.claude-custom';
  t.after(() => { if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous; });
  let account: Record<string, unknown> = {};
  const { provider, sdk } = await setup(t, undefined, { allowLocalLogin: true, environmentApiKey: 'sk-ant-api03-environment-key-wxyz' }, () => ({ account, models: [], claude_code_version: '2.1.312' }));
  provider.setAuthMethod('local_login');
  let status = await provider.status();
  assert.equal(status.authenticated, false);
  assert.match(String(status.error), /No Claude Code login/);
  assert.equal(status.claude?.method, 'local_login');
  assert.equal(status.claude?.localLoginAllowed, true);
  account = { email: 'maker@example.com', subscriptionType: 'max', tokenSource: 'claude.ai' };
  status = await provider.status();
  assert.equal(status.authenticated, true, 'A new local sign-in is seen without waiting for the cache');
  assert.deepEqual(status.account, { type: 'claude_login', email: 'maker@example.com', planType: 'max' });
  await provider.run(request());
  const env = sdk.runs().at(-1)!.options.env!;
  assert.equal(env.ANTHROPIC_API_KEY, undefined, 'Local login never sends an API key');
  assert.equal(env.CLAUDE_CONFIG_DIR, '/home/maker/.claude-custom');
  provider.setAuthMethod('api_key');
  assert.equal((await provider.status()).claude?.apiKey?.source, 'environment');
});

test('a provider with local login disabled ignores a saved local-login choice', async t => {
  const { provider, dataDir } = await setup(t);
  await mkdir(join(dataDir, 'claude'), { recursive: true });
  await writeFile(join(dataDir, 'claude', 'auth.json'), JSON.stringify({ version: 1, method: 'local_login' }));
  const status = await provider.status();
  assert.equal(status.claude?.method, 'api_key');
  await assert.rejects(provider.run(request()), /Add an Anthropic API key/);
});

test('unreadable saved settings make Claude Code unavailable until they are replaced', async t => {
  const { provider, dataDir } = await setup(t, undefined, { allowLocalLogin: true });
  const file = join(dataDir, 'claude', 'auth.json');
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, '{broken');
  const status = await provider.status();
  assert.equal(status.available, false);
  assert.match(String(status.error), /unreadable\. Paste an API key to replace them/);
  assert.deepEqual(status.claude, { method: 'api_key', apiKey: null, localLoginAllowed: true, settingsUnreadable: true }, 'The page can still offer every repair');
  provider.saveApiKey(KEY);
  assert.equal((await provider.status()).authenticated, true);
  for (const repair of [() => provider.removeApiKey(), () => provider.setAuthMethod('local_login')]) {
    await writeFile(file, '{broken');
    repair();
    const repaired = await provider.status();
    assert.equal(repaired.available, true, repaired.error);
    assert.equal(repaired.claude?.settingsUnreadable, undefined);
  }
});

test('a missing Claude Code binary is reported without leaving a probe timer behind', async t => {
  const query = (() => { throw new Error('Native CLI binary for this platform not found'); }) as unknown as NonNullable<ConstructorParameters<typeof ClaudeProvider>[0]['query']>;
  const { provider } = await setup(t, undefined, { query, probeTimeoutMs: 60_000 });
  const timers = () => process.getActiveResourcesInfo().filter(name => name === 'Timeout').length;
  const before = timers();
  const status = await provider.status();
  assert.equal(status.available, false);
  assert.match(String(status.error), /Native CLI binary/);
  assert.equal(timers(), before, 'The 60 s probe timeout was cleared');
});

test('closing while the SDK loads never starts Claude Code', async t => {
  const { provider, sdk } = await setup(t);
  const pending = provider.status();
  await provider.close();
  const status = await pending;
  assert.equal(status.available, false);
  assert.match(String(status.error), /closed/);
  assert.equal(sdk.calls.length, 0);
});

test('Claude Code login() points to API-key setup instead of a subscription sign-in', async t => {
  const { provider } = await setup(t);
  await assert.rejects(provider.login(), /Anthropic API key/);
});
