import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createGameMcpServer } from '../dist/mcp-tools.js';

async function connect(api) {
  const server = createGameMcpServer(api);
  const client = new Client({ name: 'registry-regression', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  return { client, close: async () => { await client.close(); await server.close(); } };
}
const invoke = (client, name, args = {}, options) => client.callTool({ name, arguments: args }, undefined, options);

// Validation is at the actual SDK boundary; rejected input must never reach the API.
test('shared registry advertises both-transport workflow and rejects forged authority/extra action fields', async () => {
  const calls = [];
  const f = await connect(async (...args) => { calls.push(args); return { ok: true, data: {} }; });
  try {
    const { tools } = await f.client.listTools();
    assert.equal(tools.length, 13);
    assert.match(f.client.getInstructions(), /sharing its seat/);
    assert.match(f.client.getInstructions(), /cancelling a wait does not leave/);
    assert.equal(tools.find(t => t.name === 'tablemesh_wait_for_turn').annotations.readOnlyHint, true);
    for (const t of tools) assert.equal(t.inputSchema.additionalProperties, false);
    for (const args of [
      { roomId: 'r', stateVersion: 1, windowId: 'w', requestId: 'id', accountId: 'victim', action: { type: 'fold' } },
      { roomId: 'r', stateVersion: 1, windowId: 'w', requestId: 'id', action: { type: 'raise', amount: 20, seat: 1 } },
    ]) {
      assert.equal((await invoke(f.client, 'tablemesh_act', args)).isError, true);
    }
    assert.equal((await invoke(f.client, 'tablemesh_wait_for_turn', { roomId: 'r', afterStateVersion: 1, maxWaitMs: 25001 })).isError, true);
    assert.equal(calls.length, 0);
  } finally { await f.close(); }
});

test('wait is readonly, encodes room path, forwards fresh response and bounded default, and carries cancellation', async () => {
  const calls = [];
  const data = { reason: 'state_changed', snapshot: { stateVersion: 12, you: { legalActions: [] } } };
  let abortSeen;
  const aborted = new Promise(resolve => { abortSeen = resolve; });
  let waitingStarted;
  const started = new Promise(resolve => { waitingStarted = resolve; });
  const f = await connect(async (path, method, body, signal) => {
    calls.push({ path, method, body, signal });
    if (path.includes('maxWaitMs=25000')) {
      waitingStarted();
      await new Promise(resolve => signal.addEventListener('abort', () => { abortSeen(); resolve(); }, { once: true }));
    }
    return { ok: true, data };
  });
  try {
    const response = await invoke(f.client, 'tablemesh_wait_for_turn', { roomId: 'room/other?x=1', afterStateVersion: 11 });
    assert.deepEqual(response.structuredContent, { ok: true, data });
    assert.deepEqual(JSON.parse(response.content[0].text), response.structuredContent);
    assert.equal(calls[0].path, '/rooms/room%2Fother%3Fx%3D1/wait?afterStateVersion=11&maxWaitMs=20000');
    assert.equal(calls[0].method, 'GET'); assert.equal(calls[0].body, undefined);
    const controller = new AbortController();
    const pending = invoke(f.client, 'tablemesh_wait_for_turn', { roomId: 'r', afterStateVersion: 11, maxWaitMs: 25000 }, { signal: controller.signal });
    await started;
    controller.abort();
    await assert.rejects(pending);
    let timer;
    try { await Promise.race([aborted, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('SDK did not forward cancellation')), 1000); })]); }
    finally { clearTimeout(timer); }
    assert.equal(calls.at(-1).signal.aborted, true);
    assert.equal(calls.every(c => c.method === 'GET'), true);
  } finally { await f.close(); }
});

test('actions preserve retry payload and legal view; invoker failures cannot disclose secrets', async () => {
  const calls = [];
  const f = await connect(async (path, method, body) => {
    calls.push({ path, method, body });
    if (path === '/account') throw new Error('private-token-do-not-return');
    if (method === 'POST') return { ok: false, error: { code: 'VERSION_CONFLICT', message: 'observe again', currentStateVersion: 8 } };
    return { ok: true, data: { stateVersion: 7, game: { window: { id: 'w', deadline: 123 } }, you: { legalActions: [{ type: 'call', amount: 5 }], privateState: { holeCards: ['Ac', 'Ad'] } } } };
  });
  try {
    const legal = await invoke(f.client, 'tablemesh_legal_actions', { roomId: 'r' });
    assert.deepEqual(legal.structuredContent.data, { stateVersion: 7, windowId: 'w', deadline: 123, legalActions: [{ type: 'call', amount: 5 }] });
    assert.equal(JSON.stringify(legal).includes('\"Ac\"'), false);
    const args = { roomId: 'r', stateVersion: 7, requestId: 'stable-retry', windowId: 'w', action: { type: 'raise', amount: 25 } };
    const response = await invoke(f.client, 'tablemesh_act', args);
    assert.equal(response.isError, true);
    assert.equal(response.structuredContent.error.code, 'VERSION_CONFLICT');
    assert.deepEqual(calls.at(-1), { path: '/rooms/r/actions', method: 'POST', body: { stateVersion: 7, requestId: 'stable-retry', windowId: 'w', action: { type: 'raise', amount: 25 } } });
    const failure = await invoke(f.client, 'tablemesh_account');
    assert.equal(failure.structuredContent.error.code, 'INTERNAL');
    assert.equal(JSON.stringify(failure).includes('private-token-do-not-return'), false);
  } finally { await f.close(); }
});

test('history tools are readonly, bounded, identity-free and preserve paginated API projection', async()=>{
 const calls=[];const data={summary:{availability:'summary_only',netChips:null},frames:[]};
 const f=await connect(async(...args)=>{calls.push(args);return {ok:true,data};});try {
  const tools=(await f.client.listTools()).tools;
  for(const name of ['tablemesh_list_replays','tablemesh_get_replay']) assert.equal(tools.find(t=>t.name===name).annotations.readOnlyHint,true);
  assert.equal((await invoke(f.client,'tablemesh_list_replays',{accountId:'victim'})).isError,true);
  assert.equal((await invoke(f.client,'tablemesh_get_replay',{handId:'h',limit:201})).isError,true);assert.equal(calls.length,0);
  await invoke(f.client,'tablemesh_list_replays',{before:5,limit:1});assert.equal(calls.at(-1)[0],'/replays?before=5&limit=1');
  const result=await invoke(f.client,'tablemesh_get_replay',{handId:'h/other?x=1',afterStep:-1,limit:2});
  assert.deepEqual(result.structuredContent,{ok:true,data});assert.equal(calls.at(-1)[0],'/replays/h%2Fother%3Fx%3D1?afterStep=-1&limit=2');assert.equal(calls.at(-1)[1],'GET');
 }finally{await f.close();}
});
