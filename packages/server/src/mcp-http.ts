import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createGameMcpServer, type GameApi } from './mcp-tools.js';

type RpcId = string | number;
interface PendingWait { controller: AbortController; key: string }

/** Cancellation is scoped to a credential and a pending wait, never a game command. */
export class McpWaitCancellation {
  private readonly pending = new Map<string, PendingWait>();
  private key(scope: string, id: RpcId): string { return JSON.stringify([scope, typeof id, id]); }
  add(scope: string, id: RpcId): PendingWait | null {
    const key = this.key(scope, id);
    if (this.pending.has(key)) return null;
    const entry = { key, controller: new AbortController() };
    this.pending.set(key, entry);
    return entry;
  }
  cancel(scope: string, id: RpcId): void { this.pending.get(this.key(scope, id))?.controller.abort(); }
  remove(entry: PendingWait): void { if (this.pending.get(entry.key) === entry) this.pending.delete(entry.key); }
  close(): void { for (const entry of this.pending.values()) entry.controller.abort(); this.pending.clear(); }
}

/** Each POST owns its transport; game credentials are never cached in a session. */
export async function handleGameMcp(req: IncomingMessage, res: ServerResponse, api: GameApi, waits: McpWaitCancellation, scope: string): Promise<void> {
  const context: { pending: PendingWait | null } = { pending: null };
  const server = createGameMcpServer((path, method, body, signal) => api(path, method, body,
    context.pending && /\/wait\?/u.test(path) ? AbortSignal.any([context.pending.controller.signal, ...(signal ? [signal] : [])]) : signal));
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    maxRequestBodySize: 65_536
  });
  let closing: Promise<void> | undefined;
  const close = () => closing ??= Promise.allSettled([transport.close(), server.close()]).then(() => {});
  res.once('close', () => { void close(); });
  try {
    await server.connect(transport);
    const onmessage = transport.onmessage;
    transport.onmessage = (message, extra) => {
      if ('method' in message && message.method === 'notifications/cancelled') {
        const id = message.params?.requestId;
        if (typeof id === 'number' || typeof id === 'string') waits.cancel(scope, id);
      }
      if ('method' in message && 'id' in message && message.method === 'tools/call' && message.params?.name === 'tablemesh_wait_for_turn') {
        context.pending = waits.add(scope, message.id);
        if (!context.pending) {
          void transport.send({ jsonrpc: '2.0', id: message.id, error: { code: -32600, message: 'This credential already has a pending wait with the same request id' } });
          return;
        }
      }
      onmessage?.(message, extra);
    };
    await transport.handleRequest(req, res);
  } finally {
    if (context.pending) { context.pending.controller.abort(); waits.remove(context.pending); }
    await close();
  }
}
