import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { conflict, invalid } from './errors.ts';
import type { ArduinoEvent, ArduinoLine, ArduinoLineSource, ArduinoStatus, ArduinoUpload } from '../src/lib/backend-types.ts';

/**
 * Uploads a task's linked Arduino sketch with arduino-cli and keeps one serial connection open to the
 * board, so the workbench can show the sketch's serial lines and send it short commands.
 *
 * Opening the serial port must not reset the board: an Uno resets when DTR goes high, and the sketches
 * this was built for start moving the arm a few seconds after a reset. On Windows the connection is a
 * small PowerShell bridge around System.IO.Ports.SerialPort with DTR and RTS held low from the start.
 * Elsewhere it falls back to `arduino-cli monitor` with dtr=off, which may still reset some boards.
 */
export type ArduinoProcessKind = 'detect' | 'compile' | 'upload' | 'serial';
export interface ArduinoLaunch { kind: ArduinoProcessKind; command: string; args: string[] }
export interface ArduinoOptions {
  /** arduino-cli executable (BRIDGE_ARDUINO_CLI). Found automatically when unset. */
  cli?: string;
  /** arduino-cli --config-file (BRIDGE_ARDUINO_CONFIG). The Arduino IDE 2 file is used when it exists. */
  config?: string;
  /** Serial port (BRIDGE_ARDUINO_PORT). Detected with `arduino-cli board list` when unset. */
  port?: string;
  /** Board (BRIDGE_ARDUINO_FQBN), default arduino:avr:uno. */
  fqbn?: string;
  baud?: number;
  uploadTimeoutMs?: number;
  /** How long the serial bridge may take to report the port open (default 15 s). */
  openTimeoutMs?: number;
  /** Test seam: start a process instead of spawning the real command. */
  processFactory?: (launch: ArduinoLaunch) => ChildProcessWithoutNullStreams;
  /** Test seam: the platform used to pick the serial bridge. */
  platform?: NodeJS.Platform;
}
export type { ArduinoEvent, ArduinoLine, ArduinoLineSource, ArduinoStatus, ArduinoUpload } from '../src/lib/backend-types.ts';

const KEEP_LINES = 400;
const SERIAL_LINE = /^[\x20-\x7e]{1,80}$/;
const FQBN = /^[\w.-]+:[\w.-]+:[\w.-]+(:[\w=,.-]+)?$/;
const now = () => new Date().toISOString();

/**
 * arduino-cli prints UTF-8, but tools it runs (avrdude) pass on Windows system messages in the console's
 * legacy code page. Decode a line as UTF-8 when it is valid, otherwise with the code page that usually
 * goes with the system language.
 */
export function legacyEncoding(locale = Intl.DateTimeFormat().resolvedOptions().locale): string {
  const tag = locale.toLowerCase();
  if (/^zh-(tw|hk|mo)|^zh-hant/.test(tag)) return 'big5';
  if (tag.startsWith('zh')) return 'gb18030';
  if (tag.startsWith('ja')) return 'shift_jis';
  if (tag.startsWith('ko')) return 'euc-kr';
  return 'windows-1252';
}
const utf8 = new TextDecoder('utf-8', { fatal: true });
let legacy: TextDecoder | undefined;
export function decodeOutput(bytes: Uint8Array): string {
  try { return utf8.decode(bytes); } catch {
    try { legacy ??= new TextDecoder(legacyEncoding()); return legacy.decode(bytes); } catch { return new TextDecoder().decode(bytes); }
  }
}

/** The Arduino IDE 2 ships arduino-cli inside its install folder; that is the usual way it is present. */
export function findArduinoCli(env: NodeJS.ProcessEnv = process.env, exists: (path: string) => boolean = existsSync): string | undefined {
  const win = process.platform === 'win32';
  const names = win ? ['arduino-cli.exe'] : ['arduino-cli'];
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)) {
    for (const name of names) if (exists(join(dir, name))) return join(dir, name);
  }
  const bundled = join('resources', 'app', 'lib', 'backend', 'resources', names[0]);
  const roots = win
    ? [env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs', 'Arduino IDE'), env.ProgramFiles && join(env.ProgramFiles, 'Arduino IDE')]
    : ['/Applications/Arduino IDE.app/Contents', '/usr/share/arduino-ide', '/opt/arduino-ide'];
  for (const root of roots) if (root && exists(join(root, bundled))) return join(root, bundled);
  return undefined;
}

