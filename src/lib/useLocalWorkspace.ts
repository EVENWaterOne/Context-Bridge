import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react';
import { loadWorkspace, saveWorkspace, type Workspace } from './workflow.ts';
import { ApiError, localApi, WorkspaceSaveQueue } from './local-api.ts';
import type { ServiceStatus, WorkspaceEnvelope, JobView } from './backend-types.ts';

const explicitDemo = (import.meta as ImportMeta & { env?: { MODE?: string } }).env?.MODE === 'demo';

export function useLocalWorkspace() {
  const [workspace, updateWorkspace] = useState(loadWorkspace);
  const current = useRef(workspace); current.current = workspace;
  const [mode, setMode] = useState<'loading' | 'local' | 'demo' | 'unavailable'>(explicitDemo ? 'demo' : 'loading');
  const [status, setStatus] = useState<ServiceStatus | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [initialJobs, setInitialJobs] = useState<JobView[]>([]);
  const [recovery, setRecovery] = useState<Workspace | null>(null);
  const queue = useRef<WorkspaceSaveQueue | null>(null);
  const mutation = useRef(false);
  const alive = useRef(true);
  const setWorkspace = useCallback((next: SetStateAction<Workspace>) => {
    if (mutation.current) return;
    const value = typeof next === 'function' ? next(current.current) : next;
    current.current = value; if (queue.current) setSaving(true); updateWorkspace(value);
  }, []);
  const adopt = useCallback((envelope: WorkspaceEnvelope) => {
    queue.current?.adopt(envelope); current.current = envelope.workspace; updateWorkspace(envelope.workspace);
  }, []);
  const keepDraft = useCallback((draft: Workspace) => {
    setRecovery(draft);
    try { window.localStorage.setItem('context-bridge.recovery.v2', JSON.stringify(draft)); } catch { /* The visible recovery download remains available. */ }
  }, []);
  const recover = useCallback(async (cause: unknown) => {
    const message = cause instanceof Error ? cause.message : 'Could not save the workspace.';
    if (cause instanceof ApiError && cause.status === 409) {
      keepDraft(current.current);
      try {
        const latest = await localApi<WorkspaceEnvelope>('/api/workspace'); adopt(latest);
        setError(`${message} The current server version has been loaded. Download your unsaved draft below before continuing.`);
      } catch { setError(`${message} Your draft was retained. Restore the local service and reload before continuing.`); }
    } else setError(message);
  }, [adopt, keepDraft]);
  const refreshStatus = useCallback(async () => {
    const value = await localApi<ServiceStatus>('/api/status'); setStatus(value); return value;
  }, []);
  useEffect(() => {
    alive.current = true;
    if (explicitDemo) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const [serviceResult, workspaceResult] = await Promise.allSettled([
          localApi<ServiceStatus>('/api/status', undefined, { signal: controller.signal }),
          localApi<WorkspaceEnvelope>('/api/workspace', undefined, { signal: controller.signal }),
        ]);
        if (workspaceResult.status === 'rejected') throw workspaceResult.reason;
        const envelope = workspaceResult.value;
        if (envelope.version !== 2 || !envelope.workspace?.tasks?.length) throw new Error('Local workspace unavailable.');
        const service: ServiceStatus = serviceResult.status === 'fulfilled' ? serviceResult.value : {
          mode: 'local', version: 'unknown', codex: { available: true, authenticated: false, models: [], error: 'Codex status is unavailable. Refresh status or try signing in.' },
        };
        if (!alive.current || controller.signal.aborted) return;
        queue.current = new WorkspaceSaveQueue(envelope, (state, expectedRevision) => localApi('/api/workspace', { workspace: state, expectedRevision }, { method: 'PUT' }), (canonical, submitted) => {
          if (current.current === submitted && !mutation.current) { current.current = canonical.workspace; updateWorkspace(canonical.workspace); }
        });
        setStatus(service); adopt(envelope); setInitialJobs(envelope.activeJobs); setMode('local');
      } catch (cause) {
        if (controller.signal.aborted) return;
        const localHost = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
        setMode(localHost ? 'unavailable' : 'demo');
        if (localHost) setError('The local backend is unavailable. Start Context Bridge with npm run dev, then reload. Codex has not been replaced with demo responses.');
      }
    })();
    return () => { alive.current = false; controller.abort(); };
  }, [adopt]);
  useEffect(() => {
    if (mode === 'demo') { const result = saveWorkspace(workspace); if (!result.ok) setError(result.error ?? 'Browser storage unavailable.'); return; }
    if (mode !== 'local' || mutation.current) return;
    const timer = setTimeout(() => {
      if (mutation.current) return;
      setSaving(true);
      void queue.current?.save(current.current).catch(recover).finally(() => { if (alive.current) setSaving(false); });
    }, 350);
    return () => clearTimeout(timer);
  }, [workspace, mode, recover]);
  const flush = useCallback(async () => {
    if (!queue.current || mutation.current) return;
    setSaving(true);
    try { await queue.current.save(current.current); }
    catch (cause) { await recover(cause); throw cause; }
    finally { setSaving(false); }
  }, [recover]);
  const runMutation = useCallback(async <T extends WorkspaceEnvelope>(action: () => Promise<T>): Promise<T> => {
    if (mutation.current) throw new Error('Another file operation is finishing.');
    mutation.current = true; setSaving(true);
    try { await queue.current?.save(current.current); const envelope = await action(); adopt(envelope); return envelope; }
    catch (cause) { await recover(cause); throw cause; }
    finally { mutation.current = false; setSaving(false); }
  }, [adopt, recover]);
  const reload = useCallback(async () => {
    await queue.current?.idle();
    const envelope = await localApi<WorkspaceEnvelope>('/api/workspace');
    if (queue.current?.isDirty(current.current)) {
      keepDraft(current.current);
      setError('New server results were loaded. Edits that had not finished saving were kept in the recovery draft below.');
    }
    adopt(envelope); return envelope;
  }, [adopt, keepDraft]);
  return { workspace, setWorkspace, mode, status, refreshStatus, saving, error, setError, initialJobs, flush, runMutation, reload, recovery };
}
