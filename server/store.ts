import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createInitialWorkspace, type Workspace, type Task } from '../src/lib/workflow.ts';
import type { JobView, ChatMessage, WorkspaceEnvelope } from '../src/lib/backend-types.ts';
import { conflict, invalid, missing } from './errors.ts';
import { validateWorkspace } from './validation.ts';

export const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export const filePath = (file: { name: string; relativePath?: string }) => file.relativePath ?? file.name;
export interface RootRecord { id: string; taskId: string; path: string }
export interface OperationRecord {
  id: string; key: string; taskId: string; roundId: string; suggestionId: string; state: 'prepared'|'applying'|'applied'|'failed'|'undoing'|'undone'|'recovery_required';
  files: { fileId: string; path: string; linked: boolean; beforeBase64: string; afterBase64: string; beforeHash: string; afterHash: string; rootId?: string }[];
  createdAt: string; error?: string; undoKey?: string; recoveryTarget?: 'before'|'after';
}
export class Store {
  db: DatabaseSync;
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, 'bridge.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY, revision INTEGER NOT NULL, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS roots (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, path TEXT NOT NULL); CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, key TEXT UNIQUE NOT NULL, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS imports (source TEXT PRIMARY KEY);');
    this.db.exec('PRAGMA synchronous=FULL;');
    if (!this.db.prepare('SELECT id FROM settings WHERE id=1').get()) this.db.prepare('INSERT INTO settings VALUES(1,0,?)').run(JSON.stringify(createInitialWorkspace()));
    for (const j of this.jobs()) if (j.status === 'running') this.saveJob({ ...j, status: 'interrupted', message: 'Local service restarted. Retry this request.', error: 'Service restarted before the turn finished.' });
    const w = this.envelope().workspace;
    if (w.stage === 'investigating' || w.stage === 'applying') this.mutate(s => ({ ...s, stage: s.stage === 'investigating' ? 'request' : 'review' }));
  }
  envelope(): WorkspaceEnvelope {
    const row = this.db.prepare('SELECT revision,value FROM settings WHERE id=1').get()!;
    return { version: 2, revision: Number(row.revision), workspace: JSON.parse(String(row.value)), activeJobs: this.jobs().filter(j => j.status === 'running') };
  }
  task(id: string): Task {
    const task = this.envelope().workspace.tasks.find(t => t.id === id);
    if (!task) throw missing('Task not found.');
    return task;
  }
  mutate(fn: (workspace: Workspace) => Workspace): WorkspaceEnvelope {
    const current = this.envelope();
    const before = JSON.stringify(current.workspace);
    const next = fn(current.workspace);
    const value = JSON.stringify(next);
    if (value !== before) this.db.prepare('UPDATE settings SET revision=revision+1,value=? WHERE id=1').run(value);
    return this.envelope();
  }
  save(value: unknown, expected: number): WorkspaceEnvelope {
    const current = this.envelope();
    if (expected !== current.revision) throw conflict('Workspace changed. Reload the latest saved workspace before retrying.');
    const incoming = validateWorkspace(value);
    const tasks = incoming.tasks.map(t => {
      const previous = current.workspace.tasks.find(p => p.id === t.id);
      if (!previous) return this.stripBinding(t);
      // A browser can edit imported copies and metadata, but cannot forge a real-project write or an approved proposal.
      const files = t.files.map(f => {
        const old = previous.files.find(p => p.id === f.id);
        if (old?.linked) {
          if (f.content !== old.content || filePath(f) !== filePath(old) || !f.linked) throw conflict('Refresh linked project files through the project service.');
          return { ...old, includeInContext: f.includeInContext };
        }
        if (f.linked) throw invalid('Bind local files through the project picker first.');
        return { ...f, hash: hash(f.content) };
      });
      const contextChanged = JSON.stringify(files) !== JSON.stringify(previous.files) || JSON.stringify(t.hardware) !== JSON.stringify(previous.hardware);
      const rounds = t.rounds.map(r => {
        const old = previous.rounds.find(p => p.id === r.id);
        if (!old) return { ...r, applied: false, suggestion: undefined, operationId: undefined };
        const changed = contextChanged || JSON.stringify(r.observation) !== JSON.stringify(old.observation);
        return { ...r, applied: old.applied, operationId: old.operationId, suggestion: old.applied || !changed ? old.suggestion : undefined };
      });
      return { ...t, rootId: previous.rootId, rootPath: previous.rootPath, files, rounds };
    });
    // Removing task data while an operation needs recovery would make its backup unreachable.
    for (const op of this.operations()) if (['prepared','applying','undoing','recovery_required'].includes(op.state) && !tasks.some(t => t.id === op.taskId)) throw conflict('Resolve the pending file operation before removing its task.');
    return this.mutate(() => ({ ...incoming, tasks }));
  }
  stripBinding(t: Task): Task {
    return { ...t, rootId: undefined, rootPath: undefined, files: t.files.map(f => ({ ...f, linked: false, hash: hash(f.content) })), rounds: t.rounds.map(r => ({ ...r, operationId: undefined, suggestion: r.suggestion?.version === 2 ? undefined : r.suggestion, applied: !!r.completedAt && r.applied })) };
  }
  import(value: { task?: Task; workspace?: Workspace; sourceId: string }): WorkspaceEnvelope {
    if (!value.sourceId || value.sourceId.length > 300) throw invalid('An import source ID is required.');
    if (this.db.prepare('SELECT source FROM imports WHERE source=?').get(value.sourceId)) return this.envelope();
    const source = value.workspace ?? (value.task ? { version: 1, tasks: [value.task], activeTaskId: value.task.id, stage: 'setup' } : null);
    const parsed = validateWorkspace(source);
    const current = this.envelope().workspace;
    const additions: Task[] = [];
    for (const t of parsed.tasks) {
      const existing = current.tasks.find(p => p.id === t.id);
      // The same exported task is a no-op; an edited export gets a new identity rather than replacing local work.
      if (existing && JSON.stringify(this.stripBinding(existing)) === JSON.stringify(this.stripBinding(t))) continue;
      const imported = this.stripBinding(t);
      additions.push(existing ? { ...imported, id: `task-${randomUUID()}` } : imported);
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO imports VALUES(?)').run(value.sourceId);
      const result = this.mutate(s => ({ ...s, tasks: [...s.tasks, ...additions], activeTaskId: additions[0]?.id ?? s.activeTaskId, stage: 'setup' }));
      this.db.exec('COMMIT');
      return result;
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  saveJob(job: JobView): void { this.db.prepare('INSERT OR REPLACE INTO jobs VALUES(?,?)').run(job.id, JSON.stringify(job)); }
  job(id: string): JobView { const row = this.db.prepare('SELECT value FROM jobs WHERE id=?').get(id); if (!row) throw missing('Run not found.'); return JSON.parse(String(row.value)); }
  jobs(): JobView[] { return this.db.prepare('SELECT value FROM jobs').all().map(row => JSON.parse(String(row.value))); }
  message(taskId: string, message: ChatMessage): void { this.db.prepare('INSERT OR REPLACE INTO messages VALUES(?,?,?)').run(message.id, taskId, JSON.stringify(message)); }
  messages(taskId: string): ChatMessage[] { this.task(taskId); return this.db.prepare('SELECT value FROM messages WHERE task_id=? ORDER BY rowid').all(taskId).map(row => JSON.parse(String(row.value))); }
  root(id: string, taskId: string): RootRecord {
    const row = this.db.prepare('SELECT * FROM roots WHERE id=? AND task_id=?').get(id, taskId);
    if (!row) throw missing('Project selection expired or does not belong to this task.');
    return { id: String(row.id), taskId: String(row.task_id), path: String(row.path) };
  }
  saveRoot(root: RootRecord): void { this.db.prepare('INSERT INTO roots VALUES(?,?,?)').run(root.id, root.taskId, root.path); }
  saveOperation(op: OperationRecord): void { this.db.prepare('INSERT INTO operations VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(op.id, op.key, JSON.stringify(op)); }
  operation(id: string): OperationRecord { const row = this.db.prepare('SELECT value FROM operations WHERE id=?').get(id); if (!row) throw missing('File operation not found.'); return JSON.parse(String(row.value)); }
  operationByKey(key: string): OperationRecord | undefined { const row = this.db.prepare('SELECT value FROM operations WHERE key=?').get(key); return row ? JSON.parse(String(row.value)) : undefined; }
  operations(): OperationRecord[] { return this.db.prepare('SELECT value FROM operations').all().map(row => JSON.parse(String(row.value))); }
  close(): void { this.db.close(); }
}
