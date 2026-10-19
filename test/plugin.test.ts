import { test, expect } from 'bun:test';
import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { connectProvider, providerPluginDescriptorSchema } from '@archon/provider-contract/plugin';
import { checkEventVocabulary, checkSettled } from '@archon/provider-contract/conformance';
import type { ProviderChunk } from '@archon/provider-contract';
import { descriptor, Provider } from '../src/provider';
import { startRuntime } from '../src/runtime';

async function host() {
 const p=spawn(resolve('dist/archon-provider-opencode-v2-linux-x64'),[],{stdio:['pipe','pipe','pipe']});
 let stderrBytes=0;p.stderr.on('data',b=>{stderrBytes+=b.length;});
 const done=new Promise<void>(ok=>p.on('exit',()=>ok()));
 const provider=await connectProvider({readable:Readable.toWeb(p.stdout),writable:Writable.toWeb(p.stdin)});
 return {provider,p,async close(){await provider.close();await done;expect(stderrBytes).toBe(0);}};
}
async function collect(stream:AsyncIterable<ProviderChunk>){const out:ProviderChunk[]=[];for await(const c of stream)out.push(c);return out;}
const live=process.env.ARCHON_LIVE==='1'?test:test.skip;

test('strict descriptor and real executable initialize/credential protocol',async()=>{
 providerPluginDescriptorSchema.parse(descriptor);
 const h=await host();try{
 expect(h.provider.getType()).toBe('opencode-v2');
 expect(h.provider.getCapabilities().sessionResume).toBe(false);
 expect(await h.provider.checkCredential({env:{},signal:AbortSignal.timeout(1000)})).toEqual({state:'not_checked',source:'native'});
 const chunks=await collect(h.provider.sendQuery('must not spend',process.cwd(),undefined,{model:'wrong/model'}));
 expect(chunks.at(-1)?.type).toBe('settled');
 expect(chunks.find(c=>c.type==='result')?.isError).toBe(true);
 }finally{await h.close();}
});

