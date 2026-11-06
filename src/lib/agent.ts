import { motionAssignment, motionSource, type Task, type Round, type Suggestion } from './workflow.ts';
export interface AgentContext { task: Task; round: Round }
export interface AgentProgress { progress: number; message: string }
export interface AgentOptions { signal?: AbortSignal; onProgress?: (progress: AgentProgress) => void; durationMs?: number }
export interface ApplyResult { status: 'applied'; suggestionId: string; changedFiles: string[]; message: string }
export interface RunResult { status: 'completed'; mode: 'simulated' | 'hardware'; message: string }
/** Legacy demonstration adapter. The application uses local-api.ts for real Codex jobs and file operations. */
export interface AgentAdapter { investigate(context: AgentContext, options?: AgentOptions): Promise<Suggestion>; applySuggestion(context: AgentContext, options?: AgentOptions): Promise<ApplyResult>; runMotion(context: AgentContext, options?: AgentOptions): Promise<RunResult> }
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
/** The exact request shown in the UI is also the payload sent to the HTTP adapter. */
export function buildAgentRequest({task,round}:AgentContext) {
  const includePrevious=round.observation.includePrevious;
  const files=task.files.filter(file=>{
    if(includePrevious||file.source==='uploaded')return true;
    const historical=file.name.match(/^(?:round|run)-(\d+)(?:[.-]|$)/i);
    return !historical||Number(historical[1])===round.number;
  });
  return {version:1,task:{...task,files,rounds:includePrevious?task.rounds:task.rounds.filter(item=>item.id===round.id)},round};
}
export function buildSuggestion({ task, round }: AgentContext): Suggestion {
  const o = round.observation;
  const file = motionSource(task);
  const fileName = file?.name ?? 'motion.py';
  let parameter = 'return_duration', before = '0.6', after = '1.2', unit = 's';
  let title = 'Slow down the return.', summary = 'Same target angle. A gentler return.', rationale = 'The return duration is short relative to the requested motion. Giving the same path more time reduces the abrupt acceleration without changing the target angle.';
  const issue = (['Error message', 'No motion', 'Wrong way', 'Shaking', 'Too fast', 'Other'] as const).find(value => o.issues.includes(value));
  if (issue === 'No motion') { parameter = 'servo_enabled'; before = 'False'; after = 'True'; unit = ''; title = 'Enable the motion output.'; summary = `Restore the command path to ${o.joint}.`; rationale = 'This example checks the output-enable flag before changing movement parameters. In a real session BIT would validate the controller trace and wiring first.'; }
  if (issue === 'Wrong way') { parameter = 'servo_direction'; before = '1'; after = '-1'; unit = ''; title = 'Correct the return direction.'; summary = `Reverse ${o.joint} direction, keeping the travel limits.`; rationale = 'The example mapping inverts the servo direction. Keep the existing angle limits and start with a short test to confirm the physical direction.'; }
  if (issue === 'Shaking') { parameter = 'motion_easing'; before = 'linear'; after = 'minimum_jerk'; unit = ''; title = 'Make the movement steadier.'; summary = 'Smoother acceleration. Same sequence, timing and target poses.'; rationale = 'Linear interpolation changes velocity abruptly when a movement starts or stops. A minimum-jerk curve eases acceleration into and out of each move, including the lift and turn. Compare the same sequence, then test whether the observed shaking improves.'; }
  if (issue === 'Error message') { parameter = 'serial_timeout'; before = '0.1'; after = '1.0'; unit = 's'; title = 'Allow time for the controller reply.'; summary = 'Wait for the acknowledgement before the next command.'; rationale = 'The sample log models a timeout. A longer acknowledgement window can prevent a valid reply from being treated as missing. Verify the actual error before applying to hardware.'; }
  if (issue === 'Other') { parameter = 'return_duration'; title = 'Try one controlled change.'; summary = 'Keep the geometry; slow the next test.'; rationale = 'Your observation needs a small, reversible experiment. This demo proposes a slower motion and keeps the target and joint limits unchanged.'; }
  if (o.issues.length > 1) rationale += ` You reported ${o.issues.join(', ').toLowerCase()}. This first experiment focuses on ${issue?.toLowerCase()}; the other observations remain in the request for the next check.`;
  const assignment=file?motionAssignment(file.content,parameter):undefined;
  if(assignment)before=parameter==='motion_easing'?assignment.value.replace(/["']/g,''):assignment.value;
  if (parameter === 'return_duration' && Number.isFinite(Number(before))) after = (Math.min(Number(before) * 2, 8)).toFixed(1);
  if (parameter === 'serial_timeout' && Number.isFinite(Number(before))) after = Math.min(Math.max(Number(before) * 2, 1), 5).toFixed(1);
  if (parameter === 'servo_direction' && (before === '1' || before === '-1')) after = before === '1' ? '-1' : '1';
  if (before === after || (Number.isFinite(Number(before)) && Number(before) === Number(after))) {
    throw new Error(parameter==='motion_easing'?'This motion already uses minimum-jerk easing. Record what still shakes or start a fresh stability task before proposing another change.':'This example parameter is already at its suggested setting. Revise the observation or add new evidence before trying another change.');
  }
  const codeBefore=assignment?.line??`${parameter} = ${parameter==='motion_easing'?JSON.stringify(before):before}`;
  const codeAfter=`${assignment?.line.match(/^[ \t]*/)?.[0]??''}${parameter} = ${parameter==='motion_easing'?JSON.stringify(after):after}`;
  const completed = task.rounds.filter(r => r.completedAt);
  return { id: `suggestion-${round.id}`, title, summary, rationale, parameter, before, after, unit, fileName, codeBefore, codeAfter, confidence: 'Example recommendation', evidence: [`${o.joint} · ${o.phase.toLowerCase()} · ${o.issues.join(' + ') || 'observation'}`, `${fileName} · ${parameter}`, ...(o.includePrevious && completed.length ? [`Round ${completed.at(-1)!.number} · ${completed.at(-1)!.result}`] : [])], steps: ['Compare the original and proposed motion.', 'Approve the code change; keep the target poses unchanged.', 'Run the same movement and record what changed.'], risk: 'A smoother command profile does not establish the physical cause of shaking. Check the actual movement after applying; power, load and mechanical play may need separate inspection.' };
}
export const mockAgent: AgentAdapter = {
  async investigate(context, options = {}) {
    if (!context.round.observation.issues.length) throw new Error('Choose an observation before asking BIT.');
    await progress(context.round.observation.issues.includes('Shaking')?['Opening the observation and motion files', 'Checking the lift, turn and settling sequence', 'Comparing the current easing profile', 'Preparing a steadier motion proposal']:['Opening the context folder', 'Checking hardware and motion code', 'Comparing the relevant rounds', 'Preparing one focused change'], options, 9600);
    return buildSuggestion(context);
  },
  async applySuggestion(context, options = {}) {
    const suggestion = context.round.suggestion;
    if (!suggestion) throw new Error('There is no change to apply.');
    await progress(suggestion.parameter==='motion_easing'?['Saving the original motion profile', 'Applying minimum-jerk easing', 'Checking that targets and timings are unchanged', 'Ready for the same-motion test']:['Preparing a local checkpoint', 'Updating the motion parameter', 'Checking the change', 'Ready for your test'], options, 10400);
    return { status: 'applied', suggestionId: suggestion.id, changedFiles: [suggestion.fileName], message: 'Local example code updated. No physical hardware moved.' };
  },
  async runMotion(_context, options = {}) {
    await progress(['Preparing the demo run', 'Simulating code execution'], options, 1200);
    return { status: 'completed', mode: 'simulated', message: 'Demo run complete. No code was executed on physical hardware.' };
  },
};
/** Version-one JSON adapter retained for existing integrations; local Codex uses persisted jobs and SSE in local-api.ts. */
export function createHttpAgent(baseUrl: string, request: typeof fetch = fetch): AgentAdapter {
  if (!baseUrl.startsWith('/') && !/^https:\/\//.test(baseUrl)) throw new Error('Use a same-origin path or an HTTPS Agent endpoint.');
  const call = async <T>(action: string, context: AgentContext, options: AgentOptions = {}): Promise<T> => {
    if (options.signal?.aborted) throw abortError();
    options.onProgress?.({ progress: 0, message: 'Contacting your Agent' });
    const response = await request(`${baseUrl.replace(/\/$/, '')}/${action}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(buildAgentRequest(context)), signal: options.signal });
    if (!response.ok) throw new Error(`Agent request failed (${response.status}). Try again.`);
    const body = await response.json() as T;
    options.onProgress?.({ progress: 100, message: 'Ready' });
    return body;
  };
  return { investigate: (context, options) => call<Suggestion>('investigate', context, options), applySuggestion: (context, options) => call<ApplyResult>('apply', context, options), runMotion: (context, options) => call<RunResult>('run', context, options) };
}
/** @deprecated Demonstration only. App explicitly selects mockAgent only in demo mode. */
export const agent = mockAgent;
