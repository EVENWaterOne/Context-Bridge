/**
 * A scripted local stand-in for the OpenAI Responses API, so the real Codex binary can run a turn
 * with no account and no network. Each POST /v1/responses is answered with the step whose index is
 * the number of tool outputs already in the request (request 1 gets step 0, the request carrying
 * the first tool output gets step 1, and so on). The SSE shape matches what Codex 0.164.0 accepts.
 */
import { createServer, type IncomingMessage } from 'node:http';
import zlib from 'node:zlib';

export type Step = { shell: string; yieldMs?: number } | { patch: string } | { message: string };
export interface MockRequest { url: string; method: string; body: Record<string, unknown> | null }
type Json = Record<string, unknown>;

function decode(buffer: Buffer, encoding: string | undefined): Buffer {
  if (!encoding || encoding === 'identity') return buffer;
  if (encoding === 'gzip') return zlib.gunzipSync(buffer);
  if (encoding === 'br') return zlib.brotliDecompressSync(buffer);
  if (encoding === 'deflate') return zlib.inflateSync(buffer);
  if (encoding === 'zstd' && 'zstdDecompressSync' in zlib) return (zlib as unknown as { zstdDecompressSync: (b: Buffer) => Buffer }).zstdDecompressSync(buffer);
  throw new Error(`Unsupported content encoding ${encoding}`);
}
async function read(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

export async function startResponsesMock(steps: Step[]) {
  const requests: MockRequest[] = [];
  let sequence = 0;
  const server = createServer(async (request, response) => {
    let body: Json | null = null;
    try { const raw = decode(await read(request), request.headers['content-encoding'] as string | undefined); body = raw.length ? JSON.parse(raw.toString('utf8')) : null; } catch { body = null; }
    requests.push({ url: request.url ?? '', method: request.method ?? '', body });
    const path = (request.url ?? '').split('?')[0];
    if (request.method === 'GET' && path.endsWith('/models')) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ object: 'list', data: [] })); return; }
    if (request.method !== 'POST' || !path.endsWith('/responses')) { response.writeHead(404, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'not found' } })); return; }
    const n = ++sequence;
    const input = Array.isArray(body?.input) ? body!.input as Json[] : [];
    const outputs = input.filter(item => item.type === 'function_call_output' || item.type === 'custom_tool_call_output').length;
    const step = steps[Math.min(outputs, steps.length - 1)];
    const tools = Array.isArray(body?.tools) ? body!.tools as Json[] : [];
    const callId = `call_mock_${n}`;
    let item: Json;
    if ('shell' in step) item = { type: 'function_call', name: 'exec_command', call_id: callId, arguments: JSON.stringify({ cmd: step.shell, yield_time_ms: step.yieldMs ?? 20_000 }) };
    else if ('patch' in step) {
      const tool = tools.find(entry => entry.name === 'apply_patch');
      item = tool?.type === 'custom' ? { type: 'custom_tool_call', name: 'apply_patch', call_id: callId, input: step.patch, status: 'completed' } : { type: 'function_call', name: 'apply_patch', call_id: callId, arguments: JSON.stringify({ input: step.patch }) };
    } else item = { type: 'message', role: 'assistant', id: `msg_mock_${n}`, status: 'completed', phase: 'final_answer', content: [{ type: 'output_text', text: step.message, annotations: [] }] };
    const id = `resp_mock_${n}`;
    const send = (event: Json) => response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    send({ type: 'response.created', response: { id, status: 'in_progress' } });
    send({ type: 'response.output_item.added', output_index: 0, item });
    if ('message' in step) send({ type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: item.id, delta: step.message });
    send({ type: 'response.output_item.done', output_index: 0, item });
    send({ type: 'response.completed', response: { id, status: 'completed', usage: { input_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 15 } } });
    response.end();
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = (server.address() as { port: number }).port;
  return { port, requests, close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

/** The tool outputs Codex sent back to the model, in order. */
export function toolOutputs(requests: MockRequest[]): string[] {
  const last = [...requests].reverse().find(request => Array.isArray(request.body?.input));
  return ((last?.body?.input ?? []) as Json[]).filter(item => item.type === 'function_call_output' || item.type === 'custom_tool_call_output').map(item => typeof item.output === 'string' ? item.output : JSON.stringify(item.output));
}