/** Arduino IDE 2 keeps its arduino-cli settings (board package location) in ~/.arduinoIDE/arduino-cli.yaml. */
export function findArduinoConfig(env: NodeJS.ProcessEnv = process.env, exists: (path: string) => boolean = existsSync): string | undefined {
  const home = env.USERPROFILE ?? env.HOME;
  const path = home && join(home, '.arduinoIDE', 'arduino-cli.yaml');
  return path && exists(path) ? path : undefined;
}

/** Reads `arduino-cli board list --format json`; both the 0.x array and the 1.x object layouts. */
export function portsFromBoardList(json: string, fqbn: string): string[] {
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return []; }
  const entries = Array.isArray(parsed) ? parsed : (parsed as { detected_ports?: unknown[] })?.detected_ports ?? [];
  const ports: string[] = [];
  for (const entry of entries as { matching_boards?: { fqbn?: string }[]; boards?: { fqbn?: string }[]; port?: { address?: string }; address?: string }[]) {
    const boards = entry.matching_boards ?? entry.boards ?? [];
    const address = entry.port?.address ?? entry.address;
    if (address && boards.some(b => b.fqbn === fqbn)) ports.push(address);
  }
  return ports;
}

/** PowerShell bridge: serial bytes to stdout, stdin bytes to the port. DTR/RTS stay low so the board does not reset. */
export function windowsSerialBridge(port: string, baud: number): string[] {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    // Progress records would reach stderr as CLIXML; errors are reported on stdout as one @@ERROR line.
    "$ProgressPreference = 'SilentlyContinue'",
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    `$port = New-Object System.IO.Ports.SerialPort '${port}', ${baud}, 'None', 8, 'One'`,
    '$port.DtrEnable = $false',
    '$port.RtsEnable = $false',
    '$port.Encoding = [System.Text.Encoding]::UTF8',
    '$port.WriteTimeout = 2000',
    'function Report($err) {',
    '  $reason = if ($err.Exception.InnerException) { $err.Exception.InnerException.Message } else { $err.Exception.Message }',
    "  [Console]::Out.WriteLine('@@ERROR ' + $reason); [Console]::Out.Flush()",
    '}',
    'try { $port.Open() } catch { Report $_; exit 3 }',
    "[Console]::Out.WriteLine('@@OPEN'); [Console]::Out.Flush()",
    // [Console]::In.ReadLineAsync() blocks on Windows PowerShell 5.1 and would stall the serial reads;
    // ReadAsync on the raw stdin stream does not. The bytes are passed to the port as they are.
    '$stdin = [Console]::OpenStandardInput()',
    '$inbox = New-Object byte[] 256',
    '$pending = $stdin.ReadAsync($inbox, 0, $inbox.Length)',
    'try {',
    '  while ($true) {',
    '    if ($pending.IsCompleted) {',
    '      $count = $pending.Result',
    '      if ($count -le 0) { break }',
    '      $port.Write($inbox, 0, $count)',
    '      $pending = $stdin.ReadAsync($inbox, 0, $inbox.Length)',
    '    }',
    '    $data = $port.ReadExisting()',
    '    if ($data.Length -gt 0) { [Console]::Out.Write($data); [Console]::Out.Flush() }',
    '    Start-Sleep -Milliseconds 20',
    '  }',
    '} catch { Report $_; exit 4 } finally { $port.Close() }',
  ].join('\n');
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
}

/** One serial connection: its bridge process and whether it reported the port open. */
interface SerialConnection { child: ChildProcessWithoutNullStreams; port: string; open: boolean }

export class ArduinoService {
  events = new EventEmitter();
  readonly instance = randomUUID();
  #options: ArduinoOptions;
  #fqbn: string;
  #baud: number;
  #platform: NodeJS.Platform;
  #lines: ArduinoLine[] = [];
  #seq = 0;
  #upload?: ArduinoUpload;
  #uploadChild?: ChildProcessWithoutNullStreams;
  #uploadTask?: Promise<void>;
  #uploadCancelled = false;
  #serial?: SerialConnection;
  #opening?: Promise<ArduinoStatus>;
  #serialStopping?: Promise<void>;
  #detected?: { port?: string; error?: string; at: number };
  #closed = false;

