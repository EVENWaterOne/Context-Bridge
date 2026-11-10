import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ArduinoService, findArduinoCli, portsFromBoardList, windowsSerialBridge, type ArduinoLaunch, type ArduinoOptions, type ArduinoStatus } from '../server/arduino.ts';
import { createApp } from '../server/app.ts';
import type { CodexProvider } from '../server/provider.ts';
import type { ProjectScan, WorkspaceEnvelope } from '../src/lib/backend-types.ts';

const origin = 'http://localhost:4173';
const tick = (ms = 10) => new Promise<void>(done => setTimeout(done, ms));

/** Stand-ins for arduino-cli and the serial bridge. They never touch a real board or port. */
const FAKE = String.raw`
const [kind, mode] = process.argv.slice(1);
if (kind === 'detect') {
  const boards = { none: [], one: [{ port: { address: 'COM7' }, matching_boards: [{ fqbn: 'arduino:avr:uno' }] }],
    two: [{ port: { address: 'COM7' }, matching_boards: [{ fqbn: 'arduino:avr:uno' }] }, { port: { address: 'COM9' }, matching_boards: [{ fqbn: 'arduino:avr:uno' }] }] }[mode];
  process.stdout.write(JSON.stringify({ detected_ports: boards }));
} else if (kind === 'compile' || kind === 'upload') {
  process.stdout.write(kind === 'compile' ? 'Sketch uses 7770 bytes (24%) of program storage space.\r\n' : '');
  process.stderr.write(kind === 'upload' ? 'avrdude: writing flash\n' : '');
  if (mode === 'hang') setInterval(() => {}, 1000);
  else setTimeout(() => process.exit(mode === 'fail' ? 1 : 0), 50);
} else if (kind === 'serial') {
  if (mode === 'busy') { process.stdout.write('@@ERROR Access to the port COM7 is denied.\n'); process.stderr.write('#< CLIXML noise'); process.exit(3); }
  if (mode === 'silent') { setInterval(() => {}, 1000); }
  else {
    setTimeout(() => process.stdout.write('@@OPEN\n'), mode === 'slow' ? 200 : 0);
    setTimeout(() => process.stdout.write('READY TEST\r\nSTEP 1/20 base 50\n'), (mode === 'slow' ? 200 : 0) + 20);
    if (mode === 'die') setTimeout(() => process.exit(0), 60);
    if (mode === 'error-after') setTimeout(() => { process.stdout.write('@@ERROR The device is not connected.\n'); process.exit(4); }, 60);
    let buffer = '';
    process.stdin.on('data', chunk => { buffer += chunk; let i; while ((i = buffer.indexOf('\n')) >= 0) { process.stdout.write('GOT ' + buffer.slice(0, i) + '\n'); buffer = buffer.slice(i + 1); } });
    process.stdin.on('end', () => process.exit(0));
  }
}
`;

