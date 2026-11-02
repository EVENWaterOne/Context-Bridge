import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runShell } from '../server/runner.ts';

const live = () => new AbortController().signal;
const node = JSON.stringify(process.execPath);
async function folder(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), 'context-bridge-runner-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('the verification command runs in the copy through the shell and reports its exit code and output', async t => {
  const dir = await folder(t);
  const ok = await runShell(`${node} -e "console.log(process.cwd()); console.error('to stderr')"`, dir, live(), 10_000);
  assert.equal(ok.exitCode, 0);
  assert.match(ok.output, /to stderr/);
  assert.ok(ok.output.includes(dir.split(/[\\/]/).at(-1)!), ok.output);
  const failed = await runShell(`${node} -e "process.exit(3)"`, dir, live(), 10_000);
  assert.equal(failed.exitCode, 3);
  assert.equal(failed.notFound, false);
});

test('a missing program is reported as not found, not as a failing build', async t => {
  const dir = await folder(t);
  const result = await runShell('context-bridge-no-such-tool --version', dir, live(), 10_000);
  assert.equal(result.notFound, true);
  assert.notEqual(result.exitCode, 0);
  const pytest = await runShell(`${node} -e "console.error('/usr/bin/python3: No module named pytest'); process.exit(1)"`, dir, live(), 10_000);
  assert.equal(pytest.notFound, true, 'pytest that is not installed is a missing tool, not a failing test');
});

test('long output keeps its beginning and its end, where compilers print the errors', async t => {
  const dir = await folder(t);
  const result = await runShell(`${node} -e "console.log('FIRST'); for (let i = 0; i < 4000; i++) console.log('line ' + i); console.log('LAST ERROR')"`, dir, live(), 10_000);
  assert.match(result.output, /^FIRST/);
  assert.match(result.output, /LAST ERROR$/);
  assert.match(result.output, /\n…\n/);
  assert.ok(result.output.length < 40_000);
});

test('the time limit ends the command and everything it started', { skip: process.platform === 'win32' ? 'process groups are POSIX; Windows uses taskkill /T' : false }, async t => {
  const dir = await folder(t);
  const late = join(dir, 'late.txt');
  const script = `require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => require("fs").writeFileSync(${JSON.stringify(late)}, "x"), 1500)'], { stdio: 'ignore' }); setTimeout(() => {}, 10000);`;
  const result = await runShell(`${node} -e ${JSON.stringify(script)}`, dir, live(), 400);
  assert.equal(result.timedOut, true);
  await new Promise(resolve => setTimeout(resolve, 2000));
  assert.equal(existsSync(late), false, 'A process started by the build must not outlive the time limit');
});

test('model credentials are not passed to the verification command, and a Stop cancels it', async t => {
  const dir = await folder(t);
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-should-not-leak';
  t.after(() => { if (saved === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved; });
  const result = await runShell(`${node} -e "console.log('key=' + (process.env.ANTHROPIC_API_KEY ?? 'none'))"`, dir, live(), 10_000);
  assert.match(result.output, /key=none/);
  const controller = new AbortController();
  const running = runShell(`${node} -e "setTimeout(() => {}, 10000)"`, dir, controller.signal, 20_000);
  setTimeout(() => controller.abort(), 200);
  await assert.rejects(running, { name: 'AbortError' });
});

test('a background process that keeps the output open does not hold the result after the shell ends', { skip: process.platform === 'win32' ? 'POSIX shell syntax' : false }, async t => {
  const dir = await folder(t);
  const started = Date.now();
  const result = await runShell(`${node} -e "setTimeout(() => {}, 20000)" & echo started`, dir, live(), 30_000);
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /started/);
  assert.ok(Date.now() - started < 10_000, 'The result comes after a short grace period, not after the background process ends');
});

test('long output cut inside a multi-byte character keeps valid text on both sides', async t => {
  const dir = await folder(t);
  // 3-byte characters after a 2-byte prefix: the 4 KB head cut and the 28 KB tail cut land mid-character.
  const result = await runShell(`${node} -e "process.stdout.write('ab' + '中'.repeat(20000) + 'END')"`, dir, live(), 10_000);
  assert.match(result.output, /\n…\n/);
  assert.ok(!result.output.includes('�'), 'No replacement characters at the cuts');
  assert.match(result.output, /^ab中/);
  assert.match(result.output, /中END$/);
});

test('in the sandbox the command writes only in its folder, has no network, and its output and exit code come back', { skip: process.platform !== 'linux' ? 'the sandbox is checked on Linux here' : false }, async t => {
  const { codexSandbox } = await import('../server/jobs.ts');
  const dir = await folder(t);
  const sandbox = await codexSandbox(dir);
  if (!sandbox) { t.skip('the Codex binary is not installed'); return; }
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(sandbox.home, { recursive: true });
  const work = join(dir, 'work'), outside = join(dir, 'outside.txt');
  await mkdir(work);
  const { createServer } = await import('node:http');
  const server = createServer((_, response) => response.end('open'));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const port = (server.address() as { port: number }).port;
  await writeFile(join(work, 'probe.js'), `
    const fs = require('fs');
    fs.writeFileSync('inside.txt', 'x'); console.log('INSIDE_OK');
    try { fs.writeFileSync(${JSON.stringify(outside)}, 'x'); console.log('OUTSIDE_OPEN'); } catch (e) { console.log('OUTSIDE_BLOCKED', e.code); }
    require('http').get('http://127.0.0.1:${port}/', r => { console.log('NET_OPEN'); process.exit(4); }).on('error', e => { console.log('NET_BLOCKED', e.code); process.exit(4); });`);
  const result = await runShell(`${node} probe.js`, work, live(), 30_000, { sandbox });
  assert.equal(result.exitCode, 4, result.output);
  assert.match(result.output, /INSIDE_OK/, 'Node output reaches the result from inside the sandbox');
  assert.match(result.output, /OUTSIDE_BLOCKED/);
  assert.match(result.output, /NET_BLOCKED/);
  assert.ok(!/WARNING: proceeding/.test(result.output));
  assert.equal(existsSync(outside), false);
  assert.equal(existsSync(join(work, 'inside.txt')), true);
});
