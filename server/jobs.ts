import { EventEmitter } from 'node:events';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PROVIDER_LABELS, type JobView, type ChatMessage, type FileCheck, type Proposal, type ProviderId } from '../src/lib/backend-types.ts';
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

const MAX_ACTIVITY = 60, MAX_REASONING = 256 * 1024;
/** Record what the agent is doing as the current message and in the run's history. */
function note(job: JobView, text: string): void {
  job.message = text;
  const activity = job.activity ??= [];
  if (activity.at(-1)?.text === text) return;
  activity.push({ at: new Date().toISOString(), text });
  if (activity.length > MAX_ACTIVITY) activity.splice(1, activity.length - MAX_ACTIVITY);
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
    const round = task.rounds.find(r => r.id === (roundId ?? task.activeRoundId));
    if (!round) throw invalid('Round not found.');
    if (round.id !== task.activeRoundId) throw conflict('Choose the current task round before starting a request.');
    if (kind === 'investigate' && (!round.observation.issues.length || round.applied || round.completedAt)) throw conflict('Choose an observation in an unapplied, active round.');
    if (kind === 'chat' && (!message?.trim() || message.length > 20000)) throw invalid('Enter a message up to 20,000 characters.');
    const answer = kind === 'investigate' ? options.answer?.trim() : undefined;
    if (answer && answer.length > 20000) throw invalid('Enter an answer up to 20,000 characters.');
    // The answer becomes part of this round's context, so this and every later diagnosis (and the
    // proposal's context hash) include it. It is saved only once the request is accepted below.
    const activeRound = answer ? answered(round, answer, new Date().toISOString()) : round;
    if (answer) task = { ...task, rounds: task.rounds.map(r => r.id === activeRound.id ? activeRound : r) };
    // The provider is fixed for the whole job; the app refuses to switch while a job runs.
    const providerId = this.provider.active, agent = PROVIDER_LABELS[providerId];
    const job: JobView = { id: `run-${randomUUID()}`, kind, taskId, roundId: activeRound.id, status: 'running', message: 'Preparing the selected context', text: '', createdAt: new Date().toISOString(), provider: providerId };
    job.activity = [{ at: job.createdAt, text: job.message }];
    const snapshotDir = join(this.dataDir, 'runs', job.id);
    const serialized = writeSnapshot(snapshotDir, task, activeRound);
    const fingerprint = contextHash(task, activeRound);
    if (answer && activeRound !== round) this.store.mutate(s => ({ ...s, tasks: s.tasks.map(t => t.id !== taskId ? t : { ...t, rounds: t.rounds.map(r => r.id === activeRound.id ? { ...r, clarifications: activeRound.clarifications } : r) }) }));
    // Chat history reaches a diagnosis only when the round includes history, like earlier rounds.
    const prior = kind === 'chat' || activeRound.observation.includePrevious ? this.store.messages(taskId) : [];
    if (kind === 'chat') this.store.message(taskId, { id: `msg-${randomUUID()}`, role: 'you', text: message!.trim(), createdAt: job.createdAt, status: 'completed' });
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    this.store.saveJob(job);
    const promise = (async () => {
      let timedOut = false;
      const started = Date.now();
      const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
      timeout.unref();
      // A Stop ends the job. The job time limit ending an optional correction does not: the first
      // proposal is kept.
      const stopped = () => controller.signal.aborted && !timedOut;
      const ensureCurrent = () => {
        if (stopped()) throw new DOMException('Cancelled', 'AbortError');
        const latest = this.store.task(taskId), current = latest.rounds.find(r => r.id === activeRound.id);
        if (!current || latest.activeRoundId !== activeRound.id || contextHash(latest, current) !== fingerprint) throw conflict(`Context changed while ${agent} was working. This result was not applied; request a new diagnosis.`);
      };
      try {
        note(job, `Checking the ${agent} connection`); this.emit(job);
        const provider = await this.provider.provider(providerId);
        const status = await provider.status();
        if (controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
        if (!status.available || !status.authenticated) throw new Error(status.error || `Connect ${agent} in Settings before sending a request.`);
        note(job, `${agent} is connected${model ? ` (${model})` : ''}. Sending the selected context…`); this.emit(job);
        const prompt = kind === 'investigate' ? diagnosisPrompt(serialized, { conversation: prior, proceed: options.proceed }) : chatPrompt(serialized, message!, prior, activeRound.observation.includePrevious);
        const run = async (text: string) => {
          const result = await provider.run({
            prompt: text, snapshotDir, model, signal: controller.signal, outputSchema: kind === 'investigate' ? diagnosisOutputSchema : undefined,
            onEvent: event => {
              if (controller.signal.aborted || job.status !== 'running') return;
              if (event.type === 'delta') {
                if (job.text.length + event.text.length > 2 * 1024 * 1024) { controller.abort(); return; }
                job.text += event.text;
              } else if (event.type === 'reasoning') {
                if ((job.reasoning ?? '').length + event.text.length > MAX_REASONING) return;
                job.reasoning = (job.reasoning ?? '') + event.text;
              } else note(job, event.text);
              this.emit(job);
            },
          });
          if (controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
          ensureCurrent();
          return result;
        };
        let result = await run(prompt);
        job.text = result.text; job.threadId = result.threadId;
        if (kind === 'investigate') {
          const parse = (text: string) => parseProposal(text, task, activeRound, `suggestion-${randomUUID()}`, providerId);
          const check = async (value: Proposal): Promise<FileCheck[]> => {
            if (value.outcome !== 'proposal') return [];
            note(job, 'Checking the proposed files…'); this.emit(job);
            try { return await checkChanges(value.changes, controller.signal); }
            catch (error) {
              if (!timedOut) throw error;
              return value.changes.map(change => ({ path: change.path, check: 'Not checked', status: 'skipped', detail: 'The time limit ended the automatic check.' }));
            }
          };
          let proposal: Proposal | undefined, rejected: BridgeError | undefined;
          try { proposal = parse(result.text); }
          catch (error) { if (!(error instanceof BridgeError)) throw error; rejected = error; }
          let checks = proposal ? await check(proposal) : [];
          const failures = checks.filter(item => item.status === 'failed');
          // One correction round, while at least half of the time limit is left: the model sees the
          // exact problem instead of the user finding it on the hardware or getting a failed job.
          if ((rejected || failures.length) && Date.now() - started < this.timeoutMs / 2) {
            note(job, rejected ? `${agent}'s answer could not be used; asking for a corrected one…` : `The automatic check found ${failures.length === 1 ? 'an error' : `${failures.length} errors`}; ${agent} is correcting the proposal…`);
            job.text = ''; this.emit(job);
            try {
              const retry = await run(repairPrompt(prompt, result.text, rejected ? { rejected: rejected.message } : { failures }));
              const repaired = parse(retry.text);
              // A corrected proposal replaces the first one. A question in reply to a failed check does not.
              if (!proposal || repaired.outcome === 'proposal') { proposal = repaired; checks = await check(repaired); result = retry; }
            } catch (error) {
              // A Stop or a changed context ends the job. A failed correction (an unusable answer,
              // a provider error or the time limit) keeps the first proposal, or the first error.
              if (stopped() || (error instanceof BridgeError && error.statusCode === 409)) throw error;
              if (!proposal) throw rejected;
            }
            job.text = result.text; job.threadId = result.threadId ?? job.threadId;
          }
          if (!proposal) throw rejected!;
          ensureCurrent();
          const final: Proposal = proposal.outcome === 'proposal' ? { ...proposal, checks } : proposal;
          job.result = final;
          const asked = final.outcome === 'needs_information' ? { questions: final.questions, askedAt: new Date().toISOString() } : undefined;
          this.store.mutate(s => ({ ...s, stage: s.activeTaskId === taskId ? 'review' : s.stage, tasks: s.tasks.map(t => t.id !== taskId ? t : { ...t, rounds: t.rounds.map(r => r.id === activeRound.id ? { ...r, suggestion: final, applied: false, ...(asked ? { clarifications: [...(r.clarifications ?? []), asked].slice(-MAX_CLARIFICATIONS) } : {}) } : r) }) }));
        } else {
          const reply: ChatMessage = { id: `msg-${randomUUID()}`, role: 'bit', text: result.text, createdAt: new Date().toISOString(), status: 'completed' };
          this.store.message(taskId, reply); job.result = reply;
        }
        job.status = 'completed'; note(job, kind === 'investigate' ? 'Ready for review' : 'Reply complete');
      } catch (e) {
        job.status = controller.signal.aborted ? (timedOut ? 'failed' : 'cancelled') : 'failed';
        job.error = timedOut ? `${agent} request timed out after five minutes. Retry with less context.` : controller.signal.aborted ? 'Request stopped. No file changes were made.' : e instanceof Error ? e.message : `${agent} request failed.`;
        note(job, job.error);
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
      note(job, `Stopping ${PROVIDER_LABELS[job.provider ?? this.provider.active]}…`);
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

/** The newest question sets kept per round; the validated workspace allows more. */
const MAX_CLARIFICATIONS = 20;
/**
 * Records an answer: it completes the last unanswered question set, or is kept as extra information.
 * Sending the same answer again (a retry) records nothing new.
 */
function answered(round: Round, answer: string, at: string): Round {
  const list = [...(round.clarifications ?? [])], last = list.at(-1);
  if (list.some(item => item.answer === answer) && (!last || last.answer !== undefined)) return round;
  if (last && last.answer === undefined) list[list.length - 1] = { ...last, answer, answeredAt: at };
  else list.push({ questions: [], answer, answeredAt: at });
  return { ...round, clarifications: list.slice(-MAX_CLARIFICATIONS) };
}
