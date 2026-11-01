import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import type { FileCheck } from '../src/lib/backend-types.ts';

/**
 * Automatic checks on proposed file contents, run by the local service before review.
 *
 * The model cannot run anything, so without these checks a proposal with a typo reached
 * the user, and the model had no way to learn that its change did not even parse. Each
 * check only parses text: JSON in this process, JavaScript with `node --check` and Python
 * with `ast.parse`. Neither imports nor executes the project, and both run in an empty
 * temporary folder with a minimal environment and a time limit.
 */
const TIMEOUT_MS = 10_000;
const MAX_DETAIL = 600;
// Passed to Python on its command line, never built from file content.
const PYTHON_CHECK = [
  'import ast, sys',
  'try:',
  '    sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace")',
  'except Exception:',
  '    pass',
  'try:',
  '    ast.parse(sys.stdin.buffer.read(), filename=sys.argv[1])',
  'except SyntaxError as error:',
  '    print("CB_SYNTAX\\t%s (line %s)" % (error.msg, error.lineno))',
  'except Exception as error:',
  '    print("CB_SYNTAX\\t%s" % error)',
  'else:',
  '    print("CB_OK")',
].join('\n');
const PYTHON_CANDIDATES: [string, string[]][] = process.platform === 'win32'
  ? [['py', ['-3']], ['python', []], ['python3', []]]
  : [['python3', []], ['python', []]];
// Only what an interpreter needs to start. NODE_OPTIONS and PYTHON* settings could load code.
const ENV_KEYS = ['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'LANG', 'LC_ALL'];

type Outcome = { status: 'passed' } | { status: 'failed'; detail: string } | { status: 'unavailable'; detail: string };
interface Checker { label: string; run(text: string, path: string, signal: AbortSignal): Promise<Outcome> }
export interface CheckOptions {
  /** Test seam: interpreters to try instead of the platform's usual Python commands. */
  pythonCandidates?: [string, string[]][];
}

let python: [string, string[]] | undefined;

function brief(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > MAX_DETAIL ? `${clean.slice(0, MAX_DETAIL)}…` : clean;
}

function environment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ENV_KEYS) if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
}

function execute(command: string, args: string[], options: { cwd: string; input?: string; signal: AbortSignal }): Promise<{ code: number | null; stdout: string; stderr: string; stopped: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: environment(), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], signal: options.signal, timeout: TIMEOUT_MS, killSignal: 'SIGKILL' });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { if (stdout.length < 64 * 1024) stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { if (stderr.length < 64 * 1024) stderr += chunk; });
    child.stdin.on('error', () => {});
    child.once('error', reject);
    // A signal here means the time limit ended the check (cancellation rejects through 'error').
    child.once('close', (code, killed) => resolve({ code, stdout, stderr, stopped: killed !== null }));
    child.stdin.end(options.input ?? '');
  });
}

async function inTemporaryFolder<T>(action: (folder: string) => Promise<T>): Promise<T> {
  const folder = await mkdtemp(join(tmpdir(), 'context-bridge-check-'));
  try { return await action(folder); }
  finally { await rm(folder, { recursive: true, force: true }).catch(() => {}); }
}

const json: Checker = {
  label: 'JSON syntax',
  async run(text) {
    try { JSON.parse(text); return { status: 'passed' }; }
    catch (error) { return { status: 'failed', detail: brief((error as Error).message) }; }
  },
};

const javascript = (extension: string): Checker => ({
  label: 'JavaScript syntax',
  run: (text, _path, signal) => inTemporaryFolder(async folder => {
    const file = join(folder, `proposed${extension}`);
    await writeFile(file, text, 'utf8');
    let result;
    try { result = await execute(process.execPath, ['--check', file], { cwd: folder, signal }); }
    catch (error) { if (signal.aborted) throw error; return { status: 'unavailable', detail: 'Node.js could not start the check.' }; }
    if (result.stopped) return { status: 'unavailable', detail: 'The JavaScript check did not finish in time.' };
    if (result.code === 0) return { status: 'passed' };
    const message = result.stderr.split(/\r?\n/).find(line => /^\w*Error:/.test(line));
    if (!message) return { status: 'unavailable', detail: 'The JavaScript check did not finish.' };
    const line = result.stderr.match(/:(\d+)\r?\n/)?.[1];
    return { status: 'failed', detail: brief(`${message}${line ? ` (line ${line})` : ''}`) };
  }),
});

const pythonChecker = (candidates?: [string, string[]][]): Checker => ({
  label: 'Python syntax',
  run: (text, path, signal) => inTemporaryFolder(async folder => {
    for (const candidate of candidates ?? (python ? [python] : PYTHON_CANDIDATES)) {
      let result;
      try { result = await execute(candidate[0], [...candidate[1], '-I', '-S', '-c', PYTHON_CHECK, path], { cwd: folder, input: text, signal }); }
      catch (error) { if (signal.aborted) throw error; continue; }
      if (result.stopped) return { status: 'unavailable', detail: 'The Python check did not finish in time.' };
      // Anything without the marker (for example the Windows Store alias) is not a usable Python.
      const output = result.stdout.trim();
      const found = output === 'CB_OK' || output.startsWith('CB_SYNTAX\t');
      if (found && !candidates) python = candidate;
      if (output === 'CB_OK') return { status: 'passed' };
      if (found) return { status: 'failed', detail: brief(output.slice('CB_SYNTAX\t'.length)) };
    }
    return { status: 'unavailable', detail: 'Python was not found on this computer, so this file was not checked.' };
  }),
});

function checkerFor(path: string, options: CheckOptions): Checker | undefined {
  const extension = extname(path).toLowerCase();
  if (extension === '.json') return json;
  if (['.js', '.mjs', '.cjs'].includes(extension)) return javascript(extension);
  if (extension === '.py') return pythonChecker(options.pythonCandidates);
  return undefined;
}

/**
 * Checks each proposed file. A proposed file "fails" only when its current version passes the
 * same check, so a file that never parsed (a template, Python 2, JSON with comments) is reported
 * as not checked instead of blaming the proposal.
 */
export async function checkChanges(changes: { path: string; beforeContent: string; afterContent: string }[], signal: AbortSignal, options: CheckOptions = {}): Promise<FileCheck[]> {
  const checks: FileCheck[] = [];
  for (const change of changes) {
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    const checker = checkerFor(change.path, options);
    if (!checker) { checks.push({ path: change.path, check: 'Not checked', status: 'skipped', detail: 'There is no automatic check for this file type. Test it on your build.' }); continue; }
    const strip = (text: string) => text.replace(/^\ufeff/, '');
    const after = await checker.run(strip(change.afterContent), change.path, signal);
    if (after.status === 'failed') {
      const before = await checker.run(strip(change.beforeContent), change.path, signal);
      if (before.status !== 'passed') { checks.push({ path: change.path, check: checker.label, status: 'skipped', detail: 'The current file does not pass this check either, so the proposal was not judged by it.' }); continue; }
    }
    checks.push(after.status === 'passed'
      ? { path: change.path, check: checker.label, status: 'passed' }
      : { path: change.path, check: checker.label, status: after.status === 'failed' ? 'failed' : 'skipped', detail: after.detail });
  }
  return checks;
}
