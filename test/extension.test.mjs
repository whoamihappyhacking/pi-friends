import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash, atomicJSON } from '../store.ts';
import { loadExtensions } from './pi-host.mjs';
const source=fileURLToPath(new URL('..',import.meta.url));

test('Pi loads the real parent widget; terminal notifications are once per revision across list and reload',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pi-friends-ui-')),prior=process.env.PI_FRIENDS_HOME,priorChild=process.env.PI_FRIENDS_CHILD;
  delete process.env.PI_FRIENDS_CHILD;
  process.env.PI_FRIENDS_HOME=dir;
  const key='ui',state=path.join(dir,'teams',hash(key).slice(0,24),'team.json');
  atomicJSON(state,{agents:['done','failed','stopped'].map((status,i)=>({id:status,name:`完整人名${i}`,avatar:['🙂','😎','🤓'][i],surname:['沈','陈','许'][i],taskType:'long',status,summary:'删 4 个文件 + 修好端口 bug',stopReason:'卡住了（在重复做同一件事）',messages:[],usage:{},revision:1,notifiedRevision:0}))});
  let extension;
  const notifications=[],widgets=[],sent=[];
  const ctx={cwd:dir,hasUI:true,mode:'tui',sessionManager:{getSessionId:()=>key},modelRegistry:{getAvailable:()=>[]},
    ui:{setWidget:(_key,widget)=>widgets.push(widget),notify:(...args)=>notifications.push(args)}};
  try{
    let loaded=await loadExtensions([path.join(source,'index.ts')],dir);assert.deepEqual(loaded.errors,[]);extension=loaded.extensions[0];loaded.runtime.sendMessage=(...args)=>sent.push(args);
    for(const handler of extension.handlers.get('session_start'))await handler({},ctx);
    assert.equal(widgets.at(-1),undefined);assert.equal(notifications.length,3);assert.match(notifications[0][0],/\x1b\[38;5;220m🙂沈\x1b\[39m/);
    assert.match(notifications[1][0],/\x1b\[38;5;196m😎陈\x1b\[39m/);assert.match(notifications[2][0],/我停了/);
    const tool=extension.tools.get('friends').definition;
    const list=await tool.execute('list',{action:'list'},undefined,()=>{},ctx);assert.ok(!list.isError);
    const missingType=await tool.execute('spawn',{action:'spawn',task:'test'},undefined,()=>{},ctx);assert.equal(missingType.isError,true);assert.match(missingType.details.error,/taskType/);
    for(const handler of extension.handlers.get('session_shutdown'))await handler({},ctx);extension=undefined;
    loaded=await loadExtensions([path.join(source,'index.ts')],dir);extension=loaded.extensions[0];loaded.runtime.sendMessage=(...args)=>sent.push(args);
    for(const handler of extension.handlers.get('session_start'))await handler({},ctx);
    assert.equal(notifications.length,3,'persisted UI revision prevents duplicate notifications');
    console.log('PASS real Pi parent extension loaded; done/failed/stopped notify once each; list/reload do not duplicate them');
  }finally{
    for(const handler of extension?.handlers.get('session_shutdown')||[])await handler({},ctx);
    if(priorChild===undefined)delete process.env.PI_FRIENDS_CHILD;else process.env.PI_FRIENDS_CHILD=priorChild;
    if(prior===undefined)delete process.env.PI_FRIENDS_HOME;else process.env.PI_FRIENDS_HOME=prior;fs.rmSync(dir,{recursive:true,force:true});
  }
});
test('real worker friend_exec returns isError for signal/timeout/nonzero and success for a complete command',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pi-friends-worker-'));
  const keys=['PI_FRIENDS_CHILD','PI_FRIENDS_AGENT_ID','PI_FRIENDS_AGENT_NAME','PI_FRIENDS_FILES','PI_FRIENDS_TEAM'],prior=keys.map(k=>process.env[k]);
  Object.assign(process.env,{PI_FRIENDS_CHILD:'1',PI_FRIENDS_AGENT_ID:'test',PI_FRIENDS_AGENT_NAME:'沈',PI_FRIENDS_FILES:path.join(dir,'files'),PI_FRIENDS_TEAM:path.join(dir,'team.json')});
  let extension;const ctx={cwd:dir};
  try{
    const loaded=await loadExtensions([path.join(source,'worker.ts')],dir);assert.deepEqual(loaded.errors,[]);extension=loaded.extensions[0];
    for(const handler of extension.handlers.get('session_start'))await handler({},ctx);
    const tool=extension.tools.get('friend_exec').definition;
    for(const [command,timeout,kind] of [['kill -TERM $$',undefined,'killed'],['exec sleep 30',0.05,'timeout'],['exit 8',undefined,'exit'],['printf complete',undefined,null]]){
      const out=await tool.execute('exec',{command,writePaths:[],timeout},undefined,()=>{},ctx);
      assert.equal(out.isError,kind!==null);assert.equal(out.details.success,kind===null);assert.equal(out.details.failureKind,kind);
      if(kind==='killed'||kind==='timeout'){assert.equal(out.details.killed,true);assert.notEqual(out.details.code,0);}
      console.log(`worker friend_exec ${kind||'success'}: ${JSON.stringify(out.details)}`);
    }
  }finally{
    for(const handler of extension?.handlers.get('session_shutdown')||[])await handler({},ctx);
    keys.forEach((k,i)=>{if(prior[i]===undefined)delete process.env[k];else process.env[k]=prior[i];});fs.rmSync(dir,{recursive:true,force:true});
  }
});
