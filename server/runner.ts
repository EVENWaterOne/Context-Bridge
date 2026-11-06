import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Runs the project's verification command (a build or test command the user confirmed) in a project
 * copy, through the system shell, with no input and a time limit. Model credentials are removed from
 * its environment. With a sandbox it runs inside Codex's OS sandbox: writes only in the copy and a
 * temporary folder, no network. That is required whenever the copy holds code nobody has reviewed yet.
 */
export interface ShellResult {
  exitCode: number | null;
  /** Combined output, shortened in the middle when long. */
  output: string;
  durationMs: number;
  timedOut: boolean;
  /** The shell could not find the program (for example arduino-cli is not installed). */
  notFound: boolean;
}
/** Codex's `sandbox` subcommand, used as a plain OS sandbox for one command. */
export interface Sandbox {
  /** The pinned Codex binary, and the environment it needs to start. */
  command: string;
  env: Record<string, string>;
  /** CODEX_HOME: the service's own isolated Codex profile (it keeps the Windows sandbox setup). */
  home: string;
  /** Writable besides the working folder. */
  writable: string[];
}
export interface ShellOptions {
  sandbox?: Sandbox;
  /** Folders put first on PATH (for example the real project's virtual environment). */
  path?: string[];
  env?: Record<string, string>;
  /** Windows: where the command is written as a .cmd script (it must be writable inside the sandbox). */
  scriptDir?: string;
}

const HEAD = 4 * 1024, TAIL = 28 * 1024;
// After the shell exits, how long a leftover background process may hold the output open.
const EXIT_GRACE_MS = 2_000;
const MODEL_SECRETS = /^(OPENAI_API_KEY|CODEX_API_KEY|CODEX_ACCESS_TOKEN|OPENAI_IDENTITY_TOKEN_FILE|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN)$/i;

function abortError(): Error { return new DOMException('Cancelled', 'AbortError'); }

/** Ends the shell and everything it started. */
export function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', shell: false });
    killer.once('error', () => child.kill());
    return;
  }
  // The group outlives the shell when it left background processes behind.
  try { process.kill(-child.pid, 'SIGKILL'); } catch { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
}

/** Drops an incomplete UTF-8 sequence at the start or end of a cut. */
function trimCut(bytes: Buffer, atStart: boolean): Buffer {
  if (atStart) {
    let start = 0;
    while (start < Math.min(3, bytes.length) && (bytes[start] & 0xc0) === 0x80) start++;
    return bytes.subarray(start);
  }
  for (let back = 1; back <= Math.min(3, bytes.length); back++) {
    const byte = bytes[bytes.length - back];
    if ((byte & 0xc0) === 0x80) continue;
    const need = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return need > back ? bytes.subarray(0, bytes.length - back) : bytes;
  }
  return bytes;
}
/**
 * UTF-8 first; Windows tools often print in the console code page (GBK on Chinese Windows). The
 * encoding is chosen once for the whole output, so a character cut in half at the shortening does
 * not switch one part to another code page.
 */
function decodeParts(head: Buffer, tail: Buffer, cut: boolean): [string, string] {
  const parts: [Buffer, Buffer] = cut ? [trimCut(head, false), trimCut(tail, true)] : [head, tail];
  const strict = new TextDecoder('utf-8', { fatal: true });
  try { return [strict.decode(parts[0]), strict.decode(parts[1])]; }
  catch {
    if (process.platform === 'win32') {
      try { const gbk = new TextDecoder('gb18030'); return [gbk.decode(parts[0]), gbk.decode(parts[1])]; } catch { /* no ICU data */ }
    }
    const loose = new TextDecoder('utf-8');
    return [loose.decode(parts[0]), loose.decode(parts[1])];
  }
}
const clean = (text: string) => text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r\n?/g, '\n');

/**
 * The program and arguments that run `command` through the system shell, optionally sandboxed. On
 * Windows the command goes into a .cmd script, so no layer of argument quoting can change it.
 */
