import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { FileGuard, FileLedger, fingerprint } from '../store.ts';
import { Team } from '../runtime.ts';
import { resolveModel } from '../model-config.ts';
import { liveNoticeBatch, noticeTriggersTurn } from '../notices.ts';

test('陈旧通知不恢复已离队成员且 stalled 不主动触发幽灵轮次',()=>{
  const live={id:'live',status:'running'};
  const departed={id:'gone',status:'departed'};
  const team={agents:[live,departed]};
  assert.deepEqual(liveNoticeBatch(team,[{agent:departed,reason:'stalled'},{agent:live,reason:'done'}]),[{agent:live,reason:'done'}]);
  assert.equal(noticeTriggersTurn('stalled'),false);
  assert.equal(noticeTriggersTurn('modelChanged'),false);
  assert.equal(noticeTriggersTurn('done'),true);
  assert.equal(noticeTriggersTurn('failed'),true);
});

test('模型参数优先于配置，未配置继承主会话，无厂商分支且不覆盖显式档位',()=>{
  const config={provider:'vendor-a',model:'model-a',modelDefaults:{'vendor-a':{'model-a':{thinking:'high'}}}};
  assert.deepEqual(resolveModel({},config),{provider:'vendor-a',model:'model-a',thinking:'high'});
  assert.equal(resolveModel({thinking:'off'},config).thinking,'off');
  assert.deepEqual(resolveModel({provider:'vendor-b',model:'model-b'},config),{provider:'vendor-b',model:'model-b'});
  assert.deepEqual(resolveModel({}, {}, {provider:'current',id:'current-model'}),{provider:'current',model:'current-model'});
  assert.throws(()=>resolveModel({provider:'partial'},config),/同时指定/);
  assert.throws(()=>resolveModel(),/同时指定/);
});

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(),'pi-friends-test-'));
test('文件互斥、旧快照拒写、重新读取后可编辑，记录修改者',()=>{
  const d=temp();const file=path.join(d,'shared.css');fs.writeFileSync(file,'old');
  const ledger=new FileLedger(path.join(d,'ledger'));
  const one=new FileGuard(ledger,()=>({id:'one',name:'胡歌'}),d),two=new FileGuard(ledger,()=>({id:'two',name:'周迅'}),d);
  one.begin('r','read',{path:file});one.end('r');two.begin('r','read',{path:file});two.end('r');
  one.begin('w','edit',{path:file});assert.throws(()=>two.begin('w','edit',{path:file}),/占用/);
  fs.writeFileSync(file,'new');one.end('w');assert.throws(()=>two.begin('w','edit',{path:file}),/版本已变化/);
  two.begin('r2','read',{path:file});two.end('r2');two.begin('w2','edit',{path:file});fs.writeFileSync(file,'newer');two.end('w2');
  const log=ledger.list().find(f=>f.kind==='change');assert.equal(log.name,'周迅');assert.equal(log.history.length,2);assert.equal(log.after,fingerprint(file));
  assert.equal(ledger.list().filter(f=>f.kind==='lock').length,0);
  fs.rmSync(d,{recursive:true});
});
test('符号链接不能绕过占用',()=>{
  const d=temp();fs.writeFileSync(path.join(d,'file'),'x');fs.symlinkSync(path.join(d,'file'),path.join(d,'link'));
  const ledger=new FileLedger(path.join(d,'ledger'));const a=new FileGuard(ledger,()=>({name:'a'}),d),b=new FileGuard(ledger,()=>({name:'b'}),d);
  a.begin('r','read',{path:'file'});assert.throws(()=>b.begin('r','read',{path:'link'}),/占用/);a.close();fs.rmSync(d,{recursive:true});
});

