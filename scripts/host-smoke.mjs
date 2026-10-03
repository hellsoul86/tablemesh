import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { fixture } from '../packages/server/test/helpers.mjs';

// Optional explicit host check: no global configuration, plugin install, or model override.
const root = fileURLToPath(new URL('../', import.meta.url));
const launcher = fileURLToPath(new URL('../plugins/tablemesh/launch.mjs', import.meta.url));
const f = await fixture();
try {
  const account = await f.register('宿主测试');
  const minted = await account.request('/auth/tokens', { label: 'ephemeral Codex smoke' });
  const child = spawn('codex', ['--no-daemon', 'exec', '--ephemeral', '--skip-git-repo-check', '-C', tmpdir(), '-s', 'read-only', '--json',
    '-c', 'mcp_servers.tablemesh.command="node"',
    '-c', `mcp_servers.tablemesh.args=${JSON.stringify([launcher])}`,
    '-c', 'mcp_servers.tablemesh.env_vars=["TABLEMESH_TOKEN","TABLEMESH_URL","TABLEMESH_REPO_ROOT"]',
    'Check the Tokem MCP connection. Call tablemesh_account and tablemesh_lobby once each. Do not use shell, read files, call other tools, play, or change data. Do not output credentials. Report whether both calls succeeded and the room count.'
  ], { cwd: root, env: { ...process.env, TABLEMESH_TOKEN: minted.body.data.token, TABLEMESH_URL: f.url, TABLEMESH_REPO_ROOT: root }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = ''; let timedOut = false;
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, 60_000);
  const exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code)); });
  clearTimeout(timer);
  const events = stdout.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const calls = events.filter(event => event.item?.type === 'mcp_tool_call' && event.item.server === 'tablemesh').map(event => ({ tool: event.item.tool, status: event.item.status }));
  const unique = [...new Set(calls.filter(call => call.status === 'completed').map(call => call.tool))];
  const passed = exitCode === 0 && unique.includes('tablemesh_account') && unique.includes('tablemesh_lobby');
  const failureEvents = events.filter(event => ['error', 'turn.failed'].includes(event.type)).map(event => event.message ?? event.error?.message ?? event.error ?? event.type);
  const startupErrors = stderr.split('\n').filter(line => /error|fail|unauthor|401|timeout|not found/i.test(line)).slice(-5).map(line => line.replaceAll(minted.body.data.token, '[redacted]').replace(/(?:sk-|gh[pousr]_)[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 400));
  console.log(JSON.stringify({ host: 'Codex CLI ephemeral explicit MCP configuration', passed, exitCode, timedOut, completedTools: unique, ...(passed ? {} : { limitation: timedOut ? 'No tool completion within 60 seconds' : 'No completed Tokem calls', failureEvents, startupErrors }), manifestInstallationVerified: false }));
  if (!passed) process.exitCode = 1;
} finally { await f.close(); }
