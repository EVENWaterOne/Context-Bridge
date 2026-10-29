import { constants, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { inferFileKind, type ProjectFile, type Task } from '../src/lib/workflow.ts';
import type { ApplyResponse, ProjectScan, Proposal } from '../src/lib/backend-types.ts';
import { Store, hash, filePath, type OperationRecord } from './store.ts';
import { conflict, invalid } from './errors.ts';
import { contextHash } from './context.ts';

const MAX_FILE = 1024 * 1024;
const ignored = new Set(['.git','.codex','.data','.ssh','.aws','.gnupg','node_modules','dist','build','.next','.render-cache','coverage','.venv','venv']);
const allowed = /\.(py|js|mjs|cjs|ts|tsx|jsx|ino|cpp|hpp|h|c|json|log|csv|txt|md|css|html|yaml|yml)$/i;
const secret = /^(\.env(?:\..*)?|auth\.json|credentials(?:\..*)?|secrets?(?:\..*)?|id_rsa.*|id_ed25519.*)$/i;
const timestamp = () => new Date().toISOString();

export function safeRelative(value: string): string {
  if (typeof value !== 'string' || !value || value.length > 500 || isAbsolute(value) || /[:\0\\]/.test(value)) throw invalid('Use a relative file path within the selected project.');
  const parts = value.split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p) || ignored.has(p.toLowerCase())) || secret.test(parts.at(-1)!)) throw invalid('This path is outside the permitted text context.');
  if (!allowed.test(value)) throw invalid('Only supported text files can be included.');
  return value;
}
export function decodeText(bytes: Uint8Array): string {
  if (bytes.length > MAX_FILE) throw invalid('File exceeds the 1 MB text limit.');
  try {
    const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (content.includes('\0')) throw new Error('Binary data');
    return content;
  } catch { throw invalid('This file is not UTF-8 text. Convert it explicitly before importing or editing.'); }
}
function readTextBytes(path: string): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE) throw invalid('Select a regular UTF-8 text file up to 1 MB.');
  const bytes = readFileSync(path);
  decodeText(bytes);
  return bytes;
}
export function preserveTextStyle(before: string, after: string): string {
  const bom = before.startsWith('\ufeff');
  let text = after.replace(/^\ufeff/, '');
  if (before.includes('\r\n') && !before.replace(/\r\n/g, '').includes('\n')) text = text.replace(/\r?\n/g, '\r\n');
  if (bom) text = `\ufeff${text}`;
  decodeText(Buffer.from(text));
  return text;
}

