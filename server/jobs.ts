import { EventEmitter } from 'node:events';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { JobView, ChatMessage } from '../src/lib/backend-types.ts';
import type { CodexProvider } from './provider.ts';
import { Store } from './store.ts';
import { FileService } from './files.ts';
import { contextHash, writeSnapshot, diagnosisPrompt, chatPrompt, parseProposal } from './context.ts';
import { diagnosisOutputSchema } from './validation.ts';
import { conflict, invalid } from './errors.ts';

export class Jobs {
  store: Store;
  files: FileService;
  provider: CodexProvider;
  dataDir: string;
  events = new EventEmitter();
  controllers = new Map<string, AbortController>();
  pending = new Set<Promise<void>>();
  timeoutMs: number;
  closing = false;
  constructor(store: Store, files: FileService, provider: CodexProvider, dataDir: string, timeoutMs = 5 * 60 * 1000) { this.store = store; this.files = files; this.provider = provider; this.dataDir = dataDir; this.timeoutMs = timeoutMs; }
  start(kind: 'investigate'|'chat', taskId: string, roundId?: string, message?: string, model?: string): JobView {
    if (this.closing) throw conflict('Local service is shutting down.');
    if (this.controllers.size) throw conflict('Codex is already working. Stop or finish the current request first.');
    let task = this.store.task(taskId);
    if (task.rootId) { this.files.refresh(taskId); task = this.store.task(taskId); }
    const round = task.rounds.find(r => r.id === (roundId ?? task.activeRoundId));
    if (!round) throw invalid('Round not found.');
    if (round.id !== task.activeRoundId) throw conflict('Choose the current task round before starting a request.');
    if (kind === 'investigate' && (!round.observation.issues.length || round.applied || round.completedAt)) throw conflict('Choose an observation in an unapplied, active round.');
    if (kind === 'chat' && (!message?.trim() || message.length > 20000)) throw invalid('Enter a message up to 20,000 characters.');
    const job: JobView = { id: `run-${randomUUID()}`, kind, taskId, roundId: round.id, status: 'running', message: 'Preparing the selected context', text: '', createdAt: new Date().toISOString() };
    const snapshotDir = join(this.dataDir, 'runs', job.id);
    const serialized = writeSnapshot(snapshotDir, task, round);
    const fingerprint = contextHash(task, round);
    const prior = kind === 'chat' ? this.store.messages(taskId) : [];
    if (kind === 'chat') this.store.message(taskId, { id: `msg-${randomUUID()}`, role: 'you', text: message!.trim(), createdAt: job.createdAt, status: 'completed' });
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    this.store.saveJob(job);
    const promise = (async () => {
      let timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
      timeout.unref();
      try {
        const status = await this.provider.status();
        if (controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
        if (!status.available || !status.authenticated) throw new Error(status.error || 'Connect your Codex account in Settings before sending a request.');
        const prompt = kind === 'investigate' ? diagnosisPrompt(serialized) : chatPrompt(serialized, message!, prior, round.observation.includePrevious);
        const result = await this.provider.run({
          prompt, snapshotDir, model, signal: controller.signal, outputSchema: kind === 'investigate' ? diagnosisOutputSchema : undefined,
          onEvent: event => {
            if (controller.signal.aborted || job.status !== 'running') return;
            if (event.type === 'delta') {
              if (job.text.length + event.text.length > 2 * 1024 * 1024) { controller.abort(); return; }
              job.text += event.text;
            } else job.message = event.text;
            this.emit(job);
          },
        });
        if (controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
        job.text = result.text; job.threadId = result.threadId;
        const latest = this.store.task(taskId), current = latest.rounds.find(r => r.id === round.id);
        if (!current || latest.activeRoundId !== round.id || contextHash(latest, current) !== fingerprint) throw conflict('Context changed while Codex was working. This result was not applied; request a new diagnosis.');
        if (kind === 'investigate') {
          const proposal = parseProposal(result.text, task, round, `suggestion-${randomUUID()}`);
          job.result = proposal;
          this.store.mutate(s => ({ ...s, stage: s.activeTaskId === taskId ? 'review' : s.stage, tasks: s.tasks.map(t => t.id !== taskId ? t : { ...t, rounds: t.rounds.map(r => r.id === round.id ? { ...r, suggestion: proposal, applied: false } : r) }) }));
        } else {
          const reply: ChatMessage = { id: `msg-${randomUUID()}`, role: 'bit', text: result.text, createdAt: new Date().toISOString(), status: 'completed' };
          this.store.message(taskId, reply); job.result = reply;
        }
        job.status = 'completed'; job.message = kind === 'investigate' ? 'Ready for review' : 'Reply complete';
      } catch (e) {
        job.status = controller.signal.aborted ? (timedOut ? 'failed' : 'cancelled') : 'failed';
        job.error = timedOut ? 'Codex request timed out after five minutes. Retry with less context.' : controller.signal.aborted ? 'Request stopped. No file changes were made.' : e instanceof Error ? e.message : 'Codex request failed.';
        job.message = job.error;
        if (kind === 'chat') this.store.message(taskId, { id: `msg-${job.id}`, role: 'bit', text: job.text || job.error, status: job.status === 'cancelled' ? 'cancelled' : 'failed', createdAt: new Date().toISOString() });
      } finally {
        clearTimeout(timeout);
        this.controllers.delete(job.id);
        this.emit(job);
      }
    })();
    this.pending.add(promise);
    void promise.finally(() => this.pending.delete(promise));
    return job;
  }
  emit(job: JobView): void { this.store.saveJob(job); this.events.emit(job.id, structuredClone(job)); }
  cancel(id: string): JobView {
    const job = this.store.job(id);
    const controller = this.controllers.get(id);
    if (controller) {
      controller.abort();
      // The provider must interrupt its actual turn; terminal persistence happens after it acknowledges abort.
      job.message = 'Stopping Codex…';
      this.emit(job);
    }
    return job;
  }
  async close(): Promise<void> {
    this.closing = true;
    for (const controller of this.controllers.values()) controller.abort();
    await this.provider.close();
    await Promise.allSettled([...this.pending]);
    this.events.removeAllListeners();
  }
}
