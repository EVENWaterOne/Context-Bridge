import { spawn, type ChildProcess } from 'node:child_process';

/**
 * Runs the project's verification command (a build or test command the user set or accepted) in a
 * project copy. It runs like the user typing it in a terminal at the copy, through the system shell,
 * with no input and a time limit. Model credentials are removed from its environment.
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

const HEAD = 4 * 1024, TAIL = 28 * 1024;
const MODEL_SECRETS = /^(OPENAI_API_KEY|CODEX_API_KEY|CODEX_ACCESS_TOKEN|OPENAI_IDENTITY_TOKEN_FILE|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN)$/i;

function abortError(): Error { return new DOMException('Cancelled', 'AbortError'); }

/** Ends the shell and everything it started. */
export function killTree(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', shell: false });
    killer.once('error', () => child.kill());
    return;
  }
  try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
}

/** UTF-8 first; Windows tools often print in the console code page (GBK on Chinese Windows). */
function decode(bytes: Buffer): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch {
    if (process.platform === 'win32') { try { return new TextDecoder('gb18030').decode(bytes); } catch { /* no ICU data */ } }
    return new TextDecoder('utf-8').decode(bytes);
  }
}
const clean = (text: string) => text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r\n?/g, '\n');

export function runShell(command: string, cwd: string, signal: AbortSignal, timeoutMs: number): Promise<ShellResult> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(abortError()); return; }
    const started = Date.now();
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) if (!MODEL_SECRETS.test(key)) env[key] = value;
    env.NO_COLOR = '1'; env.FORCE_COLOR = '0';
    let child: ChildProcess;
    try {
      // POSIX shells get their own process group, so a time limit ends the whole build.
      child = spawn(command, { cwd, env, shell: true, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ exitCode: null, output: (error as Error).message, durationMs: 0, timedOut: false, notFound: false });
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
    let timedOut = false, settled = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    const onAbort = () => killTree(child);
    signal.addEventListener('abort', onAbort, { once: true });
    const finish = (exitCode: number | null, failure?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (signal.aborted && !timedOut) { reject(abortError()); return; }
      let tailBytes = Buffer.concat(tail);
      if (tailBytes.length > TAIL) tailBytes = tailBytes.subarray(tailBytes.length - TAIL);
      const cut = total > headSize + tailBytes.length;
      const output = clean(`${decode(Buffer.concat(head))}${cut ? '\n…\n' : ''}${decode(tailBytes)}`).trim() || (failure?.message ?? '');
      const notFound = (failure as NodeJS.ErrnoException | undefined)?.code === 'ENOENT' || exitCode === 127 || exitCode === 9009
        || (exitCode !== 0 && /is not recognized as an internal or external command|不是内部或外部命令|command not found/i.test(output));
      resolve({ exitCode, output, durationMs: Date.now() - started, timedOut, notFound });
    };
    child.once('error', error => finish(null, error));
    child.once('close', code => finish(code));
  });
}
