import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalCodexProvider } from '../server/codex.ts';

// A real stdio child with no Codex account or network access. Its protocol shape
// is taken from the project's pinned 0.164.0 generated app-server schema.
const FAKE_SERVER = `
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const mode=process.env.FAKE_MODE, config=JSON.parse(process.env.FAKE_CONFIG);
let initialized=false;
const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
const reply=(m,result)=>send({id:m.id,result});
const event=(method,params)=>send({method,params});
const terminal=status=>event('turn/completed',{threadId:'thread-1',turn:{id:'turn-1',status,items:[],error:status==='failed'?{message:'model unavailable'}:null}});
createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line); appendFileSync(process.env.FAKE_LOG,line+'\\n');
 if(m.method==='initialize'){reply(m,{userAgent:'fake/0.164.0'});return;}
 if(m.method==='initialized'){initialized=true;return;}
 if(!initialized){send({id:m.id,error:{message:'Not initialized'}});return;}
 if(m.method==='config/read'){if(mode==='unsafe')config.features.shell_tool=true;reply(m,{config,origins:{}});return;}
 if(m.method==='mcpServerStatus/list'){reply(m,{data:mode==='mcp'?[{name:'unexpected'}]:[],nextCursor:null});return;}
 if(m.method==='account/read'){
  if(mode==='hang')return;
  if(mode==='invalid'){process.stdout.write('{broken JSON\\n');return;}
  reply(m,{account:mode==='loggedout'?null:{type:'chatgpt',email:'test@example.com',planType:'plus'},requiresOpenaiAuth:true});return;
 }
 if(m.method==='account/login/start'){reply(m,{type:'chatgpt',loginId:'login-1',authUrl:'https://auth.openai.com/test'});return;}
 if(m.method==='model/list'){reply(m,{data:[{id:'catalog-id',model:'gpt-test',displayName:'Test model',isDefault:true,hidden:false}],nextCursor:null});return;}
 if(m.method==='thread/start'){reply(m,{thread:{id:'thread-1'}});return;}
 if(m.method==='turn/start'){
  if(mode==='crash'){process.exit(7);return;}
  if(mode==='rpcerror'){send({id:m.id,error:{message:'request rejected'}});return;}
  if(mode!=='early')reply(m,{turn:{id:'turn-1',status:'inProgress',items:[]}});
  event('turn/started',{threadId:'thread-1',turn:{id:'turn-1',status:'inProgress'}});
  if(mode==='stall'||mode==='interrupt')return;
  if(mode==='tool'){event('item/started',{threadId:'thread-1',turnId:'turn-1',item:{id:'tool-1',type:'fileChange'}});return;}
  if(mode==='approval'){send({id:'server-approval',method:'item/fileChange/requestApproval',params:{threadId:'thread-1',turnId:'turn-1'}});return;}
  if(mode==='failure'){terminal('failed');return;}
  if(mode==='empty'){terminal('completed');return;}
  if(mode==='oversized'){
   event('item/agentMessage/delta',{threadId:'thread-1',turnId:'turn-1',itemId:'large-comment',delta:'x'.repeat(5*1024*1024)});
   event('turn/completed',{threadId:'thread-1',turn:{id:'turn-1',status:'completed',items:[{id:'large-answer',type:'agentMessage',text:'y'.repeat(4*1024*1024),phase:'final_answer'}]}});return;
  }
  event('item/agentMessage/delta',{threadId:'different-thread',turnId:'turn-1',itemId:'foreign',delta:'WRONG'});
  event('item/started',{threadId:'thread-1',turnId:'turn-1',item:{id:'comment',type:'agentMessage',text:'',phase:'commentary'}});
  event('item/agentMessage/delta',{threadId:'thread-1',turnId:'turn-1',itemId:'comment',delta:'Checking...'});
  event('item/completed',{threadId:'thread-1',turnId:'turn-1',item:{id:'comment',type:'agentMessage',text:'Checking...',phase:'commentary'}});
  const delta=JSON.stringify({method:'item/agentMessage/delta',params:{threadId:'thread-1',turnId:'turn-1',itemId:'answer',delta:'{"answer":'}})+'\\n';
  process.stdout.write(delta.slice(0,23));process.stdout.write(delta.slice(23));
  event('item/agentMessage/delta',{threadId:'thread-1',turnId:'turn-1',itemId:'answer',delta:'"done"}'});
  event('item/completed',{threadId:'thread-1',turnId:'turn-1',item:{id:'answer',type:'agentMessage',phase:'final_answer',text:'{"answer":"done"}'}});
  terminal('completed');
  if(mode==='early')reply(m,{turn:{id:'turn-1',status:'inProgress',items:[]}});
  return;
 }
 if(m.method==='turn/interrupt'){reply(m,{});if(mode==='interrupt')terminal('interrupted');return;}
});
`;

