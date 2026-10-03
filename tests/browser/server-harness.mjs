import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';

// Test-only process control. The application exposes no restart endpoint.
const root=fileURLToPath(new URL('../../',import.meta.url));
let child,closing=false,restarting=false;
function start(){child=spawn(process.execPath,['packages/server/dist/main.js'],{cwd:root,env:process.env,stdio:'inherit'});child.on('exit',code=>{if(!closing&&!restarting)process.exit(code??1);});}
async function stop(){if(child?.exitCode===null){const exited=once(child,'exit');child.kill('SIGTERM');await exited;}}
async function ready(){for(let n=0;n<100;n++){try{const response=await fetch('http://127.0.0.1:4100/api/account');if(response.status===401)return;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}throw new Error('Test application did not restart');}
const control=createServer(async(req,res)=>{if(req.method!=='POST'||req.url!=='/restart'){res.writeHead(404);res.end();return;}if(restarting){res.writeHead(409);res.end();return;}restarting=true;try{await stop();start();await ready();res.end('{}');}catch{res.writeHead(500);res.end('{}');}finally{restarting=false;}});
control.listen(Number(process.env.TABLEMESH_E2E_CONTROL_PORT||4198),'127.0.0.1');
start();
async function close(){closing=true;control.close();await stop();process.exit(0);}
process.on('SIGTERM',close);process.on('SIGINT',close);
