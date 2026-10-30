import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { CodexProvider } from './provider.ts';
import type { ProviderId } from '../src/lib/backend-types.ts';
import { ProviderSwitch, isProviderId, type ProviderFactory } from './providers.ts';
import { ClaudeProvider } from './claude.ts';
import { Store } from './store.ts';
import { FileService } from './files.ts';
import { Jobs } from './jobs.ts';
import { BridgeError, conflict, invalid, missing } from './errors.ts';

export interface AppOptions {
  dataDir: string;
  /** Test seam: a fixed Codex provider. */
  provider?: CodexProvider;
  /** Test seam: fixed providers by ID; only these can be selected. */
  providers?: Partial<Record<ProviderId, CodexProvider>>;
  /** Provider used until the user chooses one in the workbench (BRIDGE_PROVIDER). Codex if unset. */
  defaultProvider?: ProviderId;
  /** Claude Code options from the service environment. */
  claude?: { apiKey?: string; allowLocalLogin?: boolean };
  staticDir?: string;
  fileFault?: (phase: 'after-write', index: number) => void;
  timeoutMs?: number;
}
export async function createApp(options: AppOptions) {
  const dataDir = resolve(options.dataDir);
  mkdirSync(dataDir, { recursive: true });
  const store = new Store(dataDir), files = new FileService(store, options.fileFault);
  files.recover();
  const fixed = options.providers ?? (options.provider ? { codex: options.provider } : undefined);
  const factories: Partial<Record<ProviderId, ProviderFactory>> = fixed
    ? Object.fromEntries(Object.entries(fixed).map(([id, instance]) => [id, () => instance]))
    : {
      codex: async () => new (await import('./codex.ts')).LocalCodexProvider({ dataDir }),
      claude: () => new ClaudeProvider({ dataDir, environmentApiKey: options.claude?.apiKey, allowLocalLogin: options.claude?.allowLocalLogin }),
    };
  const saved = store.preference('provider');
  const provider = new ProviderSwitch(factories, isProviderId(saved) ? saved : options.defaultProvider ?? 'codex');
  const jobs = new Jobs(store, files, provider, dataDir, options.timeoutMs);
  const app = Fastify({ bodyLimit: 16 * 1024 * 1024, logger: false });
  const session = randomBytes(32).toString('hex');
  app.decorate('bridge', { store, files, jobs, provider });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'no-referrer').header('X-Frame-Options', 'DENY');
    const host = request.headers.host ?? '';
    if (!/^(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(host)) throw new BridgeError(403, 'LOCAL_ONLY', 'Use the localhost address printed by the local service.');
    const rawPath = request.url.split('?')[0];
    let decodedPath: string;
    try { decodedPath = decodeURIComponent(rawPath); } catch { throw invalid('Malformed URL path.'); }
    const apiRoute = request.routeOptions.url?.startsWith('/api/') || decodedPath.startsWith('/api/') || rawPath.startsWith('/api/');
    if (!apiRoute) return;
    // The router decodes URL segments before matching. Guard the matched route,
    // not just the raw prefix, and reject API aliases that could skip checks.
    if (rawPath !== decodedPath || rawPath.includes('//') || rawPath.includes('\\')) throw new BridgeError(403, 'NON_CANONICAL_PATH', 'Use the canonical local API path.');
    reply.header('Cache-Control', 'no-store');
    const origin = request.headers.origin;
    if ((origin && origin !== `http://${host}`) || request.headers['sec-fetch-site'] === 'cross-site') throw new BridgeError(403, 'ORIGIN_REJECTED', 'Only this local workbench can access its API.');
    const bootstrap = request.method === 'GET' && (request.url === '/api/workspace' || request.url === '/api/status');
    // Cookies are host-scoped, not port-scoped. Development, production and
    // isolated fixtures can run together without overwriting each other's session.
    const cookieName = `bridge_session_${host.replace(/[^a-zA-Z0-9]/g, '_')}`;
    const cookies = (request.headers.cookie ?? '').split(';').map(v => v.trim());
    if (!bootstrap && !cookies.includes(`${cookieName}=${session}`)) throw new BridgeError(401, 'SESSION_REQUIRED', 'Open the local workbench to establish a session.');
    if (!['GET','HEAD'].includes(request.method) && origin !== `http://${host}`) throw new BridgeError(403, 'ORIGIN_REQUIRED', 'A same-origin request is required.');
    if (bootstrap) reply.header('Set-Cookie', `${cookieName}=${session}; HttpOnly; SameSite=Strict; Path=/`);
  });
  app.setErrorHandler((error, _request, reply) => {
    const cause = error as Error & { code?: string; statusCode?: number };
    const bridge = cause instanceof BridgeError;
    const fsError = typeof cause.code === 'string' && /^(ENOENT|ENOTDIR|EACCES|EPERM|EISDIR)$/.test(cause.code);
    const status = bridge ? cause.statusCode : fsError ? 400 : cause.statusCode && cause.statusCode < 500 ? cause.statusCode : 500;
    if (status === 500) process.stderr.write(`[bridge] API failure (${cause.name || 'Error'}). Workspace and file-operation backups are retained.\n`);
    reply.code(status).send({ error: { code: bridge ? cause.code : fsError ? 'FILE_UNAVAILABLE' : status === 500 ? 'INTERNAL_ERROR' : 'INVALID_REQUEST', message: bridge ? cause.message : fsError ? 'The selected file or folder is missing, inaccessible, or no longer a regular project path.' : status === 500 ? 'The local service could not complete this request. Retry or inspect the local log.' : cause.message } });
  });
  const body = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('A JSON object is required.');
    return value as Record<string, unknown>;
  };
  const str = (value: unknown, name: string, max = 500): string => { if (typeof value !== 'string' || !value.trim() || value.length > max) throw invalid(`${name} is required.`); return value; };
  const params = (value: unknown) => value as Record<string, string>;
  /** The provider the page showed when the user sent the request. Pages from before Claude Code support only knew Codex. */
  const expected = (value: unknown): ProviderId => {
    if (value === undefined) return 'codex';
    if (!isProviderId(value)) throw invalid('Choose an available AI provider.');
    return value;
  };
  app.get('/api/workspace', async () => store.envelope());
  app.put('/api/workspace', async request => {
    const b = body(request.body);
    if (!Number.isInteger(b.expectedRevision)) throw invalid('expectedRevision is required.');
    return store.save(b.workspace, b.expectedRevision as number);
  });
  app.post('/api/workspace/import', async request => {
    const b = body(request.body);
    return store.import({ ...b, sourceId: str(b.sourceId, 'sourceId', 300) } as Parameters<Store['import']>[0]);
  });
  const serviceStatus = async () => ({ mode: 'local', version: '2.0.0', provider: provider.active, providers: provider.ids, agent: await provider.status(), recovery: store.operations().filter(o => o.state === 'recovery_required').map(o => ({ operationId: o.id, message: o.error })) });
  app.get('/api/status', serviceStatus);
  app.post('/api/agent/provider', async request => {
    const b = body(request.body);
    if (jobs.controllers.size) throw conflict(`${provider.label} is working. Stop or finish the current request before switching providers.`);
    // Saved before switching, so a failed write never leaves the service on an unsaved choice.
    const id = provider.check(b.provider);
    store.setPreference('provider', id);
    provider.select(id);
    return serviceStatus();
  });
  app.post('/api/codex/login', async () => (await provider.provider('codex')).login());
  const claude = async () => {
    const instance = await provider.provider('claude');
    if (!(instance instanceof ClaudeProvider)) throw invalid('Claude Code settings are not available in this service.');
    return instance;
  };
  app.put('/api/claude/api-key', async request => { (await claude()).saveApiKey(body(request.body).apiKey); return serviceStatus(); });
  app.delete('/api/claude/api-key', async () => { (await claude()).removeApiKey(); return serviceStatus(); });
  app.put('/api/claude/auth-method', async request => { (await claude()).setAuthMethod(body(request.body).method); return serviceStatus(); });
  app.get('/api/tasks/:id/messages', async request => store.messages(params(request.params).id));
  app.post('/api/tasks/:id/project/scan', async request => files.scan(params(request.params).id, str(body(request.body).path, 'An absolute project folder', 4096)));
  app.post('/api/tasks/:id/project/bind', async request => {
    const b = body(request.body);
    if (!Array.isArray(b.paths) || b.paths.some(p => typeof p !== 'string')) throw invalid('Choose source file paths.');
    return files.bind(params(request.params).id, str(b.rootId, 'rootId'), b.paths as string[]);
  });
  app.post('/api/tasks/:id/project/refresh', async request => files.refresh(params(request.params).id));
  app.post('/api/agent/investigate', async (request, reply) => {
    const b = body(request.body);
    return reply.code(202).send(jobs.start('investigate', str(b.taskId,'taskId'), str(b.roundId,'roundId'), undefined, b.model === undefined ? undefined : str(b.model,'model'), expected(b.provider)));
  });
  app.post('/api/agent/chat', async (request, reply) => {
    const b = body(request.body);
    return reply.code(202).send(jobs.start('chat', str(b.taskId,'taskId'), undefined, str(b.message,'message',20000), b.model === undefined ? undefined : str(b.model,'model'), expected(b.provider)));
  });
  app.get('/api/jobs/:id', async request => store.job(params(request.params).id));
  app.post('/api/jobs/:id/cancel', async request => jobs.cancel(params(request.params).id));
  app.get('/api/jobs/:id/events', async (request, reply) => {
    const id = params(request.params).id;
    const initial = store.job(id);
    reply.hijack();
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options':'nosniff' });
    const send = (job: typeof initial) => {
      if (reply.raw.destroyed || reply.raw.writableEnded) return;
      reply.raw.write(`event: job\ndata: ${JSON.stringify(job)}\n\n`);
      if (job.status !== 'running') { cleanup(); reply.raw.end(); }
    };
    const cleanup = () => { clearInterval(heartbeat); jobs.events.off(id, send); };
    const heartbeat = setInterval(() => { if (!reply.raw.destroyed) reply.raw.write(': heartbeat\n\n'); }, 15000);
    heartbeat.unref();
    jobs.events.on(id, send);
    reply.raw.on('close', cleanup);
    send(initial);
  });
  app.post('/api/agent/apply', async request => {
    const b = body(request.body);
    return files.apply(str(b.taskId,'taskId'), str(b.roundId,'roundId'), str(b.suggestionId,'suggestionId'), str(b.idempotencyKey,'idempotencyKey',300));
  });
  app.post('/api/operations/:id/undo', async request => files.undo(params(request.params).id, str(body(request.body).idempotencyKey,'idempotencyKey',300)));
  const staticDir = options.staticDir && resolve(options.staticDir);
  if (staticDir && existsSync(join(staticDir, 'index.html'))) {
    await app.register(fastifyStatic, { root: staticDir, wildcard: false });
    app.get('/*', async (request, reply) => {
      if (request.url.startsWith('/api/')) throw missing('API route not found.');
      return reply.sendFile('index.html');
    });
  } else {
    app.get('/', async (_request, reply) => reply.type('text/plain').send('Context Bridge API is running. Use npm run dev for the development workbench, or npm run build then npm start.'));
  }
  // Interrupt jobs before draining HTTP connections so an open SSE response
  // cannot hold shutdown open until the model timeout.
  app.addHook('preClose', async () => { await jobs.close(); });
  app.addHook('onClose', async () => { store.close(); });
  return app as typeof app & { bridge: { store: Store; files: FileService; jobs: Jobs; provider: ProviderSwitch } };
}
