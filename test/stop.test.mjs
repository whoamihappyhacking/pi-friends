import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Team, StopVerificationError, LONG_STOP_ACTIVITY_MS } from '../runtime.ts';
import { loadExtensions } from './pi-host.mjs';

const now=1792177000000;
const pause=()=>new Promise(resolve=>setTimeout(resolve,10));
class Fake extends EventEmitter {
  constructor(){super();this.calls=[];this.process={pid:0};}
  async call(type,args={}){this.calls.push({type,...args});if(type==='set_model')return {provider:args.provider,id:args.modelId};if(type==='get_state')return {};}
  kill(){this.killed=true;}
}
async function fixture(ctx,fn){
  ctx.mock.method(Date,'now',()=>now);
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pi-friends-stop-')),clients=[];
  const team=new Team({key:'stop',cwd:dir,dir,rpcFactory:()=>{const rpc=new Fake();clients.push(rpc);return rpc;}});
  try{await fn(team,clients);}finally{team.close();fs.rmSync(dir,{recursive:true,force:true});}
}
const spawn=(team,taskType='long')=>team.spawn({task:'verify evidence',taskType,provider:'test',model:'test'});

test('long with activity 31s ago is refused even when noProgressMs=159s; no stop side effects',ctx=>fixture(ctx,async(team,clients)=>{
  const a=spawn(team);await pause();
  a.lastActivity=now-31000;a.lastProgress=now-159000;a.toolStartedAt=now-31000;a.activity='read evidence.txt';
  a.lastToolOutcome={at:now-31000,tool:'read',failureKind:null};
  const receipt=await team.message(a.id,'请报告当前状态','steer');
  const before=JSON.stringify(a);
  assert.throws(()=>team.stop(a.id,'noProgressMs=159000，进度没刷新'),error=>{
    assert.ok(error instanceof StopVerificationError);assert.equal(error.details.requiresConfirmation,true);
    assert.equal(error.details.evidence.lastActivityMs,31000);assert.equal(error.details.evidence.noProgressMs,159000);
    assert.equal(error.details.evidence.lastToolOutcome.tool,'read');assert.match(error.message,/confirm=true/);return true;
  });
  assert.equal(JSON.stringify(a),before);assert.equal(receipt.status,'delivered');assert.equal(clients[0].killed,undefined);
  assert.equal(team.clients.get(a.id),clients[0]);
}));

test('long with tools inactive for over 3 minutes may stop with evidence; noProgressMs does not gate it',ctx=>fixture(ctx,async(team,clients)=>{
  const a=spawn(team);await pause();a.lastActivity=now-300000;a.lastProgress=now-1000;
  const out=team.stop(a.id,'已问询并等一轮；lastActivityMs=300000，工具长时间无响应');
  assert.equal(out.status,'stopped');assert.equal(clients[0].killed,true);
  assert.equal(out.stopEvidence.lastActivityMs,300000);assert.equal(out.stopEvidence.noProgressMs,1000);assert.equal(out.stopEvidence.confirmed,false);
}));

test('long activity cutoff is strictly less than 180000ms',ctx=>fixture(ctx,async(team,clients)=>{
  assert.equal(LONG_STOP_ACTIVITY_MS,180000);
  const a=spawn(team);await pause();a.lastActivity=now-179999;
  assert.throws(()=>team.stop(a.id,'工具无响应'),StopVerificationError);assert.equal(clients[0].killed,undefined);
  a.lastActivity=now-180000;assert.equal(team.stop(a.id,'已等一轮；lastActivityMs=180000，工具无响应').status,'stopped');
}));

test('short stops immediately with recent activity and without reason or confirmation',ctx=>fixture(ctx,async(team,clients)=>{
  const a=spawn(team,'short');await pause();a.lastActivity=now;
  assert.equal(team.stop(a.id).status,'stopped');assert.equal(clients[0].killed,true);assert.equal(a.stopEvidence,undefined);
  assert.equal(a.stopReason,'主代理决定停止任务');
}));

test('explicit boolean confirmation still requires a reason; confirmed stop saves evidence and a full reason',ctx=>fixture(ctx,async(team,clients)=>{
  const a=spawn(team);await pause();a.lastActivity=now-31000;
  assert.throws(()=>team.stop(a.id,'重复同一命令','true'),StopVerificationError);
  for(const reason of [undefined,'   '])assert.throws(()=>team.stop(a.id,reason,true),/reason/);
  assert.equal(a.status,'running');assert.equal(clients[0].killed,undefined);
  const reason='已 send 问询并等一轮；lastActivityMs=31000，但连续三轮重复同一失败命令；'+ '完整证据'.repeat(50);
  const out=team.stop(a.id,reason,true);assert.equal(out.status,'stopped');assert.equal(clients[0].killed,true);
  assert.equal(out.stopEvidence.confirmed,true);assert.equal(out.stopEvidence.lastActivityMs,31000);assert.equal(out.stopReason,reason);
  assert.ok(out.summary.length<=160);assert.equal(team.stop(a.id),out,'stopped members remain idempotent');
  assert.deepEqual(JSON.parse(fs.readFileSync(team.stateFile,'utf8')).agents[0].stopEvidence,out.stopEvidence);
}));

test('stale long still requires a reason; unknown last activity is protected',ctx=>fixture(ctx,async(team)=>{
  const a=spawn(team);await pause();a.lastActivity=now-300000;
  assert.throws(()=>team.stop(a.id),/reason/);assert.equal(a.status,'running');
  delete a.lastActivity;assert.throws(()=>team.stop(a.id,'没有记录'),error=>error.details.requiresConfirmation&&error.details.evidence.lastActivityMs===0);
}));

