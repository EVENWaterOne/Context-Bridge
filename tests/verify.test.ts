import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { checkChanges } from '../server/verify.ts';
import type { FileCheck } from '../src/lib/backend-types.ts';

const live = () => new AbortController().signal;
const change = (path: string, afterContent: string, beforeContent = '') => ({ path, beforeContent, afterContent });
/** Python may be missing on a contributor's computer; the check then says so instead of passing. */
function pythonResult(check: FileCheck, expected: 'passed' | 'failed') {
  if (check.status === 'skipped') { assert.match(check.detail ?? '', /Python was not found/); return false; }
  assert.equal(check.status, expected, JSON.stringify(check));
  return true;
}

test('proposed JSON, JavaScript and Python files are parsed, never executed', async () => {
  // Running either file would create the marker.
  const marker = join(tmpdir(), `context-bridge-executed-${randomUUID()}`);
  const checks = await checkChanges([
    change('config.json', '{"return_duration": 1.2}\n', '{"return_duration": 0.6}\n'),
    change('src/motion.mjs', `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'ran');\nexport const speed = 2;\n`, 'export const speed = 1;\n'),
    change('motion.py', `open(${JSON.stringify(marker)}, 'w').write('ran')\nreturn_duration = 1.2\n`, 'return_duration = 0.6\n'),
  ], live());
  assert.deepEqual(checks.slice(0, 2).map(check => [check.path, check.check, check.status]), [['config.json', 'JSON syntax', 'passed'], ['src/motion.mjs', 'JavaScript syntax', 'passed']]);
  pythonResult(checks[2], 'passed');
  assert.equal(existsSync(marker), false, 'A syntax check must not run the proposed code');
});

test('a syntax error is reported with its message and line', async () => {
  const checks = await checkChanges([
    change('config.json', '{"return_duration": 1.2,}\n', '{"return_duration": 0.6}\n'),
    change('motion.js', 'const speed = (;\n', 'const speed = 1;\n'),
    // A full-width comma is a typical slip when the conversation is in Chinese.
    change('motion.py', 'return_duration = 1.2，\n', 'return_duration = 0.6\n'),
  ], live());
  assert.equal(checks[0].status, 'failed');
  assert.match(checks[0].detail ?? '', /JSON|position|property/i);
  assert.equal(checks[1].status, 'failed');
  assert.match(checks[1].detail ?? '', /SyntaxError: .+\(line 1\)/);
  if (pythonResult(checks[2], 'failed')) assert.match(checks[2].detail ?? '', /invalid character.+\(line 1\)/);
});

test('a file that never passed the check is not blamed on the proposal', async () => {
  const [jsonc, python2] = await checkChanges([
    change('tsconfig.json', '{ // comment\n "strict": false }\n', '{ // comment\n "strict": true }\n'),
    change('legacy.py', 'print "slower"\n', 'print "fast"\n'),
  ], live());
  assert.equal(jsonc.status, 'skipped');
  assert.match(jsonc.detail ?? '', /current file does not pass/);
  assert.notEqual(python2.status, 'failed');
});

test('file types without a parser are listed as not checked; a BOM is not an error', async () => {
  const checks = await checkChanges([
    change('arm.ino', 'void loop() {\n', 'void loop() {}\n'),
    change('hardware.json', '\ufeff{"joints": 3}\n', '\ufeff{"joints": 4}\n'),
  ], live());
  assert.deepEqual(checks.map(check => [check.path, check.status]), [['arm.ino', 'skipped'], ['hardware.json', 'passed']]);
  assert.match(checks[0].detail ?? '', /no automatic check/i);
});

test('a missing Python or a stand-in that is not Python is reported as not checked', async () => {
  // The second stand-in imitates the Windows Store alias: it starts, prints a hint and exits.
  const pythonCandidates: [string, string[]][] = [['context-bridge-no-such-python', []], [process.execPath, ['-e', 'process.stdout.write("Python was not found; run without arguments to install from the Microsoft Store")', '--']]];
  const [check] = await checkChanges([change('motion.py', 'return_duration = 1.2，\n', 'return_duration = 0.6\n')], live(), { pythonCandidates });
  assert.equal(check.status, 'skipped');
  assert.equal(check.detail, 'Python was not found on this computer, so this file was not checked.');
});

test('a cancelled diagnosis stops the checks', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(checkChanges([change('motion.js', 'const a = 1;\n')], controller.signal), { name: 'AbortError' });
});
