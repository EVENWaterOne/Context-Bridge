import { useCallback, useEffect, useRef, useState } from 'react';
import { localApi } from './local-api.ts';
import type { ArduinoEvent, ArduinoLine, ArduinoStatus } from './backend-types.ts';

const KEEP = 400;
const sleep = (ms: number, signal: AbortSignal) => new Promise<void>(done => {
  const timer = setTimeout(done, ms);
  signal.addEventListener('abort', () => { clearTimeout(timer); done(); }, { once: true });
});

/** Lines from status replies and from the stream can overlap; the server's sequence number orders and dedupes them. */
export function mergeLines(current: ArduinoLine[], incoming: ArduinoLine[]): ArduinoLine[] {
  if (!incoming.length) return current;
  const bySeq = new Map(current.map(line => [line.seq, line]));
  for (const line of incoming) bySeq.set(line.seq, line);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq).slice(-KEEP);
}

/** Parse one server-sent-events chunk stream into Arduino events. Exported for tests. */
export function parseEvents(buffer: string): { events: ArduinoEvent[]; rest: string } {
  const events: ArduinoEvent[] = [];
  let index: number;
  buffer = buffer.replace(/\r\n/g, '\n');
  while ((index = buffer.indexOf('\n\n')) >= 0) {
    const block = buffer.slice(0, index); buffer = buffer.slice(index + 2);
    const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (data) events.push(JSON.parse(data) as ArduinoEvent);
  }
  return { events, rest: buffer };
}

/**
 * Follow /api/arduino/events until aborted, reconnecting after a dropped connection. onOffline runs whenever
 * the stream is down, so the panel never shows a stale "Connected". A restarted service issues a new session
 * cookie, so a 401 first re-reads /api/status, the route that hands out the cookie.
 */
export async function followArduino(onEvent: (event: ArduinoEvent) => void, signal: AbortSignal, onOffline: () => void = () => {}): Promise<void> {
  while (!signal.aborted) {
    try {
      const response = await fetch('/api/arduino/events', { headers: { Accept: 'text/event-stream' }, signal, credentials: 'same-origin' });
      if (response.status === 401) { await fetch('/api/status', { credentials: 'same-origin', signal }).catch(() => {}); throw new Error('Session renewed'); }
      if (!response.ok || !response.body) throw new Error('Arduino event stream unavailable');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          const parsed = parseEvents(buffer + decoder.decode(value, { stream: true }));
          buffer = parsed.rest;
          for (const event of parsed.events) onEvent(event);
        }
      } finally { reader.releaseLock(); }
    } catch { /* reconnect below */ }
    if (signal.aborted) return;
    onOffline();
    await sleep(2000, signal);
  }
}

/**
 * Upload and serial state for the Arm panel and the header Stop button. It follows the service for the whole
 * local session, not just while an Arduino task is open, so Stop stays reachable after switching tasks.
 * status is null while the event stream is down: the connection state is unknown then.
 */
export function useArduino(enabled: boolean) {
  const [status, setStatus] = useState<ArduinoStatus | null>(null);
  const [lines, setLines] = useState<ArduinoLine[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const instance = useRef('');
  // A restarted service numbers its lines from 1 again; its first status replaces the old log.
  const adopt = useCallback((next: ArduinoStatus) => {
    setStatus(next);
    if (next.instance !== instance.current) { instance.current = next.instance; setLines(next.lines.slice(-KEEP)); }
    else setLines(current => mergeLines(current, next.lines));
  }, []);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void followArduino(event => {
      if (event.type === 'line') setLines(current => mergeLines(current, [event.line]));
      else adopt(event.status);
    }, controller.signal, () => setStatus(null));
    return () => { controller.abort(); setStatus(null); };
  }, [enabled, adopt]);
  const call = useCallback(async (path: string, body: unknown = {}) => {
    setBusy(true); setError('');
    try { adopt(await localApi<ArduinoStatus>(path, body)); }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }, [adopt]);
  return {
    status, lines, error, busy,
    clearError: () => setError(''),
    upload: (taskId: string) => call('/api/arduino/upload', { taskId }),
    cancelUpload: () => call('/api/arduino/upload/cancel'),
    connect: () => call('/api/arduino/serial/open'),
    disconnect: () => call('/api/arduino/serial/close'),
    send: (text: string) => call('/api/arduino/serial/send', { text }),
  };
}
export type ArduinoControls = ReturnType<typeof useArduino>;