type Modes = Partial<Record<ArduinoLaunch['kind'], string>>;
function fakeFactory(modes: Modes = {}, launches: ArduinoLaunch[] = []) {
  return (launch: ArduinoLaunch) => {
    launches.push(launch);
    return spawn(process.execPath, ['-e', FAKE, launch.kind, modes[launch.kind] ?? 'ok'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  };
}
function service(t: TestContext, options: ArduinoOptions = {}, modes: Modes = {}) {
  const launches: ArduinoLaunch[] = [];
  const arduino = new ArduinoService({ cli: 'C:/fake/arduino-cli.exe', config: 'C:/fake/arduino-cli.yaml', port: 'COM7', platform: 'win32', processFactory: fakeFactory(modes, launches), ...options });
  t.after(() => arduino.close());
  return { arduino, launches };
}
async function until(read: () => ArduinoStatus, check: (status: ArduinoStatus) => boolean, what: string): Promise<ArduinoStatus> {
  for (let i = 0; i < 400; i++) { const status = read(); if (check(status)) return status; await tick(); }
  assert.fail(`Timed out waiting for ${what}: ${JSON.stringify(read())}`);
}
const texts = (status: ArduinoStatus, source?: string) => status.lines.filter(l => !source || l.source === source).map(l => l.text);

test('board list parsing finds the boards of the configured type in both arduino-cli layouts', () => {
  const v1 = JSON.stringify({ detected_ports: [
    { port: { address: 'COM3' }, matching_boards: [] },
    { port: { address: 'COM14' }, matching_boards: [{ name: 'Arduino Uno', fqbn: 'arduino:avr:uno' }] },
    { port: { address: 'COM15' }, matching_boards: [{ name: 'Arduino Nano', fqbn: 'arduino:avr:nano' }] },
  ] });
  assert.deepEqual(portsFromBoardList(v1, 'arduino:avr:uno'), ['COM14']);
  const v0 = JSON.stringify([{ address: 'COM5', boards: [{ fqbn: 'arduino:avr:uno' }] }]);
  assert.deepEqual(portsFromBoardList(v0, 'arduino:avr:uno'), ['COM5']);
  assert.deepEqual(portsFromBoardList('not json', 'arduino:avr:uno'), []);
});

test('arduino-cli is found on PATH first, then inside an Arduino IDE 2 install', () => {
  const sep = process.platform === 'win32' ? ';' : ':';
  const name = process.platform === 'win32' ? 'arduino-cli.exe' : 'arduino-cli';
  assert.equal(findArduinoCli({ PATH: ['/a', '/b'].join(sep) }, path => path === join('/b', name)), join('/b', name));
  if (process.platform === 'win32') {
    const ide = join('C:/Users/me/AppData/Local', 'Programs', 'Arduino IDE', 'resources', 'app', 'lib', 'backend', 'resources', name);
    assert.equal(findArduinoCli({ PATH: '', LOCALAPPDATA: 'C:/Users/me/AppData/Local' }, path => path === ide), ide);
  }
  assert.equal(findArduinoCli({ PATH: '' }, () => false), undefined);
});

test('the Windows serial bridge holds DTR and RTS low before opening, and reads stdin without blocking', () => {
  const args = windowsSerialBridge('COM14', 115200);
  const script = Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
  const dtr = script.indexOf('$port.DtrEnable = $false'), rts = script.indexOf('$port.RtsEnable = $false'), open = script.indexOf('$port.Open()');
  assert.ok(dtr > 0 && rts > 0 && open > dtr && open > rts, script);
  assert.match(script, /SerialPort 'COM14', 115200/);
  // [Console]::In.ReadLineAsync() is synchronous on Windows PowerShell 5.1 and would stall the serial reads.
  assert.ok(!script.includes('[Console]::In'), 'stdin must be read through the raw stream');
  assert.match(script, /OpenStandardInput\(\)[\s\S]*ReadAsync/);
});

test('upload compiles first, then uploads, then opens the serial connection and relays lines both ways', async t => {
  const { arduino, launches } = service(t);
  const started = await arduino.upload('task-1', 'C:/sketches/Demo');
  assert.equal(started.state, 'uploading');
  assert.equal(started.upload?.phase, 'compiling');
  const done = await until(() => arduino.status(), s => s.serial === 'open' && texts(s, 'serial').includes('STEP 1/20 base 50'), 'serial lines after upload');
  const compile = launches.find(l => l.kind === 'compile')!, upload = launches.find(l => l.kind === 'upload')!;
  assert.equal(compile.command, 'C:/fake/arduino-cli.exe');
  const buildPath = compile.args[compile.args.indexOf('--build-path') + 1];
  assert.deepEqual(compile.args, ['compile', '--fqbn', 'arduino:avr:uno', '--build-path', buildPath, 'C:/sketches/Demo', '--config-file', 'C:/fake/arduino-cli.yaml']);
  assert.deepEqual(upload.args, ['upload', '--fqbn', 'arduino:avr:uno', '--port', 'COM7', '--input-dir', buildPath, 'C:/sketches/Demo', '--config-file', 'C:/fake/arduino-cli.yaml']);
  assert.equal(done.upload?.status, 'succeeded');
  assert.equal(done.state, 'monitoring');
  assert.ok(texts(done, 'upload').includes('Sketch uses 7770 bytes (24%) of program storage space.'));
  assert.ok(texts(done, 'upload').includes('avrdude: writing flash'));
  assert.ok(texts(done, 'serial').includes('READY TEST'), 'carriage returns are stripped');
  assert.equal(launches.find(l => l.kind === 'serial')!.command, 'powershell.exe');
  await arduino.send('x');
  const echoed = await until(() => arduino.status(), s => texts(s, 'serial').includes('GOT x'), 'the sent command');
  assert.ok(texts(echoed, 'sent').includes('x'));
  assert.equal((await arduino.closeSerial()).state, 'idle');
});

test('while connected, the sketch is stopped with x and keeps its connection until the compile has passed', async t => {
  const { arduino, launches } = service(t, {}, { compile: 'hang' });
  await arduino.openSerial();
  await arduino.upload('task-1', 'C:/sketches/Demo');
  await until(() => arduino.status(), () => launches.some(l => l.kind === 'compile'), 'the compile step');
  const compiling = arduino.status();
  assert.equal(compiling.serial, 'open', 'Stop must still reach the board while compiling');
  await arduino.send('x');
  await until(() => arduino.status(), s => texts(s, 'serial').includes('GOT x'), 'x during the compile');
  await arduino.cancelUpload();
  assert.equal(arduino.status().upload?.status, 'cancelled');
  assert.equal(arduino.status().serial, 'open');
});

test('before the upload step the running sketch is sent x, then the port is handed over and reopened', async t => {
  const { arduino, launches } = service(t);
  await arduino.openSerial();
  await arduino.upload('task-1', 'C:/sketches/Demo');
  const done = await until(() => arduino.status(), s => s.upload?.status === 'succeeded' && s.serial === 'open', 'upload then reconnect');
  assert.deepEqual(launches.map(l => l.kind), ['serial', 'compile', 'upload', 'serial']);
  const sent = done.lines.findIndex(l => l.source === 'sent' && l.text === 'x');
  const uploading = done.lines.findIndex(l => l.text.startsWith('Uploading to COM7'));
  assert.ok(sent >= 0 && sent < uploading, 'x goes out before the board is reflashed');
});

test('a failed compile leaves the board and the connection alone; a failed upload is reported', async t => {
  const failing = service(t, {}, { compile: 'fail' });
  await failing.arduino.openSerial();
  await failing.arduino.upload('task-1', 'C:/sketches/Demo');
  const compileFailed = await until(() => failing.arduino.status(), s => s.upload?.status === 'failed', 'the failed compile');
  assert.match(texts(compileFailed, 'error').join('\n'), /Compile failed \(exit code 1\)[\s\S]*not touched/);
  assert.equal(compileFailed.serial, 'open');
  assert.ok(!failing.launches.some(l => l.kind === 'upload'));
  const { arduino, launches } = service(t, {}, { upload: 'fail' });
  await arduino.upload('task-1', 'C:/sketches/Demo');
  const done = await until(() => arduino.status(), s => s.upload?.status === 'failed', 'the failed upload');
  assert.equal(done.state, 'idle');
  assert.match(texts(done, 'error').join('\n'), /Upload failed \(exit code 1\)/);
  await tick(400);
  assert.equal(launches.filter(l => l.kind === 'serial').length, 0);
});

test('a second upload is refused while one runs, and cancel stops it', async t => {
  const { arduino } = service(t, {}, { compile: 'hang' });
  await arduino.upload('task-1', 'C:/sketches/Demo');
  await assert.rejects(arduino.upload('task-1', 'C:/sketches/Demo'), (error: Error & { statusCode?: number }) => error.statusCode === 409);
  await arduino.cancelUpload();
  const done = await until(() => arduino.status(), s => s.upload?.status === 'cancelled', 'the cancelled upload');
  assert.equal(done.state, 'idle');
});

test('concurrent connects share one bridge, and a connect during the auto-reconnect does not orphan a second one', async t => {
  const { arduino, launches } = service(t, {}, { serial: 'slow' });
  const [a, b] = await Promise.all([arduino.openSerial(), arduino.openSerial()]);
  assert.equal(a.serial, 'open');
  assert.equal(b.serial, 'open');
  assert.equal(launches.filter(l => l.kind === 'serial').length, 1);
  await arduino.closeSerial();
  await arduino.upload('task-1', 'C:/sketches/Demo');
  await until(() => arduino.status(), s => s.upload?.status === 'succeeded' && s.serial === 'connecting', 'the auto-reconnect starting');
  const clicked = await arduino.openSerial();
  assert.equal(clicked.serial, 'open');
  assert.equal(launches.filter(l => l.kind === 'serial').length, 2);
});

test('a connection closed while it was still starting leaves a clean closed state', async t => {
  const { arduino, launches } = service(t, {}, { serial: 'slow' });
  const opening = arduino.openSerial();
  await until(() => arduino.status(), () => launches.some(l => l.kind === 'serial'), 'the bridge to start');
  assert.equal(arduino.status().serial, 'connecting');
  await arduino.closeSerial();
  await opening.catch(() => {});
  assert.equal(arduino.status().serial, 'closed');
  assert.equal(arduino.status().state, 'idle');
  await assert.rejects(arduino.send('x'), /Connect to the board first/);
  assert.equal((await arduino.openSerial()).serial, 'open', 'a later connect works');
});

test('a busy port is reported with the reason, and the connection stays closed', async t => {
  const { arduino } = service(t, {}, { serial: 'busy' });
  await assert.rejects(arduino.openSerial(), (error: Error) => /Access to the port COM7 is denied\. Close the Arduino IDE Serial Monitor/.test(error.message) && !error.message.includes('CLIXML'));
  assert.equal(arduino.status().state, 'idle');
});

test('a bridge that never opens times out, and one that fails later says why', async t => {
  const silent = service(t, { openTimeoutMs: 300 }, { serial: 'silent' });
  await assert.rejects(silent.arduino.openSerial(), /did not open within/);
  assert.equal(silent.arduino.status().serial, 'closed');
  const { arduino } = service(t, {}, { serial: 'error-after' });
  await arduino.openSerial();
  const closed = await until(() => arduino.status(), s => s.serial === 'closed', 'the bridge failing');
  assert.match(texts(closed, 'error').join('\n'), /Serial connection error: The device is not connected\.[\s\S]*closed unexpectedly \(exit code 4\)/);
});

test('sending after the bridge died is refused without crashing the service', async t => {
  const { arduino } = service(t, {}, { serial: 'die' });
  await arduino.openSerial();
  await until(() => arduino.status(), s => s.serial === 'closed', 'the bridge exiting');
  await assert.rejects(arduino.send('x'), /Connect to the board first/);
  assert.equal(arduino.status().state, 'idle');
});

test('only short printable lines can be sent, and only while connected', async t => {
  const { arduino } = service(t);
  await assert.rejects(arduino.send('x'), /Connect to the board first/);
  await arduino.openSerial();
  for (const bad of ['', 'x\ny', 'a'.repeat(81), 42, '\u00e9']) await assert.rejects(arduino.send(bad), /printable ASCII/);
  await arduino.send('g');
});

test('closing the service stops an upload in progress and starts nothing afterwards', async t => {
  const { arduino, launches } = service(t, {}, { compile: 'hang' });
  await arduino.upload('task-1', 'C:/sketches/Demo');
  await until(() => arduino.status(), () => launches.some(l => l.kind === 'compile'), 'the compile step');
  await arduino.close();
  const count = launches.length;
  await tick(500);
  assert.equal(launches.length, count);
  assert.equal(arduino.status().upload?.status, 'cancelled');
});

test('without a configured port the single matching board is used, otherwise the user is told why', async t => {
  assert.equal(await service(t, { port: undefined }, { detect: 'one' }).arduino.port(), 'COM7');
  await assert.rejects(service(t, { port: undefined }, { detect: 'none' }).arduino.port(), /No arduino:avr:uno board is connected/);
  await assert.rejects(service(t, { port: undefined }, { detect: 'two' }).arduino.port(), /Found 2 boards[\s\S]*BRIDGE_ARDUINO_PORT/);
  await assert.rejects(service(t, { port: 'COM7 & calc' }).arduino.port(), /not a valid port name/);
});

test('the status reports an instance id that changes with each service', t => {
  const a = service(t).arduino.status(), b = service(t).arduino.status();
  assert.ok(a.instance && b.instance && a.instance !== b.instance);
  assert.equal(a.serial, 'closed');
});

/** Route-level checks: the API compiles only the folder linked to an Arduino task, behind the session. */
async function routes(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'context-bridge-test-'));
  const launches: ArduinoLaunch[] = [];
  const provider = { label: 'Fake' } as unknown as CodexProvider;
  const app = await createApp({ dataDir: join(directory, 'data'), provider, arduino: { cli: 'C:/fake/arduino-cli.exe', config: 'C:/fake/arduino-cli.yaml', port: 'COM7', platform: 'win32', processFactory: fakeFactory({}, launches) } });
  t.after(async () => {
    await app.close();
    assert.equal(dirname(resolve(directory)).toLowerCase(), resolve(tmpdir()).toLowerCase());
    assert.ok(basename(directory).startsWith('context-bridge-test-'));
    await rm(directory, { recursive: true, force: true });
  });
  const first = await app.inject({ method: 'GET', url: '/api/workspace', headers: { host: 'localhost:4173' } });
  const cookie = String(first.headers['set-cookie']).split(';')[0];
  const api = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => app.inject({ method, url, headers: { host: 'localhost:4173', origin, cookie }, ...(payload === undefined ? {} : { payload: payload as object }) });
  return { directory, app, api, launches };
}
async function linkedTask(h: Awaited<ReturnType<typeof routes>>, folder: string, sketch: string, controller: string) {
  const root = join(h.directory, folder);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, sketch), 'void setup() {}\nvoid loop() {}\n');
  const envelope = (await h.api('GET', '/api/workspace')).json() as WorkspaceEnvelope;
  const state = structuredClone(envelope.workspace);
  const task = state.tasks[0];
  task.hardware.controller = controller;
  assert.equal((await h.api('PUT', '/api/workspace', { workspace: state, expectedRevision: envelope.revision })).statusCode, 200);
  const scan = (await h.api('POST', `/api/tasks/${task.id}/project/scan`, { path: root })).json() as ProjectScan;
  const bound = await h.api('POST', `/api/tasks/${task.id}/project/bind`, { rootId: scan.rootId, paths: [sketch] });
  assert.equal(bound.statusCode, 200, bound.body);
  return { taskId: task.id, root: (bound.json() as WorkspaceEnvelope).workspace.tasks[0].rootPath! };
}

