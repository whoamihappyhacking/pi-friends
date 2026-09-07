// Real Pi extension loader, same-process upgrade; no model calls.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {hash,atomicJSON} from '../store.ts';
const source=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const cli=fs.realpathSync(execFileSync('which',[process.env.PI_FRIENDS_PI||'pi'],{encoding:'utf8'}).trim());
let packageDir=path.dirname(cli);
while(!fs.existsSync(path.join(packageDir,'dist/core/extensions/loader.js'))){const parent=path.dirname(packageDir);if(parent===packageDir)throw Error('Pi extension loader not found');packageDir=parent;}
const {loadExtensions,clearExtensionCache}=await import(pathToFileURL(path.join(packageDir,'dist/core/extensions/loader.js')).href);
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pi-friends-reload-'));
const prior=process.env.PI_FRIENDS_HOME;process.env.PI_FRIENDS_HOME=path.join(dir,'state');
let extension;
try{
  const entry=path.join(dir,'index.ts');
  fs.writeFileSync(path.join(dir,'runtime.mjs'),'export class Team {stop(){}}');
  fs.writeFileSync(entry,"import {Team} from './runtime.mjs';export default pi=>pi.registerCommand('probe',{handler:()=>typeof new Team().depart})");
  let loaded=await loadExtensions([entry],dir);assert.equal(loaded.errors.length,0);
  assert.equal(await loaded.extensions[0].commands.get('probe').handler(),'undefined');
  fs.writeFileSync(path.join(dir,'runtime.mjs'),'export class Team {depart(){}}');
  clearExtensionCache();loaded=await loadExtensions([entry],dir);
  assert.equal(await loaded.extensions[0].commands.get('probe').handler(),'undefined','reproduces stale native module');
  for(const name of ['index.ts','runtime.ts','store.ts','rpc.ts','model-config.ts','notices.ts','worker.ts'])fs.copyFileSync(path.join(source,name),path.join(dir,name));
  const key='reload-test',state=path.join(process.env.PI_FRIENDS_HOME,'teams',hash(key).slice(0,24),'team.json');
  atomicJSON(state,{version:1,agents:['menu','tool','reject'].map(id=>({id,name:id,task:'fixture',status:'done',summary:'completed',lastAnswer:'retained result',messages:[],results:[],usage:{},revision:1,notifiedRevision:1,lastProgress:Date.now()}))});
  clearExtensionCache();loaded=await loadExtensions([entry],dir);assert.deepEqual(loaded.errors,[]);extension=loaded.extensions[0];
  const widgets=[],notifications=[];let selects=0;
  const ctx={cwd:dir,hasUI:true,mode:'rpc',sessionManager:{getSessionId:()=>key},ui:{setWidget:(_k,lines)=>widgets.push(lines),select:async(_title,options)=>selects++===0?options[0]:'请他离开',notify:(...args)=>notifications.push(args)}};
  for(const fn of extension.handlers.get('session_start')||[])await fn({},ctx);
  const before=await extension.handlers.get('before_agent_start')[0]({systemPrompt:'base'},ctx);
  assert.equal(before.message,undefined);assert.match(before.systemPrompt,/最终总结前/);assert.match(before.systemPrompt,/先处理伙伴/);
  const contextual=await extension.handlers.get('context')[0]({messages:[{role:'user',content:'用户任务'}]},ctx);
  assert.match(contextual.messages[0].content,/最终总结前/);assert.match(contextual.messages[0].content,/先处理伙伴/);
  await extension.commands.get('f').handler('',ctx);
  assert.equal(JSON.parse(fs.readFileSync(state)).agents[0].status,'departed');
  const execute=extension.tools.get('friends').definition.execute;
  for(const [id,action] of [['tool','accept'],['reject','reject']]){
    const result=await execute('call',{action,id,reason:'fixture validation'},undefined,()=>{},ctx);
    assert.ok(!result.isError,JSON.stringify(result));assert.equal(result.details.status,'departed');
  }
  assert.ok(widgets.at(-1).every(line=>!line.startsWith('menu ·')&&!line.startsWith('tool ·')));
  assert.equal(notifications.length,1);
  const sourceText=fs.readFileSync(path.join(source,'index.ts'),'utf8');
  assert.ok(!sourceText.includes('display:true'));assert.ok(!sourceText.includes('| 小伙伴 |'));
  const definition=extension.tools.get('friends').definition;assert.equal(definition.renderShell,'self');
  const theme={fg:(_color,text)=>text};assert.deepEqual(definition.renderCall({action:'spawn'},theme,{}).render(80).map(s=>s.trimEnd()),['🤝 派出伙伴']);
  assert.deepEqual(definition.renderResult({details:{}},{},theme,{}).render(80),[]);
  console.log('PASS: stale .mjs reproduced; same-process upgrade; /f dismiss; tool accept/reject; widget removal');
}finally{
  for(const fn of extension?.handlers.get('session_shutdown')||[])await fn({});
  if(prior===undefined)delete process.env.PI_FRIENDS_HOME;else process.env.PI_FRIENDS_HOME=prior;
  fs.rmSync(dir,{recursive:true,force:true});
}
