// Real Pi worker: steering at a tool boundary, stop, then reload + continue.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Team } from '../runtime.ts';
import { atomicJSON } from '../store.ts';
const here=path.dirname(fileURLToPath(import.meta.url));
const root=fs.mkdtempSync(path.join(os.tmpdir(),'pi-friends-controls-'));
const options={key:'controls',cwd:root,dir:path.join(root,'state'),maxConcurrent:1,progressMs:60000,timeoutMs:180000,extraArgs:['--no-context-files']};
let team=new Team(options);const report={workspace:root,implementation:'pi-friends',checks:{}};
const until=async(predicate,ms=120000)=>{const deadline=Date.now()+ms;while(!predicate()){if(Date.now()>deadline)throw new Error('control test timeout');await new Promise(r=>setTimeout(r,100));}};
try{
  const a=team.spawn({provider:'openai-codex',model:'gpt-5.6-luna',thinking:'minimal',task:'这是可控干预测试。先 friend_report 汇报计划，然后必须调用 friend_exec 执行 sleep 12，writePaths=[]。该等待用于让主代理在工具执行时插入要求。等待结束后 write 创建 step.txt，原计划内容是 initial；如果收到主代理新要求优先按新要求。不要并行调用 sleep 和 write。'});
  await until(()=>a.activity?.includes('sleep 12'));
  const receipt=await team.message(a.id,'改变当前任务：step.txt 的内容必须是 revised，不能写 initial。其他要求不变。','steer');
  assert.equal(receipt.status,'delivered');
  await until(()=>['done','failed'].includes(a.status));assert.equal(a.status,'done',a.summary);assert.equal(receipt.status,'read');assert.equal(fs.readFileSync(path.join(root,'step.txt'),'utf8').trim(),'revised');
  report.checks.steer='passed; delivered during tool, read at next boundary, revised output';
  const originalName=a.name,session=a.sessionFile;
  await team.message(a.id,'测试停止：先用 friend_exec 执行 sleep 30，writePaths=[]。不要做任何文件修改。');
  await until(()=>a.activity?.includes('sleep 30'));
  const child=team.clients.get(a.id);team.stop(a.id);await until(()=>child.closed,5000);
  assert.equal(a.status,'stopped');assert.equal(fs.readFileSync(path.join(root,'step.txt'),'utf8').trim(),'revised');report.checks.stop='passed; subprocess exited, file preserved';
  team.close();team=new Team(options);const recovered=team.resolve(a.id);
  assert.equal(recovered.name,originalName);assert.equal(recovered.sessionFile,session);
  await team.message(a.id,'新的任务：先 read step.txt，然后把内容改成 revised|resumed。不要执行之前的 sleep。完成后汇报。');
  await until(()=>['done','failed'].includes(recovered.status));assert.equal(recovered.status,'done',recovered.summary);assert.equal(recovered.name,originalName);assert.equal(recovered.sessionFile,session);
  assert.equal(fs.readFileSync(path.join(root,'step.txt'),'utf8').trim(),'revised|resumed');report.checks.reloadContinuation='passed; same name and same saved Pi session';report.success=true;
}catch(e){report.success=false;report.error=e.stack;console.error(e.stack);process.exitCode=1;}
finally{report.agents=team.list().map(a=>({id:a.id,name:a.name,provider:a.provider,model:a.model,status:a.status,messages:a.messages,sessionFile:a.sessionFile}));team.close();atomicJSON(path.join(here,'../control-live-report.json'),report);console.log(JSON.stringify({success:report.success,checks:report.checks}));}
