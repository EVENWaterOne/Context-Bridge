import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PROVIDER_LABELS, type JobView, type ChatMessage, type CommandRun, type FileCheck, type Proposal, type ProviderId, type Verification, type VerificationRun } from '../src/lib/backend-types.ts';
import type { Round, Task } from '../src/lib/workflow.ts';
import type { ProviderSwitch } from './providers.ts';
import { Store, filePath } from './store.ts';
import { FileService } from './files.ts';
import { contextHash, writeSnapshot, diagnosisPrompt, chatPrompt, parseProposal, repairPrompt, type RepairProblem, type RunContext } from './context.ts';
import { checkChanges } from './verify.ts';
import { diagnosisOutputSchema, runOutputSchema } from './validation.ts';
import { BridgeError, conflict, invalid } from './errors.ts';
import { createWorkCopy, detectCommand, readEdits, removeCopy, writeChanges, type WorkCopy } from './workcopy.ts';
import { runShell, type Sandbox } from './runner.ts';
import { codexBinary } from './codex.ts';

export interface InvestigateOptions {
  /** The user's answer to the questions of the last diagnosis, saved with the round. */
  answer?: string;
  /** Ask for a best-effort proposal instead of more questions. */
  proceed?: boolean;
}

const MAX_ACTIVITY = 60, MAX_REASONING = 256 * 1024;
/** Run mode: commands kept on the live job and on the proposal, and how much of each output. */
const LIVE_COMMANDS = 20, LIVE_OUTPUT = 2_000, KEPT_COMMANDS = 60, KEPT_OUTPUT = 4_000;
const VERIFY_LIMIT_MS = 5 * 60 * 1000;
const tail = (text: string | undefined, size: number) => text && text.length > size ? `…${text.slice(-size)}` : text;
const shortCommand = (text: string) => { const line = text.replace(/\s+/g, ' ').trim(); return line.length > 140 ? `${line.slice(0, 140)}…` : line; };
const minutes = (ms: number) => { if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} seconds`; const value = Math.round(ms / 60_000); return value === 1 ? 'one minute' : value === 5 ? 'five minutes' : `${value} minutes`; };

/**
 * The verification command for a run: only one the user typed or confirmed. A detected command is a
 * suggestion on the page until the user confirms it, because it comes from the project's own files.
 */
export function commandFor(task: Task): { text: string; source: 'user' } | undefined {
  const own = task.execution?.command?.trim();
  return own ? { text: own, source: 'user' } : undefined;
}
export { detectCommand };
/**
 * The OS sandbox for the verification command: Codex's own, from the pinned binary, with the
 * service's isolated Codex profile (which also keeps the one-time Windows sandbox setup).
 */
export async function codexSandbox(dataDir: string): Promise<Sandbox | undefined> {
  try { const binary = await codexBinary(); return { command: binary.command, env: binary.env, home: join(dataDir, 'codex'), writable: [] }; }
  catch { return undefined; }
}
/** The real project's own tools: its virtual environment and node_modules, read-only from the copy. */
function projectTools(root: string | undefined): { path: string[]; env: Record<string, string> } {
  const path: string[] = [], env: Record<string, string> = {};
  if (!root) return { path, env };
  for (const name of ['.venv', 'venv']) {
    const bin = join(root, name, process.platform === 'win32' ? 'Scripts' : 'bin');
    if (existsSync(bin)) { path.push(bin); env.VIRTUAL_ENV = join(root, name); break; }
  }
  const modules = join(root, 'node_modules');
  if (existsSync(modules)) { path.push(join(modules, '.bin')); env.NODE_PATH = modules; }
  return { path, env };
}
function describe(run: VerificationRun): string {
  if (run.status === 'passed') return 'passed';
  if (run.status === 'unavailable') return 'could not run (program not found)';
  if (run.status === 'timeout') return 'did not finish in time';
  return `failed${run.exitCode !== undefined && run.exitCode !== null ? ` (exit code ${run.exitCode})` : ''}`;
}
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
  /** The longer limit for a diagnosis that runs code: copying, building and testing take time. */
  runTimeoutMs: number;
  /** Whether a task without a saved choice runs code while diagnosing. */
  runCodeDefault: boolean;
  closing = false;
  /** The sandbox the verification command runs in; without one it does not run. */
  sandbox: () => Promise<Sandbox | undefined>;
  constructor(store: Store, files: FileService, provider: ProviderSwitch, dataDir: string, timeoutMs = 5 * 60 * 1000, run: { timeoutMs?: number; byDefault?: boolean; sandbox?: () => Promise<Sandbox | undefined> } = {}) {
    this.store = store; this.files = files; this.provider = provider; this.dataDir = dataDir; this.timeoutMs = timeoutMs;
    this.runTimeoutMs = run.timeoutMs ?? 20 * 60 * 1000; this.runCodeDefault = run.byDefault ?? true;
    this.sandbox = run.sandbox ?? (() => codexSandbox(dataDir));
  }
  /** Whether diagnoses of this task run code in a project copy. */
  runsCode(task: Task): boolean { return task.execution?.enabled ?? this.runCodeDefault; }
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
    const runMode = kind === 'investigate' && this.runsCode(task);
    const limit = runMode ? this.runTimeoutMs : this.timeoutMs;
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    this.store.saveJob(job);
    const promise = (async () => {
      let timedOut = false;
      const started = Date.now();
      const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, limit);
      timeout.unref();
      // Run mode: the agent's project copy, and a second copy where the service runs the verification
      // command on the current files and then on exactly the proposed text.
      let work: WorkCopy | undefined, verifyCopy: WorkCopy | undefined, tools = false;
      const commands: CommandRun[] = [];
      let commandCount = 0;
      const verification: Verification = {};
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
        let command: { text: string; source: 'user' } | undefined, runContext: RunContext | undefined, sandbox: Sandbox | undefined;
        const tools0 = projectTools(task.rootPath);
        const verifyTemp = join(snapshotDir, 'check-tmp');
        const verify = async (copy: WorkCopy, when: 'before' | 'after'): Promise<VerificationRun> => {
          const { text, source } = command!;
          note(job, when === 'before' ? `Running the verification command on your current files: ${shortCommand(text)}` : `Running the verification command on ${agent}'s change: ${shortCommand(text)}`); this.emit(job);
          let outcome: VerificationRun;
          try {
            // In the OS sandbox: writes only in the check copy and its temporary folder, no network.
            // Build caches go to that folder too, so a tool does not need to write in the user's home.
            const result = await runShell(text, copy.dir, controller.signal, Math.max(1_000, Math.min(VERIFY_LIMIT_MS, limit - (Date.now() - started))), {
              sandbox: { ...sandbox!, writable: [verifyTemp] }, path: tools0.path, scriptDir: verifyTemp,
              env: { ...tools0.env, TMPDIR: verifyTemp, TMP: verifyTemp, TEMP: verifyTemp, PYTHONDONTWRITEBYTECODE: '1', ARDUINO_BUILD_CACHE_PATH: join(verifyTemp, 'arduino-cache'), PLATFORMIO_CACHE_DIR: join(verifyTemp, 'platformio-cache'), PLATFORMIO_BUILD_CACHE_DIR: join(verifyTemp, 'platformio-build-cache') },
            });
            outcome = {
              command: text, source, exitCode: result.exitCode, durationMs: result.durationMs,
              status: result.notFound ? 'unavailable' : result.timedOut ? 'timeout' : result.exitCode === 0 ? 'passed' : 'failed',
              output: tail(result.notFound ? `${result.output}\nThe program was not found on this computer. Install it, or change the verification command.` : result.output, 32_000)!,
            };
          } catch (error) {
            if (!timedOut) throw error;
            outcome = { command: text, source, status: 'timeout', output: 'The time limit for this request ended the verification.', durationMs: 0 };
          }
          note(job, `Verification ${when === 'before' ? 'on your current files' : `of ${agent}'s change`}: ${describe(outcome)}`); this.emit(job);
          return outcome;
        };
        if (runMode) {
          // The agent runs commands only inside its provider's sandbox. Where that is not available,
          // the agent gets no tools and the service still runs the build or test command.
          const access = provider.commandAccess ? await provider.commandAccess(controller.signal).catch((error: Error) => {
            if (controller.signal.aborted) throw error;
            return { available: false, note: `${agent} could not prepare its sandbox: ${error.message}` };
          }) : { available: false, note: `${agent} cannot run commands in this service.` };
          if (controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
          tools = access.available;
          if (!tools) { note(job, `${access.note} ${agent} will not run commands itself.`); this.emit(job); }
          command = commandFor(task);
          if (command) {
            sandbox = await this.sandbox();
            if (!sandbox) { note(job, 'No sandbox is available on this computer for the build or test command, so it does not run.'); this.emit(job); command = undefined; }
          }
          if (!tools && !command) { note(job, 'Nothing runs in this request, so it works like Read only.'); this.emit(job); }
          else { note(job, 'Copying the project, so code can run without touching your files…'); this.emit(job); }
          if (tools) work = await createWorkCopy(task, join(snapshotDir, 'work'), controller.signal);
          if (command) {
            verifyCopy = await createWorkCopy(task, join(snapshotDir, 'check'), controller.signal);
            await Promise.all([mkdir(verifyTemp, { recursive: true }), mkdir(sandbox!.home, { recursive: true })]);
            verification.before = await verify(verifyCopy, 'before');
          }
          runContext = { tools, editable: task.files.filter(f => f.includeInContext !== false).map(f => filePath(f)), command: command?.text, before: verification.before };
        }
        note(job, `${agent} is connected${model ? ` (${model})` : ''}. ${tools ? `Sending the request; ${agent} works in the project copy and can run commands there…` : 'Sending the selected context…'}`); this.emit(job);
        const prompt = kind === 'investigate' ? diagnosisPrompt(serialized, { conversation: prior, proceed: options.proceed, run: runContext }) : chatPrompt(serialized, message!, prior, activeRound.observation.includePrevious);
        const run = async (text: string) => {
          const result = await provider.run({
            prompt: text, snapshotDir, model, signal: controller.signal, workspace: work?.dir,
            // The adapter's own limit never cuts the job's limit short (run mode allows longer builds).
            timeoutMs: Math.max(1_000, limit - (Date.now() - started)),
            outputSchema: kind === 'investigate' ? (tools ? runOutputSchema : diagnosisOutputSchema) : undefined,
            onEvent: event => {
              if (controller.signal.aborted || job.status !== 'running') return;
              if (event.type === 'command') {
                const entry: CommandRun = { ...event.command, command: event.command.command.slice(0, 4_000), output: tail(event.command.output, KEPT_OUTPUT) };
                const index = commands.findIndex(item => item.id === entry.id);
                if (index >= 0) commands[index] = entry;
                else { commands.push(entry); commandCount++; if (commands.length > KEPT_COMMANDS) commands.shift(); }
                job.commands = commands.slice(-LIVE_COMMANDS).map(item => ({ ...item, output: tail(item.output, LIVE_OUTPUT) }));
                job.commandCount = commandCount;
                const exit = entry.exitCode !== undefined && entry.exitCode !== null ? ` (exit code ${entry.exitCode})` : '';
                note(job, entry.status === 'running' ? `${index >= 0 ? 'Running in the background' : 'Running'}: ${shortCommand(entry.command)}` : entry.status === 'declined' ? `Not allowed: ${shortCommand(entry.command)}` : `${entry.status === 'completed' ? 'Finished' : 'Failed'}: ${shortCommand(entry.command)}${exit}`);
              } else if (event.type === 'delta') {
                if (job.text.length + event.text.length > 2 * 1024 * 1024) { controller.abort(); return; }
                job.text += event.text;
              } else if (event.type === 'reasoning') {
                if ((job.reasoning ?? '').length + event.text.length > MAX_REASONING) return;
                job.reasoning = (job.reasoning ?? '') + event.text;
              } else note(job, event.text);
              this.emit(job);
            },
          });
          // The provider ends commands left running in the background before it returns.
          if (commands.some(item => item.status === 'running')) {
            for (const [index, item] of commands.entries()) if (item.status === 'running') commands[index] = { ...item, status: 'failed', exitCode: null, output: tail(`${item.output ? `${item.output}\n` : ''}Still running when ${agent} finished, so it was stopped.`, KEPT_OUTPUT) };
            job.commands = commands.slice(-LIVE_COMMANDS).map(item => ({ ...item, output: tail(item.output, LIVE_OUTPUT) }));
            this.emit(job);
          }
          if (controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
          ensureCurrent();
          return result;
        };
        let result = await run(prompt);
        job.text = result.text; job.threadId = result.threadId;
        if (kind === 'investigate') {
          // In run mode the file changes are read from the agent's project copy.
          const parse = async (text: string) => parseProposal(text, task, activeRound, `suggestion-${randomUUID()}`, providerId, work ? await readEdits(task, work, controller.signal) : undefined);
          const check = async (value: Proposal): Promise<FileCheck[]> => {
            if (value.outcome !== 'proposal') return [];
            note(job, 'Checking the proposed files…'); this.emit(job);
            try { return await checkChanges(value.changes, controller.signal); }
            catch (error) {
              if (!timedOut) throw error;
              return value.changes.map(change => ({ path: change.path, check: 'Not checked', status: 'skipped', detail: 'The time limit ended the automatic check.' }));
            }
          };
          // Exactly the proposed text, on a fresh copy of the current files: what Apply would produce.
          const verifyProposal = async (value: Proposal): Promise<VerificationRun | undefined> => {
            if (!verifyCopy || value.outcome !== 'proposal' || verification.before?.status === 'unavailable') return undefined;
            await writeChanges(verifyCopy, task.files.filter(f => f.includeInContext !== false).map(f => ({ path: filePath(f), afterContent: f.content })));
            await writeChanges(verifyCopy, value.changes);
            return verify(verifyCopy, 'after');
          };
          let proposal: Proposal | undefined, rejected: BridgeError | undefined;
          try { proposal = await parse(result.text); }
          catch (error) { if (!(error instanceof BridgeError)) throw error; rejected = error; }
          let checks = proposal ? await check(proposal) : [];
          let after = proposal ? await verifyProposal(proposal) : undefined;
          const failures = checks.filter(item => item.status === 'failed');
          // A verification that passed on the current files and fails with the change: the change broke it.
          const broke = (value?: VerificationRun) => !!value && (value.status === 'failed' || value.status === 'timeout') && verification.before?.status === 'passed';
          // One correction round, while at least half of the time limit is left: the model sees the
          // exact problem instead of the user finding it on the hardware or getting a failed job.
          if ((rejected || failures.length || broke(after)) && Date.now() - started < limit / 2) {
            const problem: RepairProblem = rejected ? { rejected: rejected.message } : failures.length ? { failures } : { verification: after! };
            note(job, rejected ? `${agent}'s answer could not be used; asking for a corrected one…` : failures.length ? `The automatic check found ${failures.length === 1 ? 'an error' : `${failures.length} errors`}; ${agent} is correcting the proposal…` : `The verification command failed with the change; ${agent} is correcting it…`);
            job.text = ''; this.emit(job);
            try {
              const retry = await run(repairPrompt(prompt, result.text, problem, tools));
              const repaired = await parse(retry.text);
              // A corrected proposal replaces the first one. A question in reply to a failed check does not.
              if (!proposal || repaired.outcome === 'proposal') { proposal = repaired; checks = await check(repaired); after = await verifyProposal(repaired); result = retry; }
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
          const ran = runMode ? {
            commands: commands.map(item => ({ ...item, output: tail(item.output, KEPT_OUTPUT) })), commandCount,
            ...(command ? { verification: { ...verification, ...(after ? { after } : {}) } } : {}),
          } : {};
          const final: Proposal = proposal.outcome === 'proposal' ? { ...proposal, checks, ...ran } : { ...proposal, ...ran };
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
        job.error = timedOut ? `${agent} request timed out after ${minutes(limit)}. Retry with less context${runMode ? ' or a faster verification command' : ''}.` : controller.signal.aborted ? 'Request stopped. No file changes were made.' : e instanceof Error ? e.message : `${agent} request failed.`;
        note(job, job.error);
        if (kind === 'chat') this.store.message(taskId, { id: `msg-${job.id}`, role: 'bit', text: job.text || job.error, status: job.status === 'cancelled' ? 'cancelled' : 'failed', createdAt: new Date().toISOString() });
      } finally {
        clearTimeout(timeout);
        // The copies can be large; the proposal keeps everything the review needs. A copy that stopped
        // partway, and the agents' temporary folders, go too.
        if (runMode) await Promise.all(['work', 'check', 'check-tmp', 'tmp'].map(name => removeCopy(join(snapshotDir, name))));
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
