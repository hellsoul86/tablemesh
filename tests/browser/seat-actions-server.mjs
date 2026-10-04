import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import {createApplication} from '../../packages/server/dist/app.js';
const root=fileURLToPath(new URL('../../',import.meta.url));
const directory=await mkdtemp(join(tmpdir(),'tokem-seat-actions-'));
const origin='http://127.0.0.1:5273';
// Independent ports and a new database: never reuse the user's running local preview.
const app=createApplication({databasePath:join(directory,'test.sqlite'),host:'127.0.0.1',port:0,allowedOrigins:[origin],adminToken:null,inventoryKey:null,mcpPublicUrl:null,realRewardsEnabled:false,starterPoints:1000});
const api=await app.listen(0);
const web=await createServer({root:join(root,'packages/web'),configFile:false,server:{host:'127.0.0.1',port:5273,strictPort:true,proxy:{'/api':api}}});
await web.listen();console.log('Isolated seat-action browser fixture ready on 5273');
let closing=false;
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{if(closing)return;closing=true;void Promise.all([web.close(),app.close()]).then(()=>process.exit(0),()=>process.exit(1));});
