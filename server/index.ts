import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.BRIDGE_PORT ?? 4173);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('BRIDGE_PORT must be an integer between 1024 and 65535.');
const app = await createApp({ dataDir: resolve(process.env.BRIDGE_DATA_DIR ?? resolve(root, '.data')), staticDir: resolve(root, 'dist') });
await app.listen({ host: '127.0.0.1', port });
process.stdout.write(`Context Bridge: http://localhost:${port}\nLocal files and Codex credentials stay in the local data directory.\n`);
let stopping = false;
const stop = async () => { if (stopping) return; stopping = true; await app.close(); };
process.once('SIGINT', () => { void stop(); });
process.once('SIGTERM', () => { void stop(); });
