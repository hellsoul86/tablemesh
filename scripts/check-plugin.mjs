import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fixture, twoPlayerRoom } from '../packages/server/test/helpers.mjs';

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
  assert.equal(tools.tools.length, 11);
  assert.equal(tools.tools.some(tool => /reward|secret|admin|inventory/i.test(tool.name)), false);
  for (const tool of tools.tools) assert.equal(tool.annotations?.idempotentHint, true);
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
  const lobby = await call('tablemesh_lobby');
  assert.equal(lobby.data.some(item => item.id === room.id), true);
  let snapshot = (await call('tablemesh_observe', { roomId: room.id })).data;
  const waited = await call('tablemesh_wait_for_turn', { roomId: room.id, afterStateVersion: snapshot.stateVersion, maxWaitMs: 0 });
  assert.equal(waited.ok, true);
  assert.equal(waited.data.snapshot.stateVersion, snapshot.stateVersion);
  assert.equal(waited.data.reason, snapshot.you.legalActions.length ? 'your_turn' : 'timeout');
  assert.match(client.getInstructions(), /current legalActions/);
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
  console.log(`Tokem plugin check: PASS (launcher spawned, 11 tools, ${toolMoves} game actions, explicit abandonment guard; host installation unverified).`);
} finally {
  await client?.close();
  await f.close();
}
