import type { Workspace, Suggestion } from './workflow.ts';

export interface FileChange {
  fileId: string;
  path: string;
  beforeHash: string;
  beforeContent: string;
  afterContent: string;
}
export interface Proposal extends Suggestion {
  version: 2;
  outcome: 'proposal' | 'needs_information';
  changes: FileChange[];
  questions: string[];
  contextHash: string;
}
export interface ChatMessage {
  id: string;
  role: 'you' | 'bit';
  text: string;
  createdAt: string;
  status?: 'completed' | 'failed' | 'cancelled' | 'interrupted';
}
export type JobStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export interface JobView {
  id: string;
  taskId: string;
  roundId: string;
  kind: 'investigate' | 'chat';
  status: JobStatus;
  message: string;
  text: string;
  result?: Proposal | ChatMessage;
  error?: string;
  createdAt: string;
  threadId?: string;
}
export interface WorkspaceEnvelope {
  version: 2;
  revision: number;
  workspace: Workspace;
  activeJobs: JobView[];
}
export interface CodexModel { id: string; displayName: string; isDefault?: boolean }
export interface CodexStatus {
  available: boolean;
  authenticated: boolean;
  version?: string;
  account?: { type: string; email?: string; planType?: string } | null;
  models: CodexModel[];
  error?: string;
}
export interface ServiceStatus { mode: 'local'; codex: CodexStatus; version: string }
export interface ApplyResponse extends WorkspaceEnvelope { operationId: string; changedFiles: string[] }
export interface ProjectScan { rootId: string; rootPath: string; files: { path: string; size: number }[]; skipped: string[] }
