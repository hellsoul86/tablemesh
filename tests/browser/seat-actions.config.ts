import {defineConfig} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const root=fileURLToPath(new URL('../../',import.meta.url));
export default defineConfig({testDir:'.',testMatch:'seat-actions.spec.ts',timeout:120000,expect:{timeout:12000},workers:1,reporter:'list',outputDir:join(root,'test-results','seat-actions'),use:{baseURL:'http://127.0.0.1:5273',browserName:'chromium',channel:process.env.TABLEMESH_BROWSER_CHANNEL,headless:true,viewport:{width:1440,height:1100},trace:'off',screenshot:'off',video:'off'},webServer:{command:'node tests/browser/seat-actions-server.mjs',cwd:root,url:'http://127.0.0.1:5273',reuseExistingServer:false,timeout:60000}});