export class FileService {
  store: Store;
  fault?: (phase: 'after-write', index: number) => void;
  constructor(store: Store, fault?: (phase: 'after-write', index: number) => void) { this.store = store; this.fault = fault; }
  resolveFile(rootId: string, taskId: string, path: string): string {
    safeRelative(path);
    const root = this.store.root(rootId, taskId).path;
    if (realpathSync(root) !== root) throw conflict('Project root moved or was replaced. Bind it again.');
    let cursor = root;
    for (const part of path.split('/')) {
      cursor = join(cursor, part);
      const stat = lstatSync(cursor);
      if (stat.isSymbolicLink()) throw invalid('Symbolic links and junctions cannot be edited.');
    }
    const actual = realpathSync(cursor);
    const rel = relative(root, actual);
    if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) throw invalid('File resolves outside the selected project.');
    if (!lstatSync(actual).isFile()) throw invalid('Select a regular text file.');
    return actual;
  }
  scan(taskId: string, input: string): ProjectScan {
    this.store.task(taskId);
    if (typeof input !== 'string' || !isAbsolute(input) || input.length > 4096) throw invalid('Enter an absolute local project folder path.');
    const rootPath = realpathSync(input);
    if (!lstatSync(rootPath).isDirectory() || dirname(rootPath) === rootPath || rootPath.split(/[\\/]/).some(p => ['.codex','.ssh','.aws','.data','.gnupg'].includes(p.toLowerCase()))) throw invalid('Select a project folder, not a drive root or credential folder.');
    const files: ProjectScan['files'] = [], skipped: string[] = [];
    let seen = 0;
    const walk = (dir: string, prefix: string, depth: number) => {
      if (depth > 20) { skipped.push(`${prefix} (nested too deeply)`); return; }
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (++seen > 15000) throw invalid('Project is too large to list. Select a smaller source folder.');
        const name = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (ignored.has(entry.name.toLowerCase()) || secret.test(entry.name)) continue;
        if (entry.isSymbolicLink()) { skipped.push(`${name} (link)`); continue; }
        if (entry.isDirectory()) { walk(join(dir, entry.name), name, depth + 1); continue; }
        if (!entry.isFile() || !allowed.test(entry.name)) continue;
        try {
          safeRelative(name);
          const bytes = readTextBytes(join(dir, entry.name));
          files.push({ path: name, size: bytes.length });
          if (files.length > 500) throw invalid('More than 500 text files. Select a smaller source folder.');
        } catch (e) {
          if (e instanceof Error && /More than 500/.test(e.message)) throw e;
          skipped.push(`${name} (non-UTF-8, large or unsupported)`);
        }
      }
    };
    walk(rootPath, '', 0);
    const rootId = `root-${randomUUID()}`;
    this.store.saveRoot({ id: rootId, taskId, path: rootPath });
    return { rootId, rootPath, files: files.sort((a,b) => a.path.localeCompare(b.path)), skipped };
  }
  bind(taskId: string, rootId: string, paths: string[]) {
    const task = this.store.task(taskId);
    if (!Array.isArray(paths) || !paths.length || paths.length > 200 || new Set(paths).size !== paths.length) throw invalid('Select between 1 and 200 distinct source files.');
    if (task.rounds.some(r => r.applied && !r.completedAt)) throw conflict('Finish or undo the active change before rebinding the project.');
    const root = this.store.root(rootId, taskId);
    const linked: ProjectFile[] = paths.map(path => this.readLinked(task, rootId, path));
    const unlinked = task.files.filter(f => !f.linked && !paths.includes(filePath(f)));
    if ([...unlinked, ...linked].reduce((n,f) => n + f.size, 0) > 6 * MAX_FILE) throw invalid('Selected context exceeds 6 MB. Select fewer source files.');
    return this.store.mutate(s => ({ ...s, tasks: s.tasks.map(t => t.id === taskId ? { ...t, rootId, rootPath: root.path, files: [...unlinked, ...linked], rounds: t.rounds.map(r => r.applied ? r : { ...r, suggestion: undefined }) } : t) }));
  }
  readLinked(task: Task, rootId: string, path: string): ProjectFile {
    const bytes = readTextBytes(this.resolveFile(rootId, task.id, path));
    const content = decodeText(bytes);
    const old = task.files.find(f => f.linked && filePath(f) === path);
    return { id: old?.id ?? `file-${randomUUID()}`, name: path, relativePath: path, kind: inferFileKind(path), content, size: bytes.length, updatedAt: old?.hash === hash(bytes) ? old.updatedAt : timestamp(), source: 'uploaded', linked: true, hash: hash(bytes), includeInContext: old?.includeInContext ?? true };
  }
  refresh(taskId: string) {
    const task = this.store.task(taskId);
    if (!task.rootId) throw invalid('This task has no linked project.');
    const files = task.files.map(f => f.linked ? this.readLinked(task, task.rootId!, filePath(f)) : f);
    const changed = files.some(f => f.hash !== task.files.find(old => old.id === f.id)?.hash);
    return this.store.mutate(s => ({ ...s, tasks: s.tasks.map(t => t.id === taskId ? { ...t, files, rounds: t.rounds.map(r => changed && !r.applied ? { ...r, suggestion: undefined } : r) } : t) }));
  }
  currentBytes(task: Task, fileId: string): Buffer {
    const file = task.files.find(f => f.id === fileId);
    if (!file) throw conflict('A reviewed file was removed. Investigate again.');
    return file.linked ? readTextBytes(this.resolveFile(task.rootId!, task.id, filePath(file))) : Buffer.from(file.content);
  }
  apply(taskId: string, roundId: string, suggestionId: string, key: string): ApplyResponse {
    const duplicate = this.store.operationByKey(key);
    if (duplicate) {
      if (duplicate.taskId !== taskId || duplicate.roundId !== roundId || duplicate.suggestionId !== suggestionId) throw conflict('This request key belongs to another operation.');
      if (duplicate.state !== 'applied' && duplicate.state !== 'undone') throw conflict('The prior operation did not complete. Inspect its status before retrying.');
      return this.response(duplicate);
    }
    const task = this.store.task(taskId), round = task.rounds.find(r => r.id === roundId);
    if (!round) throw invalid('Round not found.');
    if (round.completedAt || task.activeRoundId !== roundId) throw conflict('A completed or inactive round cannot be applied. Start a new diagnosis in the current round.');
    if (round.applied && round.operationId) return this.response(this.store.operation(round.operationId));
    const proposal = round.suggestion as Proposal | undefined;
    if (proposal?.id !== suggestionId || proposal.version !== 2 || proposal.outcome !== 'proposal' || !proposal.changes.length) throw conflict('There is no current, reviewable change to apply.');
    if (proposal.contextHash !== contextHash(task, round)) throw conflict('The observation or selected context changed. Investigate again.');
    for (const file of task.files.filter(f => f.includeInContext !== false && f.linked)) {
      if (hash(this.currentBytes(task, file.id)) !== hash(file.content)) throw conflict(`Context file changed since review: ${filePath(file)}. Refresh and investigate again.`);
    }
    for (const other of this.store.operations()) if (['prepared','applying','undoing','recovery_required'].includes(other.state)) throw conflict('A previous file operation needs recovery first.');
    const files = proposal.changes.map(c => {
      const file = task.files.find(f => f.id === c.fileId);
      if (!file || filePath(file) !== c.path || file.includeInContext === false) throw conflict('The selected context changed. Investigate again.');
      const before = this.currentBytes(task, c.fileId);
      if (hash(before) !== c.beforeHash) throw conflict(`File changed since review: ${c.path}. Refresh and investigate again.`);
      const after = Buffer.from(preserveTextStyle(decodeText(before), c.afterContent));
      return { fileId: c.fileId, path: c.path, linked: !!file.linked, beforeBase64: before.toString('base64'), afterBase64: after.toString('base64'), beforeHash: hash(before), afterHash: hash(after), rootId: task.rootId };
    });
    const op: OperationRecord = { id: `op-${randomUUID()}`, key, taskId, roundId, suggestionId, files, state: 'prepared', createdAt: timestamp(), recoveryTarget: 'before' };
    this.store.saveOperation(op);
    op.state = 'applying'; this.store.saveOperation(op);
    try {
      this.writePhysical(op, 'after');
      op.state = 'applied';
      this.commitOperation(op, true);
      return this.response(op);
    } catch (error) {
      op.error = error instanceof Error ? error.message : 'File write failed.';
      try { this.restorePhysical(op, 'before'); op.state = 'failed'; } catch { op.state = 'recovery_required'; }
      this.store.saveOperation(op);
      throw conflict(`Change was not applied: ${op.error}${op.state === 'recovery_required' ? ' Recovery needs attention; original bytes remain backed up.' : ' Original files were restored.'}`);
    }
  }
  undo(id: string, key: string): ApplyResponse {
    const op = this.store.operation(id);
    if (op.state === 'undone') return this.response(op);
    if (op.state !== 'applied') throw conflict('Only a successfully applied operation can be undone.');
    const task = this.store.task(op.taskId);
    for (const f of op.files) {
      const current = task.files.find(file => file.id === f.fileId);
      if (!current || !!current.linked !== f.linked || filePath(current) !== f.path || (f.linked && task.rootId !== f.rootId)) throw conflict('This operation belongs to a different project binding. Its original backup was retained.');
      if (hash(this.currentBytes(task, f.fileId)) !== f.afterHash) throw conflict(`Cannot undo because ${f.path} changed after applying. Your later edits were preserved.`);
    }
    op.state = 'undoing'; op.undoKey = key; op.recoveryTarget = 'after'; this.store.saveOperation(op);
    try {
      this.writePhysical(op, 'before');
      op.state = 'undone';
      this.commitOperation(op, false);
      return this.response(op);
    } catch (error) {
      op.error = error instanceof Error ? error.message : 'Undo failed.';
      try { this.restorePhysical(op, 'after'); op.state = 'applied'; } catch { op.state = 'recovery_required'; }
      this.store.saveOperation(op);
      throw conflict('Undo could not finish; the backed-up operation was retained.');
    }
  }
  writePhysical(op: OperationRecord, target: 'before'|'after'): void {
    for (const [index, f] of op.files.entries()) {
      if (!f.linked) continue;
      const path = this.resolveFile(f.rootId!, op.taskId, f.path);
      const expected = target === 'after' ? f.beforeHash : f.afterHash;
      if (hash(readFileSync(path)) !== expected) throw conflict(`${f.path} changed during the operation.`);
      this.atomicReplace(path, Buffer.from(target === 'after' ? f.afterBase64 : f.beforeBase64, 'base64'));
      this.fault?.('after-write', index);
    }
  }
  restorePhysical(op: OperationRecord, target: 'before'|'after'): void {
    for (const f of op.files) {
      if (!f.linked) continue;
      const path = this.resolveFile(f.rootId!, op.taskId, f.path);
      const current = hash(readFileSync(path)), desired = target === 'before' ? f.beforeHash : f.afterHash;
      if (current === desired) continue;
      if (current !== (target === 'before' ? f.afterHash : f.beforeHash)) throw conflict(`${f.path} contains an external edit; automatic recovery stopped.`);
      this.atomicReplace(path, Buffer.from(target === 'before' ? f.beforeBase64 : f.afterBase64, 'base64'));
    }
  }
  atomicReplace(path: string, bytes: Buffer): void {
    // The temporary file lives beside the destination so rename stays on the same volume.
    const temp = join(dirname(path), `.${basename(path)}.bridge-${randomUUID()}.tmp`);
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, lstatSync(path).mode);
      writeFileSync(descriptor, bytes); fsyncSync(descriptor); closeSync(descriptor); descriptor = undefined;
      renameSync(temp, path);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      if (existsSync(temp)) unlinkSync(temp);
    }
  }
  commitOperation(op: OperationRecord, applied: boolean): void {
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      this.store.saveOperation(op);
      this.store.mutate(s => ({ ...s, stage: s.activeTaskId === op.taskId && s.tasks.find(t => t.id === op.taskId)?.activeRoundId === op.roundId ? (applied ? 'test' : 'review') : s.stage, tasks: s.tasks.map(t => t.id !== op.taskId ? t : {
        ...t, files: t.files.map(file => {
          const entry = op.files.find(f => f.fileId === file.id);
          if (!entry) return file;
          const bytes = Buffer.from(applied ? entry.afterBase64 : entry.beforeBase64, 'base64');
          return { ...file, content: decodeText(bytes), hash: hash(bytes), size: bytes.length, updatedAt: timestamp() };
        }), rounds: t.rounds.map(r => r.id === op.roundId ? { ...r, applied, operationId: op.id } : r),
      }) }));
      this.store.db.exec('COMMIT');
    } catch (e) { this.store.db.exec('ROLLBACK'); throw e; }
  }
  recover(): void {
    for (const op of this.store.operations()) {
      if (!['prepared','applying','undoing','recovery_required'].includes(op.state)) continue;
      try {
        const undoing = op.recoveryTarget === 'after' || op.state === 'undoing';
        op.recoveryTarget = undoing ? 'after' : 'before';
        this.restorePhysical(op, undoing ? 'after' : 'before');
        op.state = undoing ? 'applied' : 'failed';
        op.error = 'Service restarted during the operation; files were restored from backup.';
      } catch (e) { op.state = 'recovery_required'; op.error = e instanceof Error ? e.message : 'Recovery could not complete.'; }
      this.store.saveOperation(op);
    }
  }
  response(op: OperationRecord): ApplyResponse { return { ...this.store.envelope(), operationId: op.id, changedFiles: op.files.map(f => f.path) }; }
}
