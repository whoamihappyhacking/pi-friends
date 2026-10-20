import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { displayName } from '../identity.ts';
import { Team, nextCheckAt } from '../runtime.ts';

class Fake extends EventEmitter {
  constructor(){super();this.calls=[];this.process={pid:0};}
  async call(type,args={}){this.calls.push({type,...args});if(type==='set_model')return{provider:args.provider,id:args.modelId};if(type==='get_state')return{};}
  kill(){this.killed=true;}
}
const pause=()=>new Promise(r=>setTimeout(r,10));
const fixture=async fn=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pi-friends-policy-')),clients=[];
  const team=new Team({key:'checks',cwd:dir,dir,maxToolFailures:3,timeoutMs:1,rpcFactory:()=>{const rpc=new Fake();clients.push(rpc);return rpc;}});
  try{await fn(team,clients);}finally{team.close();fs.rmSync(dir,{recursive:true,force:true});}
};
test('timeouts and kills have separate counters; ordinary errors also never stop a task',()=>fixture(async(t,clients)=>{
  const a=t.spawn({task:'long build',taskType:'long',provider:'test',model:'test'});await pause();
  const emit=(isError,details)=>clients[0].emit('event',{type:'tool_execution_end',toolName:'friend_exec',isError,result:{details}});
  emit(true,{success:false,failureKind:'exit'}); assert.equal(a.failures,1);
  for(let i=0;i<4;i++){emit(true,{failureKind:'timeout',killed:true,timedOut:true,code:0});emit(false,{killed:true,code:0});}
  assert.equal(a.failures,1);assert.deepEqual(a.interruptions,{timeout:4,killed:4});assert.equal(a.status,'running');assert.ok(!clients[0].killed);
  emit(true,{failureKind:'exit'});assert.equal(a.failures,2);emit(true,{failureKind:'exit'});assert.equal(a.failures,3);assert.equal(a.status,'running');assert.notEqual(clients[0].killed,true);
  emit(false,{success:true});assert.equal(a.failures,0);assert.equal(a.lastToolOutcome.failureKind,null);
}));
test('legacy total timeout never stops a task; due check notifies parent once until inspection',()=>fixture(async(t,clients)=>{
  const a=t.spawn({task:'long',taskType:'long',provider:'test',model:'test'});await pause();
  const notices=[];t.on('notice',e=>notices.push(e));
  a.startedAt=Date.now()-600001;a.lastProgress=a.startedAt;a.nextCheckAt=Date.now()-1;
  t.tick();t.tick();assert.equal(a.status,'running');assert.ok(!clients[0].killed);
  assert.equal(notices.filter(e=>e.reason==='checkDue').length,1);
  assert.equal(clients[0].calls.filter(c=>c.message?.includes('进度检查')).length,0);
  const before=t.list()[0];assert.equal(before.checkDue,true);assert.equal(before.reportToUser,true);assert.ok(before.elapsedMs>=600000);assert.ok(before.anomalies.length);
  t.acknowledgeChecks([a]);assert.ok(a.nextCheckAt>Date.now());assert.equal(t.list()[0].checkDue,false);
}));
test('long checks at 2/4 minutes then 10/15; short checks every minute',()=>{
  const startedAt=1000000;
  const long={taskType:'long',startedAt};
  for(const [elapsed,next] of [[0,120000],[120000,240000],[240000,600000],[300000,600000],[600000,900000]])assert.equal(nextCheckAt(long,startedAt+elapsed),startedAt+next);
  for(const [elapsed,next] of [[0,60000],[60000,120000],[300000,360000]])assert.equal(nextCheckAt({...long,taskType:'short'},startedAt+elapsed),startedAt+next);
});
test('current tool, elapsed time and stop reason are visible; explicit stop is immediate',()=>fixture(async(t,clients)=>{
  const a=t.spawn({task:'short',taskType:'short',provider:'test',model:'test'});await pause();
  clients[0].emit('event',{type:'tool_execution_start',toolCallId:'build',toolName:'friend_exec',args:{command:'go test ./...'}});
  let row=t.list()[0];assert.match(row.activity,/go test/);assert.equal(row.reportToUser,false);assert.ok(row.toolElapsedMs>=0);
  assert.equal(t.resolve(displayName(a)).id,a.id);
  t.stop(a.id,'卡住了（在重复做同一件事）');assert.equal(a.status,'stopped');assert.match(a.stopReason,/重复/);assert.equal(clients[0].killed,true);
  const elapsed=t.inspect(a).elapsedMs;assert.equal(t.inspect(a,Date.now()+60000).elapsedMs,elapsed);
}));
