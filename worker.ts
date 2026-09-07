import fs from 'node:fs';
import { Type } from 'typebox';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { FileLedger, FileGuard, canonical, fingerprint, readJSON } from './store.ts';

export default function(pi: ExtensionAPI) {
  if (!process.env.PI_FRIENDS_CHILD) return;
  const id = process.env.PI_FRIENDS_AGENT_ID!;
  let name = process.env.PI_FRIENDS_AGENT_NAME!;
  const ledger = new FileLedger(process.env.PI_FRIENDS_FILES);
  let guard: FileGuard;
  const result = (value: unknown) => ({ content:[{ type:'text' as const,text:JSON.stringify(value) }],details:value });
  pi.on('session_start', (_e,ctx) => { guard = new FileGuard(ledger,()=>({id,name}),ctx.cwd); });
  pi.on('tool_call',(e) => { try { guard?.begin(e.toolCallId,e.toolName,e.input); } catch(error) { return {block:true,reason:String(error)}; } });
  pi.on('tool_result',e => { guard?.end(e.toolCallId,e.isError); });
  pi.on('agent_settled',()=>guard?.close());
  pi.on('session_shutdown',()=>guard?.close());
  pi.registerTool({ name:'friend_report', label:'汇报进度', description:'设置自己的简短人名并汇报一句具体进度；需要帮助用 blocked。名字不代表角色，后续任务保留名字。',
    parameters:Type.Object({name:Type.Optional(Type.String({maxLength:16})),summary:Type.String({maxLength:240}),state:Type.Optional(Type.Union([Type.Literal('running'),Type.Literal('blocked')]))}),
    async execute(_id,p) {
      if(p.name) { const team=readJSON(process.env.PI_FRIENDS_TEAM,{agents:[]}); const self=team.agents.find(a=>a.id===id);
        if ((!self?.named || p.name === name) && !team.agents.some(a=>a.id!==id&&a.status!=='departed'&&a.name===p.name)) name=p.name; }
      return result({name,summary:p.summary,state:p.state||'running'});
    }
  });
  pi.registerTool({name:'friend_files',label:'协作文件',description:'查看谁正在占用或最近修改了哪些文件。',parameters:Type.Object({}),
    async execute() { return result(ledger.list().map(({history,...row})=>row).slice(-80)); }
  });
  pi.registerTool({name:'friend_exec',label:'任务命令',description:'执行任务所需的命令。必须声明所有预期写入的文件 writePaths；禁止借此绕过 edit/write 的版本检查。这是协作约定，不是沙箱。timeout 单位秒，默认 60，可为长命令指定更大值。',
    parameters:Type.Object({command:Type.String(),writePaths:Type.Array(Type.String()),timeout:Type.Optional(Type.Number({minimum:1}))}),
    async execute(_id,p,signal,_update,ctx) {
      const files=[...new Set(p.writePaths.map(f=>canonical(f,ctx.cwd)))].sort(); const held=[];
      try {
        for(const file of files) { const release=ledger.claim(file,{id,name}); const before=fingerprint(file); held.push({file,release,before});
          if(before!==null&&guard.seen.get(file)!==before) throw new Error(`请先 read 最新文件：${file}`); }
        const out=await pi.exec('bash',['-lc',p.command],{signal,timeout:(p.timeout||60)*1000});
        return {...result({code:out.code,stdout:out.stdout.slice(-12000),stderr:out.stderr.slice(-4000)}),isError:out.code!==0};
      } finally { for(const h of held) { try { ledger.record(h.file,{id,name},h.before,'friend_exec'); guard.seen.set(h.file,fingerprint(h.file)); } finally { h.release(); } } }
    }
  });
}
