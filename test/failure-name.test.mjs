import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Team } from '../runtime.ts';
import { displayName } from '../identity.ts';
import { atomicJSON, hash } from '../store.ts';
import { loadExtensions } from './pi-host.mjs';

const pause=()=>new Promise(resolve=>setTimeout(resolve,20));
async function until(condition,description,ms=7000){
  const deadline=Date.now()+ms;
  while(!condition()&&Date.now()<deadline)await pause();
  assert.ok(condition(),description);
}
class Fake extends EventEmitter {
  constructor(){super();this.process={pid:0};}
  async call(type,args={}){if(type==='set_model')return {provider:args.provider,id:args.modelId};if(type==='get_state')return {};}
  kill(){this.killed=true;}
}
const failure=(rpc,i)=>rpc.emit('event',{type:'tool_execution_end',toolCallId:`failure-${i}`,toolName:'read',isError:true,
  result:{content:[{type:'text',text:`ENOENT simulated-${i}`}],details:{error:`ENOENT simulated-${i}`}}});

for(const taskType of ['short','long'])for(const legacy of [false,true]){
  test(`${taskType}: 60 consecutive tool failures keep running (${legacy?'legacy maxToolFailures=3':'default config'}), observable and persisted`,async()=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pi-friends-failures-')),clients=[],notices=[];
    const team=new Team({key:'failures',cwd:dir,dir,...(legacy?{maxToolFailures:3}:{}),rpcFactory:()=>{const rpc=new Fake();clients.push(rpc);return rpc;}});
    try{
      team.on('notice',event=>notices.push(event));
      const a=team.spawn({task:'consecutive failures',taskType,provider:'test',model:'test'});
      await until(()=>a.status==='running','member started');
      for(let i=1;i<=60;i++){
        failure(clients[0],i);
        assert.equal(a.failures,i);assert.equal(a.status,'running');assert.notEqual(clients[0].killed,true);
        assert.equal(a.lastToolOutcome.tool,'read');assert.equal(a.lastToolOutcome.failureKind,'tool');
        assert.equal(a.lastToolOutcome.error,`ENOENT simulated-${i}`);
      }
      const row=team.list()[0];
      assert.equal(row.failures,60);assert.equal(row.status,'running');assert.equal(row.displayName,displayName(a));
      assert.deepEqual(row.lastToolOutcome,a.lastToolOutcome);assert.equal(a.finishedAt,undefined);assert.equal(a.revision,0);
      const waited=await team.wait(1,AbortSignal.abort());assert.equal(waited[0].failures,60);assert.equal(waited[0].status,'running');
      const persisted=JSON.parse(fs.readFileSync(team.stateFile,'utf8')).agents[0];
      assert.equal(persisted.failures,60);assert.equal(persisted.status,'running');assert.deepEqual(persisted.lastToolOutcome,a.lastToolOutcome);
      assert.ok(!notices.some(event=>event.reason==='failed'));
      clients[0].emit('event',{type:'tool_execution_end',toolName:'read',isError:false});
      assert.equal(a.failures,0);assert.equal(a.lastToolOutcome.failureKind,null);assert.equal(a.status,'running');
    }finally{team.close();fs.rmSync(dir,{recursive:true,force:true});}
  });
}