  constructor(options: ArduinoOptions = {}) {
    this.#options = options;
    this.#fqbn = options.fqbn ?? 'arduino:avr:uno';
    if (!FQBN.test(this.#fqbn)) throw new Error('BRIDGE_ARDUINO_FQBN is not a valid board name, e.g. arduino:avr:uno.');
    this.#baud = options.baud ?? 115200;
    this.#platform = options.platform ?? process.platform;
    this.events.setMaxListeners(50);
  }

  get cli(): string | undefined { return this.#options.cli ?? findArduinoCli(); }
  get config(): string | undefined { return this.#options.config ?? findArduinoConfig(); }
  get uploading(): boolean { return this.#upload?.status === 'running'; }
  get #serialState(): ArduinoStatus['serial'] { return this.#serial?.open ? 'open' : this.#serial || this.#opening ? 'connecting' : 'closed'; }

  status(): ArduinoStatus {
    const cli = this.cli, serial = this.#serialState;
    return {
      available: !!cli,
      reason: cli ? undefined : 'arduino-cli was not found. Install the Arduino IDE 2, or set BRIDGE_ARDUINO_CLI to its arduino-cli executable.',
      cli,
      port: this.#options.port ?? this.#detected?.port,
      fqbn: this.#fqbn,
      instance: this.instance,
      state: this.uploading ? 'uploading' : serial === 'open' ? 'monitoring' : serial === 'connecting' ? 'connecting' : 'idle',
      serial,
      upload: this.#upload && { ...this.#upload },
      lines: this.#lines.slice(),
    };
  }

  #emitStatus(): void { if (!this.#closed) this.events.emit('event', { type: 'status', status: { ...this.status(), lines: [] } } satisfies ArduinoEvent); }
  #line(source: ArduinoLineSource, text: string): void {
    const line: ArduinoLine = { seq: ++this.#seq, at: now(), source, text: text.slice(0, 2000) };
    this.#lines.push(line);
    if (this.#lines.length > KEEP_LINES) this.#lines.splice(0, this.#lines.length - KEEP_LINES);
    this.events.emit('event', { type: 'line', line } satisfies ArduinoEvent);
  }

  #spawn(kind: ArduinoProcessKind, command: string, args: string[]): ChildProcessWithoutNullStreams {
    const launch: ArduinoLaunch = { kind, command, args };
    return this.#options.processFactory?.(launch) ?? spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
  }
  #cliArgs(args: string[]): string[] { const config = this.config; return config ? [...args, '--config-file', config] : args; }
  #requireCli(): string {
    const cli = this.cli;
    if (!cli) throw conflict('arduino-cli was not found. Install the Arduino IDE 2, or set BRIDGE_ARDUINO_CLI to its arduino-cli executable.');
    return cli;
  }
  #ensureRunning(): void { if (this.#closed) throw conflict('The local service is stopping.'); }

  /** The configured port, or the one board of this type `arduino-cli board list` reports. */
  async port(): Promise<string> {
    let port = this.#options.port;
    if (!port) {
      if (!this.#detected || Date.now() - this.#detected.at > 10_000 || !this.#detected.port) this.#detected = { ...(await this.#detect()), at: Date.now() };
      if (!this.#detected.port) throw conflict(this.#detected.error ?? 'No board found.');
      port = this.#detected.port;
    }
    const valid = this.#platform === 'win32' ? /^COM[1-9]\d{0,2}$/i.test(port) : /^\/dev\/[\w./-]+$/.test(port);
    if (!valid) throw invalid(`Serial port "${port}" is not a valid port name.`);
    return port;
  }
  async #detect(): Promise<{ port?: string; error?: string }> {
    const cli = this.#requireCli();
    const child = this.#spawn('detect', cli, this.#cliArgs(['board', 'list', '--format', 'json']));
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.resume();
    const code = await new Promise<number | null>(done => {
      const timer = setTimeout(() => { void this.#kill(child); done(null); }, 20_000);
      child.once('error', () => { clearTimeout(timer); done(-1); });
      child.once('exit', c => { clearTimeout(timer); done(c); });
    });
    if (code !== 0) return { error: 'arduino-cli could not list the connected boards.' };
    const ports = portsFromBoardList(out, this.#fqbn);
    if (ports.length === 1) return { port: ports[0] };
    return { error: ports.length ? `Found ${ports.length} boards of type ${this.#fqbn} (${ports.join(', ')}). Set BRIDGE_ARDUINO_PORT to choose one.` : `No ${this.#fqbn} board is connected. Plug it in by USB, or set BRIDGE_ARDUINO_PORT.` };
  }

  /** Run one arduino-cli step to completion, streaming its output. Resolves with the exit code (null when killed or failed to start). */
  #step(kind: 'compile' | 'upload', args: string[]): Promise<number | null> {
    const child = this.#spawn(kind, this.#requireCli(), args);
    this.#uploadChild = child;
    this.#pipeLines(child.stdout, 'upload');
    this.#pipeLines(child.stderr, 'upload');
    return new Promise(done => {
      const timeout = setTimeout(() => { this.#line('error', `${kind === 'compile' ? 'Compiling' : 'Uploading'} timed out.`); void this.#kill(child); }, this.#options.uploadTimeoutMs ?? 180_000);
      child.once('error', error => this.#line('error', `Could not start arduino-cli: ${error.message}`));
      child.once('close', code => { clearTimeout(timeout); if (this.#uploadChild === child) this.#uploadChild = undefined; done(code); });
    });
  }

  /**
   * Compile, then upload, one sketch folder. Resolves once the work has started; progress arrives as events.
   * The serial connection stays open while compiling, so Stop keeps working. Before the upload step the
   * running sketch is sent x (stop) and the port is handed to the uploader.
   */
  async upload(taskId: string, sketchDir: string): Promise<ArduinoStatus> {
    this.#ensureRunning();
    if (this.uploading) throw conflict('An upload is already running. Wait for it or cancel it.');
    this.#requireCli();
    // Claim the upload before any await, so two clicks cannot start two uploads.
    this.#upload = { taskId, sketch: sketchDir, status: 'running', phase: 'compiling', startedAt: now() };
    this.#uploadCancelled = false;
    this.#emitStatus();
    this.#uploadTask = this.#runUpload(sketchDir).catch(error => this.#finishUpload('failed', (error as Error).message));
    return this.status();
  }
  async #runUpload(sketchDir: string): Promise<void> {
    const port = await this.port();
    const buildPath = await mkdtemp(join(tmpdir(), 'context-bridge-arduino-'));
    try {
      if (this.#stopRequested()) return;
      this.#line('info', `Compiling ${sketchDir} for ${this.#fqbn}.`);
      const compiled = await this.#step('compile', this.#cliArgs(['compile', '--fqbn', this.#fqbn, '--build-path', buildPath, sketchDir]));
      if (this.#stopRequested()) return;
      if (compiled !== 0) { this.#finishUpload('failed', `Compile failed (exit code ${compiled}). See the lines above. The board was not touched.`); return; }
      // The upload needs the port. Stop the running sketch first, so the arm is still while the board is reflashed.
      if (this.#serial?.open) { await this.send('x').catch(() => {}); await delay(150); }
      await this.closeSerial();
      if (this.#stopRequested()) return;
      this.#upload = this.#upload && { ...this.#upload, phase: 'uploading' };
      this.#emitStatus();
      this.#line('info', `Uploading to ${port}. The board restarts and runs the new sketch; Stop is unavailable until it reconnects.`);
      const uploaded = await this.#step('upload', this.#cliArgs(['upload', '--fqbn', this.#fqbn, '--port', port, '--input-dir', buildPath, sketchDir]));
      if (this.#stopRequested()) return;
      if (uploaded !== 0) { this.#finishUpload('failed', `Upload failed (exit code ${uploaded}). See the lines above.`); return; }
      this.#finishUpload('succeeded', 'Upload finished. Opening the serial connection without resetting the board.');
      await delay(300);
      if (!this.#closed) await this.openSerial().catch(() => { /* logged by openSerial */ });
    } finally {
      await rm(buildPath, { recursive: true, force: true }).catch(() => {});
    }
  }
  #stopRequested(): boolean {
    if (!this.#uploadCancelled && !this.#closed) return false;
    this.#finishUpload('cancelled', 'Upload cancelled. If it stopped during the upload step, the board may have no sketch until the next upload.');
    return true;
  }
  #finishUpload(status: ArduinoUpload['status'], message: string): void {
    if (this.#upload?.status !== 'running') return;
    this.#upload = { ...this.#upload, status, finishedAt: now() };
    this.#line(status === 'succeeded' ? 'info' : 'error', message);
    this.#emitStatus();
  }
  async cancelUpload(): Promise<ArduinoStatus> {
    if (!this.uploading) return this.status();
    this.#uploadCancelled = true;
    if (this.#uploadChild) await this.#kill(this.#uploadChild);
    await this.#uploadTask;
    return this.status();
  }

  /** Open the serial connection. Holding DTR low keeps the board running what it already runs. Concurrent calls share one attempt. */
  openSerial(): Promise<ArduinoStatus> {
    try { this.#ensureRunning(); } catch (error) { return Promise.reject(error); }
    if (this.#serial?.open) return Promise.resolve(this.status());
    if (!this.#opening) {
      this.#opening = this.#open()
        .catch(error => { this.#line('error', (error as Error).message); throw error; })
        .finally(() => { this.#opening = undefined; this.#emitStatus(); });
      this.#emitStatus();
    }
    return this.#opening;
  }
  async #open(): Promise<ArduinoStatus> {
    if (this.uploading && this.#upload?.phase === 'uploading') throw conflict('Wait for the upload to finish.');
    await this.#serialStopping;
    const port = await this.port();
    this.#ensureRunning();
    if (this.uploading && this.#upload?.phase === 'uploading') throw conflict('Wait for the upload to finish.');
    if (this.#serial) return this.status();
    let command: string, args: string[];
    if (this.#platform === 'win32') { command = 'powershell.exe'; args = windowsSerialBridge(port, this.#baud); }
    else { command = this.#requireCli(); args = this.#cliArgs(['monitor', '--port', port, '--fqbn', this.#fqbn, '--quiet', '--config', `baudrate=${this.#baud}`, '--config', 'dtr=off', '--config', 'rts=off']); }
    const child = this.#spawn('serial', command, args);
    const connection: SerialConnection = { child, port, open: false };
    this.#serial = connection;
    this.#emitStatus();
    await new Promise<void>((resolveOpen, rejectOpen) => {
      let buffer = '', errors = '', reason = '', settled = false;
      const succeed = () => {
        if (settled) return;
        settled = true; clearTimeout(timer); connection.open = true;
        this.#line('info', `Serial connected to ${port} at ${this.#baud} baud (board not reset).`);
        this.#emitStatus(); resolveOpen();
      };
      const fail = (message: string) => { if (!settled) { settled = true; clearTimeout(timer); rejectOpen(conflict(message)); } };
      const openTimeout = this.#options.openTimeoutMs ?? 15_000;
      const timer = setTimeout(() => { fail(`The serial connection to ${port} did not open within ${Math.round(openTimeout / 1000)} s.`); void this.#kill(child); }, openTimeout);
      // Writing to a bridge that just exited must not crash the service.
      child.stdin.on('error', () => {});
      child.stderr.on('data', chunk => { errors += chunk; if (errors.length > 4000) errors = errors.slice(-4000); });
      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        let index: number;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const text = buffer.slice(0, index).replace(/\r$/, '');
          buffer = buffer.slice(index + 1);
          if (text.startsWith('@@ERROR ')) {
            reason = text.slice(8).trim().replace(/[.。]+$/, '');
            if (connection.open) this.#line('error', `Serial connection error: ${reason}.`);
            continue;
          }
          if (!connection.open && text === '@@OPEN') { succeed(); continue; }
          if (this.#platform !== 'win32' && !connection.open) succeed();
          if (this.#serial === connection) this.#line('serial', text);
        }
        if (buffer.length > 2000) { if (this.#serial === connection) this.#line('serial', buffer); buffer = ''; }
      });
      if (this.#platform !== 'win32') setTimeout(() => { if (!connection.open && this.#serial === connection && child.exitCode === null) succeed(); }, 800);
      child.once('error', error => fail(`Could not open the serial connection: ${error.message}`));
      child.once('close', code => {
        const current = this.#serial === connection;
        if (current) this.#serial = undefined;
        if (!connection.open) fail(`Could not open ${port}${reason ? `: ${reason}` : errors.trim() ? `: ${errors.trim().slice(0, 300)}` : ` (exit code ${code})`}. Close the Arduino IDE Serial Monitor or any other program using the port.`);
        else if (current && !this.#closed) { this.#line(code ? 'error' : 'info', code ? `Serial connection closed unexpectedly (exit code ${code}).` : 'Serial connection closed.'); this.#emitStatus(); }
      });
    }).catch(error => { if (this.#serial === connection) this.#serial = undefined; throw error; });
    if (this.#closed) { await this.#closeConnection(); throw conflict('The local service is stopping.'); }
    return this.status();
  }

  async closeSerial(): Promise<ArduinoStatus> {
    // A connection still starting is finished first, so it cannot come up after this returns.
    if (this.#opening) await this.#opening.catch(() => {});
    return this.#closeConnection();
  }
  async #closeConnection(): Promise<ArduinoStatus> {
    const connection = this.#serial;
    if (connection) {
      this.#serial = undefined;
      const { child } = connection;
      // Closing stdin lets the bridge close the port itself; the kill is the fallback.
      this.#serialStopping = (async () => {
        child.stdin.end();
        const exited = await Promise.race([new Promise<boolean>(done => { if (child.exitCode !== null || child.signalCode !== null) done(true); else child.once('close', () => done(true)); }), delay(1500).then(() => false)]);
        if (!exited) await this.#kill(child);
      })();
      await this.#serialStopping;
      this.#serialStopping = undefined;
      this.#emitStatus();
    }
    return this.status();
  }

  /** Send one line (for example x, g, s) to the running sketch. Resolves once the bridge has taken it. */
  async send(text: unknown): Promise<ArduinoStatus> {
    if (typeof text !== 'string' || !SERIAL_LINE.test(text)) throw invalid('Send 1 to 80 printable ASCII characters.');
    const connection = this.#serial;
    if (!connection?.open) throw conflict('Connect to the board first.');
    await new Promise<void>((resolveWrite, rejectWrite) => {
      connection.child.stdin.write(`${text}\n`, error => error ? rejectWrite(conflict(`"${text}" did not reach the board: ${error.message}. Reconnect and try again.`)) : resolveWrite());
    }).catch(error => { this.#line('error', (error as Error).message); throw error; });
    this.#line('sent', text);
    return this.status();
  }

  /** Split on bytes, then decode each line, so a multi-byte character is never cut in half. */
  #pipeLines(stream: NodeJS.ReadableStream, source: ArduinoLineSource): void {
    let buffer = Buffer.alloc(0);
    const emit = (bytes: Buffer) => { for (const part of decodeOutput(bytes).split('\r')) if (part.trim()) this.#line(source, part); };
    stream.on('data', (chunk: Buffer | string) => {
      buffer = Buffer.concat([buffer, typeof chunk === 'string' ? Buffer.from(chunk) : chunk]);
      let index: number;
      while ((index = buffer.indexOf(0x0a)) >= 0) { emit(buffer.subarray(0, index)); buffer = buffer.subarray(index + 1); }
    });
    stream.on('end', () => { if (buffer.length) emit(buffer); buffer = Buffer.alloc(0); });
  }

  async #kill(child: ChildProcessWithoutNullStreams): Promise<void> {
    const exited = new Promise<void>(done => {
      if (child.exitCode !== null || child.signalCode !== null) { done(); return; }
      const timer = setTimeout(done, 2_000);
      child.once('exit', () => { clearTimeout(timer); done(); });
    });
    if (child.exitCode === null && child.pid) {
      if (process.platform === 'win32' && !this.#options.processFactory) {
        await new Promise<void>(done => {
          const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
          const timer = setTimeout(() => { killer.kill(); child.kill(); done(); }, 2_000);
          killer.once('error', () => { clearTimeout(timer); child.kill(); done(); });
          killer.once('exit', () => { clearTimeout(timer); if (child.exitCode === null) child.kill(); done(); });
        });
      } else { child.kill('SIGTERM'); await delay(100); if (child.exitCode === null) child.kill('SIGKILL'); }
    }
    await exited;
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.uploading) this.#uploadCancelled = true;
    if (this.#uploadChild) await this.#kill(this.#uploadChild);
    await this.#uploadTask?.catch(() => {});
    await this.closeSerial();
    this.events.removeAllListeners();
  }
}