test('real isolated friends tool returns stop evidence, injects rules, and shares protection with /f',async ctx=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pi-friends-stop-tool-'));
  const keys=['PI_FRIENDS_HOME','PI_FRIENDS_CHILD','PI_FRIENDS_PI'],prior=keys.map(key=>process.env[key]);
  // This executable speaks the Pi RPC protocol without loading a model or a real session.
  const executable=path.join(dir,'fake-pi.mjs');
  fs.writeFileSync(executable,`#!${process.execPath}\nimport { createInterface } from 'node:readline';\ncreateInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);const data=m.type==='set_model'?{provider:m.provider,id:m.modelId}:{};process.stdout.write(JSON.stringify({type:'response',id:m.id,success:true,data})+'\\n');});\n`,{mode:0o700});
  process.env.PI_FRIENDS_HOME=dir;process.env.PI_FRIENDS_PI=executable;delete process.env.PI_FRIENDS_CHILD;
  let extension,menuConfirm=false,confirmCount=0;
  const notifications=[];
  const context={cwd:dir,hasUI:true,mode:'tui',sessionManager:{getSessionId:()=> 'isolated-stop'},model:{provider:'test',id:'test'},modelRegistry:{getAvailable:()=>[{provider:'test',id:'test'}]},
    ui:{setWidget(){},notify:(...args)=>notifications.push(args),input:async()=> '已问询并等一轮；lastActivityMs=31000，连续三轮重复同一失败命令',
      select:async(_title,options)=>options.includes('停止')?'停止':options[0],confirm:async()=>{confirmCount++;return menuConfirm;}}};
  try{
    const loaded=await loadExtensions([fileURLToPath(new URL('../index.ts',import.meta.url))],dir);
    assert.deepEqual(loaded.errors,[]);extension=loaded.extensions[0];loaded.runtime.sendMessage=()=>{};
    for(const handler of extension.handlers.get('session_start'))await handler({},context);
    ctx.mock.method(Date,'now',()=>now);
    const tool=extension.tools.get('friends').definition;
    assert.equal(tool.parameters.properties.confirm.type,'boolean');
    const call=params=>tool.execute(params.action,params,undefined,()=>{},context);
    const spawned=await call({action:'spawn',taskType:'long',task:'verify evidence'});assert.ok(!spawned.isError);
    const a=spawned.details;
    for(let i=0;i<100&&a.status!=='running';i++)await pause();assert.equal(a.status,'running');
    a.lastActivity=now-31000;a.lastProgress=now-159000;a.activity='read evidence.txt';a.toolStartedAt=now-31000;
    a.lastToolOutcome={at:now-31000,tool:'read',failureKind:null};
    const out=await call({action:'stop',id:a.id,reason:'noProgressMs=159000，进度没刷新'});
    assert.equal(out.isError,true);assert.equal(out.details.requiresConfirmation,true);assert.equal(out.details.evidence.lastActivityMs,31000);
    assert.match(out.content[0].text,/LONG_TASK_STOP_VERIFICATION/);assert.equal(a.status,'running');
    console.log('SIMULATED friends stop RETURN '+JSON.stringify(out));
    const send=await call({action:'send',id:a.id,message:'请报告当前状态',mode:'steer'});assert.equal(send.details.status,'delivered');
    const list=await call({action:'list',id:a.id});assert.equal(list.details[0].status,'running');assert.equal(list.details[0].lastActivityMs,31000);
    const noReason=await call({action:'stop',id:a.id,confirm:true});assert.equal(noReason.isError,true);assert.match(noReason.details.error,/reason/);
    const event={systemPrompt:'base'};
    const injected=await extension.handlers.get('before_agent_start')[0](event,context);
    for(const fragment of ['先 friends send','至少一轮','noProgressMs','lastActivityMs < 180000','confirm=true','reason 必须'])assert.ok(injected.systemPrompt.includes(fragment),fragment);
    for(const content of ['task',[{type:'text',text:'task'}]]){
      const original={role:'user',content};const transformed=await extension.handlers.get('context')[0]({messages:[original]},context);
      assert.notEqual(transformed.messages[0],original);assert.match(JSON.stringify(transformed.messages),/停之前必须二次验证/);
    }
    const menu=extension.commands.get('f').handler;
    await menu('',context);assert.equal(confirmCount,1);assert.equal(a.status,'running','cancelling /f confirmation must keep long alive');
    menuConfirm=true;await menu('',context);assert.equal(confirmCount,2);assert.equal(a.status,'stopped');assert.equal(a.stopEvidence.confirmed,true);
    console.log('SIMULATED /f stop confirmed '+JSON.stringify({status:a.status,stopReason:a.stopReason,stopEvidence:a.stopEvidence}));
    const b=(await call({action:'spawn',taskType:'long',task:'explicit tool confirmation'})).details;
    for(let i=0;i<100&&b.status!=='running';i++)await pause();assert.equal(b.status,'running');
    b.lastActivity=now-31000;
    const confirmed=await call({action:'stop',id:b.id,confirm:true,reason:'已问询并等一轮；lastActivityMs=31000，连续三轮重复同一失败命令'});
    assert.ok(!confirmed.isError);assert.equal(confirmed.details.status,'stopped');assert.equal(confirmed.details.stopEvidence.confirmed,true);
    console.log('SIMULATED friends stop confirm=true '+JSON.stringify({status:confirmed.details.status,stopReason:confirmed.details.stopReason,stopEvidence:confirmed.details.stopEvidence}));
    assert.equal(notifications.filter(([_text,kind])=>kind==='error').length,0);
  }finally{
    for(const handler of extension?.handlers.get('session_shutdown')||[])await handler({},context);
    keys.forEach((key,i)=>{if(prior[i]===undefined)delete process.env[key];else process.env[key]=prior[i];});
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
