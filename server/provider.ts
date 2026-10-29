import type { CodexStatus } from '../src/lib/backend-types.ts';

export interface CodexRunRequest {
  prompt: string;
  snapshotDir: string;
  model?: string;
  outputSchema?: Record<string, unknown>;
  signal: AbortSignal;
  onEvent: (event: { type: 'delta' | 'status'; text: string }) => void;
}
export interface CodexRunResult { text: string; threadId?: string }
export interface CodexLogin { loginId?: string; authUrl?: string; verificationUri?: string; userCode?: string }
export interface CodexProvider {
  status(): Promise<CodexStatus>;
  login(): Promise<CodexLogin>;
  run(request: CodexRunRequest): Promise<CodexRunResult>;
  close(): Promise<void>;
}
