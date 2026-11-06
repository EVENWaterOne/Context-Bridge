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
/** A command the agent ran in its copy of the project, as its provider reported it. */
export interface CommandRun {
  id: string;
  command: string;
  status: 'running' | 'completed' | 'failed' | 'declined';
  exitCode?: number | null;
  /** The end of the output, shortened. */
  output?: string;
  durationMs?: number;
}
/** One run of the project's verification command (a build or test command) by the local service. */
export interface VerificationRun {
  command: string;
  /** Set by the user, or detected from the project files. */
  source: 'user' | 'detected';
  /** unavailable: the program is missing or could not start, so nothing was learned about the code. */
  status: 'passed' | 'failed' | 'timeout' | 'unavailable';
  exitCode?: number | null;
  output: string;
  durationMs: number;
}
export interface Verification {
  /** On the current files, before the agent started. */
  before?: VerificationRun;
  /** On a fresh copy of the project with exactly the proposed changes. */
  after?: VerificationRun;
}
export interface Proposal extends Suggestion {
  version: 2;
  outcome: 'proposal' | 'needs_information';
  changes: FileChange[];
  questions: string[];
  contextHash: string;
  provider?: ProviderId;
  checks?: FileCheck[];
  /** Run mode: commands the agent ran in its project copy (the latest ones when there were many). */
  commands?: CommandRun[];
  /** Run mode: how many commands the agent ran in all. */
  commandCount?: number;
  /** Run mode: the verification command before and after the proposed change. */
  verification?: Verification;
  /** Run mode: files outside the selection that the agent created or changed. They are not applied. */
  otherEdits?: string[];
}
/** How a task runs code while diagnosing, with the command the service would use now. */
export interface ExecutionInfo {
  enabled: boolean;
  /** The user's own verification command. */
  command?: string;
  /** A command detected from the project, used when the user set none. */
  detected?: string;
  /** What confines the agent's commands with the current provider on this computer. */
  sandbox: string;
  /** Whether the agent can run commands here, when known before a request (Codex on Windows sets up on first use). */
  tools?: { available: boolean; note: string };
  /** Whether the service has a sandbox to run the build or test command in. */
  checker: boolean;
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
  /** Run mode: the latest commands the agent ran so far. */
  commands?: CommandRun[];
  /** Run mode: how many commands the agent ran so far. */
  commandCount?: number;
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
