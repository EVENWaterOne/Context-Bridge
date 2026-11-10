import type { Workspace, Suggestion } from './workflow.ts';

/** The local service runs one model provider at a time; Codex stays the default. */
export type ProviderId = 'codex' | 'claude';
export const PROVIDER_LABELS: Record<ProviderId, string> = { codex: 'Codex', claude: 'Claude Code' };

export interface FileChange {
  fileId: string;
  path: string;
  beforeHash: string;
  beforeContent: string;
  afterContent: string;
}
/**
 * A check the local service ran on a proposed file before review. It parses the proposed text
 * only; project code is never executed.
 */
export interface FileCheck {
  path: string;
  /** What was checked, for example "Python syntax". */
  check: string;
  status: 'passed' | 'failed' | 'skipped';
  detail?: string;
}
export interface Proposal extends Suggestion {
  version: 2;
  outcome: 'proposal' | 'needs_information';
  changes: FileChange[];
  questions: string[];
  contextHash: string;
  provider?: ProviderId;
  checks?: FileCheck[];
}
export interface ChatMessage {
  id: string;
  role: 'you' | 'bit';
  text: string;
  createdAt: string;
  status?: 'completed' | 'failed' | 'cancelled' | 'interrupted';
}
export type JobStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
/** One step the agent reported, in order. */
export interface JobActivity { at: string; text: string }
export interface JobView {
  id: string;
  taskId: string;
  roundId: string;
  kind: 'investigate' | 'chat';
  status: JobStatus;
  message: string;
  text: string;
  /** Status history; absent on runs saved before it existed. */
  activity?: JobActivity[];
  /** Reasoning summary streamed by the provider, if any. */
  reasoning?: string;
  result?: Proposal | ChatMessage;
  error?: string;
  createdAt: string;
  threadId?: string;
  provider?: ProviderId;
}
export interface WorkspaceEnvelope {
  version: 2;
  revision: number;
  workspace: Workspace;
  activeJobs: JobView[];
}
export interface CodexModel { id: string; displayName: string; isDefault?: boolean }
/** Claude Code authentication. The key itself never leaves the local service; only a short hint does. */
export interface ClaudeAuthStatus {
  method: 'api_key' | 'local_login';
  apiKey: { source: 'saved' | 'environment'; hint: string } | null;
  /** Personal local use only. Enabled with BRIDGE_CLAUDE_LOCAL_LOGIN=1, never by the browser. */
  localLoginAllowed: boolean;
  /** The saved settings file is damaged; saving a key or removing the saved one replaces it. */
  settingsUnreadable?: boolean;
}
/** Connection status of a model provider. The name predates Claude Code support; the shape is provider-neutral. */
export interface CodexStatus {
  available: boolean;
  authenticated: boolean;
  version?: string;
  account?: { type: string; email?: string; planType?: string } | null;
  models: CodexModel[];
  error?: string;
  claude?: ClaudeAuthStatus;
}
export interface ServiceStatus { mode: 'local'; version: string; provider: ProviderId; providers: ProviderId[]; agent: CodexStatus }
export interface ApplyResponse extends WorkspaceEnvelope { operationId: string; changedFiles: string[] }
export interface ProjectScan { rootId: string; rootPath: string; files: { path: string; size: number }[]; skipped: string[] }

/** Arduino upload and serial connection (server/arduino.ts). */
export type ArduinoLineSource = 'upload' | 'serial' | 'sent' | 'info' | 'error';
export interface ArduinoLine { seq: number; at: string; source: ArduinoLineSource; text: string }
export interface ArduinoUpload { taskId: string; sketch: string; status: 'running' | 'succeeded' | 'failed' | 'cancelled'; phase?: 'compiling' | 'uploading'; startedAt: string; finishedAt?: string }
export interface ArduinoStatus {
  available: boolean;
  reason?: string;
  cli?: string;
  port?: string;
  fqbn: string;
  /** Changes when the service restarts; line sequence numbers start again then. */
  instance: string;
  /** uploading wins over the serial state; the serial field below says whether Stop can reach the board. */
  state: 'idle' | 'connecting' | 'uploading' | 'monitoring';
  serial: 'closed' | 'connecting' | 'open';
  upload?: ArduinoUpload;
  /** The most recent lines; the events stream only sends them in its first status event. */
  lines: ArduinoLine[];
}
export type ArduinoEvent = { type: 'line'; line: ArduinoLine } | { type: 'status'; status: ArduinoStatus };
