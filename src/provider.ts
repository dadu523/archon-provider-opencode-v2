import type { IAgentProvider, SendQueryOptions, ProviderChunk, ProviderCapabilities } from '@archon/provider-contract';
import { truncateToolOutput } from '@archon/provider-contract';
import type { ProviderPluginDescriptor } from '@archon/provider-contract/plugin';
import { Ajv } from 'ajv';
import { startRuntime, type Runtime, type RuntimeConfig } from './runtime';

export const capabilities: ProviderCapabilities = {
  backgroundWork:'unobserved', sessionResume:false, sessionFork:false,
  mcp:false,hooks:false,skills:false,plugins:false,agents:false,toolRestrictions:false,
  structuredOutput:'best-effort',requiresAllPropertiesRequired:false,envInjection:false,
  costControl:false,costReporting:false,tokenReporting:false,stopReasonReporting:false,
  turnCountReporting:false,resolvedModelReporting:true,effortControl:false,fallbackModel:false,
  sandbox:false,settingSources:false,nativeTools:false,containerExec:false,
};
export const descriptor: ProviderPluginDescriptor = {
  protocol:1,id:'opencode-v2',displayName:'OpenCode V2',version:'0.1.0',capabilities,
  credentials:{kind:'static',specs:[]},
  configSchema:{type:'object',additionalProperties:false,properties:{
    binary:{type:'string'}, timeoutMs:{type:'integer',minimum:1000,maximum:600000},
  }},
};
let busy=false;
export function validateOptions(resume: string|undefined,o:SendQueryOptions) {
  if(resume || o.forkSession) throw new Error('Session resume/fork is unsupported');
  if(o.execContext?.kind==='container') throw new Error('Container execution is unsupported');
  if(o.nativeTools?.length || o.fallbackModel || o.maxBudgetUsd!==undefined) throw new Error('Native tools, fallback and budget control are unsupported');
  const n=o.nodeConfig ?? {};
  for(const key of ['mcp','hooks','skills','plugins','agents','allowed_tools','denied_tools','pi','effort','sandbox','betas','fallbackModel','settingSources','maxBudgetUsd']) {
    if(n[key]!==undefined) throw new Error(`Unsupported node capability: ${key}`);
  }
  if(!o.model || !/^opencode-go\/[^/#\s]+$/.test(o.model)) throw new Error('An exact opencode-go/model id is required');
  const cfg=o.assistantConfig ?? {};
  for(const key of Object.keys(cfg)) if(!['binary','timeoutMs'].includes(key)) throw new Error(`Unsupported provider option: ${key}`);
  if(cfg.binary!==undefined && (typeof cfg.binary!=='string' || !cfg.binary.startsWith('/'))) throw new Error('binary must be absolute');
  if(cfg.timeoutMs!==undefined && (!Number.isInteger(cfg.timeoutMs) || Number(cfg.timeoutMs)<1000 || Number(cfg.timeoutMs)>600000)) throw new Error('Invalid timeoutMs');
}
export class Provider implements IAgentProvider {
  getType(){return descriptor.id;}
  getCapabilities(){return capabilities;}
  async checkCredential(){return {state:'not_checked',source:'native'} as const;}
  async *sendQuery(prompt:string,cwd:string,resume?:string,o:SendQueryOptions={}):AsyncGenerator<ProviderChunk> {
    let runtime:Runtime|undefined;
    let sessionID:string|undefined;
    let result:Extract<ProviderChunk,{type:'result'}>={type:'result'};
    const tools=new Set<string>();
    const toolNames=new Map<string,string>();
    const abort=new AbortController();
    const cfg=(o.assistantConfig??{}) as RuntimeConfig;
    const timer=setTimeout(()=>abort.abort(new DOMException('Provider timeout','TimeoutError')),cfg.timeoutMs??180000);
    const onAbort=()=>abort.abort(o.abortSignal?.reason);
    o.abortSignal?.addEventListener('abort',onAbort,{once:true});
    if(o.abortSignal?.aborted) onAbort();
    let acquired=false;
    let cancelled=false;
    let dispatched=false, observedTerminal=false;
    let observationError:unknown;
    let streamAbort:AbortController|undefined;
    try {
      validateOptions(resume,o);
      if(busy) throw new Error('Only one foreground session is supported');
      busy=true; acquired=true;
      abort.signal.throwIfAborted();
      const rawSystem=o.systemPrompt ?? o.nodeConfig?.systemPrompt;
      if(rawSystem && typeof rawSystem==='object' && !Array.isArray(rawSystem)) throw new Error('Claude system-prompt presets are unsupported');
      const system=((Array.isArray(rawSystem)?rawSystem.join('\n\n'):rawSystem) ?? 'Complete the supplied Archon workflow step.')+'\nUse foreground tools only. Do not delegate, invoke other coding agents, or start background processes.';
      const format=o.outputFormat ?? (o.nodeConfig?.output_format ? {type:'json_schema',schema:o.nodeConfig.output_format} : undefined);
      const validator=format?new Ajv({strict:false,allErrors:true}).compile(format.schema):undefined;
      runtime=await startRuntime(cwd,system,cfg,abort.signal);
      const c=runtime.client;
      const [providerID,id]=o.model!.split('/');
      const session=await c.session.create({location:{directory:cwd},agent:'factory',model:{providerID:providerID!,id:id!},title:'Archon opencode-v2 experiment'},{signal:abort.signal});
      sessionID=session.id;
      await runtime.verifyIsolation();
      if(session.model?.providerID!==providerID || session.model?.id!==id) throw new Error('Session selected a different model');
      streamAbort=new AbortController();
      const streamSignal=AbortSignal.any([abort.signal,streamAbort.signal]);
      const events=c.event.subscribe({signal:streamSignal})[Symbol.asyncIterator]();
      const first=await events.next();
      if(first.done || first.value.type!=='server.connected') throw new Error('V2 event handshake failed');
      const text=format?`${prompt}\n\nReturn your final answer as ONLY a JSON value matching this JSON Schema, without markdown fences:\n${JSON.stringify(format.schema)}`:prompt;
      dispatched=true;
      const inbox=await c.session.prompt({sessionID,text},{signal:abort.signal});
      let delivered=false,terminal=false,wholeText='',resolved=false;
      let textMessage='';
      const seen=new Set<string>();
      yield {type:'state_update',state:'running'};
      while(!terminal) {
        const next=await events.next();
        if(next.done) throw new Error('V2 observation ended before execution terminal');
        const ev=next.value;
        if(!('data' in ev) || !('sessionID' in ev.data) || ev.data.sessionID!==sessionID) continue;
        if('id' in ev) {if(seen.has(ev.id))continue;seen.add(ev.id);}
        if(ev.type==='session.inbox.delivered' && ev.data.inboxID===inbox.id) delivered=true;
        if(!delivered) continue;
        switch(ev.type) {
          case 'session.step.started':
            if(ev.data.model.providerID!==providerID || ev.data.model.id!==id) throw new Error('Runtime model fallback detected');
            resolved=true;break;
          case 'session.text.ended':
            if(ev.data.text){if(textMessage!==ev.data.assistantMessageID){wholeText='';textMessage=ev.data.assistantMessageID;}wholeText+=ev.data.text;yield {type:'agent_message_chunk',text:ev.data.text};}break;
          case 'session.reasoning.ended':
            if(ev.data.text) yield {type:'agent_thought_chunk',text:ev.data.text};break;
          case 'session.tool.input.started':toolNames.set(ev.data.id,ev.data.name);break;
          case 'session.tool.called':
            if(tools.has(ev.data.id))throw new Error('Duplicate tool call');
            tools.add(ev.data.id);yield {type:'tool_call',toolCallId:ev.data.id,name:toolNames.get(ev.data.id)??'unknown',rawInput:ev.data.input};break;
          case 'session.tool.success':
          case 'session.tool.failed':
            if(!tools.delete(ev.data.id))throw new Error('Unpaired tool result');
            yield {type:'tool_call_update',toolCallId:ev.data.id,status:ev.type==='session.tool.success'?'completed':'failed',...truncateToolOutput(ev.type==='session.tool.failed'?ev.data.error.message:ev.data.content.filter(x=>x.type==='text').map(x=>x.text).join('\n'))};break;
          case 'permission.asked': case 'form.created': throw new Error('Unattended session requires user action');
          case 'session.execution.succeeded':terminal=true;break;
          case 'session.execution.failed':
            result={type:'result',isError:true,failure:{class:ev.data.error.status===401||ev.data.error.status===403?'auth':'unknown',evidence:ev.data.error.type+(ev.data.error.status?` HTTP ${ev.data.error.status}`:'') }};
            terminal=true;break;
          case 'session.execution.interrupted':throw new Error('V2 execution interrupted before completion');
        }
      }
      observedTerminal=true;
      if(tools.size)throw new Error('Execution terminal with unfinished tools');
      result.text=wholeText;
      if(resolved)result.resolvedModel={id:o.model!};
      if(validator && !result.isError) {
        try {const data=JSON.parse(wholeText.trim().replace(/^```(?:json)?\s*|\s*```$/g,''));if(!validator(data))throw new Error('Schema mismatch');result.structuredOutput=data;}
        catch {result.isError=true;result.failure={class:'unknown',evidence:'Final response did not satisfy the requested JSON schema'};}
      }
    } catch(e) {
      cancelled=abort.signal.aborted;
      if(dispatched && !observedTerminal)observationError=e;
      result={type:'result',isError:true,failure:{class:runtime?'unknown':'misconfigured',evidence:e instanceof Error?e.message:'Provider failed'}};
    } finally {
      clearTimeout(timer);o.abortSignal?.removeEventListener('abort',onAbort);
      streamAbort?.abort();
      if(runtime) {
        if(sessionID) {try {await runtime.client.session.interrupt({sessionID},{signal:AbortSignal.timeout(3000)});}catch{}}
        try {await runtime.close();}finally {if(acquired)busy=false;}
      }
      if(acquired)busy=false;
    }
    for(const toolCallId of tools) yield {type:'tool_call_update',toolCallId,status:'cancelled'};
    if(cancelled) throw abort.signal.reason;
    if(observationError) throw observationError;
    yield result;
    yield {type:'settled'};
  }
}