test('upload route compiles exactly the linked sketch folder of an Arduino task', async t => {
  const h = await routes(t);
  const { taskId, root } = await linkedTask(h, 'Demo', 'Demo.ino', 'Arduino Uno');
  const response = await h.api('POST', '/api/arduino/upload', { taskId });
  assert.equal(response.statusCode, 202, response.body);
  for (let i = 0; i < 300 && !h.launches.some(l => l.kind === 'compile'); i++) await tick();
  const compile = h.launches.find(l => l.kind === 'compile')!;
  assert.equal(compile.args[compile.args.indexOf('--config-file') - 1], root);
  assert.equal((await h.api('GET', '/api/arduino/status')).statusCode, 200);
  const send = await h.api('POST', '/api/arduino/serial/send', { text: 'x' });
  assert.equal(send.statusCode, 409, 'not connected yet');
});

test('upload route refuses non-Arduino tasks, folders without a matching .ino, and requests without a session', async t => {
  const h = await routes(t);
  const other = await linkedTask(h, 'Esp', 'Esp.ino', 'ESP32');
  const refused = await h.api('POST', '/api/arduino/upload', { taskId: other.taskId });
  assert.equal(refused.statusCode, 400);
  assert.match(refused.body, /controller is an Arduino board/);
  const h2 = await routes(t);
  const mismatch = await linkedTask(h2, 'Folder', 'Other.ino', 'Arduino Uno');
  const wrongName = await h2.api('POST', '/api/arduino/upload', { taskId: mismatch.taskId });
  assert.equal(wrongName.statusCode, 400);
  assert.match(wrongName.body, /needs Folder\.ino/);
  const anonymous = await h2.app.inject({ method: 'POST', url: '/api/arduino/serial/send', headers: { host: 'localhost:4173', origin }, payload: { text: 'x' } });
  assert.equal(anonymous.statusCode, 401);
  assert.equal([...h.launches, ...h2.launches].filter(l => l.kind === 'compile' || l.kind === 'upload').length, 0);
});