function launch(command: string, options: ShellOptions): { file: string; args: string[]; script?: string } {
  const { sandbox } = options;
  let script: string | undefined;
  let shell: { file: string; args: string[] };
  if (process.platform === 'win32') {
    script = join(options.scriptDir ?? tmpdir(), `context-bridge-${randomUUID()}.cmd`);
    // cmd.exe reads a script in the console code page, so UTF-8 text such as a Chinese folder name needs 65001 first.
    writeFileSync(script, `@echo off\r\nchcp 65001 >nul 2>&1\r\n${command}\r\n`, 'utf8');
    shell = { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/c', script] };
  } else shell = { file: '/bin/sh', args: ['-c', command] };
  if (!sandbox) return { ...shell, script };
  const config: Record<string, unknown> = {
    sandbox_mode: 'workspace-write',
    'sandbox_workspace_write.writable_roots': sandbox.writable,
    'sandbox_workspace_write.network_access': false,
    'sandbox_workspace_write.exclude_slash_tmp': true,
    'sandbox_workspace_write.exclude_tmpdir_env_var': true,
    ...(process.platform === 'win32' ? { 'windows.sandbox': 'unelevated' } : {}),
  };
  const sandboxed = [sandbox.command, 'sandbox', ...Object.entries(config).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]), '--', shell.file, ...shell.args];
  if (process.platform === 'win32') return { file: sandboxed[0], args: sandboxed.slice(1), script };
  // Node gives a child a socket pair for its output, and inside the Linux sandbox Node's own writes to
  // a socket are lost (npm test would print nothing). An unsandboxed sh hands the sandbox a real pipe
  // and relays it with cat, keeping the sandbox's exit code.
  return { file: '/bin/sh', args: ['-c', RELAY, 'sh', ...sandboxed], script };
}
const RELAY = 'exec 3>&1; status=$({ { "$@" 2>&1 3>&- 4>&-; echo $? >&4; } | cat >&3 4>&-; } 4>&1); exit "${status:-1}"';
// Printed when CODEX_HOME is under /tmp (tests); not part of the command's output.
const SANDBOX_NOISE = /^WARNING: proceeding, even though we could not create PATH aliases:.*\n?/gm;

export function runShell(command: string, cwd: string, signal: AbortSignal, timeoutMs: number, options: ShellOptions = {}): Promise<ShellResult> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(abortError()); return; }
    const started = Date.now();
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) if (!MODEL_SECRETS.test(key)) env[key] = value;
    Object.assign(env, options.env, { NO_COLOR: '1', FORCE_COLOR: '0' });
    if (options.path?.length) {
      const key = Object.keys(env).find(name => name.toUpperCase() === 'PATH') ?? 'PATH';
      env[key] = [...options.path, env[key]].filter(Boolean).join(process.platform === 'win32' ? ';' : ':');
    }
    if (options.sandbox) Object.assign(env, options.sandbox.env, { CODEX_HOME: options.sandbox.home });
    let child: ChildProcess, script: string | undefined;
    const removeScript = () => { if (script) { try { rmSync(script, { force: true }); } catch { /* removed with its folder */ } } };
    try {
      const launched = launch(command, options);
      script = launched.script;
      // POSIX shells get their own process group, so a time limit ends the whole build.
      child = spawn(launched.file, launched.args, { cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      removeScript();
      resolve({ exitCode: null, output: (error as Error).message, durationMs: 0, timedOut: false, notFound: (error as NodeJS.ErrnoException).code === 'ENOENT' });
      return;
    }
    const head: Buffer[] = [], tail: Buffer[] = [];
    let headSize = 0, tailSize = 0, total = 0;
    const collect = (chunk: Buffer) => {
      total += chunk.length;
      if (headSize < HEAD) {
        const take = chunk.subarray(0, HEAD - headSize);
        head.push(take); headSize += take.length; chunk = chunk.subarray(take.length);
      }
      if (!chunk.length) return;
      tail.push(chunk); tailSize += chunk.length;
      while (tailSize - tail[0].length >= TAIL) tailSize -= tail.shift()!.length;
    };
    child.stdout!.on('data', collect);
    child.stderr!.on('data', collect);
    let timedOut = false, settled = false, grace: ReturnType<typeof setTimeout> | undefined;
    // Settles even when a leftover background process keeps the output open after the shell ended.
    const release = (code: number | null) => {
      grace ??= setTimeout(() => { child.stdout?.destroy(); child.stderr?.destroy(); finish(code); }, EXIT_GRACE_MS);
    };
    const stop = () => { killTree(child); release(null); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    signal.addEventListener('abort', stop, { once: true });
    const finish = (exitCode: number | null, failure?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); if (grace) clearTimeout(grace);
      signal.removeEventListener('abort', stop);
      // Anything the command left running ends with it.
      killTree(child);
      removeScript();
      if (signal.aborted && !timedOut) { reject(abortError()); return; }
      let tailBytes = Buffer.concat(tail);
      if (tailBytes.length > TAIL) tailBytes = tailBytes.subarray(tailBytes.length - TAIL);
      const cut = total > headSize + tailBytes.length;
      const [first, last] = decodeParts(Buffer.concat(head), tailBytes, cut);
      const output = clean(`${first}${cut ? '\n…\n' : ''}${last}`).replace(SANDBOX_NOISE, '').trim() || (failure?.message ?? '');
      const notFound = (failure as NodeJS.ErrnoException | undefined)?.code === 'ENOENT' || exitCode === 127 || exitCode === 9009
        || (exitCode !== 0 && /is not recognized as an internal or external command|不是内部或外部命令|command not found|No module named pytest/i.test(output));
      resolve({ exitCode, output, durationMs: Date.now() - started, timedOut, notFound });
    };
    child.once('error', error => finish(null, error));
    child.once('exit', code => release(code));
    child.once('close', code => finish(code));
  });
}
