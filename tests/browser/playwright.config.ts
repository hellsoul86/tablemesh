import {defineConfig} from '@playwright/test';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const root=fileURLToPath(new URL('../../',import.meta.url));
// Disposable test credentials are created per run and never printed or snapshotted.
process.env.TABLEMESH_E2E_ADMIN ||= randomBytes(32).toString('hex');
const inventoryKey=randomBytes(32).toString('base64');
const serverEnv={TABLEMESH_DB:join(tmpdir(),`tablemesh-e2e-${Date.now()}-${randomBytes(4).toString('hex')}.sqlite`),TABLEMESH_ADMIN_TOKEN:process.env.TABLEMESH_E2E_ADMIN,TABLEMESH_INVENTORY_KEY:inventoryKey,TABLEMESH_PROVIDER_KEY:randomBytes(32).toString('base64'),TABLEMESH_STARTER_POINTS:'1000',TABLEMESH_REAL_REWARDS:'false'};
export default defineConfig({testDir:'.',testMatch:'*.spec.ts',timeout:120_000,expect:{timeout:12_000},workers:1,fullyParallel:false,reporter:'list',outputDir:join(root,'test-results'),use:{baseURL:'http://127.0.0.1:5173',browserName:'chromium',channel:process.env.TABLEMESH_BROWSER_CHANNEL,headless:true,actionTimeout:15000,viewport:{width:1440,height:1000},trace:'off',screenshot:'off',video:'off'},webServer:[
 {command:'node tests/browser/server-harness.mjs',cwd:root,url:'http://127.0.0.1:4100/api/account',reuseExistingServer:false,timeout:60_000,env:serverEnv},
 {command:'npm run dev --workspace @tablemesh/web',cwd:root,url:'http://127.0.0.1:5173',reuseExistingServer:false,timeout:60_000},
 {command:'npm run dev --workspace @tablemesh/rewards-web',cwd:root,url:'http://127.0.0.1:5174',reuseExistingServer:false,timeout:60_000}
]});
