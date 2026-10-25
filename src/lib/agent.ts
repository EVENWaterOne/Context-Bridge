import type { Task, Round, Suggestion } from './workflow.ts';
export interface AgentContext { task: Task; round: Round }
export interface AgentProgress { progress: number; message: string }
export interface AgentOptions { signal?: AbortSignal; onProgress?: (progress: AgentProgress) => void; durationMs?: number }
export interface ApplyResult { status: 'applied'; suggestionId: string; changedFiles: string[]; message: string }
/** Replace this adapter when a server-side Agent connection is available. Never place API secrets in browser code. */
export interface AgentAdapter { investigate(context: AgentContext, options?: AgentOptions): Promise<Suggestion>; applySuggestion(context: AgentContext, options?: AgentOptions): Promise<ApplyResult> }
function abortError() { return new DOMException('Operation cancelled', 'AbortError'); }
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const done = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(done, ms);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(abortError()); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}
async function progress(messages: string[], options: AgentOptions, duration: number) {
  for (let i = 0; i < messages.length; i++) {
    if (options.signal?.aborted) throw abortError();
    options.onProgress?.({ progress: Math.round(i / messages.length * 100), message: messages[i] });
    await pause((options.durationMs ?? duration) / messages.length, options.signal);
  }
  options.onProgress?.({ progress: 100, message: 'Ready' });
}
export function buildSuggestion({ task, round }: AgentContext): Suggestion {
  const o = round.observation;
  const file = task.files.find(f => f.kind === 'code');
  const fileName = file?.name ?? 'motion.py';
  let parameter = 'return_duration', before = '0.6', after = '1.2', unit = 's';
  let title = 'Slow down the return.', summary = 'Same target angle. A gentler return.', rationale = 'The return duration is short relative to the requested motion. Giving the same path more time reduces the abrupt acceleration without changing the target angle.';
  const issue = o.issue;
  if (issue === 'No motion') { parameter = 'servo_enabled'; before = 'False'; after = 'True'; unit = ''; title = 'Enable the motion output.'; summary = `Restore the command path to ${o.joint}.`; rationale = 'This example checks the output-enable flag before changing movement parameters. In a real session BIT would validate the controller trace and wiring first.'; }
  if (issue === 'Wrong way') { parameter = 'servo_direction'; before = '1'; after = '-1'; unit = ''; title = 'Correct the return direction.'; summary = `Reverse ${o.joint} direction, keeping the travel limits.`; rationale = 'The example mapping inverts the servo direction. Keep the existing angle limits and start with a short test to confirm the physical direction.'; }
  if (issue === 'Shaking') { parameter = 'step_interval'; before = '0.02'; after = '0.04'; unit = 's'; title = 'Give each step room to settle.'; summary = 'Space the commands for a steadier movement.'; rationale = 'In this example, back-to-back updates make the joint chase its target. Increasing the interval reduces command frequency while preserving the target.'; }
  if (issue === 'Error message') { parameter = 'serial_timeout'; before = '0.1'; after = '1.0'; unit = 's'; title = 'Allow time for the controller reply.'; summary = 'Wait for the acknowledgement before the next command.'; rationale = 'The sample log models a timeout. A longer acknowledgement window can prevent a valid reply from being treated as missing. Verify the actual error before applying to hardware.'; }
  if (issue === 'Other') { parameter = 'return_duration'; title = 'Try one controlled change.'; summary = 'Keep the geometry; slow the next test.'; rationale = 'Your observation needs a small, reversible experiment. This demo proposes a slower motion and keeps the target and joint limits unchanged.'; }
  const existing = file?.content.match(new RegExp(`^${parameter}\\s*=\\s*([^\\n#]+)`, 'm'))?.[1]?.trim();
  if (existing) before = existing;
  if (parameter === 'return_duration' && Number.isFinite(Number(before))) after = (Math.min(Number(before) * 2, 4)).toFixed(1);
  const completed = task.rounds.filter(r => r.completedAt);
  return { id: `suggestion-${round.id}`, title, summary, rationale, parameter, before, after, unit, fileName, codeBefore: `${parameter} = ${before}`, codeAfter: `${parameter} = ${after}`, confidence: 'Example recommendation', evidence: [`${o.joint} · ${o.phase.toLowerCase()} · ${issue ?? 'observation'}`, `${fileName} · ${parameter}`, ...(o.includePrevious && completed.length ? [`Round ${completed.at(-1)!.number} · ${completed.at(-1)!.result}`] : [])], steps: ['Review the parameter and explanation.', 'Apply the change to this task’s local code.', 'Run the simulated test, then record what changed.'], risk: 'Simulation only. A real hardware connection must verify limits and require a separate test approval.' };
}
export const mockAgent: AgentAdapter = {
  async investigate(context, options = {}) {
    if (!context.round.observation.issue) throw new Error('Choose an observation before asking BIT.');
    await progress(['Opening the context folder', 'Checking hardware and motion code', 'Comparing the relevant rounds', 'Preparing one focused change'], options, 9600);
    return buildSuggestion(context);
  },
  async applySuggestion(context, options = {}) {
    const suggestion = context.round.suggestion;
    if (!suggestion) throw new Error('There is no change to apply.');
    await progress(['Preparing a local checkpoint', 'Updating the motion parameter', 'Checking the change', 'Ready for your test'], options, 10400);
    return { status: 'applied', suggestionId: suggestion.id, changedFiles: [suggestion.fileName], message: 'Local example code updated. No physical hardware moved.' };
  },
};
/** Explicit opt-in HTTP adapter. The endpoint should be your own authenticated server, which holds secrets. */
export function createHttpAgent(baseUrl: string, request: typeof fetch = fetch): AgentAdapter {
  if (!baseUrl.startsWith('/') && !/^https:\/\//.test(baseUrl)) throw new Error('Use a same-origin path or an HTTPS Agent endpoint.');
  const call = async <T>(action: string, context: AgentContext, options: AgentOptions = {}): Promise<T> => {
    if (options.signal?.aborted) throw abortError();
    options.onProgress?.({ progress: 0, message: 'Contacting your Agent' });
    const response = await request(`${baseUrl.replace(/\/$/, '')}/${action}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: 1, task: context.task, round: context.round }), signal: options.signal });
    if (!response.ok) throw new Error(`Agent request failed (${response.status}). Try again.`);
    const body = await response.json() as T;
    options.onProgress?.({ progress: 100, message: 'Ready' });
    return body;
  };
  return { investigate: (context, options) => call<Suggestion>('investigate', context, options), applySuggestion: (context, options) => call<ApplyResult>('apply', context, options) };
}
export const agent = mockAgent;
