import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { OpenCode } from '@opencode/client';

export const VERSION = '2.0.32';
export const BUILTINS = [
  'opencode.provider.opencode', 'opencode.config.policy', 'opencode.models.dev',
  'opencode.agent', 'opencode.config.agent', 'opencode.config.shell',
  'opencode.tool.shell', 'opencode.tool.read', 'opencode.tool.write',
  'opencode.tool.edit', 'opencode.tool.glob', 'opencode.tool.grep',
];
export interface RuntimeConfig { binary?: string; timeoutMs?: number }
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
export async function startRuntime(cwd: string, system: string, cfg: RuntimeConfig, signal: AbortSignal) {
  if (process.platform !== 'linux') throw new Error('This experiment supports Linux only');
  // Do not allow managed/system configuration to reintroduce integrations.
  try { await access('/etc/opencode'); throw new Error('System OpenCode configuration needs explicit review'); }
  catch (e: any) { if (e.code !== 'ENOENT') throw e; }
  const binary = cfg.binary ?? join(homedir(), '.opencode/bin/opencode');
  const probe = spawn(binary, ['--version'], { stdio: ['ignore','pipe','ignore'] });
  let version = ''; probe.stdout.on('data', b => { version += b.toString(); });
  const probeTimer = setTimeout(() => probe.kill('SIGKILL'), 5000);
  const code = await new Promise<number | null>((ok, fail) => { probe.once('error', fail); probe.once('exit', ok); }).finally(() => clearTimeout(probeTimer));
  if (code !== 0 || !['opencode v'+VERSION,VERSION].includes(version.trim())) throw new Error(`OpenCode V2 ${VERSION} required; no V1 fallback`);
  signal.throwIfAborted();
  const database = resolve(process.env.XDG_DATA_HOME ?? join(homedir(), '.local/share'), 'opencode/opencode.db');
  await access(database, constants.R_OK | constants.W_OK); // Native shared DB; never read/copy credentials.
  const root = await mkdtemp(join(tmpdir(), 'archon-opencode-v2-'));
  for (const dir of ['home','config/opencode','data','state','cache']) await mkdir(join(root,dir),{recursive:true});
  const content = {
    plugins: ['-*', ...BUILTINS], default_agent:'factory', update:'disable', share:'disabled',
    shell:'/bin/bash', snapshots:false, formatter:false, lsp:false,
    agents: {factory:{mode:'primary',description:'Archon foreground worker',system,
      permissions:[{action:'*',resource:'*',effect:'allow'}]}},
    policies: [
      {action:'provider.use',resource:'*',effect:'deny'},
      {action:'provider.use',resource:'opencode-go',effect:'allow'},
      {action:'integration.use',resource:'*',effect:'deny'},
      {action:'tool.use',resource:'subagent:*',effect:'deny'},
    ],
  };
  const password = crypto.randomUUID() + crypto.randomUUID();
  const env: Record<string,string> = {
    PATH:process.env.PATH ?? '/usr/bin:/bin', HOME:join(root,'home'), LANG:'C.UTF-8', TERM:'dumb',
    XDG_CONFIG_HOME:join(root,'config'), XDG_DATA_HOME:join(root,'data'),
    XDG_STATE_HOME:join(root,'state'), XDG_CACHE_HOME:join(root,'cache'),
    OPENCODE_DB:database, OPENCODE_CONFIG_DIR:join(root,'config/opencode'),
    OPENCODE_DISABLE_PROJECT_CONFIG:'1', OPENCODE_DISABLE_CLAUDE_CODE:'1',
    OPENCODE_DISABLE_FILEWATCHER:'1', OPENCODE_CONFIG_CONTENT:JSON.stringify(content),
    OPENCODE_SERVER_PASSWORD:password,
  };
  const child = spawn(binary,['serve','--stdio','--hostname','127.0.0.1','--port','0','--log-level','none'],
    {cwd,env,detached:true,stdio:['pipe','pipe','pipe']});
  // Never persist/forward runtime diagnostics: they may contain provider responses or secrets.
  child.stderr.resume();
  const monitorArgs=Bun.main.startsWith('/$bunfs/')?['--cleanup-monitor']:[join(import.meta.dir,'main.ts'),'--cleanup-monitor'];
  const monitor=spawn(process.execPath,monitorArgs,{detached:true,stdio:['pipe','pipe','ignore'],env:{PATH:env.PATH}});
  const monitorExit=new Promise<void>(ok=>monitor.once('exit',()=>ok()));
  monitor.stdin.on('error',()=>{});
  monitor.stdin.write(JSON.stringify({pid:child.pid,root})+'\n');
  const monitorReady=new Promise<void>((ok,fail)=>{
    monitor.stdout.once('data',b=>b.toString().trim()==='ready'?ok():fail(new Error('Cleanup monitor protocol failed')));
    monitor.once('error',()=>fail(new Error('Cleanup monitor failed to start')));
    monitor.once('exit',()=>fail(new Error('Cleanup monitor exited before readiness')));
  });
  let exited = false;
  const exit = new Promise<void>(ok => { child.once('exit', () => { exited = true; ok(); }); child.once('error', () => {exited=true;ok();}); });
  const killGroup = (sig: NodeJS.Signals) => { if(child.pid) {try {process.kill(-child.pid,sig);} catch(e:any) {if(e.code!=='ESRCH') throw e;} } };
  let closed = false;
  const close = async () => {
    if(closed) return; closed=true;
    child.stdin.end(); killGroup('SIGTERM');
    await Promise.race([exit,delay(1000)]);
    // Also kill leftover tool descendants if their leader already exited.
    killGroup('SIGKILL');
    await Promise.race([exit,delay(1000)]);
    if(!exited) throw new Error('Owned OpenCode process did not exit');
    await rm(root,{recursive:true,force:true});
    monitor.stdin.end(JSON.stringify({done:true})+'\n');
    await Promise.race([monitorExit,delay(2000).then(()=>{throw new Error('Cleanup monitor did not exit');})]);
  };
  try {
    await Promise.race([monitorReady,delay(5000).then(()=>{throw new Error('Cleanup monitor startup timeout');})]);
    const url = await new Promise<string>((ok,fail) => {
      const lines = createInterface({input:child.stdout});
      const timer=setTimeout(()=>done(new Error('OpenCode startup timeout')),20000);
      const onAbort=()=>done(signal.reason ?? new Error('Cancelled'));
      const done=(error?:Error,value?:string)=>{ clearTimeout(timer);signal.removeEventListener('abort',onAbort);lines.close();error?fail(error):ok(value!); };
      signal.addEventListener('abort',onAbort,{once:true});
      child.once('error',()=>done(new Error('OpenCode process launch failed')));
      child.once('exit',()=>done(new Error('OpenCode exited before readiness')));
      lines.on('line', line=>{try{const value=JSON.parse(line);if(typeof value.url==='string')done(undefined,value.url);}catch{}});
    });
    child.stdout.resume();
    const parsed = new URL(url);
    if(parsed.protocol!=='http:' || parsed.hostname!=='127.0.0.1') throw new Error('Unexpected sidecar address');
    const v2Fetch=Object.assign((input:Parameters<typeof fetch>[0],init?:Parameters<typeof fetch>[1])=>{
      const target=new URL(input instanceof Request?input.url:String(input));
      if(target.origin!==parsed.origin || !target.pathname.startsWith('/api/'))throw new Error('Non-V2 request blocked; no V1 fallback');
      return fetch(input,init);
    },{preconnect:fetch.preconnect});
    const client=OpenCode.make({baseUrl:url,fetch:v2Fetch,headers:{Authorization:`Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`}});
    const info=await client.server.info({signal});
    if(info.version!==VERSION) throw new Error('V2 API runtime version mismatch');
    const location={directory:cwd};
    const verifyIsolation=async () => {
      await client.model.list({location},{signal}); // This endpoint waits for plugin activation.
      const plugins=await client.plugin.list({location},{signal});
      const active=plugins.data.filter(p=>p.state.status==='active');
      if(active.length===0 || active.some(p=>p.source.type!=='builtin' || !BUILTINS.includes(p.id ?? ''))) throw new Error('Unexpected plugin inventory');
      if(plugins.data.some(p=>p.state.status==='failed'))throw new Error('An OpenCode plugin failed initialization');
      const skills=await client.skill.list({location},{signal});
      const mcp=await client.mcp.list({location},{signal});
      if(skills.data.length || mcp.data.length) throw new Error('Ambient skills/MCP detected');
      return {plugins:active.map(p=>p.id),skills:skills.data.length,mcp:mcp.data.length};
    };
    return {client,close,pid:child.pid!,root,url,verifyIsolation};
  } catch(e) { await close(); throw e; }
}
export type Runtime = Awaited<ReturnType<typeof startRuntime>>;
