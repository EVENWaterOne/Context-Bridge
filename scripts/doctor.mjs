import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalCodexProvider } from '../server/codex.ts';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const provider = new LocalCodexProvider({ dataDir: resolve(process.env.BRIDGE_DATA_DIR ?? resolve(root, '.data')) });
try {
  const status = await provider.status();
  process.stdout.write(JSON.stringify({ node: process.version, codex: status }, null, 2) + '\n');
  if (!status.available) process.exitCode = 1;
} finally { await provider.close(); }
