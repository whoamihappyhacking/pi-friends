// Opt-in live integration: only the user's configured bai provider. No old extension.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Team } from '../runtime.ts';
import { atomicJSON } from '../store.ts';
const here=path.dirname(fileURLToPath(import.meta.url));
const root=fs.mkdtempSync(path.join(os.tmpdir(),'pi-friends-live-'));
const workspace=path.join(root,'site');fs.mkdirSync(workspace);
const fixtures={
  'nav.css':'.nav { display:flex; gap:0; }\n',
  'form.html':'<label>邮箱</label><input id="email" type="text">\n',
  'dialog.html':'<div id="dialog"><button>关闭</button></div>\n',
  'mobile.css':'.page { width:1200px; }\n',
};
for(const [file,content]of Object.entries(fixtures))fs.writeFileSync(path.join(workspace,file),content);
const events=[];const team=new Team({key:'live-test',cwd:workspace,dir:path.join(root,'state'),maxConcurrent:4,progressMs:60000,stallMs:180000,timeoutMs:600000,fallback:{provider:'openai-codex',model:'gpt-5.6-luna',thinking:'minimal',afterAttempts:2},extraArgs:['--no-context-files']});
team.on('notice',e=>{const item={at:Date.now(),name:e.agent.name,id:e.agent.id,status:e.agent.status,summary:e.agent.summary,reason:e.reason};events.push(item);console.log(JSON.stringify(item));});
const tasks=[
  {model:'glm-5.3-flash',task:'只修改 nav.css：把 .nav 的 gap 改成 12px；添加 @media (max-width: 640px)，其中 .nav 的 flex-direction 为 column。先 read 再 edit。用 friend_report 起一个人名并报告进度。完成后简要说明验证。'},
  {model:'qwen3.8-flash',task:'只修改 form.html：给 label 加 for="email"，input type 改成 email 并添加 required 属性。先 read 再 edit。用 friend_report 起一个人名并报告进度。不要改别的文件。'},
  {model:'glm-5.3-flash',task:'只修改 dialog.html：外层 div 添加 role="dialog" 和 aria-modal="true"，关闭按钮添加 aria-label="关闭弹窗"。先 read 再 edit。用 friend_report 起一个人名并报告进度。'},
  {model:'qwen3.8-flash',quiet:true,task:'只修改 mobile.css：把 .page 的固定宽度改为 width:100%，添加 max-width:1200px 和 box-sizing:border-box。先 read 再 edit。用 friend_report 起一个人名并报告进度。'}
];
const report={implementation:'pi-friends',root,startedAt:new Date().toISOString(),checks:{}};
try{
  const agents=tasks.map(t=>team.spawn({...t,provider:'bai'}));
  while(agents.some(a=>['queued','starting','running','retrying','blocked','stalled'].includes(a.status)))await team.wait(10);
  report.agents=team.list().map(a=>({id:a.id,name:a.name,provider:a.provider,model:a.model,modelHistory:a.modelHistory,status:a.status,summary:a.summary,sessionFile:a.sessionFile,files:a.files,usage:a.usage}));
  for(const a of agents)assert.equal(a.status,'done',`${a.name}: ${a.summary}`);
  assert.match(fs.readFileSync(path.join(workspace,'nav.css'),'utf8'),/gap:\s*12px/);
  assert.match(fs.readFileSync(path.join(workspace,'nav.css'),'utf8'),/flex-direction:\s*column/);
  assert.match(fs.readFileSync(path.join(workspace,'form.html'),'utf8'),/for="email"/);
  assert.match(fs.readFileSync(path.join(workspace,'form.html'),'utf8'),/type="email"/);
  assert.match(fs.readFileSync(path.join(workspace,'form.html'),'utf8'),/required/);
  assert.match(fs.readFileSync(path.join(workspace,'dialog.html'),'utf8'),/aria-modal="true"/);
  assert.match(fs.readFileSync(path.join(workspace,'mobile.css'),'utf8'),/width:\s*100%/);
  report.checks.parallelFrontend='passed';report.checks.providers='Started with bai (two GLM, two Qwen); user-authorized Luna fallback on repeated 429';
  const original=agents[0],oldName=original.name,sessionFile=original.sessionFile;
  assert.ok(sessionFile&&fs.existsSync(sessionFile),'child session was not saved');
  const receipt=await team.message(original.id,'继续修改你刚才处理的那个文件：为 .nav 添加 align-items:center；不要改其它文件。说出上一项任务改了什么，以确认记得上下文。');
  while(original.status!=='done'&&original.status!=='failed')await team.wait(10);
  assert.equal(original.status,'done',original.summary);assert.equal(original.name,oldName);assert.equal(original.sessionFile,sessionFile);assert.equal(receipt.status,'read');
  assert.match(fs.readFileSync(path.join(workspace,'nav.css'),'utf8'),/align-items:\s*center/);report.checks.continuation='passed; same name/session and message read';
  assert.ok(team.ledger.list().filter(f=>f.kind==='change').length>=4);report.checks.fileLedger='passed';
  assert.equal(events.filter(e=>e.id===agents[3].id&&e.reason==='progress').length,0);report.checks.quiet='passed';
  report.success=true;
}catch(e){report.success=false;report.error=e.stack;console.error(e.stack);process.exitCode=1;}
finally{report.events=events;report.finishedAt=new Date().toISOString();team.close();atomicJSON(path.join(here,'../live-report.json'),report);console.log('REPORT',path.join(here,'../live-report.json'));console.log('FIXTURES',workspace);}
