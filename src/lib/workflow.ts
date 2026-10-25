/** Browser-local prototype state. No passwords or external service credentials are persisted. */
export type Stage = 'setup' | 'first-run' | 'observe' | 'request' | 'investigating' | 'review' | 'applying' | 'test' | 'feedback';
export type Issue = 'Too fast' | 'No motion' | 'Wrong way' | 'Shaking' | 'Error message' | 'Other';
export type Feedback = 'Better' | 'Same' | 'Worse' | 'Not sure';
export type Joint = 'J1' | 'J2' | 'J3';
export type Phase = 'Home' | 'Reach' | 'Pause' | 'Return';
export interface Hardware { name: string; controller: string; connection: string; joints: number; gripper: boolean; notes: string; configured: boolean }
export interface ProjectFile { id: string; name: string; kind: 'code' | 'hardware' | 'log' | 'note' | 'other'; content: string; size: number; updatedAt: string; source: 'sample' | 'uploaded' | 'generated'; mimeType?: string }
export interface Observation { joint: Joint; issue: Issue | null; phase: Phase; detail: string; desired: string[]; includePrevious: boolean }
export interface Suggestion { id: string; title: string; summary: string; rationale: string; parameter: string; before: string; after: string; unit: string; fileName: string; codeBefore: string; codeAfter: string; confidence: string; evidence: string[]; steps: string[]; risk: string }
export interface Round { id: string; number: number; observation: Observation; suggestion?: Suggestion; applied: boolean; result?: Feedback; note?: string; createdAt: string; completedAt?: string }
export interface Task { id: string; name: string; hardware: Hardware; files: ProjectFile[]; rounds: Round[]; activeRoundId: string; createdAt: string }
export interface Workspace { version: 1; tasks: Task[]; activeTaskId: string; stage: Stage }
export interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void }
export const STORAGE_KEY = 'context-bridge.workspace.v1';
export const ISSUES: Issue[] = ['Too fast', 'No motion', 'Wrong way', 'Shaking', 'Error message', 'Other'];
export const FEEDBACK_OPTIONS: Feedback[] = ['Better', 'Same', 'Worse', 'Not sure'];
export const STAGES: Stage[] = ['setup', 'first-run', 'observe', 'request', 'investigating', 'review', 'applying', 'test', 'feedback'];
const now = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
export const emptyObservation = (): Observation => ({ joint: 'J2', issue: null, phase: 'Return', detail: '', desired: ['Slower return'], includePrevious: true });
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
export function createInitialWorkspace(): Workspace {
  const createdAt = '2026-10-25T08:00:00.000Z';
  const history: Round = {
    id: 'arm-round-6', number: 6, createdAt, completedAt: '2026-10-25T08:12:00.000Z', applied: true, result: 'Better', note: 'The reach is stable. Return still feels abrupt.',
    observation: { joint: 'J2', issue: 'Shaking', phase: 'Reach', detail: 'The elbow jitters near the end of reach.', desired: ['Smoother motion'], includePrevious: false },
    suggestion: { id: 'suggestion-history-arm', title: 'Ease into the target.', summary: 'Use eased interpolation at the end of reach.', rationale: 'A linear step gives the elbow a sudden stop. An ease-out curve reduces that discontinuity.', parameter: 'reach_easing', before: 'linear', after: 'ease_out', unit: '', fileName: 'motion.py', codeBefore: 'reach_easing = "linear"', codeAfter: 'reach_easing = "ease_out"', confidence: 'Example recommendation', evidence: ['Run 06 · reach oscillation', 'motion.py · interpolation'], steps: ['Change the easing curve.', 'Keep target angles unchanged.', 'Test the reach.'], risk: 'Check clearance before testing.' },
  };
  const active: Round = { id: 'arm-round-7', number: 7, observation: emptyObservation(), applied: false, createdAt };
  const arm: Task = {
    id: 'task-desk-arm', name: 'Desktop arm · return motion', createdAt, activeRoundId: active.id,
    hardware: { name: 'Desktop robot arm', controller: 'ESP32', connection: 'USB serial · 115200 baud', joints: 3, gripper: true, notes: 'J1 base · J2 elbow · J3 wrist. Keep the work area clear.', configured: false },
    files: [
      makeFile('motion.py', '# Desktop arm · motion profile\nreach_easing = "ease_out"\nreturn_duration = 0.6\nservo_direction = 1\nstep_interval = 0.02\n\ndef return_home(arm):\n    arm.move_to([0, 45, 0], duration=return_duration)\n', 'code', 'sample'),
      makeFile('hardware.json', JSON.stringify({ controller: 'ESP32', baudRate: 115200, joints: { J1: 'base', J2: 'elbow', J3: 'wrist' }, gripper: true, limits: { J1: [-90, 90], J2: [0, 120], J3: [-60, 60] } }, null, 2), 'hardware', 'sample'),
      makeFile('run-06.log', '[00:00.000] profile=reach\n[00:00.600] J2 target=45 actual=44.8\n[00:01.200] reach complete\n[00:01.800] return complete\n[observer] Reach is stable. Return is abrupt.\n', 'log', 'sample'),
    ], rounds: [history, active],
  };
  const petHistory: Round = {
    id: 'pet-round-1', number: 1, createdAt, completedAt: '2026-10-24T11:40:00.000Z', applied: true, result: 'Same', note: 'Touch response works, but the tail still moves too abruptly.',
    observation: { joint: 'J1', issue: 'Too fast', phase: 'Return', detail: 'Tail snaps to neutral after a greeting.', desired: ['Smoother motion'], includePrevious: false },
    suggestion: { ...history.suggestion!, id: 'suggestion-history-pet', title: 'Slow the tail return.', parameter: 'return_duration', before: '0.3', after: '0.6', unit: 's', fileName: 'tail.py', codeBefore: 'return_duration = 0.3', codeAfter: 'return_duration = 0.6', summary: 'Give the tail more time to settle.', rationale: 'Longer interpolation reduces the sudden stop.', evidence: ['Tail greeting trace'], steps: ['Update the return duration.', 'Replay the greeting.'] },
  };
  const petActive: Round = { ...newRound(2), id: 'pet-round-2' };
  const pet: Task = {
    id: 'task-desktop-pet', name: 'Desktop pet · tail response', createdAt, activeRoundId: petActive.id,
    hardware: { name: 'Desktop companion', controller: 'Raspberry Pi + ESP32', connection: 'USB serial · 115200 baud', joints: 1, gripper: false, notes: 'Tail servo on J1. Test with low amplitude.', configured: false },
    files: [makeFile('tail.py', '# Tail response\nreturn_duration = 0.6\nservo_direction = 1\nstep_interval = 0.02\n', 'code', 'sample'), makeFile('pet-hardware.json', '{\n  "controller": "ESP32",\n  "joints": 1,\n  "tailPin": 18\n}\n', 'hardware', 'sample'), makeFile('run-01.log', '[touch] greeting detected\n[tail] return complete in 0.6s\n[observer] Still abrupt.\n', 'log', 'sample')], rounds: [petHistory, petActive],
  };
  return { version: 1, tasks: [arm, pet], activeTaskId: arm.id, stage: 'setup' };
}
export function getActiveTask(state: Workspace): Task { const task = state.tasks.find(t => t.id === state.activeTaskId); if (!task) throw new Error('Active task is missing.'); return task; }
export function getActiveRound(state: Workspace): Round { const task = getActiveTask(state); const round = task.rounds.find(r => r.id === task.activeRoundId); if (!round) throw new Error('Active round is missing.'); return round; }
export function updateTask(state: Workspace, patch: Partial<Omit<Task, 'id'>>, taskId = state.activeTaskId): Workspace {
  if (!state.tasks.some(t => t.id === taskId)) throw new Error('Task not found.');
  return { ...state, tasks: state.tasks.map(t => t.id === taskId ? { ...t, ...patch } : t) };
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
  const task: Task = { id: id('task'), name: clean.slice(0, 100), createdAt: now(), activeRoundId: round.id, hardware: { name: 'Desktop robot arm', controller: 'ESP32', connection: 'USB serial · 115200 baud', joints: 3, gripper: true, notes: '', configured: false }, files: [], rounds: [round] };
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
  if (round.applied) return state;
  const existing = task.files.find(f => f.name === suggestion.fileName);
  const content = existing ? (existing.content.includes(suggestion.codeBefore) ? existing.content.replace(suggestion.codeBefore, suggestion.codeAfter) : `${existing.content.trimEnd()}\n${suggestion.codeAfter}\n`) : `${suggestion.codeAfter}\n`;
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
      if (round.observation.issue !== null && !ISSUES.includes(round.observation.issue as Issue)) return false;
    }
    if (!task.rounds.some((r: Round) => r.id === task.activeRoundId)) return false;
  }
  return ids.has(value.activeTaskId as string);
}
function browserStorage(): StorageLike | undefined { try { return typeof window === 'undefined' ? undefined : window.localStorage; } catch { return undefined; } }
export function loadWorkspace(storage = browserStorage()): Workspace {
  try {
    const raw = storage?.getItem(STORAGE_KEY); if (!raw) return createInitialWorkspace();
    const value: unknown = JSON.parse(raw); if (!isValidWorkspace(value)) return createInitialWorkspace();
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