async function setup(t: { after: (fn: () => Promise<void>) => void }, mode = 'normal', timeout = 500, runTimeout = timeout * 5) {
  const root = await mkdtemp(join(tmpdir(), 'context-bridge-codex-test-'));
  const snapshot = join(root, 'snapshots', 'one'); await mkdir(snapshot, { recursive: true });
  const log = join(root, 'requests.jsonl');
  let launches = 0;
  let launchContext: { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv } | undefined;
  const provider = new LocalCodexProvider({
    dataDir: root, rpcTimeoutMs: timeout, runTimeoutMs: runTimeout, cancelGraceMs: 100,
    processFactory(context) {
      launches++; launchContext = context;
      const config: Record<string, unknown> = {};
      for (let index = 0; index < context.args.length; index++) {
        if (context.args[index] !== '-c') continue;
        const entry = context.args[++index], equal = entry.indexOf('='), path = entry.slice(0, equal).split('.');
        let table = config;
        for (const key of path.slice(0, -1)) { table[key] ??= {}; table = table[key] as Record<string, unknown>; }
        table[path.at(-1)!] = JSON.parse(entry.slice(equal + 1));
      }
      return spawn(process.execPath, ['--input-type=module', '-e', FAKE_SERVER], {
        cwd: context.cwd, env: { ...context.env, FAKE_CONFIG: JSON.stringify(config), FAKE_MODE: mode, FAKE_LOG: log },
        stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      });
    },
  });
  t.after(async () => { await provider.close(); await rm(root, { recursive: true, force: true }); });
  const requests = async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const request = (signal = new AbortController().signal) => ({ prompt: 'Selected snapshot only', snapshotDir: snapshot, signal, onEvent: () => {}, outputSchema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false } });
  return { provider, request, requests, root, snapshot, context: () => launchContext!, launches: () => launches };
}

test('logged-out status stays available and login uses the managed ChatGPT flow', async t => {
  const { provider, requests } = await setup(t, 'loggedout');
  const status = await provider.status();
  assert.equal(status.available, true); assert.equal(status.authenticated, false); assert.equal(status.account, null); assert.deepEqual(status.models, []);
  assert.deepEqual(await provider.login(), { loginId: 'login-1', authUrl: 'https://auth.openai.com/test', verificationUri: undefined, userCode: undefined });
  assert.deepEqual((await requests()).filter(m => m.method === 'account/login/start')[0].params, { type: 'chatgpt' });
});

test('initialize is shared, config is isolated, and model IDs use invocation slugs', async t => {
  const fixture = await setup(t);
  const [a, b] = await Promise.all([fixture.provider.status(), fixture.provider.status()]);
  assert.equal(a.authenticated, true); assert.equal(b.models[0].id, 'gpt-test'); assert.equal(fixture.launches(), 1);
  const messages = await fixture.requests();
  assert.equal(messages.filter(m => m.method === 'initialize').length, 1);
  assert.equal(messages[1].method, 'initialized');
  assert.equal(fixture.context().env.CODEX_HOME, join(fixture.root, 'codex'));
  assert.equal(fixture.context().cwd, join(fixture.root, 'codex-runtime'));
  assert.equal(fixture.context().env.CODEX_API_KEY, undefined);
  assert.equal(fixture.context().env.OPENAI_API_KEY, undefined);
});

