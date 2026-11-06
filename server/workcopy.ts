import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, open, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { constants, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import type { Task } from '../src/lib/workflow.ts';
import { filePath } from './store.ts';
import { decodeText, ignored, safeRelative, secret } from './files.ts';
import { conflict, invalid } from './errors.ts';

/**
 * A private copy of the user's project for one diagnosis. The agent runs commands and edits files
 * in it; the service reads the edits back as a reviewable proposal, so the real project changes only
 * when the user applies. The copy keeps the project folder's own name, because Arduino requires a
 * sketch's folder to match its .ino file.
 */
export interface WorkCopy {
  dir: string;
  /** Fingerprint of every file as copied, to find what changed afterwards. */
  manifest: Map<string, string>;
  /** Paths left out of the copy, with the reason. */
  skipped: string[];
}
export interface WorkEdits {
  /** Selected files whose text changed. */
  changes: { path: string; afterContent: string }[];
  /** Other files the agent created, changed or deleted. They are never applied. */
  other: string[];
}

// Caches and editor state are rebuilt by the tools; dependencies and build output are not part of the
// source. Version control and credential folders never leave the project.
// Agent settings folders (.codex, .agents, .claude) stay out too: an agent could otherwise load the
// project's own instructions or configuration from its working copy.
const SKIP = new Set([...ignored, '.svn', '.hg', '.pio', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.gradle', '.agents', '.claude']);
const MAX_ENTRIES = 20_000;
const MAX_BYTES = 300 * 1024 * 1024;
const MAX_FILE = 100 * 1024 * 1024;
const HASHED = 8 * 1024 * 1024;
const MAX_OTHER = 50;
const MAX_TEXT = 1024 * 1024;
// Besides the files the file service never reads, a whole-project copy also leaves out common
// credential and key files, so an agent that searches the project cannot send them to its model.
const COPY_SECRET = /^(\.npmrc|\.netrc|_netrc|\.pypirc|\.git-credentials|\.envrc|\.htpasswd|.*\.(pem|key|p12|pfx|keystore|jks|ppk)|client_secret.*\.json|token\.json|service[-_]?account.*\.json|.*credentials.*\.json|.*[_-]secrets?\.(py|json|ya?ml|toml|ini|txt|cfg|conf))$/i;
// Arduino's convention for Wi-Fi passwords and keys (arduino_secrets.h, wifi_secrets.h …). The sketch
// includes it, so the copy keeps the names with empty values: the code still compiles and the values
// never leave the computer.
const ARDUINO_SECRETS = /^(.*[_-])?secrets?\.(h|hpp)$/i;
const redact = (text: string) => text.split('\n').map(line => /^\s*#\s*include\b/.test(line) ? line : line.replace(/"(?:[^"\\\n]|\\.)*"/g, '""')).join('\n');

function aborted(signal?: AbortSignal): void { if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError'); }
function folderName(task: Task): string {
  const name = task.rootPath ? basename(task.rootPath) : 'project';
  const clean = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '');
  return clean || 'project';
}
const textPrint = (text: string) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
async function print(path: string, size: number): Promise<string> {
  return size > HASHED ? `size:${size}` : createHash('sha256').update(await readFile(path)).digest('hex');
}
const at = (dir: string, rel: string) => join(dir, ...rel.split('/'));

/**
 * Copies the linked project folder (or, for a task without one, its imported files) into
 * `parent/<project folder name>`. Links, credential files, dependencies and build output are left
 * out. The task's own file text is written last, so the copy holds exactly what the agent was shown.
 */
export async function createWorkCopy(task: Task, parent: string, signal?: AbortSignal): Promise<WorkCopy> {
  const dir = join(parent, folderName(task));
  await mkdir(dir, { recursive: true });
  const manifest = new Map<string, string>(), skipped: string[] = [];
  // Selected files are written from the task below (their text is in the prompt anyway).
  const own = new Set(task.files.map(f => filePath(f)));
  if (task.rootPath) {
    const root = task.rootPath;
    // The same function that recorded rootPath when the folder was linked; the native one can return
    // another spelling of the same folder on Windows (drive letter case, mapped drives).
    if (realpathSync(root) !== root) throw conflict('Project root moved or was replaced. Link it again.');
    let entries = 0, bytes = 0;
    const walk = async (source: string, prefix: string, depth: number): Promise<void> => {
      if (depth > 30) { skipped.push(`${prefix} (nested too deeply)`); return; }
      for (const entry of await readdir(source, { withFileTypes: true })) {
        aborted(signal);
        if (++entries > MAX_ENTRIES) throw invalid('The project folder has more than 20,000 entries to copy. Link a smaller project folder, or turn off Run code.');
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) { skipped.push(`${rel} (link)`); continue; }
        if (entry.isDirectory()) {
          if (SKIP.has(entry.name.toLowerCase())) continue;
          await mkdir(at(dir, rel), { recursive: true });
          await walk(join(source, entry.name), rel, depth + 1);
          continue;
        }
        if (!entry.isFile()) continue;
        const from = join(source, entry.name);
        if (own.has(rel)) continue;
        if (ARDUINO_SECRETS.test(entry.name)) {
          const stat = await lstat(from);
          if (stat.size <= MAX_TEXT) {
            const text = redact(await readFile(from, 'utf8'));
            await writeFile(at(dir, rel), text, 'utf8');
            manifest.set(rel, textPrint(text));
            skipped.push(`${rel} (copied with its values removed)`);
          } else skipped.push(`${rel} (may hold credentials)`);
          continue;
        }
        if (secret.test(entry.name) || COPY_SECRET.test(entry.name)) { skipped.push(`${rel} (may hold credentials)`); continue; }
        const stat = await lstat(from);
        if (stat.size > MAX_FILE) { skipped.push(`${rel} (larger than 100 MB)`); continue; }
        bytes += stat.size;
        if (bytes > MAX_BYTES) throw invalid('The project folder holds more than 300 MB to copy. Link a smaller project folder, or turn off Run code.');
        await copyFile(from, at(dir, rel));
        manifest.set(rel, await print(at(dir, rel), stat.size));
      }
    };
    await walk(root, '', 0);
  }
  for (const file of task.files) {
    aborted(signal);
    const rel = filePath(file);
    try { safeRelative(rel); } catch { skipped.push(`${rel} (not a project path)`); continue; }
    await mkdir(dirname(at(dir, rel)), { recursive: true });
    await writeFile(at(dir, rel), file.content, 'utf8');
    manifest.set(rel, textPrint(file.content));
  }
  return { dir, manifest, skipped };
}

/** The project's file paths without copying anything, to show which verification command would run. */
export async function listProject(task: Task): Promise<{ paths: string[]; read: (rel: string) => string | undefined }> {
  const paths = new Set(task.files.map(f => filePath(f)));
  const root = task.rootPath;
  if (root) {
    let entries = 0;
    const walk = async (source: string, prefix: string, depth: number): Promise<void> => {
      if (depth > 30 || entries > MAX_ENTRIES) return;
      let list;
      try { list = await readdir(source, { withFileTypes: true }); } catch { return; }
      for (const entry of list) {
        if (++entries > MAX_ENTRIES) return;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory() && !SKIP.has(entry.name.toLowerCase())) await walk(join(source, entry.name), rel, depth + 1);
        else if (entry.isFile() && !secret.test(entry.name) && !COPY_SECRET.test(entry.name)) paths.add(rel);
      }
    };
    await walk(root, '', 0);
  }
  const read = (rel: string) => {
    if (!root) return undefined;
    try {
      const path = at(root, rel);
      if (lstatSync(path).size > 1024 * 1024) return undefined;
      return readFileSync(path, 'utf8');
    } catch { return undefined; }
  };
  return { paths: [...paths], read };
}

/** Writes proposed text into a copy, for checking exactly what Apply would write. */
export async function writeChanges(copy: WorkCopy, changes: { path: string; afterContent: string }[]): Promise<void> {
  for (const change of changes) {
    safeRelative(change.path);
    await mkdir(dirname(at(copy.dir, change.path)), { recursive: true });
    await writeFile(at(copy.dir, change.path), change.afterContent, 'utf8');
  }
}

/**
 * Reads one file the agent may have replaced. The agent controls its copy, so the file must still be
 * a regular file at that exact place, with no link anywhere on its path (a link could point at saved
 * keys), and small enough to be text. A FIFO or device is never opened.
 */
async function readOwn(copy: WorkCopy, rel: string): Promise<Buffer | 'missing' | 'refused'> {
  const path = at(copy.dir, rel);
  let stat;
  try { stat = await lstat(path); } catch { return 'missing'; }
  if (!stat.isFile()) return 'refused';
  if (stat.size > MAX_TEXT) return 'refused';
  const [root, real] = await Promise.all([realpath(copy.dir), realpath(path).catch(() => '')]);
  const inside = relative(root, real);
  const expected = rel.split('/').join(sep);
  if (process.platform === 'win32' ? inside.toLowerCase() !== expected.toLowerCase() : inside !== expected) return 'refused';
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    if (!(await handle.stat()).isFile()) return 'refused';
    const buffer = Buffer.alloc(MAX_TEXT + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return bytesRead > MAX_TEXT ? 'refused' : buffer.subarray(0, bytesRead);
  } finally { await handle.close(); }
}

/** Reads what the agent changed in its copy: selected files become the proposal, anything else is listed. */
export async function readEdits(task: Task, copy: WorkCopy, signal?: AbortSignal): Promise<WorkEdits> {
  const selected = task.files.filter(f => f.includeInContext !== false);
  const selectedPaths = new Set(selected.map(f => filePath(f)));
  const changes: WorkEdits['changes'] = [], other: string[] = [];
  for (const file of selected) {
    aborted(signal);
    const rel = filePath(file);
    const bytes = await readOwn(copy, rel).catch(() => 'refused' as const);
    if (bytes === 'missing') { other.push(`${rel} (deleted; Apply never deletes files)`); continue; }
    if (bytes === 'refused') throw invalid(`${rel} in the working copy is no longer a regular text file up to 1 MB (it was replaced by a link, folder or special file).`);
    let text: string;
    try { text = decodeText(bytes); }
    catch { throw invalid(`${rel} is no longer UTF-8 text up to 1 MB after the edits in the working copy.`); }
    if (text !== file.content) changes.push({ path: rel, afterContent: text });
  }
  const seen = new Set<string>();
  const walk = async (source: string, prefix: string, depth: number): Promise<void> => {
    if (depth > 30 || other.length >= MAX_OTHER) return;
    let entries;
    try { entries = await readdir(source, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      aborted(signal);
      if (other.length >= MAX_OTHER) return;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { if (!SKIP.has(entry.name.toLowerCase())) await walk(join(source, entry.name), rel, depth + 1); continue; }
      if (!entry.isFile() || selectedPaths.has(rel)) continue;
      seen.add(rel);
      const before = copy.manifest.get(rel);
      const now = await print(join(source, entry.name), (await lstat(join(source, entry.name))).size);
      if (before === undefined) other.push(`${rel} (new)`);
      else if (before !== now) other.push(`${rel} (changed)`);
    }
  };
  await walk(copy.dir, '', 0);
  for (const rel of copy.manifest.keys()) {
    if (other.length >= MAX_OTHER) break;
    if (!seen.has(rel) && !selectedPaths.has(rel)) other.push(`${rel} (deleted)`);
  }
  return { changes, other };
}

/** Removes a copy. Windows can hold a file open briefly after a process ends, so it retries. */
export async function removeCopy(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}

const FQBN: Record<string, string> = {
  'Arduino Uno': 'arduino:avr:uno',
  ESP32: 'esp32:esp32:esp32',
  'Raspberry Pi + ESP32': 'esp32:esp32:esp32',
  STM32F103C8T6: 'STMicroelectronics:stm32:GenF1:pnum=BLUEPILL_F103C8',
};
// Sketch folders become part of a shell command. Only plain names are used, so no shell (sh or
// cmd.exe) can read anything in them as syntax; other sketches are left for the user to type.
const PLAIN_PATH = /^[\p{L}\p{N} _.\-/()+]+$/u;
const quoted = (path: string) => /^[\w./-]+$/.test(path) ? path : `"${path}"`;
const python = () => process.platform === 'win32' ? 'py -3' : 'python3';

/**
 * A build or test command for the project, when one is evident: PlatformIO (build only), an Arduino
 * sketch for a controller with a known board ID, an npm test script or a pytest configuration. It is
 * only a suggestion: nothing runs it until the user confirms it as the task's command.
 */
export function detectCommand(task: Task, paths: string[], read: (rel: string) => string | undefined): string | undefined {
  // An explicit target: a `targets = upload` default in platformio.ini must never flash the board.
  if (paths.includes('platformio.ini')) return 'pio run -t checkprogsize';
  const selected = task.files.filter(f => f.includeInContext !== false).map(f => filePath(f));
  const fqbn = FQBN[task.hardware.controller];
  if (fqbn) {
    const root = folderName(task);
    const sketches = [...new Set(paths.flatMap(path => {
      const parts = path.split('/'), name = parts.at(-1)!;
      if (!/\.ino$/i.test(name)) return [];
      // Library examples are not the user's sketch.
      if (parts.slice(0, -1).some(part => /^(libraries|examples)$/i.test(part))) return [];
      const folder = parts.length > 1 ? parts.at(-2)! : root;
      if (folder.toLowerCase() !== name.slice(0, -4).toLowerCase()) return [];
      return [parts.slice(0, -1).join('/') || '.'];
    }))].filter(path => PLAIN_PATH.test(path) && !path.startsWith('-'));
    // The sketch that holds a selected file (.ino, .h, .cpp …) is the one the change can break.
    const holds = (sketch: string, file: string) => sketch === '.' ? !file.includes('/') : file.startsWith(`${sketch}/`);
    const preferred = sketches.filter(sketch => selected.some(file => holds(sketch, file)));
    const list = preferred.length ? preferred : selected.length && selected.some(file => /\.(ino|h|hpp|c|cpp)$/i.test(file)) ? [] : sketches.length === 1 ? sketches : [];
    if (list.length) return list.slice(0, 3).map(path => `arduino-cli compile --fqbn ${fqbn} ${quoted(path)}`).join(' && ');
  }
  if (paths.includes('package.json')) {
    try {
      const test = JSON.parse(read('package.json') ?? '{}')?.scripts?.test;
      if (typeof test === 'string' && test.trim() && !/no test specified/i.test(test)) return 'npm test';
    } catch { /* not a usable package.json */ }
  }
  // pytest only from its own configuration or from tests that import it: a hardware script named
  // test_servo.py is not a test suite, and pytest would run it while collecting.
  if (paths.some(path => /(^|\/)(conftest\.py|pytest\.ini)$/i.test(path))) return `${python()} -m pytest -q`;
  for (const config of ['pyproject.toml', 'setup.cfg', 'tox.ini']) {
    if (paths.includes(config) && /^\[(tool\.pytest[^\]]*|tool:pytest|pytest)\]/m.test(read(config) ?? '')) return `${python()} -m pytest -q`;
  }
  const tests = paths.filter(path => /(^|\/)(test_[^/]*|[^/]*_test)\.py$/i.test(path)).slice(0, 20);
  if (tests.some(path => /^\s*(import pytest|from pytest import)/m.test(read(path) ?? ''))) return `${python()} -m pytest -q`;
  return undefined;
}
