import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fixture, twoPlayerRoom } from '../packages/server/test/helpers.mjs';
const installed = spawnSync('codex', ['--version'], { encoding: 'utf8' });
if (installed.error || installed.status !== 0) {
  console.error('Tokem Codex host check requires an already installed Codex CLI on PATH. No installation was attempted.');
  process.exit(1);
}
const version = installed.stdout.trim();
const scratch = await mkdtemp(join(tmpdir(), 'tokem-host-'));
const evidenceDir = process.env.TABLEMESH_HOST_CHECK_EVIDENCE_DIR || scratch;
await mkdir(evidenceDir, { recursive: true });
// This fixture uses isolated memory SQLite and synthetic accounts/credentials.
// Never start a model turn: calls go through the actual host's MCP API directly.
const f = await fixture({ host: '127.0.0.1', mcpPublicUrl: null, secureCookies: false, now: Date.now });
const evidence = { version, node: process.version, ephemeral: false, toolCount: 0, calls: [], modelTurns: 0, paidModelCalls: 0, configuration: 'runtime -c only; ephemeral credential store; environment whitelist; no HOME/CODEX_HOME override', result: 'FAIL' };
let child;
const testSecrets = [];
let output = '';
let stderr = '';
const pending = new Map();
let sequence = 0;
function rpc(method, params, timeout = 15000) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Timeout: ' + method)); }, timeout);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
}
try {
  const room = await twoPlayerRoom(f);
  const minted = await room.a.request('/auth/tokens', { label: 'ephemeral Codex host test' });
  const gameToken = minted.body.data.token;
  testSecrets.push(gameToken);
  const opts = [
    'mcp_servers={tablemesh={url="' + f.url + '/mcp",bearer_token_env_var="TABLEMESH_TOKEN",startup_timeout_sec=15,tool_timeout_sec=45,required=true}}',
    'cli_auth_credentials_store="ephemeral"',
    'model="tokem-offline-fixture"',
    'model_provider="tokem_offline"',
    'model_providers.tokem_offline={name="Tokem offline test",base_url="http://127.0.0.1:9/v1",wire_api="responses",requires_openai_auth=false}',
    'check_for_update_on_startup=false',
    'analytics.enabled=false',
    'features.apps=false',
    'plugins={}',
  ];
  child = spawn('codex', ['app-server', '--stdio', ...opts.flatMap(v => ['-c', v])], {
    cwd: scratch,
    env: { PATH: process.env.PATH || '', ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}), TABLEMESH_TOKEN: gameToken },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.on('data', data => { stderr += data; });
  child.stdout.on('data', data => {
    output += data;
    for (;;) {
      const i = output.indexOf('\n'); if (i < 0) break;
      const line = output.slice(0, i); output = output.slice(i + 1);
      let message; try { message = JSON.parse(line); } catch { continue; }
      if (message.id !== undefined && !message.method) {
        const p = pending.get(message.id); pending.delete(message.id);
        if (p) message.error ? p.reject(new Error(message.error.message)) : p.resolve(message.result);
      } else if (message.id !== undefined && message.method) {
        child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'Test does not permit host requests' } }) + '\n');
      }
    }
  });
  child.on('exit', code => { for (const p of pending.values()) p.reject(new Error('Host exited ' + code)); pending.clear(); });
  const initialized = await rpc('initialize', { clientInfo: { name: 'tokem_ephemeral_host_smoke', version: '0.1.0' }, capabilities: { experimentalApi: true } });
  evidence.initialize = Boolean(initialized);
  child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
  const thread = await rpc('thread/start', { cwd: scratch, ephemeral: true, model: 'tokem-offline-fixture', modelProvider: 'tokem_offline', approvalPolicy: 'never', sandbox: 'read-only' }, 20000);
  assert.equal(thread.thread.ephemeral, true);
  evidence.ephemeral = true;
  const threadId = thread.thread.id;
  const inventory = await rpc('mcpServerStatus/list', { threadId, detail: 'toolsAndAuthOnly', limit: 100 }, 20000);
  const server = inventory.data.find(s => s.name === 'tablemesh');
  assert.ok(server, 'Tokem missing from real host inventory');
  assert.deepEqual(inventory.data.map(s => s.name), ['tablemesh'], 'Runtime config must enable only Tokem');
  evidence.toolCount = Object.keys(server.tools).length;
  assert.equal(evidence.toolCount, 11);
  const call = async (tool, args = {}) => {
    const result = await rpc('mcpServer/tool/call', { threadId, server: 'tablemesh', tool, arguments: args });
    const content = result.structuredContent ?? result.result?.structuredContent ?? result;
    if (!content.ok && content.content) {
      const parsed = JSON.parse(content.content.find(i => i.type === 'text').text);
      return parsed;
    }
    return content;
  };
  const account = await call('tablemesh_account');
  assert.equal(account.data.id, room.a.account.id); evidence.calls.push('account');
  const lobby = await call('tablemesh_lobby'); assert.ok(lobby.data.some(r => r.id === room.id)); evidence.calls.push('lobby');
  const snapshot = (await call('tablemesh_observe', { roomId: room.id })).data;
  assert.equal(snapshot.you.privateState.holeCards.length, 2); evidence.calls.push('observe-own-cards');
  const waited = await call('tablemesh_wait_for_turn', { roomId: room.id, afterStateVersion: snapshot.stateVersion, maxWaitMs: 0 });
  assert.equal(waited.data.snapshot.you.accountId, room.a.account.id); evidence.calls.push('wait');
  const legal = await call('tablemesh_legal_actions', { roomId: room.id });
  const move = legal.data.legalActions.find(m => m.type === 'call') ?? legal.data.legalActions.find(m => m.type === 'check');
  assert.ok(move, 'fixture owner must have first heads-up turn');
  const action = await call('tablemesh_act', { roomId: room.id, stateVersion: legal.data.stateVersion, windowId: legal.data.windowId, requestId: randomUUID(), action: { type: move.type } });
  assert.equal(action.ok, true); assert.ok(action.data.snapshot.stateVersion > snapshot.stateVersion); evidence.calls.push('legal-action');
  const threadList = await rpc('thread/list', { cwd: scratch, limit: 100 });
  assert.equal(threadList.data.some(t => t.id === threadId), false); evidence.notPersisted = true;
  assert.equal(stderr.includes(gameToken), false); evidence.noTokenInDiagnostics = true;
  evidence.result = 'PASS';
} catch (error) {
  evidence.error = testSecrets.reduce((message, secret) => message.replaceAll(secret, '[redacted]'), String(error.message)).slice(0, 1000);
  // Diagnostics may contain user paths; record only booleans and safe protocol errors.
  evidence.hostReportedError = /ERROR|error/i.test(stderr);

  process.exitCode = 1;
} finally {
  child?.kill('SIGTERM');
  await f.close();
  evidence.artifactHashes = {};
  for (const path of ['packages/server/dist/mcp-tools.js', 'packages/server/dist/mcp-http.js', 'packages/server/dist/app.js', 'package-lock.json']) {
    evidence.artifactHashes[path] = createHash('sha256').update(await readFile(new URL('../' + path, import.meta.url))).digest('hex');
  }
  const evidencePath = join(evidenceDir, 'codex-host.json');
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
  if (evidence.result === 'PASS') console.log(`Tokem Codex host: PASS (${version}, ${evidence.toolCount} tools, 1 legal action, ephemeral thread, no model turn). Evidence: ${evidencePath}`);
  else console.error(`Tokem Codex host: FAIL (${evidence.error}). This check requires app-server ephemeral threads, mcpServerStatus/list and mcpServer/tool/call; verified CLI version: 0.158.0. Evidence: ${evidencePath}`);
}
