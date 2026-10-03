import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fixture, twoPlayerRoom } from '../packages/server/test/helpers.mjs';
import { startFakeProvider } from '../packages/server/test/support/fake-provider.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const pluginRoot = fileURLToPath(new URL('../plugins/tablemesh/', import.meta.url));
const read = name => JSON.parse(readFileSync(new URL('../plugins/tablemesh/' + name, import.meta.url), 'utf8'));
const portable = read('plugin.json'); const legacy = read('.codex-plugin/plugin.json');
assert.equal(portable.name, 'tablemesh');
assert.equal(portable.version, legacy.version);
assert.equal(legacy.skills, './skills/');
assert.equal(legacy.mcpServers, './.mcp.json');
assert.match(readFileSync(new URL('../plugins/tablemesh/skills/play/SKILL.md', import.meta.url), 'utf8'), /legalActions/);
const config = read('mcp.json').mcpServers.tablemesh;
assert.equal(config.type, 'stdio');
assert.equal(config.command, 'node');
assert.deepEqual(config.args, read('.mcp.json').mcpServers.tablemesh.args);
assert.equal(/\/Users\/|\/home\/|CLAUDE_PLUGIN_ROOT/.test(JSON.stringify(config)), false);
const args = config.args.map(arg => arg.replaceAll('${PLUGIN_ROOT}', pluginRoot.replace(/\/$/, '')));
assert.equal(args.some(arg => /\$\{/.test(arg)), false);
const f = await fixture();
const model = await startFakeProvider();
let client;
try {
  const room = await twoPlayerRoom(f);
  const minted = await room.a.request('/auth/tokens', { label: 'plugin validation' });
  const transport = new StdioClientTransport({ command: process.execPath, args, cwd: tmpdir(), env: {
    PATH: process.env.PATH || '', TABLEMESH_URL: f.url, TABLEMESH_TOKEN: minted.body.data.token, TABLEMESH_REPO_ROOT: root
  }, stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += chunk.toString(); });
  client = new Client({ name: 'tablemesh-plugin-check', version: '0.1.0' });
  await client.connect(transport);
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 12);
  assert.equal(tools.tools.some(tool => /reward|secret|admin|inventory/i.test(tool.name)), false);
  for (const tool of tools.tools) assert.equal(tool.annotations?.idempotentHint, true);
  assert.equal(tools.tools.find(tool => tool.name === 'tablemesh_autoplay_control').annotations.openWorldHint, true);
  const call = async (name, arguments_ = {}) => {
    const response = await client.callTool({ name, arguments: arguments_ });
    assert.ok(response.structuredContent);
    assert.equal(response.content[0].type, 'text');
    assert.deepEqual(JSON.parse(response.content[0].text), response.structuredContent);
    assert.equal(response.isError, !response.structuredContent.ok);
    return response.structuredContent;
  };
  const account = await call('tablemesh_account');
  assert.equal(account.data.id, room.a.account.id);
  const stopped = await call('tablemesh_autoplay_control', { roomId: room.id, operation: 'stop', requestId: randomUUID() });
  assert.equal(stopped.ok, true);
  assert.equal(stopped.data.autoplay.phase, 'stopped');
  assert.equal((await call('tablemesh_autoplay_status', { roomId: room.id })).data.phase, 'stopped');
  const missingConfig = await call('tablemesh_autoplay_control', { roomId: room.id, operation: 'start', requestId: randomUUID() });
  assert.equal(missingConfig.ok, false);
  const syntheticKey = 'synthetic-plugin-key';
  assert.equal((await room.a.request('/llm/config', { requestId: randomUUID(), config: { protocol: 'openai-compatible', baseUrl: model.baseUrl, model: 'synthetic', apiKey: syntheticKey,
    limits: { timeoutMs: 5000, maxOutputTokens: 256, maxRequestsPerHand: 20, maxRequestsPerRun: 100 } } }, 'PUT')).body.ok, true);
  const modelStatus = await call('tablemesh_autoplay_status', { roomId: room.id });
  assert.equal(modelStatus.data.modelConfig.ready, true);
  assert.equal(JSON.stringify(modelStatus).includes(syntheticKey), false);
  assert.equal((await call('tablemesh_autoplay_control', { roomId: room.id, operation: 'start', requestId: randomUUID() })).ok, true);
  for (let n = 0; n < 100; n++) {
    if ((await room.a.request(`/rooms/${room.id}`)).body.data.game.actorSeat !== 0) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(model.requests.length, 1);
  assert.equal((await room.a.request(`/rooms/${room.id}`)).body.data.game.actorSeat, 1);
  assert.equal((await call('tablemesh_autoplay_control', { roomId: room.id, operation: 'stop', requestId: randomUUID() })).data.autoplay.phase, 'stopped');
  const lobby = await call('tablemesh_lobby');
  assert.equal(lobby.data.some(item => item.id === room.id), true);
  let snapshot = (await call('tablemesh_observe', { roomId: room.id })).data;
  const bCards = (await room.b.request(`/rooms/${room.id}`)).body.data.you.privateState.holeCards;
  for (const card of bCards) assert.equal(JSON.stringify(snapshot).includes(`"${card}"`), false);
  let toolMoves = 0;
  for (let i = 0; i < 40 && snapshot.game.phase !== 'complete'; i++) {
    const legal = await call('tablemesh_legal_actions', { roomId: room.id });
    if (legal.data.legalActions.length) {
      const move = legal.data.legalActions.find(move => move.type === 'check') ?? legal.data.legalActions.find(move => move.type === 'call');
      assert.ok(move);
      const result = await call('tablemesh_act', { roomId: room.id, stateVersion: legal.data.stateVersion, windowId: legal.data.windowId, requestId: randomUUID(), action: { type: move.type } });
      assert.equal(result.ok, true); toolMoves++;
    } else {
      const own = (await room.b.request(`/rooms/${room.id}`)).body.data;
      const move = own.you.legalActions.find(move => move.type === 'check') ?? own.you.legalActions.find(move => move.type === 'call');
      assert.ok(move);
      assert.equal((await room.b.request(`/rooms/${room.id}/actions`, { stateVersion: own.stateVersion, windowId: own.game.window.id, requestId: randomUUID(), action: { type: move.type } })).body.ok, true);
    }
    snapshot = (await call('tablemesh_observe', { roomId: room.id })).data;
  }
  assert.equal(snapshot.game.phase, 'complete');
  assert.ok(toolMoves >= 2);
  const nextHand = await call('tablemesh_start_hand', { roomId: room.id, stateVersion: snapshot.stateVersion, requestId: randomUUID() });
  assert.equal(nextHand.ok, true);
  const leaveMeta = { roomId: room.id, stateVersion: nextHand.data.snapshot.stateVersion, requestId: randomUUID() };
  const unconfirmed = await call('tablemesh_leave_room', leaveMeta);
  assert.equal(unconfirmed.ok, false);
  assert.equal((await call('tablemesh_account')).data.fairPlay.reputation, 100);
  const confirmed = await call('tablemesh_leave_room', { ...leaveMeta, requestId: randomUUID(), confirmAbandon: true });
  assert.equal(confirmed.ok, true);
  assert.equal((await call('tablemesh_account')).data.fairPlay.reputation, 90);
  const points = await call('tablemesh_points');
  assert.equal(points.data.account.points, 1000);
  assert.equal(JSON.stringify(points).includes('code_ciphertext'), false);
  assert.equal(stderr.includes(minted.body.data.token), false);
  console.log(`Tokem plugin check: PASS (launcher spawned, 12 tools, ${toolMoves} game actions, 1 local model action, autoplay controls and explicit abandonment guard; host installation unverified).`);
} finally {
  await client?.close();
  await f.close();
  await model.close();
}