class Fake extends EventEmitter {
  constructor(){super();this.calls=[];this.process={pid:0};}
  async call(type,args={}){this.calls.push({type,...args});if(type==='set_model')return {provider:args.provider,id:args.modelId};if(type==='get_state')return {sessionFile:'/not-created'};}
  kill(){this.killed=true;}
}
const pause=()=>new Promise(r=>setTimeout(r,10));
test('离队后复用人名，现役同名优先解析，姓名池用尽也不退回编号',async()=>{
  const d=temp(),clients=[];const t=new Team({key:'names',cwd:d,dir:d,maxConcurrent:1,maxTasks:0,namePool:['胡歌'],rpcFactory:()=>{const f=new Fake();clients.push(f);return f;}});
  try{
    const old=t.spawn({task:'old',provider:'test',model:'test'});await pause();t.depart(old.id);
    const current=t.spawn({task:'current',provider:'test',model:'test'});await pause();
    assert.equal(current.name,'胡歌');assert.equal(t.resolve('胡歌').id,current.id);assert.equal(t.resolve(old.id).id,old.id);
    const more=[1,2,3,4].map(i=>t.spawn({task:String(i),provider:'test',model:'test'}));
    assert.ok(more.every(a=>!/伙伴\d+/.test(a.name)));assert.equal(new Set([current,...more].map(a=>a.name)).size,5);
  }finally{t.close();fs.rmSync(d,{recursive:true});}
});
test('验收通过、失败、主动遣散均离队，取消消息且刷新不复活',async()=>{
  const d=temp(),clients=[];let t=new Team({key:'depart',cwd:d,dir:d,maxConcurrent:1,rpcFactory:()=>{const f=new Fake();clients.push(f);return f;}});
  try{
    const a=t.spawn({task:'a',provider:'test',model:'test'});await pause();
    assert.throws(()=>t.depart(a.id,'accepted'),/已完成/);
    clients[0].emit('event',{type:'message_end',message:{role:'assistant',content:[{type:'text',text:'result'}]}});
    clients[0].emit('event',{type:'agent_settled'});await pause();
    t.depart(a.id,'accepted','断言通过');assert.equal(t.list().length,0);assert.equal(t.list(true)[0].lastAnswer,'result');
    assert.equal(t.list(true)[0].departure.outcome,'accepted');
    await assert.rejects(t.message(a.id,'再做一点'),/已离开/);
    await assert.rejects(t.switchModel(a.id,{provider:'test',model:'other'}),/已离开/);
    const b=t.spawn({task:'b',provider:'test',model:'test'});await pause();
    const c=t.spawn({task:'c',provider:'test',model:'test'});
    const pending=await t.message(c.id,'附加要求');t.depart(c.id,'rejected','目标不符');assert.equal(pending.status,'cancelled');
    t.depart(b.id);assert.equal(clients[1].killed,true);assert.equal(t.clients.size,0);
    clients[1].emit('event',{type:'agent_settled'});assert.equal(b.status,'departed');
    const original=b.departure;t.depart(b.id);assert.equal(b.departure,original);
    t.close();t=new Team({key:'depart',cwd:d,dir:d});assert.equal(t.list().length,0);assert.equal(t.list(true).length,3);assert.equal(t.clients.size,0);
  }finally{t.close();fs.rmSync(d,{recursive:true});}
});
test('运行策略可配置，长任务不限时，不暗中限制并发或禁用技能',async()=>{
  const d=temp(),clients=[],launches=[];
  const t=new Team({key:'policy',cwd:d,dir:d,maxConcurrent:9,maxTasks:0,maxToolFailures:0,timeoutMs:1,stallMs:0,namePool:['小林'],skills:true,rpcFactory:args=>{launches.push(args);const f=new Fake();clients.push(f);return f;}});
  try{
    for(let i=0;i<9;i++)t.spawn({task:'task',provider:'test',model:'test',timeoutMs:0});
    await pause();assert.equal(clients.length,9);assert.equal(t.agents[0].name,'小林');assert.equal(new Set(t.agents.map(a=>a.name)).size,9);
    assert.ok(launches.every(args=>!args.includes('--no-skills')));
    for(let i=0;i<4;i++)clients[0].emit('event',{type:'tool_execution_end',toolName:'edit',isError:true});
    t.tick();assert.equal(t.agents[0].status,'running');
    const full='完整结果'+ 'x'.repeat(17000);
    clients[0].emit('event',{type:'message_end',message:{role:'assistant',content:[{type:'text',text:full}]}});
    assert.equal(t.agents[0].lastAnswer,full);
    for(let i=0;i<101;i++)await t.message(t.agents[0].id,`要求 ${i}`,'steer');
    assert.equal(t.agents[0].messages.length,101);
    const limited=t.spawn({task:'limited',provider:'test',model:'test'});t.stop(t.agents[1].id);await pause();limited.startedAt=0;t.tick();assert.equal(limited.status,'failed');
  }finally{t.close();fs.rmSync(d,{recursive:true});}
  assert.throws(()=>new Team({key:'invalid',maxConcurrent:0}),/maxConcurrent/);
});
test('并发排队、逐成员模型、身份稳定、消息已读、继续和中断恢复',async()=>{
  const d=temp(), clients=[];const factory=()=>{const f=new Fake();clients.push(f);return f;};
  const t=new Team({key:'test',cwd:d,dir:d,maxConcurrent:1,rpcFactory:factory});
  const a=t.spawn({task:'a',provider:'bai',model:'glm-5.3-flash'});const b=t.spawn({task:'b',provider:'bai',model:'qwen3.8-flash'});
  await pause();assert.equal(b.status,'queued');assert.equal(clients.length,1);assert.notEqual(a.name,b.name);
  const receipt=await t.message(a.id,'新要求','steer');assert.equal(receipt.status,'delivered');
  clients[0].emit('event',{type:'message_start',message:{role:'user',content:`[TEAM_MESSAGE:${receipt.id}] 新要求`}});assert.equal(receipt.status,'read');
  clients[0].emit('event',{type:'message_end',message:{role:'assistant',content:[{type:'text',text:'完成'}],stopReason:'stop'}});
  clients[0].emit('event',{type:'agent_settled'});await pause();assert.equal(b.status,'running');assert.equal(clients[1].calls[0].modelId,'qwen3.8-flash');
  const oldName=a.name;await t.message(a.id,'继续第二项');assert.equal(a.status,'queued');assert.equal(a.name,oldName);
  t.stop(b.id);await pause();assert.equal(a.status,'running');assert.match(clients[2].calls.find(c=>c.type==='prompt').message,/继续第二项/);
  t.close();const restored=new Team({key:'test',cwd:d,dir:d,rpcFactory:factory});assert.equal(restored.resolve(a.id).status,'interrupted');assert.equal(restored.resolve(a.id).name,oldName);restored.close();fs.rmSync(d,{recursive:true});
});
test('静默模式不催进度，普通模式不堆积催报消息，连续失败会停止',async()=>{
  const d=temp(),clients=[];const t=new Team({key:'test',cwd:d,dir:d,progressMs:100,rpcFactory:()=>{const f=new Fake();clients.push(f);return f;}});
  const a=t.spawn({task:'normal',provider:'test',model:'test'}),b=t.spawn({task:'quiet',quiet:true,provider:'test',model:'test'});await pause();
  a.lastNotice=0;b.lastNotice=0;t.tick();await pause();a.lastNotice=0;t.tick();
  assert.equal(clients[0].calls.filter(c=>c.message?.includes('进度检查')).length,1);assert.equal(clients[1].calls.filter(c=>c.message?.includes('进度检查')).length,0);
  for(let i=0;i<3;i++)clients[0].emit('event',{type:'tool_execution_end',toolName:'edit',isError:true});assert.equal(a.status,'failed');assert.equal(clients[0].killed,true);
  t.close();fs.rmSync(d,{recursive:true});
});
test('同一个父会话禁止重复接管，关闭后可恢复',()=>{
  const d=temp();const t=new Team({key:'owner',cwd:d,dir:d});
  assert.throws(()=>new Team({key:'owner',cwd:d,dir:d}),/占用/);t.close();
  const next=new Team({key:'owner',cwd:d,dir:d});next.close();fs.rmSync(d,{recursive:true});
});
test('限流切换备用模型，保留名字与任务，消息进入新进程',async()=>{
  const d=temp(),clients=[];const t=new Team({key:'fallback',cwd:d,dir:d,fallback:{provider:'openai-codex',model:'gpt-5.6-luna',thinking:'minimal'},rpcFactory:()=>{const f=new Fake();clients.push(f);return f;}});
  const a=t.spawn({task:'修复布局',provider:'unrelated-vendor',model:'custom-model'});await pause();const name=a.name;
  clients[0].emit('event',{type:'auto_retry_start',attempt:2,maxAttempts:5,delayMs:10000,errorMessage:'429 rate limit'});await pause();
  assert.equal(a.provider,'openai-codex');assert.equal(a.model,'gpt-5.6-luna');assert.equal(a.name,name);assert.equal(a.modelHistory[0].provider,'unrelated-vendor');assert.equal(clients[0].killed,true);
  assert.ok(clients[1].calls.some(c=>c.type==='set_thinking_level'&&c.level==='minimal'));
  assert.ok(clients[1].calls.some(c=>c.type==='prompt'&&c.message.includes('修复布局')));
  t.close();fs.rmSync(d,{recursive:true});
});
