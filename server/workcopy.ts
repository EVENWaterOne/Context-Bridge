import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { lstatSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
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
  if (task.rootPath) {
    const root = task.rootPath;
    if (await realpath(root) !== root) throw conflict('Project root moved or was replaced. Link it again.');
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
        if (secret.test(entry.name)) { skipped.push(`${rel} (may hold credentials)`); continue; }
        const from = join(source, entry.name), stat = await lstat(from);
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
        else if (entry.isFile() && !secret.test(entry.name)) paths.add(rel);
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

/** Reads what the agent changed in its copy: selected files become the proposal, anything else is listed. */
export async function readEdits(task: Task, copy: WorkCopy, signal?: AbortSignal): Promise<WorkEdits> {
  const selected = task.files.filter(f => f.includeInContext !== false);
  const selectedPaths = new Set(selected.map(f => filePath(f)));
  const changes: WorkEdits['changes'] = [], other: string[] = [];
  for (const file of selected) {
    const rel = filePath(file);
    let bytes: Buffer;
    try { bytes = await readFile(at(copy.dir, rel)); }
    catch { other.push(`${rel} (deleted; Apply never deletes files)`); continue; }
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
const quoted = (path: string) => /^[\w./-]+$/.test(path) ? path : `"${path}"`;

/**
 * A build or test command for the project, when one is evident: PlatformIO, an Arduino sketch for a
 * controller with a known board ID, an npm test script or pytest tests. The user can replace it.
 */
export function detectCommand(task: Task, paths: string[], read: (rel: string) => string | undefined): string | undefined {
  if (paths.includes('platformio.ini')) return 'pio run';
  const fqbn = FQBN[task.hardware.controller];
  if (fqbn) {
    const root = folderName(task);
    const sketches = [...new Set(paths.flatMap(path => {
      const parts = path.split('/'), name = parts.at(-1)!;
      if (!/\.ino$/i.test(name)) return [];
      const folder = parts.length > 1 ? parts.at(-2)! : root;
      if (folder.toLowerCase() !== name.slice(0, -4).toLowerCase()) return [];
      return [parts.slice(0, -1).join('/') || '.'];
    }))].filter(path => !path.includes('"'));
    const chosen = task.files.filter(f => f.includeInContext !== false).map(f => filePath(f)).filter(path => /\.ino$/i.test(path)).map(path => path.split('/').slice(0, -1).join('/') || '.');
    const preferred = sketches.filter(path => chosen.includes(path));
    const list = (preferred.length ? preferred : sketches).slice(0, 3);
    if (list.length) return list.map(path => `arduino-cli compile --fqbn ${fqbn} ${quoted(path)}`).join(' && ');
  }
  if (paths.includes('package.json')) {
    try {
      const test = JSON.parse(read('package.json') ?? '{}')?.scripts?.test;
      if (typeof test === 'string' && test.trim() && !/no test specified/i.test(test)) return 'npm test';
    } catch { /* not a usable package.json */ }
  }
  if (paths.some(path => /(^|\/)(test_[^/]*\.py|[^/]*_test\.py|conftest\.py|pytest\.ini)$/i.test(path))) return `${process.platform === 'win32' ? 'py -3' : 'python3'} -m pytest -q`;
  return undefined;
}