for (const mode of ['normal', 'early']) test(`${mode}: structured turn aggregates split JSONL and returns only the final answer`, async t => {
  const { provider, request, requests, snapshot } = await setup(t, mode);
  const deltas: string[] = [];
  const result = await provider.run({ ...request(), model: 'gpt-test', onEvent: event => deltas.push(event.text) });
  assert.deepEqual(result, { text: '{"answer":"done"}', threadId: 'thread-1' });
  assert.ok(!deltas.join('').includes('WRONG')); assert.ok(deltas.join('').includes('Checking...'));
  const messages = await requests(), start = messages.find(m => m.method === 'thread/start'), turn = messages.find(m => m.method === 'turn/start');
  assert.notEqual(start.params.cwd, snapshot);
  assert.equal(start.params.sandbox, 'read-only'); assert.equal(start.params.ephemeral, true);
  assert.equal(turn.params.input[0].text, 'Selected snapshot only');
  assert.deepEqual(turn.params.sandboxPolicy, { type: 'readOnly', networkAccess: false });
  assert.deepEqual(turn.params.outputSchema, request().outputSchema);
  assert.equal('access' in turn.params.sandboxPolicy, false);
});

for (const mode of ['unsafe', 'mcp']) test(`${mode}: startup fails closed when isolation checks fail`, async t => {
  const { provider } = await setup(t, mode);
  const result = await provider.status();
  assert.equal(result.available, false); assert.match(result.error!, /safety configuration|no MCP/);
});

for (const mode of ['failure', 'empty', 'tool', 'approval', 'crash', 'rpcerror']) test(`${mode}: turn failures reject without hanging or accepting partial output`, async t => {
  const { provider, request } = await setup(t, mode);
  await assert.rejects(provider.run(request()), /failed|without a response|disabled tool|exited|request rejected/);
});

for (const mode of ['interrupt', 'stall']) test(`${mode}: abort interrupts the active turn and has a bounded fallback`, async t => {
  const fixture = await setup(t, mode), controller = new AbortController();
  await fixture.provider.status();
  const running = fixture.provider.run(fixture.request(controller.signal));
  const abort = setTimeout(() => controller.abort(), 80);
  await assert.rejects(running, { name: 'AbortError' }); clearTimeout(abort);
  const messages = await fixture.requests();
  assert.ok(messages.some(m => m.method === 'turn/interrupt' && m.params.turnId === 'turn-1'));
  const next = await fixture.provider.status(); assert.equal(next.available, true);
  assert.equal(fixture.launches(), mode === 'stall' ? 2 : 1);
});

test('RPC timeouts and malformed JSON clean pending requests', async t => {
  for (const mode of ['hang', 'invalid']) {
    const { provider } = await setup(t, mode, 100);
    const result = await provider.status();
    assert.equal(result.available, false); assert.match(result.error!, /timed out|Invalid Codex protocol/);
  }
});

test('run timeout terminates a stalled task and a new status can restart the process', async t => {
  const fixture = await setup(t, 'stall', 500, 100);
  await assert.rejects(fixture.provider.run(fixture.request()), /run timed out/);
  assert.equal((await fixture.provider.status()).available, true); assert.equal(fixture.launches(), 2);
});

test('aggregate output limits reject even when exceeded in the terminal notification', async t => {
  const fixture = await setup(t, 'oversized');
  await assert.rejects(fixture.provider.run(fixture.request()), /size limit/);
});

test('pre-aborted runs start no process and close rejects in-flight work', async t => {
  const fixture = await setup(t, 'stall'), controller = new AbortController(); controller.abort();
  await assert.rejects(fixture.provider.run(fixture.request(controller.signal)), { name: 'AbortError' }); assert.equal(fixture.launches(), 0);
  await fixture.provider.status();
  const running = fixture.provider.run(fixture.request());
  const closed = setTimeout(() => { void fixture.provider.close(); }, 80);
  await assert.rejects(running, /closed/); clearTimeout(closed);
  assert.equal((await fixture.provider.status()).available, false);
});

test('real paths outside application-owned snapshots are rejected', async t => {
  const fixture = await setup(t);
  await assert.rejects(fixture.provider.run({ ...fixture.request(), snapshotDir: dirnameForTest(fixture.root) }), /requires a snapshot/);
});
function dirnameForTest(path: string): string { return join(path, '..'); }
