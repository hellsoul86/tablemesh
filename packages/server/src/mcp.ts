import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createGameMcpServer, type GameApi } from './mcp-tools.js';

const token = process.env.TABLEMESH_TOKEN;
let endpoint: URL;
try { endpoint = new URL(process.env.TABLEMESH_URL || 'http://127.0.0.1:4100'); }
catch { console.error('Tokem 服务地址无效。'); process.exit(1); }
if (!token || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !['http:', 'https:'].includes(endpoint.protocol)
  || (endpoint.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname))) {
  console.error('Tokem MCP 需要游戏 token，以及 HTTPS 或本机服务地址。');
  process.exit(1);
}

const api: GameApi = async (path, method = 'GET', body, signal) => {
  try {
    const response = await fetch(new URL('/api' + path, endpoint), {
      method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(path.includes('/wait?') ? 30_000 : 10_000)]) : AbortSignal.timeout(path.includes('/wait?') ? 30_000 : 10_000), redirect: 'error'
    });
    const result = await response.json() as Awaited<ReturnType<GameApi>>;
    if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') throw new Error('Invalid response');
    return result;
  } catch {
    return { ok: false, error: { code: 'INTERNAL', message: 'Tokem 暂时无法连接。先读取最新状态，再决定是否重试提交。' } };
  }
};

const server = createGameMcpServer(api, { ...(process.env.TABLEMESH_REWARDS_URL ? { rewardsUrl: process.env.TABLEMESH_REWARDS_URL } : {}) });
await server.connect(new StdioServerTransport());
