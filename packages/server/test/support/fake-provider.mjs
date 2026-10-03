import { createServer } from 'node:http';

// Local test service. Requests stay in memory; nothing prints credentials.
export async function startFakeProvider({ port = 0 } = {}) {
  const requests = [];
  let mode = 'passive';
  let delayMs = 0;
  const server = createServer(async (req, res) => {
    if (req.url === '/control' && req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const control = JSON.parse(raw);
      mode = control.mode;
      delayMs = control.delayMs ?? 0;
      res.end('{}');
      return;
    }
    if (req.url === '/stats') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ count: requests.length })); return; }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({ path: req.url, headers: req.headers, body });
    const currentMode = mode;
    const currentDelay = delayMs;
    if (currentDelay) await new Promise(resolve => setTimeout(resolve, currentDelay));
    if (currentMode === 'error') { res.writeHead(503); res.end(JSON.stringify({ error: 'synthetic-private-error', echoedKey: req.headers.authorization || req.headers['x-api-key'] })); return; }
    if (currentMode === 'redirect') { res.writeHead(302, { location: '/v1/chat/completions' }); res.end(); return; }
    if (currentMode === 'oversized') { res.end('x'.repeat(70_000)); return; }
    const user = body.messages.at(-1).content;
    const observation = JSON.parse(typeof user === 'string' ? user : user[0].text);
    const actions = observation.legalActions ?? [{ type: 'check' }];
    const passive = ['check', 'call', 'fold'].find(type => actions.some(action => action.type === type)) ?? 'fold';
    const content = currentMode === 'invalid' ? 'not JSON' : currentMode === 'nonce' ? JSON.stringify({ decisionNonce: 'wrong', action: { type: passive } }) :
      JSON.stringify({ decisionNonce: observation.decisionNonce, action: { type: passive } });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url?.endsWith('/messages') ? { content: [{ type: 'text', text: content }], stop_reason: 'end_turn' } :
      { choices: [{ message: { content }, finish_reason: 'stop' }] }));
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, requests,
    setMode(next, delay = 0) { mode = next; delayMs = delay; },
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const fixture = await startFakeProvider({ port: Number(process.env.TABLEMESH_FAKE_PROVIDER_PORT || 4199) });
  console.log(`Local test model: ${fixture.baseUrl}`);
  const close = async () => { await fixture.close(); process.exit(0); };
  process.on('SIGINT', close); process.on('SIGTERM', close);
}
