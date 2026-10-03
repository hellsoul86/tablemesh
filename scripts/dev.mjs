import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
execFileSync('npm', ['run', 'build', '--workspace', '@tablemesh/core'], { cwd: root, stdio: 'inherit' });
// Launch runtimes directly without npm/shell intermediaries or detached groups.
// A supervising terminal/test process can terminate the whole process group.
const children = [
  spawn(process.execPath, ['--import', 'tsx', 'packages/server/src/main.ts'], { cwd: root, env: process.env, stdio: 'inherit' }),
  ...['web', 'rewards-web'].map(name => spawn(process.execPath, [fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url))], {
    cwd: fileURLToPath(new URL(`../packages/${name}/`, import.meta.url)), env: process.env, stdio: 'inherit'
  }))
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.pid) continue;
    try { child.kill('SIGTERM'); } catch {}
  }
  setTimeout(() => process.exit(code), 250).unref();
}
for (const child of children) {
  child.once('error', () => stop(1));
  child.once('exit', code => { if (!stopping) stop(code ?? 1); });
}
process.once('SIGINT', () => stop());
process.once('SIGTERM', () => stop());
