import { createInterface } from 'node:readline';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Private pipe, no credentials. Survives the pinned host's SIGKILL of its plugin group.
export async function cleanupMonitor() {
 let owned:{pid:number;root:string}|undefined, disarmed=false;
 for await(const line of createInterface({input:process.stdin})) {
  const message=JSON.parse(line);
  if(message.done===true){disarmed=true;continue;}
  if(owned || !Number.isInteger(message.pid) || message.pid<2 || typeof message.root!=='string' || !message.root.startsWith(join(tmpdir(),'archon-opencode-v2-')))throw new Error('Invalid cleanup ownership');
  owned=message;process.stdout.write('ready\n');
 }
 if(!owned)return;
 if(!disarmed) {
  for(const sig of ['SIGTERM','SIGKILL'] as const){
   try{process.kill(-owned.pid,sig);}catch(e:any){if(e.code!=='ESRCH')throw e;}
   if(sig==='SIGTERM')await Bun.sleep(250);
  }
 }
 await rm(owned.root,{recursive:true,force:true});
}
