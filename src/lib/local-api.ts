import type { Workspace } from './workflow.ts';
import type { WorkspaceEnvelope, JobView } from './backend-types.ts';

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) { super(message); this.name = 'ApiError'; this.status = status; this.code = code; }
}

export async function localApi<T>(path: string, body?: unknown, options: { method?: string; signal?: AbortSignal } = {}): Promise<T> {
  const response = await fetch(path, {
    method: options.method ?? (body === undefined ? 'GET' : 'POST'),
    credentials: 'same-origin', signal: options.signal,
    headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data: unknown;
  try { data = await response.json(); } catch { throw new ApiError(response.status, 'INVALID_RESPONSE', 'The local backend did not return JSON. Start the local server and reopen its address.'); }
  if (!response.ok) {
    const error = (data as { error?: { code?: string; message?: string } })?.error;
    throw new ApiError(response.status, error?.code ?? 'REQUEST_FAILED', error?.message ?? `Request failed (${response.status}).`);
  }
  return data as T;
}

const terminal = (job: JobView) => job.status !== 'running';
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) { reject(new DOMException('Cancelled', 'AbortError')); return; }
  const done = () => { signal?.removeEventListener('abort', abort); resolve(); };
  const timer = setTimeout(done, ms);
  const abort = () => { clearTimeout(timer); reject(new DOMException('Cancelled', 'AbortError')); };
  signal?.addEventListener('abort', abort, { once: true });
});

/** Stream real job events. A dropped SSE connection falls back to persisted job status. */
export async function followJob(id: string, onJob: (job: JobView) => void, signal?: AbortSignal): Promise<JobView> {
  let current: JobView | undefined;
  try {
    const response = await fetch(`/api/jobs/${encodeURIComponent(id)}/events`, { headers: { Accept: 'text/event-stream' }, signal, credentials: 'same-origin' });
    if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('Event stream unavailable');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        let index: number;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const event = buffer.slice(0, index); buffer = buffer.slice(index + 2);
          const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          if (!data) continue;
          current = JSON.parse(data) as JobView;
          onJob(current);
          if (terminal(current)) { await reader.cancel(); return current; }
        }
      }
    } finally { reader.releaseLock(); }
  } catch (error) { if (signal?.aborted) throw error; }
  let failures = 0;
  while (!signal?.aborted) {
    try { current = await localApi<JobView>(`/api/jobs/${encodeURIComponent(id)}`, undefined, { signal }); failures = 0; }
    catch (error) { if (signal?.aborted || ++failures >= 3) throw error; await sleep(1500, signal); continue; }
    onJob(current);
    if (terminal(current)) return current;
    await sleep(1500, signal);
  }
  throw new DOMException('Cancelled', 'AbortError');
}

/** One revision writer per browser; coalesce drafts and never send concurrent PUTs. */
export class WorkspaceSaveQueue {
  private revision: number;
  private saved: string;
  private pending?: Workspace;
  private running?: Promise<void>;
  private put: (workspace: Workspace, revision: number) => Promise<WorkspaceEnvelope>;
  private onSaved?: (envelope: WorkspaceEnvelope, submitted: Workspace) => void;
  constructor(envelope: WorkspaceEnvelope, put: (workspace: Workspace, revision: number) => Promise<WorkspaceEnvelope>, onSaved?: (envelope: WorkspaceEnvelope, submitted: Workspace) => void) {
    this.onSaved = onSaved;
    this.put = put; this.revision = envelope.revision; this.saved = JSON.stringify(envelope.workspace);
  }
  adopt(envelope: WorkspaceEnvelope) { this.revision = envelope.revision; this.saved = JSON.stringify(envelope.workspace); this.pending = undefined; }
  isDirty(workspace: Workspace) { return JSON.stringify(workspace) !== this.saved; }
  async idle() { try { await this.running; } catch { /* Caller will fetch the authoritative snapshot. */ } }
  async save(workspace: Workspace): Promise<void> {
    this.pending = workspace;
    do {
      if (!this.running) {
        const run = Promise.resolve().then(() => this.drain()); this.running = run;
        try { await run; } finally { if (this.running === run) this.running = undefined; }
      } else await this.running;
    } while (this.pending);
  }
  private async drain() {
    while (this.pending) {
      const snapshot = this.pending; this.pending = undefined;
      if (JSON.stringify(snapshot) === this.saved) continue;
      const envelope = await this.put(snapshot, this.revision);
      this.revision = envelope.revision; this.saved = JSON.stringify(envelope.workspace);
      this.onSaved?.(envelope, snapshot);
    }
  }
}
