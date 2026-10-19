import { descriptor } from '../src/provider';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const pin=process.env.ARCHON_CHECKOUT;
if(!pin)throw new Error('Set ARCHON_CHECKOUT to the exact tested Archon checkout (9155ff15d1d557c1fee4e5e1627e14d0beafcf73)');
const {ProcessAgentProvider}=await import(join(pin,'packages/core/src/providers/process-provider.ts'));
const provider=new ProcessAgentProvider(descriptor,[resolve('dist/archon-provider-opencode-v2-linux-x64')]);
const before=new Set((await readdir(tmpdir())).filter(x=>x.startsWith('archon-opencode-v2-')));
const cwd=await mkdtemp(join(tmpdir(),'opencode-v2-pinned-host-'));
const abort=new AbortController();let started=false,settled=false;
const monitor=setInterval(async()=>{try{await readFile(join(cwd,'started'));started=true;abort.abort();}catch{}},100);
try{
 for await(const c of provider.sendQuery('Use shell to run this exact foreground command: echo $$ > tool.pid; printf started > started; sleep 30; printf late > late . Do not use background execution.',cwd,undefined,{model:'opencode-go/deepseek-v4.1-flash',abortSignal:abort.signal})){if(c.type==='settled')settled=true;}
 clearInterval(monitor);
 if(!started || settled)throw new Error('Expected cancellation of a running tool without settled');
 for(let i=0;i<100;i++){
  if(!(await readdir(tmpdir())).some(x=>x.startsWith('archon-opencode-v2-')&&!before.has(x)))break;
  await Bun.sleep(100);
 }
 const leftovers=(await readdir(tmpdir())).filter(x=>x.startsWith('archon-opencode-v2-')&&!before.has(x));
 if(leftovers.length)throw new Error('Runtime directory leaked after pinned host SIGKILL');
 const pid=Number((await readFile(join(cwd,'tool.pid'),'utf8')).trim());
 let live=true;try{process.kill(pid,0);}catch{live=false;}
 if(live)throw new Error('Tool survived pinned host cancellation');
 let late=false;try{await readFile(join(cwd,'late'));late=true;}catch{}
 if(late)throw new Error('Cancelled tool completed its forbidden late write');
 console.log(JSON.stringify({test:'exact-pinned-ProcessAgentProvider-cancellation',pass:true,runningToolKilled:true,temporaryRuntimeRemoved:true,noSettled:true}));
}finally{clearInterval(monitor);await rm(cwd,{recursive:true,force:true});}
