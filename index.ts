import path from 'node:path';
import { Type } from 'typebox';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Text, truncateToWidth } from '@earendil-works/pi-tui';
import { Team, statusLabels, clean } from './runtime.ts';
import { FileGuard, rootDir, readJSON } from './store.ts';
import { resolveModel } from './model-config.ts';
import { liveNoticeBatch, noticeTriggersTurn } from './notices.ts';

const busy = (a: any) => ['queued','starting','running','retrying','blocked','stalled'].includes(a.status);
const result = (data: unknown, text?: string) => ({ content:[{type:'text' as const,text:text||JSON.stringify(data)}],details:data });
const compact = (agents: any[]) => agents.map(a=>`${clean(a.name)} ${statusLabels[a.status]} ${clean(a.summary)}`).join('\n') || '暂无小伙伴';
const displaySummary=(a:any)=>a.status==='done'?clean((a.lastAnswer||a.summary).split('\n')[0].replace(/[`*#]/g,'')):clean(a.summary);

export default function(pi: ExtensionAPI) {
  if (process.env.PI_FRIENDS_CHILD) return;
  let team: Team | undefined, ctxRef: ExtensionContext | undefined, guard: FileGuard | undefined, noticeTimer: ReturnType<typeof setTimeout> | undefined;
  const notices = new Map<string, any>();
  let progressPending=false;
  const workflow='[Pi Friends 内部收尾规则] 在向用户发送本轮最终总结前，先处理伙伴事务。除非用户明确要求任务在后台继续，否则等待仍在执行的伙伴；检查其结果与相关文件；对完成项调用 friends accept 或 reject，对无需继续的失败、停止和阻塞项妥善处理；最后只给用户一次合并后的总结。不要先总结主 Agent 自己的部分，再回来处理伙伴。常规进度只看输入框上方的面板，不要为了播报状态频繁调用 friends list。';
  const configFile = path.join(rootDir(),'config.json');
  let config: any = {};
  function draw() {
    if (!team || !ctxRef?.hasUI) return;
    const all=team.agents.filter(a=>a.status!=='departed'); const working=all.filter(busy); const done=all.filter(a=>!busy(a)).slice(-3);
    const rows=[...working,...done].slice(0,8);
    const lines=[`Pi Friends · ⚙️ ${working.length}${all.length ? ` / 👥 ${all.length}` : ''} · /f 详情`];
    for (const a of rows) {
      const age=Math.max(0,Math.floor((Date.now()-a.lastProgress)/1000));
      lines.push(`${a.name} · ${statusLabels[a.status]}${a.quiet?' · 🔕':''} · ${displaySummary(a)}${busy(a)?` · ${age}s`:''}`);
    }
    if(working.length+done.length>rows.length)lines.push(`还有 ${working.length+done.length-rows.length} 位，/f 查看`);
    if(ctxRef.mode==='tui')ctxRef.ui.setWidget('pi-friends',()=>({render:(width:number)=>lines.map(line=>truncateToWidth(line,width,'…')),invalidate(){}}),{placement:'aboveEditor'});
    else ctxRef.ui.setWidget('pi-friends', lines, {placement:'aboveEditor'});
  }
  function get(ctx: ExtensionContext) {
    ctxRef=ctx;
    if(!team) {
      config=readJSON(configFile,{});
      team=new Team({key:ctx.sessionManager.getSessionId(),cwd:ctx.cwd,
        maxConcurrent:config.maxConcurrent,maxTasks:config.maxTasks,maxToolFailures:config.maxToolFailures,namePool:config.namePool,skills:config.skills,
        progressMs:config.progressMs,stallMs:config.stallMs,timeoutMs:config.timeoutMs,fallback:config.fallback});
      guard=new FileGuard(team.ledger,()=>({id:`parent:${ctx.sessionManager.getSessionId()}`,name:'主 Agent'}),ctx.cwd);
      team.on('change',draw); team.on('tick',draw);
      const queueNotice=event=>{
        if(event.agent.status==='departed'){notices.delete(event.agent.id);return;}
        if(event.reason==='progress'){progressPending=true;return;}
        notices.set(event.agent.id,event);
        if(noticeTimer)return;
        noticeTimer=setTimeout(()=>{
          noticeTimer=undefined;
          // A queued stall/model event can outlive the member. Re-check live team
          // state at delivery time so departed members never produce ghost turns.
          const batch=liveNoticeBatch(team,[...notices.values()]);
          notices.clear();
          if(!batch.length)return;
          const important=batch.some(e=>noticeTriggersTurn(e.reason));
          const text='[Pi Friends 内部事件，不向用户展示] 先处理伙伴结果，再统一回复用户。\n'+compact(batch.map(e=>e.agent))+batch.filter(e=>e.reason==='done').map(e=>`\n${e.agent.name} 的待验收结果：\n${(e.agent.lastAnswer||e.agent.summary).slice(0,4000)}`).join('');
          pi.sendMessage({customType:'pi-friends',content:text,display:false,details:{implementation:'pi-friends',events:batch.map(e=>({id:e.agent.id,reason:e.reason}))}},
            {triggerTurn:important,deliverAs:important?'followUp':'nextTurn'});
          for(const e of batch)if(e.agent.revision)e.agent.notifiedRevision=e.agent.revision;
          team?.save();
        },500);
      };
      team.on('notice',queueNotice);
      for(const a of team.agents)if(a.revision>a.notifiedRevision)queueNotice({agent:a,reason:a.status});
    }
    return team;
  }
  pi.on('session_start',(_e,ctx)=>{get(ctx);draw();});
  pi.on('before_agent_start',(event)=>{
    if(!team)return;
    const present=team.agents.filter(a=>a.status!=='departed');if(!present.length)return;
    const message=progressPending?(progressPending=false,{customType:'pi-friends-progress',content:'[Pi Friends 内部进度，不向用户展示]\n'+compact(present.filter(a=>!a.quiet)),display:false}):undefined;
    return {systemPrompt:event.systemPrompt+'\n\n'+workflow,...(message?{message}:{})};
  });
  // This also runs between tool calls, so a newly spawned friend is covered in
  // the same agent turn. The copied context is changed only for the model call.
  pi.on('context',(event)=>{
    if(!team?.agents.some(a=>a.status!=='departed'))return;
    const messages=[...event.messages];
    for(let i=messages.length-1;i>=0;i--){
      const message:any=messages[i];if(message.role!=='user')continue;
      const content=message.content;
      if(typeof content==='string')messages[i]={...message,content:content.includes('[Pi Friends 内部收尾规则]')?content:content+'\n\n'+workflow};
      else if(Array.isArray(content)&&!content.some(c=>c.type==='text'&&c.text?.includes('[Pi Friends 内部收尾规则]')))
        messages[i]={...message,content:[...content,{type:'text',text:workflow}]};
      break;
    }
    return {messages};
  });
  pi.on('session_shutdown',()=>{if(noticeTimer)clearTimeout(noticeTimer);noticeTimer=undefined;notices.clear();team?.close();guard?.close();ctxRef?.ui.setWidget('pi-friends',undefined);team=undefined;});
  pi.on('tool_call',(e,ctx)=>{get(ctx);try{guard?.begin(e.toolCallId,e.toolName,e.input);}catch(error){return {block:true,reason:String(error)};}});
  pi.on('tool_result',e=>guard?.end(e.toolCallId,e.isError));
  pi.on('agent_settled',()=>guard?.close());

  pi.registerTool({name:'friends',label:'Pi Friends',description:'我们自己的异步小伙伴插件。spawn 派发，list 查看进度/文件，send 干预或续派，stop 停止，wait 等待结果；accept/reject 验收后自动离队，dismiss 主动遣散；models 列出可用模型，quiet 切换汇报。人名随机且不绑定角色，Provider/model 可分别指定。',
    renderShell:'self',
    renderCall(p,theme){
      const labels:any={spawn:'🤝 派出伙伴',list:'👥 查看伙伴',wait:'⏳ 等待伙伴',send:'✉️ 联系伙伴',stop:'⏹️ 停止伙伴',accept:'✅ 验收通过',reject:'❌ 验收失败',dismiss:'👋 请他离开',quiet:'🔕 调整提醒',model:'🧠 更换模型',models:'🧠 查看模型'};
      return new Text(theme.fg('muted',`${labels[p.action]||'🤝 Pi Friends'}${p.id?` · ${clean(p.id,20)}`:''}`),0,0);
    },
    renderResult(toolResult,_options,theme){
      const error=(toolResult as any).details?.error;
      return new Text(error?theme.fg('error',`❌ ${clean(error,120)}`):'',0,0);
    },
    promptSnippet:'派出异步小伙伴，查看进度、干预和继续任务',
    promptGuidelines:[
      '用户交来多项可独立完成的工作、并行能节省时间时，使用 friends spawn；单个简单修改不必派人。模型优先使用派发参数，其次本机插件配置，否则继承主会话当前模型。显式选择时同时提供 provider 和 model；thinking 可省略，不要猜测档位。名字用人名或省略让小伙伴自选。',
      'friends spawn 立即返回，不代表任务完成。将任务按文件分工，context 提供目标、约束和验收标准，避免复制全部历史。',
      '派发后主 Agent 可继续独立工作。常规状态直接看常驻面板，不要频繁 list；在准备最终回复前，除非用户明确要求后台继续，否则先 wait 伙伴、检查交付、验收或处理异常，再给用户一次合并总结。不要先总结自己的部分，再回来处理伙伴。',
      '主 Agent 实际验收后必须调用 friends accept（通过）或 reject（失败），填写 reason 说明验证依据；两者都会自动让成员离开。用户要求成员离开时用 dismiss。不要将子代理自报完成直接当成验收通过；未验收保持待验收。departed 成员仅保留历史，不再续派。',
      'friends send 默认追加后续任务，mode=steer 才调整当前方向；delivered 是已送达，read 是消息已进入子代理会话。',
      '主 Agent 不要通过 bash 修改其他小伙伴正在占用的文件。遇到阻塞查看 friends list，补充要求或 stop，禁止无限轮询与盲目重派。'
    ],
    parameters:Type.Object({action:Type.Union(['spawn','list','send','stop','wait','models','quiet','model','accept','reject','dismiss'].map(s=>Type.Literal(s))),
      reason:Type.Optional(Type.String()),history:Type.Optional(Type.Boolean({description:'list 包含已离开的历史成员'})),
      task:Type.Optional(Type.String()),name:Type.Optional(Type.String()),provider:Type.Optional(Type.String()),model:Type.Optional(Type.String()),context:Type.Optional(Type.String()),
      thinking:Type.Optional(Type.Union(['off','minimal','low','medium','high','xhigh','max'].map(s=>Type.Literal(s)))),
      quiet:Type.Optional(Type.Boolean()),id:Type.Optional(Type.String()),message:Type.Optional(Type.String()),
      timeoutMs:Type.Optional(Type.Integer({minimum:0,description:'本次成员任务超时毫秒数，0 不限时；省略使用配置'})),
      mode:Type.Optional(Type.Union([Type.Literal('followUp'),Type.Literal('steer')])),seconds:Type.Optional(Type.Number({minimum:1,maximum:30}))}),
    async execute(_id,p,signal,_update,ctx) {
      const t=get(ctx);
      try {
        if(p.action==='models')return result(ctx.modelRegistry.getAvailable().filter(m=>!p.provider||m.provider===p.provider).map(m=>({provider:m.provider,model:m.id,name:m.name})));
        if(p.action==='spawn'||p.action==='model') {
          const {provider,model,thinking}=resolveModel(p,config,ctx.model);
          if(!ctx.modelRegistry.getAvailable().some(m=>m.provider===provider&&m.id===model))throw new Error(`未找到已配置的模型 ${provider}/${model}，请用 friends models 查询；不会偷偷换模型。`);
          if(p.action==='model')return result(await t.switchModel(p.id!,{provider,model,thinking}));
          const a=t.spawn({...p,provider,model,thinking});return result(a,`已派出 ${a.name} ${statusLabels[a.status]}。进度看常驻面板；最终回复前处理其结果。`);
        }
        if(p.action==='send')return result(await t.message(p.id!,p.message!,p.mode||'followUp'));
        if(['accept','reject','dismiss'].includes(p.action))return result(t.depart(p.id!,({accept:'accepted',reject:'rejected',dismiss:'dismissed'})[p.action],p.reason||''));
        if(p.action==='stop')return result(t.stop(p.id!));
        if(p.action==='quiet'){const a=t.resolve(p.id!);if(a.status==='departed')throw new Error('该成员已离开');a.quiet=p.quiet??true;t.changed(a);return result({id:a.id,name:a.name,quiet:a.quiet});}
        const all=p.action==='wait'?await t.wait(p.seconds||20,signal):t.list(p.history||!!p.id);
        const selected=p.id?all.filter(a=>a.id===t.resolve(p.id).id):all.slice(-20);
        for(const a of selected)if(a.revision){const stored=t.resolve(a.id);stored.notifiedRevision=a.revision;notices.delete(a.id);}
        t.save();
        const detail=selected.map(a=>({id:a.id,name:a.name,status:a.status,provider:a.provider,model:a.model,task:a.task,progress:a.summary,activity:a.activity,
          messages:a.messages.slice(-5).map(({text,...m})=>m),files:a.files||[],result:(a.lastAnswer||'').slice(0,p.id?16000:2000),sessionFile:a.sessionFile,usage:a.usage}));
        return result(selected,compact(selected)+'\n'+detail.map(a=>`${a.name}：${JSON.stringify(a)}`).join('\n'));
      }catch(e){return {...result({error:String(e)}),isError:true};}
    }
  });

  const menu=async(ctx:any)=>{
    const t=get(ctx);
    const members=t.agents.filter(a=>a.status!=='departed');
    if(!members.length){ctx.ui.notify('当前没有在队小伙伴。直接说：派两个小伙伴分别处理……','info');return;}
    const options=members.map(a=>`${a.name} · ${statusLabels[a.status]} · ${displaySummary(a).slice(0,22)}`);
    const choice=await ctx.ui.select('Pi Friends',options);if(!choice)return;
    const a=members[options.indexOf(choice)];
    const action=await ctx.ui.select(`${a.name} · ${a.provider}/${a.model}`,['查看详情',...(a.status==='done'?['验收通过并离开']:[]),'验收失败并离开','请他离开','补充当前要求','追加下一项任务',a.quiet?'开启进度汇报':'改为静默','停止']);
    if(action==='查看详情'){
      const files=t.ledger.list().filter(f=>f.id===a.id).map(f=>`${f.file} · ${new Date(f.at||f.since).toLocaleTimeString()}`).join('\n');
      await ctx.ui.editor(`${a.name} · 详情（修改此文本不会发消息）`,`${a.task}\n\n${a.summary}\n模型：${a.provider}/${a.model}\n\n${a.lastAnswer||''}\n\n文件：\n${files}\n\n消息确认：\n${a.messages.map(m=>`${m.status}: ${m.text}`).join('\n')}`);
    }else if(action==='验收通过并离开'||action==='验收失败并离开'||action==='请他离开'){
      t.depart(a.id,action==='验收通过并离开'?'accepted':action==='验收失败并离开'?'rejected':'dismissed','用户在 /f 菜单中选择');
      ctx.ui.notify(`${a.name} 已离开，历史记录保留`,'info');
    }else if(action==='停止')t.stop(a.id);
    else if(action==='改为静默'||action==='开启进度汇报'){a.quiet=!a.quiet;t.changed(a);}
    else if(action){const text=await ctx.ui.input(`给 ${a.name} 发消息`);if(text)await t.message(a.id,text,action==='补充当前要求'?'steer':'followUp');}
  };
  pi.registerCommand('f',{description:'Pi Friends 小伙伴列表',handler:async(_args,ctx)=>{try{await menu(ctx);}catch(error){ctx.ui.notify(`Pi Friends：${error instanceof Error?error.message:String(error)}`,'error');}}});
}