test('the events stream starts with the current status and closes when the service stops', async t => {
  const h = await routes(t);
  await h.app.listen({ host: '127.0.0.1', port: 0 });
  const address = h.app.server.address() as { port: number };
  const first = await fetch(`http://localhost:${address.port}/api/workspace`);
  const cookie = String(first.headers.get('set-cookie')).split(';')[0];
  const response = await fetch(`http://localhost:${address.port}/api/arduino/events`, { headers: { cookie } });
  assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const reader = response.body!.getReader();
  const chunk = new TextDecoder().decode((await reader.read()).value);
  assert.match(chunk, /^event: status\ndata: \{"type":"status","status":\{"available":true/);
  const closing = h.app.close();
  for (;;) { const { done } = await reader.read(); if (done) break; }
  await closing;
});

test('the client parses the Arduino event stream across chunk boundaries and merges lines without duplicates', async () => {
  const { parseEvents, mergeLines } = await import('../src/lib/arduino.ts');
  const line = (seq: number, text: string) => ({ seq, at: '2026-11-10T00:00:00.000Z', source: 'serial' as const, text });
  const frame = (event: unknown) => `event: x\r\ndata: ${JSON.stringify(event)}\r\n\r\n`;
  const whole = frame({ type: 'line', line: line(1, 'READY') }) + ': heartbeat\n\n' + frame({ type: 'line', line: line(2, 'STEP 1/20') });
  const first = parseEvents(whole.slice(0, 30));
  assert.equal(first.events.length, 0);
  const second = parseEvents(first.rest + whole.slice(30));
  assert.deepEqual(second.events.map(e => e.type === 'line' && e.line.text), ['READY', 'STEP 1/20']);
  assert.equal(second.rest, '');
  const merged = mergeLines([line(1, 'READY'), line(2, 'STEP 1/20')], [line(2, 'STEP 1/20'), line(3, 'DONE')]);
  assert.deepEqual(merged.map(l => l.seq), [1, 2, 3]);
  assert.equal(mergeLines(Array.from({ length: 450 }, (_, i) => line(i, 'x')), []).length, 450, 'no work when nothing arrives');
  assert.equal(mergeLines([], Array.from({ length: 450 }, (_, i) => line(i, 'x'))).length, 400);
});

test('tool output is decoded as UTF-8, or in the legacy code page of the system language', async () => {
  const { decodeOutput, legacyEncoding } = await import('../server/arduino.ts');
  assert.equal(decodeOutput(Buffer.from('Sketch uses 7714 bytes', 'utf8')), 'Sketch uses 7714 bytes');
  assert.equal(decodeOutput(Buffer.from('端口不存在', 'utf8')), '端口不存在');
  assert.equal(legacyEncoding('zh-CN'), 'gb18030');
  assert.equal(legacyEncoding('zh-TW'), 'big5');
  assert.equal(legacyEncoding('ja-JP'), 'shift_jis');
  assert.equal(legacyEncoding('en-US'), 'windows-1252');
  if (legacyEncoding() === 'gb18030') {
    // avrdude on a Chinese Windows: "系统找不到指定的文件。" in GBK
    const gbk = Buffer.from('cfb5cdb3d5d2b2bbb5bdd6b8b6a8b5c4cec4bcfea1a3', 'hex');
    assert.equal(decodeOutput(gbk), '系统找不到指定的文件。');
  }
});

test('upload lines keep multi-byte characters that arrive split across chunks', async t => {
  const SPLIT = String.raw`
const bytes = Buffer.from('端口 COM99 不存在\n', 'utf8');
process.stdout.write(bytes.subarray(0, 4));
setTimeout(() => { process.stdout.write(bytes.subarray(4)); setTimeout(() => process.exit(1), 20); }, 30);
`;
  const arduino = new ArduinoService({ cli: 'C:/fake/arduino-cli.exe', config: 'C:/fake/cfg.yaml', port: 'COM7', platform: 'win32',
    processFactory: () => spawn(process.execPath, ['-e', SPLIT], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }) });
  t.after(() => arduino.close());
  await arduino.upload('task-1', 'C:/sketches/Demo');
  const done = await until(() => arduino.status(), s => s.upload?.status === 'failed', 'the failed compile');
  assert.ok(texts(done, 'upload').includes('端口 COM99 不存在'), JSON.stringify(texts(done, 'upload')));
});
