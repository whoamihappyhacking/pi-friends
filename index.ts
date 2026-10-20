import path from 'node:path';
import { Type } from 'typebox';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Text, truncateToWidth } from '@earendil-works/pi-tui';
import { Team, statusLabels, clean, StopVerificationError } from './runtime.ts';
import { FileGuard, rootDir, readJSON } from './store.ts';
import { resolveModel } from './model-config.ts';
import { liveNoticeBatch, noticeTriggersTurn } from './notices.ts';
import { renderPanel, displaySummary, terminalNotification } from './panel.ts';
import { displayName } from './identity.ts';

const busy = (a: any) => ['queued','starting','running','retrying','blocked','stalled'].includes(a.status);
const result = (data: unknown, text?: string) => ({ content:[{type:'text' as const,text:text||JSON.stringify(data)}],details:data });
const compact = (agents: any[]) => agents.map(a=>`${displayName(a)} ${statusLabels[a.status]} ${clean(a.summary)}`).join('\n') || '暂无小伙伴';
const memberResult = (a: any, data: any = a, text?: string) => {
  const details = data === a ? a : {...data,agentId:a.id,name:a.name,displayName:displayName(a)};
  const {name,...visible} = details;
  return result(details,text || `${displayName(a)}：${JSON.stringify(visible)}`);
};

