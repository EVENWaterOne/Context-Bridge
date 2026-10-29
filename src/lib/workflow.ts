import { emptyAssembly, existingArmAssembly, assembledCount, assemblyReady, type HardwareAssembly } from './assembly.ts';
import { HARDWARE_PROFILE, JOINT_IDS, JOINTS, hardwareDescription, pendingCalibration, type HardwareJoint, type ServoLimits } from './hardware.ts';
import type { FileChange } from './backend-types.ts';
/** Browser-local prototype state. No passwords or external service credentials are persisted. */
export type Stage = 'setup' | 'first-run' | 'observe' | 'request' | 'investigating' | 'review' | 'applying' | 'test' | 'feedback';
export type Issue = 'Too fast' | 'No motion' | 'Wrong way' | 'Shaking' | 'Error message' | 'Other';
export type Feedback = 'Better' | 'Same' | 'Worse' | 'Not sure';
export type Joint = HardwareJoint;
export type Phase = 'Home' | 'Reach' | 'Pause' | 'Return';
export interface Hardware { name: string; controller: string; connection: string; joints: number; gripper: boolean; notes: string; configured: boolean; profile?: string; servoCalibration?: ServoLimits; assembly?: HardwareAssembly }
export interface ProjectFile { id: string; name: string; kind: 'code' | 'hardware' | 'log' | 'note' | 'other'; content: string; size: number; updatedAt: string; source: 'sample' | 'uploaded' | 'generated'; mimeType?: string; relativePath?: string; linked?: boolean; hash?: string; includeInContext?: boolean }
export interface Observation { joint: Joint; issues: Issue[]; phase: Phase; detail: string; desired: string[]; includePrevious: boolean }
export interface Suggestion { id: string; title: string; summary: string; rationale: string; parameter: string; before: string; after: string; unit: string; fileName: string; codeBefore: string; codeAfter: string; confidence: string; evidence: string[]; steps: string[]; risk: string; version?: 2; outcome?: 'proposal' | 'needs_information'; changes?: FileChange[]; questions?: string[]; contextHash?: string }
export interface Round { id: string; number: number; observation: Observation; suggestion?: Suggestion; applied: boolean; result?: Feedback; note?: string; createdAt: string; completedAt?: string; operationId?: string }
export interface Task { id: string; name: string; hardware: Hardware; files: ProjectFile[]; rounds: Round[]; activeRoundId: string; createdAt: string; rootId?: string; rootPath?: string }
export interface Workspace { version: 1; tasks: Task[]; activeTaskId: string; stage: Stage }
export interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void }
export const STORAGE_KEY = 'context-bridge.workspace.v1';
export const ISSUES: Issue[] = ['Too fast', 'No motion', 'Wrong way', 'Shaking', 'Error message', 'Other'];
export const FEEDBACK_OPTIONS: Feedback[] = ['Better', 'Same', 'Worse', 'Not sure'];
export const STAGES: Stage[] = ['setup', 'first-run', 'observe', 'request', 'investigating', 'review', 'applying', 'test', 'feedback'];
const now = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
export const emptyObservation = (): Observation => ({ joint: 'J2', issues: [], phase: 'Return', detail: '', desired: ['Slower return'], includePrevious: true });
export function newRound(number: number): Round { return { id: id('round'), number, observation: emptyObservation(), applied: false, createdAt: now() }; }
export function makeFile(name: string, content: string, kind: ProjectFile['kind'] = 'other', source: ProjectFile['source'] = 'uploaded'): ProjectFile {
  return { id: id('file'), name, content, kind, source, size: new TextEncoder().encode(content).length, updatedAt: now() };
}
export function inferFileKind(name: string): ProjectFile['kind'] {
  if (/\.(py|js|ts|tsx|jsx|ino|cpp|h|c)$/i.test(name)) return 'code';
  if (/\.(log|csv)$/i.test(name)) return 'log';
  if (/hardware|wiring|\.json$/i.test(name)) return 'hardware';
  if (/\.(txt|md)$/i.test(name)) return 'note';
  return 'other';
}
/** A first visit uses the same empty assembly as a newly created task. */
export function createInitialWorkspace(): Workspace {
  return createTask({version:1,tasks:[],activeTaskId:'',stage:'setup'},'My first build');
}
/** Sample data is opt-in; it must never determine a new visitor's starting point. */
export function createExampleWorkspace(): Workspace {
  const createdAt = '2026-10-25T08:00:00.000Z';
  const history: Round = {
    id: 'arm-round-6', number: 6, createdAt, completedAt: '2026-10-25T08:12:00.000Z', applied: true, result: 'Better', note: 'The reach is stable. Return still feels abrupt.',
    observation: { joint: 'J3', issues: ['Shaking'], phase: 'Reach', detail: 'The forearm linkage jitters near the end of reach.', desired: ['Smoother motion'], includePrevious: false },
    suggestion: { id: 'suggestion-history-arm', title: 'Ease into the target.', summary: 'Use eased interpolation at the end of reach.', rationale: 'A linear step gives the elbow a sudden stop. An ease-out curve reduces that discontinuity.', parameter: 'reach_easing', before: 'linear', after: 'ease_out', unit: '', fileName: 'motion.py', codeBefore: 'reach_easing = "linear"', codeAfter: 'reach_easing = "ease_out"', confidence: 'Example recommendation', evidence: ['Run 06 · reach oscillation', 'motion.py · interpolation'], steps: ['Change the easing curve.', 'Keep target angles unchanged.', 'Test the reach.'], risk: 'Check clearance before testing.' },
  };
  const active: Round = { id: 'arm-round-7', number: 7, observation: emptyObservation(), applied: false, createdAt };
  const arm: Task = {
    id: 'task-desk-arm', name: 'Desktop arm · return motion', createdAt, activeRoundId: active.id,
    hardware: { name: 'Desktop robot arm', controller: 'ESP32', connection: 'USB serial · 115200 baud', joints: 3, gripper: true, profile: HARDWARE_PROFILE, servoCalibration: pendingCalibration(), assembly: existingArmAssembly(), notes: 'J1 base · J2 shoulder · J3 forearm linkage · J4 gripper. No independent wrist axis. Servo calibration pending.', configured: false },
    files: [
      makeFile('motion.py', '# Desktop arm · motion profile\nreach_easing = "ease_out"\nreturn_duration = 0.6\nservo_direction = 1\nstep_interval = 0.02\n\ndef return_home(arm):\n    # No fabricated servo angles: home comes from the calibrated controller.\n    arm.return_to_calibrated_home(duration=return_duration)\n', 'code', 'sample'),
      makeFile('hardware.json', JSON.stringify(hardwareDescription(), null, 2), 'hardware', 'sample'),
      makeFile('run-06.log', '[00:00.000] profile=reach\n[00:00.600] J2 target=45 actual=44.8\n[00:01.200] reach complete\n[00:01.800] return complete\n[observer] Reach is stable. Return is abrupt.\n', 'log', 'sample'),
    ], rounds: [history, active],
  };
  const gripHistory: Round = { ...history, id: 'grip-round-1', number: 1,
    observation: { ...history.observation, joint: 'J4', detail: 'The coupled jaws hesitate during closing.' },
    note: 'Jaw movement is steadier. Check the closing timing next.' };
  const gripActive: Round = { ...newRound(2), id: 'grip-round-2' };gripActive.observation.joint='J4';
  const grip: Task = { ...arm, id:'task-gripper', name:'Desktop arm · gripper timing', activeRoundId:gripActive.id,
    hardware:{...arm.hardware,servoCalibration:pendingCalibration()},files:arm.files.map(f=>({...f,id:id('file')})),rounds:[gripHistory,gripActive] };
  return { version: 1, tasks: [arm, grip], activeTaskId: arm.id, stage: 'setup' };
}
export function getActiveTask(state: Workspace): Task { const task = state.tasks.find(t => t.id === state.activeTaskId); if (!task) throw new Error('Active task is missing.'); return task; }
export function getActiveRound(state: Workspace): Round { const task = getActiveTask(state); const round = task.rounds.find(r => r.id === task.activeRoundId); if (!round) throw new Error('Active round is missing.'); return round; }
export function updateTask(state: Workspace, patch: Partial<Omit<Task, 'id'>>, taskId = state.activeTaskId): Workspace {
  if (!state.tasks.some(t => t.id === taskId)) throw new Error('Task not found.');
  return { ...state, tasks: state.tasks.map(t => t.id === taskId ? { ...t, ...patch } : t) };
}
/** Context files follow confirmed parts; unvalidated input stays in the setup draft. */
function hardwareContext(hardware:Hardware) {
  const assembly=hardware.assembly??existingArmAssembly(),count=assembledCount(assembly);
  return {...hardwareDescription(hardware.controller),connection:hardware.connection,
    category:assembly.category,servoCount:count,armDOF:Math.min(3,count),gripperDOF:count===4?1:0,
    servo:undefined,calibrationNote:'Entered servo limits are user-provided. Unmeasured channels remain null; preview poses are illustrative.',axes:Object.fromEntries(JOINT_IDS.slice(0,count).map(joint=>[joint,{...JOINTS[joint],...assembly.parts[joint]}])),
    servoCalibration:hardware.servoCalibration??pendingCalibration(),configurationComplete:hardware.configured};
}
export function updateHardware(state: Workspace, patch: Partial<Hardware>): Workspace {
  const task=getActiveTask(state),hardware={...task.hardware,...patch};
  if(hardware.assembly){const count=assembledCount(hardware.assembly);hardware.joints=Math.min(3,count);hardware.gripper=count===4;}
  const content=JSON.stringify(hardwareContext(hardware),null,2);
  return updateTask(state,{hardware,files:task.files.map(file=>file.source!=='uploaded'&&file.kind==='hardware'&&['hardware.json','context-bridge-hardware.json'].includes(file.name)?{...file,content,size:new TextEncoder().encode(content).length,updatedAt:now()}:file)});
}
export function completeHardwareSetup(state:Workspace):Workspace {
  const task=getActiveTask(state),assembly=task.hardware.assembly??existingArmAssembly();
  if(!task.name.trim()||!task.hardware.controller.trim()||!task.hardware.connection.trim()||!assemblyReady(assembly,task.hardware.servoCalibration??pendingCalibration()))throw new Error('Finish adding the four parts and choose a controller and connection.');
  let next=updateHardware(state,{configured:true,profile:HARDWARE_PROFILE,assembly:{...assembly,step:5}});
  const updated=getActiveTask(next);
  if(!updated.files.some(file=>file.source!=='uploaded'&&file.kind==='hardware'&&['hardware.json','context-bridge-hardware.json'].includes(file.name))){
    next=updateTask(next,{files:[...updated.files,makeFile('context-bridge-hardware.json',JSON.stringify(hardwareContext(updated.hardware),null,2),'hardware','generated')]});
  }
  return setStage(next,'first-run');
}
export function updateRound(state: Workspace, patch: Partial<Omit<Round, 'id' | 'number'>>, roundId = getActiveTask(state).activeRoundId): Workspace {
  const task = getActiveTask(state);
  if (!task.rounds.some(r => r.id === roundId)) throw new Error('Round not found.');
  return updateTask(state, { rounds: task.rounds.map(r => r.id === roundId ? { ...r, ...patch } : r) });
}
export function setStage(state: Workspace, stage: Stage): Workspace {
  if (stage === 'setup' && state.stage !== 'setup' && getActiveTask(state).hardware.configured) return state;
  const round = getActiveRound(state);
  // An applied change belongs to this round until the user evaluates or undoes it.
  if (round.applied && ['observe', 'request', 'investigating'].includes(stage)) return { ...state, stage: 'feedback' };
  return { ...state, stage };
}
export function reviseObservation(state: Workspace, patch: Partial<Observation>): Workspace {
  const round = getActiveRound(state);
  if (round.applied || round.completedAt) return state;
  return updateRound(state, { observation: { ...round.observation, ...patch }, suggestion: undefined });
}
/** Toggle against the latest state so rapid clicks and shortcuts never lose a selection. */
export function toggleIssue(state: Workspace, issue: Issue): Workspace {
  const issues = getActiveRound(state).observation.issues;
  return reviseObservation(state, { issues: issues.includes(issue) ? issues.filter(value => value !== issue) : [...issues, issue] });
}
/** Imports are task-bound and deterministic: one current file per filename. */
export function upsertFiles(state: Workspace, incoming: ProjectFile[], taskId = state.activeTaskId): Workspace {
  const task = state.tasks.find(t => t.id === taskId);
  if (!task) return state;
  const files = [...task.files];
  for (const file of incoming) {
    const index = files.findIndex(existing => existing.name === file.name);
    if (index < 0) files.push(file);
    else files[index] = { ...file, id: files[index].id };
  }
  return updateTask(state, { files }, taskId);
}
export function switchTask(state: Workspace, taskId: string): Workspace {
  if (!state.tasks.some(t => t.id === taskId)) throw new Error('Task not found.');
  return { ...state, activeTaskId: taskId, stage: 'setup' };
}
export function createTask(state: Workspace, name: string): Workspace {
  const clean = name.trim(); if (!clean) throw new Error('Give your task a name.');
  const round = newRound(1);
  const task: Task = { id: id('task'), name: clean.slice(0, 100), createdAt: now(), activeRoundId: round.id, hardware: { name: 'Desktop robot arm', controller: '', connection: '', joints: 0, gripper: false, profile: HARDWARE_PROFILE, servoCalibration: pendingCalibration(), assembly: emptyAssembly(), notes: '', configured: false }, files: [], rounds: [round] };
  return { ...state, tasks: [...state.tasks, task], activeTaskId: task.id, stage: 'setup' };
}
export function completeRound(state: Workspace, result: Feedback, note = ''): Workspace {
  if (!FEEDBACK_OPTIONS.includes(result)) throw new Error('Choose a feedback result.');
  const task = getActiveTask(state), round = getActiveRound(state);
  if (!round.applied) throw new Error('Apply and test a change before saving feedback.');
  if (round.completedAt) throw new Error('This round is already complete.');
  const next = newRound(Math.max(...task.rounds.map(r => r.number)) + 1);
  next.observation.joint = round.observation.joint;
  const updated = updateTask(state, { rounds: [...task.rounds.map(r => r.id === round.id ? { ...r, result, note: note.trim(), completedAt: now() } : r), next], activeRoundId: next.id });
  return { ...updated, stage: 'observe' };
}
export function applyRoundChange(state: Workspace): Workspace {
  const task = getActiveTask(state), round = getActiveRound(state), suggestion = round.suggestion;
  if (!suggestion) throw new Error('No suggestion to apply.');
  if (suggestion.version === 2) throw new Error('Codex changes must be applied by the local backend.');
  if (round.applied) return state;
  const existing = task.files.find(f => f.name === suggestion.fileName);
  if (!existing || !suggestion.codeBefore || existing.content.split(suggestion.codeBefore).length !== 2) throw new Error('The source changed or the proposed text is ambiguous. Investigate again before applying.');
  const content = existing.content.replace(suggestion.codeBefore, suggestion.codeAfter);
  const file = existing ? { ...existing, content, size: new TextEncoder().encode(content).length, updatedAt: now() } : makeFile(suggestion.fileName, content, 'code', 'generated');
  const files = existing ? task.files.map(f => f.id === file.id ? file : f) : [...task.files, file];
  return updateRound(updateTask(state, { files }), { applied: true });
}
function isObject(v: unknown): v is Record<string, unknown> { return !!v && typeof v === 'object'; }
function isValidWorkspace(value: unknown): value is Workspace {
  if (!isObject(value) || value.version !== 1 || !Array.isArray(value.tasks) || !value.tasks.length || !STAGES.includes(value.stage as Stage)) return false;
  const ids = new Set<string>();
  for (const task of value.tasks) {
    if (!isObject(task) || typeof task.id !== 'string' || ids.has(task.id) || typeof task.name !== 'string' || !isObject(task.hardware) || !Array.isArray(task.files) || !Array.isArray(task.rounds) || !task.rounds.length) return false;
    ids.add(task.id);
    if (typeof task.hardware.name !== 'string' || typeof task.hardware.joints !== 'number') return false;
    if (task.files.some((f: unknown) => !isObject(f) || typeof f.id !== 'string' || typeof f.name !== 'string' || typeof f.content !== 'string')) return false;
    for (const round of task.rounds) {
      if (!isObject(round) || typeof round.id !== 'string' || typeof round.number !== 'number' || !isObject(round.observation) || !Array.isArray(round.observation.desired) || typeof round.observation.detail !== 'string' || typeof round.applied !== 'boolean') return false;
      if (!Array.isArray(round.observation.issues) || round.observation.issues.some(issue => !ISSUES.includes(issue as Issue))) return false;
    }
    if (!task.rounds.some((r: Round) => r.id === task.activeRoundId)) return false;
  }
  return ids.has(value.activeTaskId as string);
}
function browserStorage(): StorageLike | undefined { try { return typeof window === 'undefined' ? undefined : window.localStorage; } catch { return undefined; } }
export function loadWorkspace(storage = browserStorage()): Workspace {
  try {
    const raw = storage?.getItem(STORAGE_KEY); if (!raw) return createInitialWorkspace();
    const value: unknown = JSON.parse(raw);
    // Preserve existing v1 workspaces when upgrading single-choice observations.
    if (isObject(value) && Array.isArray(value.tasks)) for (const task of value.tasks) {
      if (isObject(task) && Array.isArray(task.rounds)) for (const round of task.rounds) {
        if (!isObject(round) || !isObject(round.observation)) continue;
        const observation = round.observation;
        if (!Array.isArray(observation.issues) && (observation.issue === null || ISSUES.includes(observation.issue as Issue))) {
          observation.issues = observation.issue ? [observation.issue] : [];
          delete observation.issue;
        }
      }
    }
    if (!isValidWorkspace(value)) return createInitialWorkspace();
    // Upgrade only the old arm preset; keep imported files and unrelated hardware.
    value.tasks=value.tasks.map(task=>{
      if(task.hardware.profile || (task.hardware.name!=='Desktop robot arm'&&task.id!=='task-desk-arm'))return task;
      const hardware={...task.hardware,joints:3,gripper:true,profile:HARDWARE_PROFILE,servoCalibration:pendingCalibration(),notes:'J1 base · J2 shoulder · J3 forearm linkage · J4 gripper. Servo calibration pending.'};
      const rounds=task.rounds.map(round=>({...round,observation:{...round.observation,joint:round.observation.joint==='J2'?'J3' as const:round.observation.joint==='J3'?'J4' as const:round.observation.joint}}));
      const files=task.files.map(file=>file.source==='sample'&&file.name==='hardware.json'?{...file,content:JSON.stringify(hardwareDescription(hardware.controller),null,2),updatedAt:now(),size:new TextEncoder().encode(JSON.stringify(hardwareDescription(hardware.controller),null,2)).length}:file);
      return {...task,hardware,rounds,files};
    });
    // Work in flight is restartable; a refresh never pretends an interrupted operation completed.
    const stage = value.stage === 'investigating' ? 'request' : value.stage === 'applying' ? 'review' : value.stage;
    return { ...value, stage };
  } catch { return createInitialWorkspace(); }
}
export function saveWorkspace(state: Workspace, storage = browserStorage()): { ok: boolean; error?: string } {
  try { if (!storage) return { ok: false, error: 'Browser storage is unavailable.' }; storage.setItem(STORAGE_KEY, JSON.stringify(state)); return { ok: true }; }
  catch { return { ok: false, error: 'Storage is full or unavailable. Export your task to keep a copy.' }; }
}
export function exportTask(task: Task): string { return JSON.stringify({ format: 'context-bridge-task', version: 1, exportedAt: now(), task }, null, 2); }
