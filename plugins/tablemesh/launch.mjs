import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// A copied plugin uses an explicitly configured existing repository runtime.
// Checkout-local use derives the path from this file, never the host's cwd.
const root = process.env.TABLEMESH_REPO_ROOT
  ? resolve(process.env.TABLEMESH_REPO_ROOT)
  : fileURLToPath(new URL('../../', import.meta.url));
const manifest = join(root, 'package.json');
const entry = join(root, 'packages/server/dist/mcp.js');
if (!existsSync(manifest) || JSON.parse(readFileSync(manifest, 'utf8')).name !== 'tablemesh' || !existsSync(entry)) {
  console.error('Tokem runtime is not built. Set TABLEMESH_REPO_ROOT to the checkout and run npm ci && npm run build there.');
  process.exit(1);
}
await import(pathToFileURL(entry).href);
