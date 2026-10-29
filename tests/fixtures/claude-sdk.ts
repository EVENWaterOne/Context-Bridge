/** Test-only stand-in for the Claude Agent SDK query(). No process, network or credentials. */
import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';

type QueryFn = typeof import('@anthropic-ai/claude-agent-sdk')['query'];
export interface FakeCall { prompt: unknown; options: Options; closed: boolean; probe: boolean }
export type Script = (call: FakeCall) => AsyncIterable<SDKMessage> | Iterable<SDKMessage>;
export interface FakeInit { account?: Record<string, unknown>; models?: { value: string; displayName: string; description?: string }[]; claude_code_version?: string }

export const DEFAULT_INIT: FakeInit = {
  account: { subscriptionType: 'Claude API', apiProvider: 'firstParty' },
  models: [{ value: 'default', displayName: 'Default (recommended)' }, { value: 'sonnet', displayName: 'Sonnet' }, { value: 'opus', displayName: 'Opus' }],
  claude_code_version: '2.1.312',
};

const base = { uuid: '00000000-0000-4000-8000-000000000000', session_id: 'fake-session' };
export const message = {
  init: (tools: string[] = [], extra: Record<string, unknown> = {}) => ({ ...base, type: 'system', subtype: 'init', tools, mcp_servers: [], permissionMode: 'dontAsk', model: 'claude-test', apiKeySource: 'ANTHROPIC_API_KEY', claude_code_version: '2.1.312', cwd: '', slash_commands: [], output_style: 'default', skills: [], plugins: [], ...extra }) as unknown as SDKMessage,
  text: (text: string, parent: string | null = null) => ({ ...base, type: 'stream_event', parent_tool_use_id: parent, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } }) as unknown as SDKMessage,
  toolStart: (name = 'StructuredOutput') => ({ ...base, type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name, input: {} } } }) as unknown as SDKMessage,
  toolUse: (name: string, input: unknown = {}) => ({ ...base, type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'toolu_1', name, input }] } }) as unknown as SDKMessage,
  apiError: (error: string) => ({ ...base, type: 'assistant', parent_tool_use_id: null, error, message: { content: [{ type: 'text', text: 'API Error' }] } }) as unknown as SDKMessage,
  retry: (error: string, attempt = 1) => ({ ...base, type: 'system', subtype: 'api_retry', attempt, max_retries: 10, retry_delay_ms: 1000, error_status: 401, error }) as unknown as SDKMessage,
  result: (result: string, extra: Record<string, unknown> = {}) => ({ ...base, type: 'result', subtype: 'success', is_error: false, result, duration_ms: 1, duration_api_ms: 1, num_turns: 1, stop_reason: 'end_turn', total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [], ...extra }) as unknown as SDKMessage,
  refusalFallback: () => ({ ...base, type: 'system', subtype: 'model_refusal_fallback', trigger: 'refusal', original_model: 'claude-chosen', fallback_model: 'claude-older', content: 'Retrying with another model' }) as unknown as SDKMessage,
  failure: (subtype: string, errors: string[]) => ({ ...base, type: 'result', subtype, is_error: true, errors, duration_ms: 1, duration_api_ms: 1, num_turns: 1, stop_reason: null, total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [] }) as unknown as SDKMessage,
};

/** Resolves when the run's AbortController fires, like the real SDK ending its stream. */
export function aborted(call: FakeCall): Promise<never> {
  return new Promise((_resolve, reject) => {
    const signal = call.options.abortController?.signal;
    const fail = () => { const error = new Error('Claude Code process aborted by user'); error.name = 'AbortError'; reject(error); };
    if (!signal || signal.aborted) fail(); else signal.addEventListener('abort', fail, { once: true });
  });
}

export function fakeSdk(script: Script = () => [message.init(), message.text('Hello'), message.result('Hello')], init: FakeInit | (() => FakeInit) = DEFAULT_INIT) {
  const calls: FakeCall[] = [];
  const query = ((params: { prompt: unknown; options?: Options }) => {
    const call: FakeCall = { prompt: params.prompt, options: params.options ?? {}, closed: false, probe: typeof params.prompt !== 'string' };
    calls.push(call);
    let iterator: AsyncIterator<SDKMessage> | Iterator<SDKMessage> | undefined;
    const source = () => {
      if (!iterator) {
        const value = script(call);
        iterator = Symbol.asyncIterator in value ? value[Symbol.asyncIterator]() : value[Symbol.iterator]();
      }
      return iterator;
    };
    const session = {
      async next() {
        if (call.closed) return { done: true, value: undefined };
        if (call.options.abortController?.signal.aborted) await aborted(call);
        return source().next();
      },
      async return() { call.closed = true; return { done: true, value: undefined }; },
      async throw(error: unknown) { call.closed = true; throw error; },
      [Symbol.asyncIterator]() { return this; },
      async initializationResult() { return typeof init === 'function' ? init() : init; },
      close() { call.closed = true; },
    };
    return session as unknown as Query;
  }) as unknown as QueryFn;
  return { query, calls, runs: () => calls.filter(call => !call.probe) };
}