test('model errors and unexpected child exits still fail after repeated tool failures',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pi-friends-real-errors-')),clients=[];
  const team=new Team({key:'real-errors',cwd:dir,dir,rpcFactory:()=>{const rpc=new Fake();clients.push(rpc);return rpc;}});
  try{
    const a=team.spawn({task:'model error',taskType:'long',provider:'test',model:'test'});await until(()=>a.status==='running','first started');
    for(let i=1;i<=5;i++)failure(clients[0],i);
    clients[0].emit('event',{type:'message_end',message:{role:'assistant',stopReason:'error',errorMessage:'model unavailable'}});
    clients[0].emit('event',{type:'agent_settled'});
    await until(()=>a.status==='failed','model failure still terminal');
    assert.equal(a.lastError,'model unavailable');assert.equal(a.failures,5);assert.equal(clients[0].killed,true);
    const b=team.spawn({task:'child crash',taskType:'short',provider:'test',model:'test'});await until(()=>b.status==='running','second started');
    for(let i=1;i<=5;i++)failure(clients[1],i);
    clients[1].emit('exit',17,null);assert.equal(b.status,'failed');assert.match(b.summary,/17/);assert.equal(b.failures,5);
  }finally{team.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('real friends tool: five failures stay running, all member results and reminders use panel displayName',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pi-friends-failure-name-tool-'));
  const keys=['PI_FRIENDS_HOME','PI_FRIENDS_CHILD','PI_FRIENDS_PI'],prior=keys.map(key=>process.env[key]);
  const executable=path.join(dir,'fake-pi.mjs');
  // A real RPC subprocess emits synthetic tool events; no model or current session is loaded.
  fs.writeFileSync(executable,`#!${process.execPath}
import { createInterface } from 'node:readline';
const emit=message=>process.stdout.write(JSON.stringify(message)+'\\n');
createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line);
  emit({type:'response',id:m.id,success:true,data:m.type==='set_model'?{provider:m.provider,id:m.modelId}:{}});
  if(m.type==='prompt'&&m.message.includes('simulate-five-failures')){
    for(let i=1;i<=5;i++)emit({type:'tool_execution_end',toolCallId:'read-'+i,toolName:'read',isError:true,result:{details:{error:'ENOENT simulated-'+i}}});
  }
  if(m.type==='prompt'&&m.message.includes('SIMULATE_FINISH')){
    emit({type:'message_end',message:{role:'assistant',content:'模拟完成，待主 Agent 验收',stopReason:'stop'}});
    emit({type:'agent_settled'});
  }
});
`,{mode:0o700});
  process.env.PI_FRIENDS_HOME=dir;process.env.PI_FRIENDS_PI=executable;delete process.env.PI_FRIENDS_CHILD;
  atomicJSON(path.join(dir,'config.json'),{maxToolFailures:3});
  // A saved member without displayName exercises migration of existing histories.
  const key='failure-name-tool',state=path.join(dir,'teams',hash(key).slice(0,24),'team.json');
  atomicJSON(state,{agents:[{id:'old-history',name:'历史完整名',avatar:'😀',surname:'陈',status:'departed',messages:[],results:[],usage:{},revision:0,notifiedRevision:0}]});
  let extension,menuDetails;
  const widgets=[],sent=[],notifications=[];
  const context={cwd:dir,hasUI:true,mode:'tui',sessionManager:{getSessionId:()=>key},model:{provider:'test',id:'test'},modelRegistry:{getAvailable:()=>[{provider:'test',id:'test',name:'Test model'},{provider:'test',id:'other',name:'Other model'}]},
    ui:{setWidget:(_key,widget)=>widgets.push(widget),notify:(...args)=>notifications.push(args),
      select:async(_title,options)=>options.includes('查看详情')?'查看详情':options[0],editor:async(title,text)=>{menuDetails={title,text};}}};
  try{
    const loaded=await loadExtensions([fileURLToPath(new URL('../index.ts',import.meta.url))],dir);
    assert.deepEqual(loaded.errors,[]);extension=loaded.extensions[0];loaded.runtime.sendMessage=(...args)=>sent.push(args);
    for(const handler of extension.handlers.get('session_start'))await handler({},context);
    const tool=extension.tools.get('friends').definition;
    const call=(params,signal)=>tool.execute(params.action,params,signal,()=>{},context);
    const checkMember=(out,a)=>{
      assert.ok(!out.isError,JSON.stringify(out));assert.equal(out.details.displayName,displayName(a));assert.equal(out.details.name,a.name);
      assert.ok(out.content[0].text.includes(displayName(a)));assert.ok(!out.content[0].text.includes(`"name":"${a.name}"`),'full name stays in details');
    };
    const members=[];
    for(const [taskType,name] of [['short','褚二五'],['long','内部长活名']]){
      const out=await call({action:'spawn',taskType,name,task:'simulate-five-failures'});const a=out.details;members.push(a);checkMember(out,a);
      await until(()=>a.failures===5&&a.status==='running',`${taskType} keeps running after fifth tool error`);
      assert.equal(a.lastToolOutcome.failureKind,'tool');assert.equal(a.lastToolOutcome.error,'ENOENT simulated-5');
    }
    const [short,long]=members;
    const widget=widgets.at(-1)();const panel=widget.render(160).join('\n');
    for(const a of members){assert.ok(panel.includes(a.displayName));assert.ok(!panel.includes(a.name));}
    await extension.commands.get('f').handler('',context);
    assert.ok(menuDetails.title.startsWith(short.displayName));assert.ok(menuDetails.text.includes(short.name));
    const theme={fg:(_color,text)=>text};
    assert.ok(tool.renderCall({action:'send',id:short.id},theme).render(160).join('').includes(short.displayName));
    const injected=await extension.handlers.get('before_agent_start')[0]({systemPrompt:'base'},context);
    for(const fragment of ['displayName','failures / lastToolOutcome','工具失败不会自动停止任务','confirm=true'])assert.ok(injected.systemPrompt.includes(fragment),fragment);
    const contextual=await extension.handlers.get('context')[0]({messages:[{role:'user',content:'task'}]},context);
    assert.ok(contextual.messages[0].content.includes('工具失败不会自动停止任务'));
    const guideline=tool.promptGuidelines.join('\n');assert.ok(guideline.includes('displayName'));assert.ok(guideline.includes('failures / lastToolOutcome'));
    // Wait for the production timer and notice batch, then inspect through the public tool.
    for(const a of members)a.nextCheckAt=Date.now()-1;
    await until(()=>sent.some(([message])=>message.content.includes('到检查时间')), 'checkDue delivered');
    const due=sent.find(([message])=>message.content.includes('到检查时间'))[0];
    for(const a of members){assert.ok(due.content.includes(`${a.displayName}（${a.id}）到检查时间`));assert.ok(!due.content.includes(a.name));}
    assert.match(due.content,/failures=5/);assert.match(due.content,/lastToolOutcome=.*"failureKind":"tool"/);
    const listed=await call({action:'list'});
    for(const a of members){const row=listed.details.find(row=>row.id===a.id);assert.equal(row.status,'running');assert.equal(row.failures,5);assert.equal(row.displayName,a.displayName);assert.equal(row.name,a.name);assert.equal(row.lastToolOutcome.error,'ENOENT simulated-5');}
    assert.ok(!listed.content[0].text.includes(short.name));assert.ok(!listed.content[0].text.includes(long.name));
    console.log('SIMULATED friends list RETURN '+JSON.stringify(listed));
    console.log('SIMULATED checkDue RETURN '+JSON.stringify(due));
    const waited=await call({action:'wait'},AbortSignal.abort());assert.equal(waited.details.length,2);
    for(const a of members){assert.ok(waited.content[0].text.includes(a.displayName));assert.equal(waited.details.find(row=>row.id===a.id).status,'running');}
    const history=await call({action:'list',history:true});assert.ok(history.content[0].text.includes('历史完整名'));
    const old=history.details.find(row=>row.id==='old-history');assert.equal(old.displayName,'😀陈');
    assert.equal(JSON.parse(fs.readFileSync(state,'utf8')).agents[0].displayName,'😀陈');
    checkMember(await call({action:'send',id:short.displayName,message:'请报告当前状态',mode:'steer'}),short);
    checkMember(await call({action:'quiet',id:short.id,quiet:true}),short);
    const refused=await call({action:'stop',id:long.id,reason:'只因失败五次'});
    assert.equal(refused.isError,true);assert.equal(refused.details.displayName,long.displayName);assert.ok(refused.content[0].text.startsWith(long.displayName));
    assert.ok(refused.details.error.includes(long.displayName));assert.equal(refused.details.evidence.name,long.name);assert.equal(refused.details.evidence.displayName,long.displayName);
    assert.equal(long.status,'running');
    checkMember(await call({action:'stop',id:short.id,reason:'主 Agent 主动决定停止'}),short);
    checkMember(await call({action:'dismiss',id:short.id}),short);
    checkMember(await call({action:'reject',id:long.id,reason:'主 Agent 主动判定'}),long);
    assert.equal((await call({action:'models'})).details.length,2);
    const complete=(await call({action:'spawn',taskType:'short',name:'完成内部名',task:'wait for finish'})).details;
    await until(()=>complete.status==='running','completion fixture started');
    checkMember(await call({action:'model',id:complete.id,provider:'test',model:'other'}),complete);
    await until(()=>complete.status==='running','model switch fixture restarted');
    checkMember(await call({action:'send',id:complete.id,message:'SIMULATE_FINISH'}),complete);
    await until(()=>complete.status==='done','completion fixture settled');
    await until(()=>sent.some(([message])=>message.content.includes(`${complete.displayName} 的待验收结果`)),'completion notice delivered');
    const done=sent.find(([message])=>message.content.includes(`${complete.displayName} 的待验收结果`))[0];assert.ok(!done.content.includes(complete.name));
    checkMember(await call({action:'accept',id:complete.id,reason:'检查模拟结果通过'}),complete);
    const departedError=await call({action:'send',id:complete.id,message:'should reject'});
    assert.equal(departedError.isError,true);assert.equal(departedError.details.displayName,complete.displayName);assert.ok(departedError.content[0].text.startsWith(complete.displayName));
    assert.equal(notifications.filter(([_text,kind])=>kind==='error').length,0);
    console.log('PASS real friends tool: spawn/list/wait/send/stop/accept/reject/dismiss/quiet/model; displayName matches production panel; checkDue/done reminders use displayName; legacy records migrated');
  }finally{
    for(const handler of extension?.handlers.get('session_shutdown')||[])await handler({},context);
    keys.forEach((key,i)=>{if(prior[i]===undefined)delete process.env[key];else process.env[key]=prior[i];});
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
