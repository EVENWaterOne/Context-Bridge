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
