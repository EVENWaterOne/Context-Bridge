import { useEffect, useRef } from 'react';
import type { ArduinoControls } from '../lib/arduino';
import type { ArduinoStatus } from '../lib/backend-types';

const SERIAL_TEXT = { closed: 'Not connected', connecting: 'Connecting…', open: 'Connected' } as const;

/** What the panel and the header button say about the board right now. Connection first, then the last upload. */
export function armSummary(status: ArduinoStatus | null, taskId: string, sketch: string): { main: string; extra?: string } {
  if (!status) return { main: 'Reconnecting to the local service… The connection state is unknown until it answers.' };
  if (!status.available) return { main: status.reason ?? 'arduino-cli is not available.' };
  const upload = status.upload, mine = upload?.taskId === taskId;
  if (upload?.status === 'running') return upload.phase === 'uploading'
    ? { main: `Uploading to ${status.port ?? 'the board'}. Stop is unavailable until the board reconnects.` }
    : { main: `Compiling ${mine ? sketch : upload.sketch}…`, extra: status.serial === 'open' ? 'Stop still reaches the sketch that is running now.' : undefined };
  const last = mine && upload?.status === 'failed' ? 'The last upload failed. See the log below.'
    : mine && upload?.status === 'cancelled' ? 'The last upload was cancelled.' : undefined;
  if (status.serial === 'open') return { main: `Connected to ${status.port ?? 'the board'}. Serial lines appear below.`, extra: last };
  if (status.serial === 'connecting') return { main: 'Opening the serial connection…', extra: last };
  if (mine && upload?.status === 'succeeded') return { main: 'The new sketch is running, but the panel is not connected: Stop cannot reach it. Connect, or use the board\'s reset or power to stop it.' };
  return { main: 'Not connected. Upload a sketch, or connect to see what the board is running.', extra: last };
}

/** Upload the linked sketch, watch its serial output and send it commands, without the Arduino IDE. */
export function ArmPanel({ arduino, taskId, sketch, canUpload, onClose }: { arduino: ArduinoControls; taskId: string; sketch: string; canUpload: boolean; onClose: () => void }) {
  const { status, lines, error, busy } = arduino;
  const end = useRef<HTMLDivElement>(null), panel = useRef<HTMLElement>(null);
  const serial = status?.serial ?? 'closed';
  const connected = serial === 'open', uploading = status?.state === 'uploading';
  const summary = armSummary(status, taskId, sketch);
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }); }, [lines.length]);
  // Focus moves into the panel when it opens, onto Stop when the board is connected.
  useEffect(() => { (panel.current?.querySelector<HTMLButtonElement>(connected ? '.arm-stop' : 'button:not(:disabled)'))?.focus(); }, []);
  const upload = () => {
    const where = status?.port ? ` on ${status.port}` : '';
    if (window.confirm(`Upload ${sketch} to the board${where}?\n\nIt compiles first; Stop keeps working meanwhile. Right before flashing, the running sketch is sent x (stop) and Stop is unavailable until the board reconnects. The board then restarts and the arm can start moving a few seconds later. Keep hands and objects clear.`)) void arduino.upload(taskId);
  };
  const runAgain = () => { if (window.confirm('Send g? The sketch runs again and the arm starts moving. Keep hands and objects clear.')) void arduino.send('g'); };
  return <aside ref={panel} id="arm-panel" className="chat-panel arm-panel" role="dialog" aria-modal="false" aria-labelledby="arm-title">
    <div className="chat-heading">
      <div><span className={`status-dot ${uploading || serial === 'connecting' ? 'working' : connected ? 'ok' : ''}`} aria-hidden="true"/><h2 id="arm-title">Arm</h2><small className="arm-meta">{status?.port ?? 'port ?'} · {status?.fqbn ?? 'arduino:avr:uno'} · {status ? SERIAL_TEXT[serial] : 'Unknown'}</small></div>
      <button className="icon-button" aria-label="Close arm panel" onClick={onClose}>×</button>
    </div>
    <p className="arm-summary" role="status" aria-live="polite">{summary.main}{summary.extra && <><br/><small>{summary.extra}</small></>}</p>
    {error && <p className="arm-error" role="alert">{error} <button className="text-button" onClick={arduino.clearError}>Dismiss</button></p>}
    <div className="arm-commands" role="group" aria-label="Commands sent to the running sketch">
      <button type="button" className="button arm-stop" disabled={!connected} onClick={() => void arduino.send('x')} title="Sends x: every servo is released at once">Stop · x</button>
      <span className="arm-divider" aria-hidden="true"/>
      <button type="button" className="button" disabled={!connected || busy} onClick={runAgain} title="Sends g after a confirm: the sketch runs again, the arm moves">Run again · g</button>
      <button type="button" className="button" disabled={!connected || busy} onClick={() => void arduino.send('s')} title="Sends s: the sketch prints its status">Status · s</button>
    </div>
    <div className="arm-actions" role="group" aria-label="Upload and connection">
      {uploading
        ? <button type="button" className="button" onClick={() => void arduino.cancelUpload()}>Cancel upload</button>
        : <button type="button" className="button primary ai-border" disabled={busy || !status?.available || !canUpload} onClick={upload} title={canUpload ? undefined : 'Open the Arduino task whose sketch folder is linked to upload it'}>Upload to arm</button>}
      {connected
        ? <button type="button" className="button" disabled={busy} onClick={() => void arduino.disconnect()}>Disconnect</button>
        : <button type="button" className="button" disabled={busy || serial === 'connecting' || status?.upload?.phase === 'uploading' && uploading || !status?.available} onClick={() => void arduino.connect()}>Connect</button>}
    </div>
    <div className="arm-log" role="log" aria-live="off" aria-label="Upload and serial log">
      {!lines.length && <p className="fine">Upload output and the sketch's serial lines appear here.</p>}
      {lines.map(line => <div key={line.seq} className={`arm-line ${line.source}`}>{line.source === 'sent' ? `> ${line.text}` : line.text}</div>)}
      <div ref={end}/>
    </div>
    <p className="arm-note">Stop releases every servo: the arm goes limp and a held object drops. While connected, Stop also sits in the page header. Opening the connection does not restart the board. Close the Arduino IDE Serial Monitor first; only one program can use the port.</p>
  </aside>;
}
