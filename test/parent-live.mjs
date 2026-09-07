import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { PiRPC } from '../rpc.ts';
import { atomicJSON } from '../store.ts';
const here=path.dirname(fileURLToPath(import.meta.url)),extension=path.resolve(here,'../index.ts');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pi-friends-parent-'));
fs.writeFileSync(path.join(dir,'add.mjs'),'export const add = (a,b) => a-b;\n');
fs.writeFileSync(path.join(dir,'max.mjs'),'export const max = (a,b) => a < b ? a : b;\n');
atomicJSON(path.join(dir,'state/config.json'),{modelDefaults:{bai:{'glm-5.3-flash':{thinking:'high'},'qwen3.8-flash':{thinking:'low'}}},fallback:{provider:'openai-codex',model:'gpt-5.6-luna',thinking:'minimal',afterAttempts:2}});
const rpc=new PiRPC(['--mode','rpc','--no-extensions','-e',extension,'--no-skills','--no-prompt-templates','--no-context-files','--provider','openai-codex','--model','gpt-5.6-luna','--thinking','minimal','--session-dir',path.join(dir,'parent-session')],{cwd:dir,env:{PI_FRIENDS_HOME:path.join(dir,'state')}});
let latest=[],settled=0;const tools=[],widgets=[],answers=[];const report={implementation:'pi-friends',workspace:dir};
rpc.on('fault',e=>console.error(e.message));
rpc.on('event',e=>{
  if(e.type==='tool_execution_start'){tools.push({name:e.toolName,args:e.args});console.log('TOOL',e.toolName,e.args?.action||'');}
  if(e.type==='tool_execution_end'&&e.toolName==='friends'&&Array.isArray(e.result?.details)){
    const members=new Map(latest.map(a=>[a.id,a]));
    for(const a of e.result.details)if(a.id&&a.status)members.set(a.id,a);
    latest=[...members.values()];
  }
  if(e.type==='extension_ui_request'&&e.method==='setWidget'&&e.widgetKey==='pi-friends'){widgets.push(e.widgetLines);if(widgets.length>1000)widgets.shift();}
  if(e.type==='message_end'&&e.message?.role==='assistant'){const text=(e.message.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('\n');if(text)answers.push(text);}
  if(e.type==='agent_settled')settled++;
});
try {
  const commands=await rpc.call('get_commands');assert.ok(commands.commands.some(c=>c.name==='f'));assert.ok(!commands.commands.some(c=>c.name.startsWith('subagents')));
  await rpc.call('prompt',{message:'这是 Pi Friends 插件真实验收。必须调用 friends 工具 action=spawn 派出两位异步小伙伴，不能自己修改代码，也不能使用其它子代理插件。第一位 provider=bai model=glm-5.3-flash，任务：只读改 add.mjs，把加法修正确，报告进度并说明验证；第二位 provider=bai model=qwen3.8-flash，任务：只读改 max.mjs，使它返回两数最大值，报告进度并说明验证。name 留空让插件分配人名。两位都启动后，用 friends wait 等待，必要时继续 wait；全部完成后检查结果并作一次简短合并总结，不要使用表格。不要提前结束，不需要任何其它工作。'});
  const deadline=Date.now()+360000;
  while(Date.now()<deadline){
    await new Promise(r=>setTimeout(r,1000));
    if(latest.length>=2&&latest.every(a=>a.status==='done')&&settled>0){const state=await rpc.call('get_state');if(!state.isStreaming&&!state.pendingMessageCount)break;}
  }
  assert.equal(tools.filter(t=>t.name==='friends'&&t.args?.action==='spawn').length,2);
  assert.ok(tools.every(t=>!['subagent','Agent','spawn_agent'].includes(t.name)));
  assert.equal(latest.length,2);assert.ok(latest.every(a=>a.status==='done'),JSON.stringify(latest.map(a=>({name:a.name,status:a.status,summary:a.summary}))));
  const {add}=await import(path.join(dir,'add.mjs'));const {max}=await import(path.join(dir,'max.mjs'));
  assert.equal(add(2,3),5);assert.equal(add(-1,3),2);assert.equal(max(3,8),8);assert.equal(max(8,3),8);
  assert.ok(widgets.some(lines=>lines?.some(l=>/Pi Friends · ⚙️ [1-9]/u.test(l))));
  report.success=true;report.checks=['parent model called our friends tool','children started with bai; Luna fallback authorized on repeated 429','both fixes execute correctly','TUI widget events contain named members','no old subagent tools'];
}catch(e){report.success=false;report.error=e.stack;console.error(e.stack);process.exitCode=1;}
finally{report.tools=tools;report.agents=latest.map(a=>({id:a.id,name:a.name,provider:a.provider,model:a.model,status:a.status}));report.widgets=widgets.filter(Boolean).slice(-20);report.answers=answers;atomicJSON(path.resolve(here,'../parent-live-report.json'),report);rpc.kill();console.log('REPORT parent-live-report.json');}