export default function(pi: ExtensionAPI) {
  if (process.env.PI_FRIENDS_CHILD) return;
  let team: Team | undefined, ctxRef: ExtensionContext | undefined, guard: FileGuard | undefined, noticeTimer: ReturnType<typeof setTimeout> | undefined;
  const notices = new Map<string, any>();
  let progressPending=false;
  const workflow='[Pi Friends 内部收尾规则] 在向用户发送本轮最终总结前，先处理伙伴事务。除非用户明确要求任务在后台继续，否则等待仍在执行的伙伴；检查其结果与相关文件；对完成项调用 friends accept 或 reject，对无需继续的失败、停止和阻塞项妥善处理；最后给用户合并后的总结。派发前主 Agent 必须判断 taskType=long 或 short。向用户称呼伙伴一律使用 displayName（面板的头像+姓氏），name 仅作内部详情查询，按 UUID 区分历史同名成员。长活前 5 分钟每 2 分钟检查并向用户汇报一句，之后每 5 分钟检查并汇报一句；短活每 1 分钟检查，不向用户播报，发现卡住或重复可直接 friends stop，无需二次验证。长活停之前必须二次验证：①先 friends send 询问当前状态，等待伙伴回应或至少一轮检查后再决定，消息 delivered 不等于已回应；②判断卡死依据是工具多久没动、是否重复做同一件事，结合 lastActivityMs、toolElapsedMs、lastToolOutcome 与 interruptions，不能拿 noProgressMs（进度多久没刷新）当卡死证据，长活读大文件、写长报告时几分钟没阶段汇报是正常的；③只有确信跑偏、重复或工具长时间无响应才 stop；④lastActivityMs < 180000 表示近 3 分钟仍有活动，不许直接 stop，插件会拒绝并返回证据，确需停止时须完成前述二次验证并显式带 confirm=true；⑤stop 的 reason 必须写清询问后的结论和证据，引用上述字段或具体重复/跑偏行为。收到 checkDue 后调用 list 查看最新进度、当前工具、耗时与异常提示，依上述规则决定继续或停止。工具失败不会自动停止任务，由主 Agent 依 list 中的 failures / lastToolOutcome 判断是否继续，不能仅因失败次数自动停掉；模型调用报错、进程崩溃仍按原有错误流程处理。可随时 list/send，stop 必须遵守长短活规则；插件不会按固定时长结束任务。';
  const configFile = path.join(rootDir(),'config.json');
  let config: any = {};
  function draw() {
    if (!team || !ctxRef?.hasUI) return;
    const lines=renderPanel(team.agents);
    if(!lines.length){ctxRef.ui.setWidget('pi-friends',undefined);return;}
    if(ctxRef.mode==='tui')ctxRef.ui.setWidget('pi-friends',()=>({render:(width:number)=>lines.map(line=>truncateToWidth(line,width,'…')),invalidate(){}}),{placement:'aboveEditor'});
    else ctxRef.ui.setWidget('pi-friends', lines, {placement:'aboveEditor'});
  }
  function get(ctx: ExtensionContext) {
    ctxRef=ctx;
    if(!team) {
      config=readJSON(configFile,{});
      team=new Team({key:ctx.sessionManager.getSessionId(),cwd:ctx.cwd,
        maxConcurrent:config.maxConcurrent,maxTasks:config.maxTasks,namePool:config.namePool,skills:config.skills,
        progressMs:config.progressMs,stallMs:config.stallMs,timeoutMs:config.timeoutMs,fallback:config.fallback});
      guard=new FileGuard(team.ledger,()=>({id:`parent:${ctx.sessionManager.getSessionId()}`,name:'主 Agent'}),ctx.cwd);
      team.on('change',draw); team.on('tick',draw);
      const queueNotice=event=>{
        if(event.agent.status==='departed'){notices.delete(event.agent.id);return;}
        const notification=terminalNotification(event.agent,event.reason);
        if(notification && ctxRef?.hasUI && (event.agent.uiNotifiedRevision||0)<event.agent.revision){
          ctxRef.ui.notify(notification,event.reason==='failed'?'error':'info');
          event.agent.uiNotifiedRevision=event.agent.revision;team?.save();
        }
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
          const checkInstructions=batch.filter(e=>e.reason==='checkDue').map(e=>`\n${displayName(e.agent)}（${e.agent.id}）到检查时间：failures=${e.agent.failures || 0}，lastToolOutcome=${JSON.stringify(e.agent.lastToolOutcome || null)}；工具失败不会自动停止，调用 friends list 获取最新活动并决定是否 stop。${e.agent.taskType==='long'?'长活：主动向用户汇报一句具体进度；停止前先 send 问状态并等一轮，以工具活动而非 noProgressMs 判断，lastActivityMs < 180000 不许直接 stop，reason 必须带证据。':'短活：自己检查，不向用户播报；发现卡住或重复可直接 stop。'}`).join('');
          const text='[Pi Friends 内部事件，不向用户展示] 先处理伙伴结果，再统一回复用户。\n'+compact(batch.map(e=>e.agent))+checkInstructions+batch.filter(e=>e.reason==='done').map(e=>`\n${displayName(e.agent)} 的待验收结果：\n${(e.agent.lastAnswer||e.agent.summary).slice(0,4000)}`).join('');
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

  pi.registerTool({name:'friends',label:'Pi Friends',description:'我们自己的异步小伙伴插件。spawn 派发，list 查看进度/文件，send 干预或续派，stop 停止，wait 等待结果；accept/reject 验收后自动离队，dismiss 主动遣散；models 列出可用模型，quiet 切换汇报。人名随机且不绑定角色，称呼伙伴用 displayName（与面板一致），name 仅供内部查询；工具失败次数只供观察，不会自动停止。Provider/model 可分别指定。',
    renderShell:'self',
    renderCall(p,theme){
      const labels:any={spawn:'🤝 派出伙伴',list:'👥 查看伙伴',wait:'⏳ 等待伙伴',send:'✉️ 联系伙伴',stop:'⏹️ 停止伙伴',accept:'✅ 验收通过',reject:'❌ 验收失败',dismiss:'👋 请他离开',quiet:'🔕 调整提醒',model:'🧠 更换模型',models:'🧠 查看模型'};
      let label=p.id;
      if(p.id&&team){try{label=displayName(team.resolve(p.id));}catch{}}
      return new Text(theme.fg('muted',`${labels[p.action]||'🤝 Pi Friends'}${label?` · ${clean(label,20)}`:''}`),0,0);
    },
    renderResult(toolResult,_options,theme){
      const error=(toolResult as any).details?.error;
      return new Text(error?theme.fg('error',`❌ ${clean(error,120)}`):'',0,0);
    },
    promptSnippet:'派出异步小伙伴，查看进度、干预和继续任务',
    promptGuidelines:[
      '用户交来多项可独立完成的工作、并行能节省时间时，使用 friends spawn；单个简单修改不必派人。模型优先使用派发参数，其次本机插件配置，否则继承主会话当前模型。显式选择时同时提供 provider 和 model；thinking 可省略，不要猜测档位。名字用人名或省略让小伙伴自选。',
      '派发后向用户称呼伙伴一律使用返回的 displayName（面板头像+姓氏）；name 是详情中的完整昵称，不用于对外称呼。用成员 UUID 操作可避免离队后名字复用的歧义。工具失败不会自动停止任务，由主 Agent 依 list 中的 failures / lastToolOutcome 判断是否继续；stop 仍须遵守长短活规则。',
      'friends spawn 立即返回，不代表任务完成。将任务按文件分工，context 提供目标、约束和验收标准，避免复制全部历史。',
      '派发后主 Agent 可继续独立工作。派发前必须预判 taskType：long 长活前 5 分钟每 2 分钟检查并向用户汇报一句，之后每 5 分钟检查并汇报；short 短活每分钟检查但不播报，发现卡住或重复可直接 stop。长活停止前必须先 send 询问并等一轮，以工具多久没动/是否重复判断，不能用 noProgressMs 代替卡死证据；lastActivityMs < 180000 禁止直接 stop，确需停止须二次验证后带 confirm=true，reason 必须写清字段与具体证据。检查提醒 checkDue 会唤醒主 Agent，调用 list 查看最新进度/活动/耗时/异常并依规则决定继续或停止。插件没有任务截止时间。最终回复前等待、检查交付、验收或处理异常，再汇总。',
      '主 Agent 实际验收后必须调用 friends accept（通过）或 reject（失败），填写 reason 说明验证依据；两者都会自动让成员离开。用户要求成员离开时用 dismiss。不要将子代理自报完成直接当成验收通过；未验收保持待验收。departed 成员仅保留历史，不再续派。',
      'friends send 默认追加后续任务，mode=steer 才调整当前方向；delivered 是已送达，read 是消息已进入子代理会话。',
      '主 Agent 不要通过 bash 修改其他小伙伴正在占用的文件。遇到阻塞查看 friends list，补充要求或 stop，禁止无限轮询与盲目重派。'
    ],
    parameters:Type.Object({action:Type.Union(['spawn','list','send','stop','wait','models','quiet','model','accept','reject','dismiss'].map(s=>Type.Literal(s))),
      reason:Type.Optional(Type.String({description:'长活 stop 必填：询问并等一轮后的结论，引用活动/工具字段或重复、跑偏证据'})),confirm:Type.Optional(Type.Boolean({description:'仅用于 stop：完成长活二次验证后，明确覆盖近 3 分钟仍有活动的保护；仍须填写证据 reason'})),history:Type.Optional(Type.Boolean({description:'list 包含已离开的历史成员'})),
      task:Type.Optional(Type.String()),taskType:Type.Optional(Type.Union([Type.Literal('long'),Type.Literal('short')],{description:'spawn 必填：主 Agent 预判长活 long 或短活 short'})),name:Type.Optional(Type.String()),provider:Type.Optional(Type.String()),model:Type.Optional(Type.String()),context:Type.Optional(Type.String()),
      thinking:Type.Optional(Type.Union(['off','minimal','low','medium','high','xhigh','max'].map(s=>Type.Literal(s)))),
      quiet:Type.Optional(Type.Boolean()),id:Type.Optional(Type.String()),message:Type.Optional(Type.String()),
      timeoutMs:Type.Optional(Type.Integer({minimum:0,description:'已弃用，仅兼容旧调用；不会按固定时长停止成员任务'})),
      mode:Type.Optional(Type.Union([Type.Literal('followUp'),Type.Literal('steer')])),seconds:Type.Optional(Type.Number({minimum:1,maximum:30}))}),
    async execute(_id,p,signal,_update,ctx) {
      const t=get(ctx);
      try {
        if(p.action==='models')return result(ctx.modelRegistry.getAvailable().filter(m=>!p.provider||m.provider===p.provider).map(m=>({provider:m.provider,model:m.id,name:m.name})));
        if(p.action==='spawn'||p.action==='model') {
          if(p.action==='spawn'&&!p.taskType)throw new Error('派发前请由主 Agent 预判 taskType=long（长活）或 short（短活）');
          const {provider,model,thinking}=resolveModel(p,config,ctx.model);
          if(!ctx.modelRegistry.getAvailable().some(m=>m.provider===provider&&m.id===model))throw new Error(`未找到已配置的模型 ${provider}/${model}，请用 friends models 查询；不会偷偷换模型。`);
          if(p.action==='model')return memberResult(await t.switchModel(p.id!,{provider,model,thinking}));
          const a=t.spawn({...p,provider,model,thinking});return memberResult(a, a, `已派出 ${displayName(a)} ${statusLabels[a.status]}。称呼请用 displayName，与常驻面板一致；最终回复前处理其结果。`);
        }
        if(p.action==='send'){const a=t.resolve(p.id!);return memberResult(a,await t.message(a.id,p.message!,p.mode||'followUp'));}
        if(['accept','reject','dismiss'].includes(p.action))return memberResult(t.depart(p.id!,({accept:'accepted',reject:'rejected',dismiss:'dismissed'})[p.action],p.reason||''));
        if(p.action==='stop')return memberResult(t.stop(p.id!,p.reason,p.confirm));
        if(p.action==='quiet'){const a=t.resolve(p.id!);if(a.status==='departed')throw new Error('该成员已离开');a.quiet=p.quiet??true;t.changed(a);return memberResult(a,{id:a.id,quiet:a.quiet});}
        const all=p.action==='wait'?await t.wait(p.seconds||20,signal):t.list(p.history||!!p.id);
        const selected=p.id?all.filter(a=>a.id===t.resolve(p.id).id):all;
        t.acknowledgeChecks(selected);
        for(const row of selected){const stored=t.resolve(row.id);row.wasCheckDue=row.checkDue;row.nextCheckAt=stored.nextCheckAt;row.checkDue=false;row.lastCheckedAt=stored.lastCheckedAt;}
        for(const a of selected)if(a.revision){const stored=t.resolve(a.id);stored.notifiedRevision=a.revision;notices.delete(a.id);}
        t.save();
        const detail=selected.map(a=>({id:a.id,displayName:displayName(a),...((p.history||p.id)?{name:a.name}:{}),taskType:a.taskType,status:a.status,provider:a.provider,model:a.model,task:a.task,progress:a.summary,activity:a.activity,
          elapsedMs:a.elapsedMs,noProgressMs:a.noProgressMs,toolElapsedMs:a.toolElapsedMs,lastActivityMs:a.lastActivityMs,nextCheckAt:a.nextCheckAt,checkDue:a.checkDue,wasCheckDue:a.wasCheckDue,lastCheckedAt:a.lastCheckedAt,reportToUser:a.reportToUser,anomalies:a.anomalies,failures:a.failures,lastError:a.lastError,interruptions:a.interruptions,lastToolOutcome:a.lastToolOutcome,
          messages:a.messages.slice(-5).map(({text,...m})=>m),files:a.files||[],result:(a.lastAnswer||'').slice(0,p.id?16000:2000),sessionFile:a.sessionFile,usage:a.usage}));
        return result(selected,compact(selected)+'\n'+detail.map(a=>`${a.displayName}：${JSON.stringify(a)}`).join('\n'));
      }catch(e){
        const data={error:String(e),...(e instanceof StopVerificationError?e.details:{})};
        let a;try{if(p.id)a=t.resolve(p.id);}catch{}
        return {...(a?memberResult(a,data):result(data)),isError:true};
      }
    }
  });

  const menu=async(ctx:any)=>{
    const t=get(ctx);
    const members=t.agents.filter(a=>a.status!=='departed');
    if(!members.length){ctx.ui.notify('当前没有在队小伙伴。直接说：派两个小伙伴分别处理……','info');return;}
    const options=members.map(a=>`${displayName(a)} · ${statusLabels[a.status]} · ${displaySummary(a).slice(0,22)}`);
    const choice=await ctx.ui.select('Pi Friends',options);if(!choice)return;
    const a=members[options.indexOf(choice)];
    const action=await ctx.ui.select(`${displayName(a)} · ${a.provider}/${a.model}`,['查看详情',...(a.status==='done'?['验收通过并离开']:[]),'验收失败并离开','请他离开','补充当前要求','追加下一项任务',a.quiet?'开启进度汇报':'改为静默','停止']);
    if(action==='查看详情'){
      const files=t.ledger.list().filter(f=>f.id===a.id).map(f=>`${f.file} · ${new Date(f.at||f.since).toLocaleTimeString()}`).join('\n');
      await ctx.ui.editor(`${displayName(a)} · ${a.name} · 详情（修改此文本不会发消息）`,`ID：${a.id}\n完整人名：${a.name}\n类型：${a.taskType}\n观察：${JSON.stringify(t.inspect(a))}\n\n${a.task}\n\n${a.summary}\n模型：${a.provider}/${a.model}\n\n${a.lastAnswer||''}\n\n文件：\n${files}\n\n消息确认：\n${a.messages.map(m=>`${m.status}: ${m.text}`).join('\n')}`);
    }else if(action==='验收通过并离开'||action==='验收失败并离开'||action==='请他离开'){
      t.depart(a.id,action==='验收通过并离开'?'accepted':action==='验收失败并离开'?'rejected':'dismissed','用户在 /f 菜单中选择');
      ctx.ui.notify(`${displayName(a)} 已离开，历史记录保留`,'info');
    }else if(action==='停止'){
      const reason=a.taskType==='long'?await ctx.ui.input('停止长活：先 send 问状态并等一轮，填写结论和工具/重复/跑偏证据'):'用户在 /f 菜单中选择停止';
      if(!reason?.trim())return;
      try{t.stop(a.id,reason);}catch(error){
        if(!(error instanceof StopVerificationError)||!error.details.requiresConfirmation)throw error;
        if(await ctx.ui.confirm('该长活最近仍有活动，是否依据证据确认停止？',error.message))t.stop(a.id,reason,true);
      }
    }
    else if(action==='改为静默'||action==='开启进度汇报'){a.quiet=!a.quiet;t.changed(a);}
    else if(action){const text=await ctx.ui.input(`给 ${displayName(a)} 发消息`);if(text)await t.message(a.id,text,action==='补充当前要求'?'steer':'followUp');}
  };
  pi.registerCommand('f',{description:'Pi Friends 小伙伴列表',handler:async(_args,ctx)=>{try{await menu(ctx);}catch(error){ctx.ui.notify(`Pi Friends：${error instanceof Error?error.message:String(error)}`,'error');}}});
}
