import type { CodexStatus, CommandRun } from '../src/lib/backend-types.ts';

export type AgentEvent =
  /** delta: answer text; status: what the agent is doing now; reasoning: the model's own reasoning summary, when it sends one. */
  | { type: 'delta' | 'status' | 'reasoning'; text: string }
  /** Run mode: a command the agent started or finished in its working copy. */
  | { type: 'command'; command: CommandRun };
export interface CodexRunRequest {
  prompt: string;
  snapshotDir: string;
  model?: string;
  outputSchema?: Record<string, unknown>;
  /**
   * Run mode: a private copy of the project inside snapshotDir. The agent works there and may read,
   * edit and run commands in it, without network access. Without it the agent has no tools at all.
   */
  workspace?: string;
  signal: AbortSignal;
  onEvent: (event: AgentEvent) => void;
}
export interface CodexRunResult { text: string; threadId?: string }
/** Whether the agent can run commands in a working copy on this computer, in one sentence for the page. */
export interface CommandAccess { available: boolean; note: string }
export interface CodexLogin { loginId?: string; authUrl?: string; verificationUri?: string; userCode?: string }
export interface CodexProvider {
  status(): Promise<CodexStatus>;
  login(): Promise<CodexLogin>;
  run(request: CodexRunRequest): Promise<CodexRunResult>;
  close(): Promise<void>;
  /** How this provider confines the agent's commands in run mode on this computer, in a sentence for the page. */
  sandbox?(): string;
  /**
   * Run mode: whether the agent can run commands in a working copy now, preparing the provider's
   * sandbox when needed. When it cannot, the agent gets no tools and only the service's build or
   * test command runs.
   */
  commandAccess?(signal: AbortSignal): Promise<CommandAccess>;
}