test('V1 executable is rejected before sidecar creation',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'opencode-v1-reject-'));
 try{
 const binary=join(dir,'fake-opencode');await writeFile(binary,'#!/bin/sh\nprintf "1.18.34\\n"\n',{mode:0o700});
 await expect(startRuntime(dir,'test',{binary},AbortSignal.timeout(3000))).rejects.toThrow('no V1 fallback');
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('unsupported skills/MCP/native tools/containers fail before inference',async()=>{
 for(const options of [{nodeConfig:{skills:['personal']}},{nodeConfig:{mcp:'x'}},{execContext:{kind:'container' as const,containerId:'x'}},{fallbackModel:'other'},{nativeTools:[{name:'test',description:'test',inputSchema:{properties:{},required:[]},handler:async()=>''}]}]){
  const chunks=await collect(new Provider().sendQuery('must not spend',process.cwd(),undefined,{model:'opencode-go/deepseek-v4.1-flash',...options}));
  expect(chunks.find(c=>c.type==='result')?.isError).toBe(true);
  expect(chunks.at(-1)?.type).toBe('settled');
 }
});

live('authenticated protocol: foreground tool, final JSON, exact model, contract conformance',async()=>{
 const cwd=await mkdtemp(join(tmpdir(),'opencode-v2-protocol-')); const h=await host();
 try{
 const chunks=await collect(h.provider.sendQuery('Use the foreground shell tool to run: printf factory-tool-ok > proof.txt; cat proof.txt . After the tool finishes, return the required JSON with ok=true and proof="factory-tool-ok".',cwd,undefined,{
  model:'opencode-go/deepseek-v4.1-flash',
  outputFormat:{type:'json_schema',schema:{type:'object',required:['ok','proof'],additionalProperties:false,properties:{ok:{const:true},proof:{const:'factory-tool-ok'}}}},
 }));
 const result=chunks.find(c=>c.type==='result');
 expect(result?.isError).not.toBe(true);
 expect(result?.structuredOutput).toEqual({ok:true,proof:'factory-tool-ok'});
 expect(result?.resolvedModel?.id).toBe('opencode-go/deepseek-v4.1-flash');
 expect(await readFile(join(cwd,'proof.txt'),'utf8')).toBe('factory-tool-ok');
 expect(chunks.some(c=>c.type==='tool_call'&&c.name==='shell')).toBe(true);
 const fixtures=[{name:'actual tool+JSON',run:async function*(){yield* chunks;}}];
 expect(await checkEventVocabulary(fixtures)).toEqual([]);
 expect(await checkSettled(fixtures)).toEqual([]);
 console.log(JSON.stringify({live:'protocol-tool-json',pass:true,toolCalls:chunks.filter(c=>c.type==='tool_call').length}));
 }finally{await h.close();await rm(cwd,{recursive:true,force:true});}
},180000);

live('protocol cancellation kills running shell and removes runtime directory',async()=>{
 const cwd=await mkdtemp(join(tmpdir(),'opencode-v2-cancel-'));const h=await host();
 const before=new Set((await readdir(tmpdir())).filter(x=>x.startsWith('archon-opencode-v2-')));
 const abort=new AbortController();let started=false;let observed:ProviderChunk[]=[];
 let monitor:ReturnType<typeof setInterval>|undefined;
 try{
 monitor=setInterval(async()=>{try{await readFile(join(cwd,'started'));started=true;abort.abort();}catch{}},100);
 try{
 for await(const chunk of h.provider.sendQuery('Use the shell tool to run exactly this foreground command: echo $$ > tool.pid; printf started > started; sleep 30; printf late > late . Do not put it in the background.',cwd,undefined,{model:'opencode-go/deepseek-v4.1-flash',abortSignal:abort.signal})) observed.push(chunk);
 throw new Error('Expected cancellation');
 }catch(e){if(!abort.signal.aborted)throw e;}
 clearInterval(monitor);
 expect(started).toBe(true);expect(observed.some(c=>c.type==='settled')).toBe(false);
 // The host aborts immediately; wait for the plugin's owned cleanup before closing it.
 for(let i=0;i<100;i++){
 const left=(await readdir(tmpdir())).filter(x=>x.startsWith('archon-opencode-v2-')&&!before.has(x));
 if(!left.length)break;await Bun.sleep(100);
 }
 const pid=Number((await readFile(join(cwd,'tool.pid'),'utf8')).trim());
 expect(()=>process.kill(pid,0)).toThrow();
 await expect(readFile(join(cwd,'late'),'utf8')).rejects.toThrow();
 expect((await readdir(tmpdir())).filter(x=>x.startsWith('archon-opencode-v2-')&&!before.has(x))).toEqual([]);
 console.log(JSON.stringify({live:'protocol-cancellation',pass:true,runningToolKilled:true,noSettled:true,temporaryRuntimeRemoved:true}));
 }finally{clearInterval(monitor);await h.close();await rm(cwd,{recursive:true,force:true});}
},180000);

live('provider timeout aborts and cleans up without settling',async()=>{
 const cwd=await mkdtemp(join(tmpdir(),'opencode-v2-timeout-'));
 const before=new Set((await readdir(tmpdir())).filter(x=>x.startsWith('archon-opencode-v2-')));
 let settled=false;
 try{
 let error:unknown;
 try{for await(const c of new Provider().sendQuery('Use shell to sleep 30 seconds in the foreground.',cwd,undefined,{model:'opencode-go/deepseek-v4.1-flash',assistantConfig:{timeoutMs:1500}})){if(c.type==='settled')settled=true;}}
 catch(e){error=e;}
 expect(error).toBeDefined();expect(settled).toBe(false);
 expect((await readdir(tmpdir())).filter(x=>x.startsWith('archon-opencode-v2-')&&!before.has(x))).toEqual([]);
 console.log(JSON.stringify({live:'timeout',pass:true,noSettled:true,temporaryRuntimeRemoved:true}));
 }finally{await rm(cwd,{recursive:true,force:true});}
},15000);
