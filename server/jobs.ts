import { EventEmitter } from 'node:events';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PROVIDER_LABELS, type JobView, type ChatMessage, type Proposal, type ProviderId } from '../src/lib/backend-types.ts';
import type { Round } from '../src/lib/workflow.ts';
import type { ProviderSwitch } from './providers.ts';
import { Store } from './store.ts';
import { FileService } from './files.ts';
import { contextHash, writeSnapshot, diagnosisPrompt, chatPrompt, parseProposal, repairPrompt } from './context.ts';
import { checkChanges } from './verify.ts';
import { diagnosisOutputSchema } from './validation.ts';
import { BridgeError, conflict, invalid } from './errors.ts';

export interface InvestigateOptions {
  /** The user's answer to the questions of the last diagnosis, saved with the round. */
  answer?: string;
  /** Ask for a best-effort proposal instead of more questions. */
  proceed?: boolean;
}

export class Jobs {
  store: Store;
  files: FileService;
  provider: ProviderSwitch;
  dataDir: string;
  events = new EventEmitter();
  controllers = new Map<string, AbortController>();
  pending = new Set<Promise<void>>();
  timeoutMs: number;
  closing = false;
  constructor(store: Store, files: FileService, provider: ProviderSwitch, dataDir: string, timeoutMs = 5 * 60 * 1000) { this.store = store; this.files = files; this.provider = provider; this.dataDir = dataDir; this.timeoutMs = timeoutMs; }
  start(kind: 'investigate'|'chat', taskId: string, roundId?: string, message?: string, model?: string, expected: ProviderId = 'codex', options: InvestigateOptions = {}): JobView {
    if (this.closing) throw conflict('Local service is shutting down.');
    if (this.controllers.size) throw conflict(`${this.provider.label} is already working. Stop or finish the current request first.`);
    // Another window may have switched providers; never send this page's model or context to the other one.
    if (expected !== this.provider.active) throw new BridgeError(409, 'PROVIDER_CHANGED', `The AI provider was changed to ${this.provider.label} in another window. Check the connection and model, then send again.`);
    let task = this.store.task(taskId);
    if (task.rootId) { this.files.refresh(taskId); task = this.store.task(taskId); }
    let round = task.rounds.find(r => r.id === (roundId ?? task.activeRoundId));
    if (!round) throw invalid('Round not found.');
    if (round.id !== task.activeRoundId) throw conflict('Choose the current task round before starting a request.');
    if (kind === 'investigate' && (!round.observation.issues.length || round.applied || round.completedAt)) throw conflict('Choose an observation in an unapplied, active round.');
    if (kind === 'chat' && (!message?.trim() || message.length > 20000)) throw invalid('Enter a message up to 20,000 characters.');
    const answer = kind === 'investigate' ? options.answer?.trim() : undefined;
    if (answer && answer.length > 20000) throw invalid('Enter an answer up to 20,000 characters.');
    if (answer) {
      // The answer becomes part of this round's context, so every later diagnosis (and the proposal's
      // context hash) includes it. It fills the open question set, or is added as extra information.
      const roundKey = round.id, at = new Date().toISOString();
      this.store.mutate(s => ({ ...s, tasks: s.tasks.map(t => t.id !== taskId ? t : { ...t, rounds: t.rounds.map(r => r.id === roundKey ? answered(r, answer, at) : r) }) }));
      task = this.store.task(taskId);
      round = task.rounds.find(r => r.id === roundKey)!;
    }
    const activeRound = round;
    // The provider is fixed for the whole job; the app refuses to switch while a job runs.
    const providerId = this.provider.active, agent = PROVIDER_LABELS[providerId];
    const job: JobView = { id: `run-${randomUUID()}`, kind, taskId, roundId: activeRound.id, status: 'running', message: 'Preparing the selected context', text: '', createdAt: new Date().toISOString(), provider: providerId };
    const snapshotDir = join(this.dataDir, 'runs', job.id);
    const serialized = writeSnapshot(snapshotDir, task, activeRound);
    const fingerprint = contextHash(task, activeRound);
    // Chat history reaches a diagnosis only when the round includes history, like earlier rounds.
    const prior = kind === 'chat' || activeRound.observation.includePrevious ? this.store.messages(taskId) : [];
    if (kind === 'chat') this.store.message(taskId, { id: `msg-${randomUUID()}`, role: 'you', text: message!.trim(), createdAt: job.createdAt, status: 'completed' });
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    this.store.saveJob(job);
    const promise = (async () => {
      let timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
      timeout.unref();
      try {
        const provider = await this.provider.provider(providerId);
        const status = await provider.status();
        if (controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
        if (!status.available || !status.authenticated) throw new Error(status.error || `Connect ${agent} in Settings before sending a request.`);
        const prompt = kind === 'investigate' ? diagnosisPrompt(serialized, { conversation: prior, proceed: options.proceed }) : chatPrompt(serialized, message!, prior, activeRound.observation.includePrevious);
        const run = async (text: string) => {
          const result = await provider.run({
            prompt: text, snapshotDir, model, signal: controller.signal, outputSchema: kind === 'investigate' ? diagnosisOutputSchema : undefined,
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
          const latest = this.store.task(taskId), current = latest.rounds.find(r => r.id === activeRound.id);
          if (!current || latest.activeRoundId !== activeRound.id || contextHash(latest, current) !== fingerprint) throw conflict(`Context changed while ${agent} was working. This result was not applied; request a new diagnosis.`);
          return result;
        };
        let result = await run(prompt);
        job.text = result.text; job.threadId = result.threadId;
        if (kind === 'investigate') {
          let proposal = parseProposal(result.text, task, activeRound, `suggestion-${randomUUID()}`, providerId);
          if (proposal.outcome === 'proposal') {
            job.message = 'Checking the proposed files…'; this.emit(job);
            let checks = await checkChanges(proposal.changes, controller.signal);
            const failures = checks.filter(check => check.status === 'failed');
            if (failures.length) {
              // One correction round: the model sees the exact error instead of the user finding it on the hardware.
              job.message = `The automatic check found ${failures.length === 1 ? 'an error' : `${failures.length} errors`}; ${agent} is correcting the proposal…`; job.text = ''; this.emit(job);
              let retry: Awaited<ReturnType<typeof run>> | undefined, repaired: Proposal | undefined;
              try { retry = await run(repairPrompt(prompt, result.text, failures)); }
              catch (error) {
                // Cancellation, timeout and a changed context end the job. Any other failure of the
                // correction keeps the first proposal, with its failed check shown in review.
                if (controller.signal.aborted || error instanceof BridgeError) throw error;
              }
              if (retry) { try { repaired = parseProposal(retry.text, task, activeRound, `suggestion-${randomUUID()}`, providerId); } catch { /* Same: keep the first proposal. */ } }
              if (retry && repaired?.outcome === 'proposal') {
                job.message = 'Checking the corrected files…'; this.emit(job);
                proposal = repaired; result = retry; checks = await checkChanges(proposal.changes, controller.signal);
              }
              job.text = result.text; job.threadId = result.threadId ?? job.threadId;
            }
            proposal = { ...proposal, checks };
          }
          job.result = proposal;
          const asked = proposal.outcome === 'needs_information' ? { questions: proposal.questions, askedAt: new Date().toISOString() } : undefined;
          this.store.mutate(s => ({ ...s, stage: s.activeTaskId === taskId ? 'review' : s.stage, tasks: s.tasks.map(t => t.id !== taskId ? t : { ...t, rounds: t.rounds.map(r => r.id === activeRound.id ? { ...r, suggestion: proposal, applied: false, ...(asked ? { clarifications: [...(r.clarifications ?? []), asked] } : {}) } : r) }) }));
        } else {
          const reply: ChatMessage = { id: `msg-${randomUUID()}`, role: 'bit', text: result.text, createdAt: new Date().toISOString(), status: 'completed' };
          this.store.message(taskId, reply); job.result = reply;
        }
        job.status = 'completed'; job.message = kind === 'investigate' ? 'Ready for review' : 'Reply complete';
      } catch (e) {
        job.status = controller.signal.aborted ? (timedOut ? 'failed' : 'cancelled') : 'failed';
        job.error = timedOut ? `${agent} request timed out after five minutes. Retry with less context.` : controller.signal.aborted ? 'Request stopped. No file changes were made.' : e instanceof Error ? e.message : `${agent} request failed.`;
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
      job.message = `Stopping ${PROVIDER_LABELS[job.provider ?? this.provider.active]}…`;
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

/** Records an answer: it completes the last unanswered question set, or is kept as extra information. */
function answered(round: Round, answer: string, at: string): Round {
  const list = [...(round.clarifications ?? [])], last = list.at(-1);
  if (last && last.answer === undefined) list[list.length - 1] = { ...last, answer, answeredAt: at };
  else list.push({ questions: [], answer, answeredAt: at });
  // Keep the newest entries; the validated workspace bounds this list.
  return { ...round, clarifications: list.slice(-20) };
}
