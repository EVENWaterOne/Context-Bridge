import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalCodexProvider } from '../server/codex.ts';
import { ClaudeProvider } from '../server/claude.ts';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = resolve(process.env.BRIDGE_DATA_DIR ?? resolve(root, '.data'));
const codex = new LocalCodexProvider({ dataDir });
const claude = new ClaudeProvider({ dataDir, environmentApiKey: process.env.ANTHROPIC_API_KEY?.trim() || undefined, allowLocalLogin: process.env.BRIDGE_CLAUDE_LOCAL_LOGIN === '1' });
try {
  // Status only starts each process and reads its account state; neither calls a model.
  const [codexStatus, claudeStatus] = await Promise.all([codex.status(), claude.status()]);
  process.stdout.write(JSON.stringify({ node: process.version, codex: codexStatus, claude: claudeStatus }, null, 2) + '\n');
  if (!codexStatus.available || !claudeStatus.available) process.exitCode = 1;
} finally { await Promise.all([codex.close(), claude.close()]); }
