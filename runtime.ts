import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomInt } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { atomicJSON, readJSON, rootDir, hash, FileLedger } from './store.ts';
import { PiRPC } from './rpc.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const active = s => ['queued','starting','running','retrying','blocked','stalled'].includes(s);
export const statusLabels = { queued:'⏳', starting:'🚀', running:'⚙️', retrying:'🔄', blocked:'🙋', stalled:'⚠️', done:'📋', failed:'❌', stopped:'⏹️', interrupted:'⏸️', departed:'👋' };
export const clean = (text, max = 160) => String(text || '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').slice(0, max);
const names = ['胡歌','周迅','一凡','刘亦菲','张译','黄渤','倪妮','吴彦祖','刘诗诗','陈坤','舒淇','彭于晏','章子怡','高圆圆','刘德华','梁朝伟','汤唯','邓超','孙俪','雷佳音','马伊琍','秦昊','海清','姚晨','佟丽娅','段奕宏','郝蕾','袁泉','陈道明','宋佳','王凯','白宇','朱一龙','张子枫','咏梅','陶虹','梅婷','于和伟','王志文','俞飞鸿'];
const nameSurnames=['林','陈','周','苏','沈','顾','陆','许','程','孟','叶','江','宋','唐','夏','乔','温','徐','韩','谢'];
const nameCharacters=['安','宁','清','言','川','舟','禾','然','悦','遥','越','晴','晖','卓','岚','知','远','嘉','景','初'];
const generatedNames=nameSurnames.flatMap(s=>nameCharacters.flatMap(a=>nameCharacters.map(b=>s+a+b)));
export const textOf = m => typeof m?.content === 'string' ? m.content : (m?.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');

export class Team extends EventEmitter {
  constructor({ key, cwd, dir = rootDir(), maxConcurrent = 4, maxTasks = 16, maxToolFailures = 3, namePool = names, skills = false, progressMs = 60000, stallMs = 180000, timeoutMs = 1800000, fallback, rpcFactory, extraArgs = [] }) {
    for(const [label,value,min] of [['maxConcurrent',maxConcurrent,1],['maxTasks',maxTasks,0],['maxToolFailures',maxToolFailures,0],['progressMs',progressMs,1],['stallMs',stallMs,0],['timeoutMs',timeoutMs,0]])
      if(!Number.isSafeInteger(value)||value<min)throw new Error(`${label} 必须是 >= ${min} 的整数`);
    if(!Array.isArray(namePool)||namePool.some(n=>typeof n!=='string'||!clean(n,16)))throw new Error('namePool 必须是人名数组');
    if(typeof skills!=='boolean')throw new Error('skills 必须是布尔值');
    super(); this.cwd = cwd; this.dir = path.join(dir, 'teams', hash(key).slice(0, 24)); this.stateFile = path.join(this.dir, 'team.json');
    this.fileDir = path.join(dir, 'files'); this.ledger = new FileLedger(this.fileDir);
    this.releaseOwner = new FileLedger(path.join(dir,'owners')).claim(this.stateFile,{name:'Pi Friends 主会话'});
    this.maxConcurrent = maxConcurrent; this.progressMs = progressMs; this.stallMs = stallMs; this.timeoutMs = timeoutMs;
    this.maxTasks=maxTasks;this.maxToolFailures=maxToolFailures;this.namePool=namePool.map(n=>clean(n,16));this.skills=skills;
    this.rpcFactory = rpcFactory || ((args, options) => new PiRPC(args, options)); this.extraArgs = extraArgs; this.fallback=fallback;
    this.clients = new Map(); this.closed = false;
    this.agents = readJSON(this.stateFile, { agents: [] }).agents;
    for (const a of this.agents) if (active(a.status)) {
      if(a.status==='blocked'&&a.finishedAt)continue;
      // Only stop a recorded orphan after verifying its exact child identity.
      if(process.platform==='linux'&&a.pid>0){try{const env=fs.readFileSync(`/proc/${a.pid}/environ`,'utf8').split('\0');if(env.includes(`PI_FRIENDS_AGENT_ID=${a.id}`))process.kill(-a.pid,'SIGKILL');}catch{}}
      a.status = 'interrupted'; a.summary = '上次运行已中断，可继续此会话';
    }
    this.save(); this.timer = setInterval(() => this.tick(), 1000); this.timer.unref();
  }
  save() { atomicJSON(this.stateFile, { version: 1, implementation: 'pi-friends', agents: this.agents }); }
  changed(a) { this.save(); this.emit('change', a); }
  resolve(id) {
    const exact=this.agents.filter(a=>a.id===id);if(exact.length===1)return exact[0];
    const ids=this.agents.filter(a=>a.id.startsWith(id));if(ids.length===1)return ids[0];
    const names=this.agents.filter(a=>a.name===id),present=names.filter(a=>a.status!=='departed');
    if(present.length===1)return present[0];if(!present.length&&names.length===1)return names[0];
    throw new Error('请提供唯一的人名或 ID');
  }
  spawn({ task, name, provider, model, thinking, timeoutMs = this.timeoutMs, context = '', quiet = false }) {
    if (this.closed) throw new Error('Team is closed');
    if (!provider || !model) throw new Error('必须提供 provider 和 model');
    if (!task?.trim()) throw new Error('任务不能为空');
    if(!Number.isSafeInteger(timeoutMs)||timeoutMs<0)throw new Error('timeoutMs 必须是非负整数；0 表示不限时');
    if (this.maxTasks && this.agents.filter(a => active(a.status)&&!a.finishedAt).length >= this.maxTasks) throw new Error(`最多保留 ${this.maxTasks} 个待运行任务，请等待已有成员完成`);
    // Departed people no longer occupy a display name. UUIDs keep history unambiguous.
    const used = new Set(this.agents.filter(a=>a.status!=='departed').map(a => a.name));
    if(name!==undefined){name=clean(name,16);if(!name)throw new Error('人名不能为空');}
    if (name && used.has(name)) throw new Error('人名已存在，请换一个名字或继续给原成员派活');
    const choices = this.namePool.filter(n => !used.has(n));
    const generated=generatedNames.filter(n=>!used.has(n));
    if(!name&&choices.length===0&&generated.length===0)throw new Error('当前团队没有可用人名，请在 namePool 增加候选名');
    const id = randomUUID();
    const a = { id, name: name || (choices.length ? choices[randomInt(choices.length)] : generated[randomInt(generated.length)]), task, context, timeoutMs,
      provider, model, thinking, quiet, status: 'queued', summary: '等待空闲位置', createdAt: Date.now(), updatedAt: Date.now(), lastActivity: Date.now(), lastProgress: Date.now(),
      lastNotice: Date.now(), messages: [], results: [], usage: { input:0, output:0, cost:0 }, failures: 0, revision: 0, notifiedRevision: 0 };
    this.agents.push(a); this.changed(a); this.pump(); return a;
  }
  pump() {
    if (this.closed) return;
    while (this.clients.size < this.maxConcurrent) {
      const a = this.agents.find(a => a.status === 'queued'); if (!a) break;
      const starting=this.start(a),generation=a.generation;
      starting.catch(e => {if(a.generation===generation)this.fail(a, e);});
    }
  }
  async start(a) {
    delete a.settling;
    delete a.finishedAt;
    a.generation=(a.generation||0)+1;
    a.status = 'starting'; a.summary = '正在连接模型'; a.startedAt = Date.now(); a.lastActivity = Date.now(); a.lastProgress = Date.now(); a.failures = 0; a.lastError = ''; a.lastAnswer = '';
    const runDir = path.join(this.dir, a.id); fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
    const args = ['--mode','rpc','--no-extensions','-e',path.join(here,'worker.ts'),'--no-prompt-templates',
      '--provider',a.provider,'--model',a.model,'--name',a.name,'--session-dir',runDir,
      '--tools','read,edit,write,grep,find,ls,friend_report,friend_files,friend_exec',
      '--append-system-prompt',this.instructions(a), ...this.extraArgs];
    if (a.thinking !== undefined) args.push('--thinking', a.thinking);
    if (!this.skills) args.push('--no-skills');
    if (a.sessionFile && fs.existsSync(a.sessionFile)) args.push('--session', a.sessionFile);
    const rpc = this.rpcFactory(args, { cwd: this.cwd, env: { PI_FRIENDS_CHILD: '1', PI_FRIENDS_AGENT_ID:a.id, PI_FRIENDS_AGENT_NAME:a.name,
      PI_FRIENDS_FILES:this.fileDir, PI_FRIENDS_TEAM:this.stateFile } });
    this.clients.set(a.id, rpc); a.pid = rpc.process?.pid; this.changed(a);
    rpc.on('event', event => this.event(a, rpc, event));
    rpc.on('fault', error => this.fail(a, error));
    rpc.on('exit', (code, signal) => {
      if (this.clients.get(a.id) !== rpc) return;
      this.clients.delete(a.id);
      if (active(a.status)) this.fail(a, new Error(`子进程意外退出：${code ?? signal}`));
      this.pump();
    });
    // The RPC response proves that this exact provider/model was accepted.
    const model = await rpc.call('set_model', { provider:a.provider, modelId:a.model });
    if (model && (model.provider !== a.provider || model.id !== a.model)) throw new Error('子代理实际模型与指定模型不一致');
    if (a.thinking !== undefined) await rpc.call('set_thinking_level',{level:a.thinking});
    const state = await rpc.call('get_state'); a.sessionFile = state?.sessionFile || a.sessionFile;
    if (this.clients.get(a.id) !== rpc) return;
    a.status = 'running'; this.changed(a);
    const queued = a.pendingTask; delete a.pendingTask;
    if (queued) {
      await rpc.call('prompt', { message: this.messageText(queued) });
      if (queued.status === 'pending') queued.status = 'delivered';
    } else await rpc.call('prompt', { message: `任务：${a.task}\n\n相关上下文：${a.context || '没有额外历史，请按任务读取相关文件。'}` });
    for(const m of a.deferredMessages||[]) {await rpc.call('prompt',{message:this.messageText(m),streamingBehavior:m.mode});if(m.status==='pending')m.status='delivered';}
    delete a.deferredMessages;
    this.changed(a);
  }
  instructions(a) {
    return `你是独立 Pi 子代理，内部 ID ${a.id}，插件已为你分配显示人名 ${a.name}。人名不代表能力或职业，不依赖你记住或主动命名。首次行动用 friend_report 报告一句话计划；可以保留当前名字，也可自选未占用的简短人名。后续任务保留身份。\n` +
      `只处理主代理委派的任务。默认通过 read/edit/write 修改文件；这些工具共享文件占用和版本检查。先 read 再 edit/write，冲突时重新读取或先处理别的文件。不要通过 shell 绕过冲突检查。friend_exec 用于任务所需的命令，任何预计写入的文件必须在 writePaths 声明；它不是安全沙箱。\n` +
      `每个阶段变化主动用 friend_report 给一句具体进度；需要帮助时 state=blocked。不要把“工具还在运行”当成已取得进展。收到主代理消息立即遵循；收到“请更新进度”时调用报告工具，不要仅聊天。\n` +
      `不要无限重试同一个失败操作。任务结束说明：改动文件、完成内容、验证结果、未解决项；完成是交回待主代理验收。不得自行派子代理。任务通知由主代理统一处理，不自行发送设备通知。主代理上下文不会自动全文复制，必要时请求补充。`;
  }
  event(a, rpc, e) {
    if (this.clients.get(a.id) !== rpc) return;
    if (['message_update','tool_execution_start','tool_execution_end','message_start'].includes(e.type)) a.lastActivity = Date.now();
    if(e.type==='auto_retry_start') {
      a.status='retrying';a.retry={attempt:e.attempt,maxAttempts:e.maxAttempts,delayMs:e.delayMs,error:clean(e.errorMessage,120)};
      a.summary=`模型暂时不可用，${Math.ceil(e.delayMs/1000)} 秒后重试（${e.attempt}/${e.maxAttempts}）：${clean(e.errorMessage,70)}`;
      this.changed(a);
      if(this.fallback?.provider&&this.fallback?.model&&!a.fallbackUsed&&(!this.fallback.fromProvider||a.provider===this.fallback.fromProvider)&&e.attempt>=(this.fallback.afterAttempts||2)&&/429|rate.?limit/i.test(e.errorMessage||'')) {
        a.fallbackUsed=true;
        this.switchModel(a.id,this.fallback,'当前模型持续限流，按配置切换备用模型。请保留已完成的修改，继续原任务并验证。').catch(error=>this.fail(a,error));
      }
    }
    if(e.type==='auto_retry_end'&&e.success){a.status='running';a.summary='模型连接恢复，继续任务';delete a.retry;this.changed(a);}
    if (e.type === 'message_start' && e.message?.role === 'user') {
      const text = textOf(e.message);
      for (const m of a.messages) if (text.includes(`[TEAM_MESSAGE:${m.id}]`)) { m.status = 'read'; m.readAt = Date.now(); }
      this.changed(a);
    }
    if (e.type === 'tool_execution_start') {
      a.activity = `${e.toolName} ${clean(e.args?.path || e.args?.command || '',80)}`;
      this.emit('change', a);
    }
    if (e.type === 'tool_execution_end') {
      if (e.toolName === 'friend_report' && !e.isError) {
        const report = e.result?.details;
        if (report?.summary) {
          if (report.name && !a.named && !this.agents.some(other => other.id !== a.id && other.status!=='departed' && other.name === report.name)) {
            a.name = clean(report.name,16); a.named = true;
            rpc.call('set_session_name', { name:a.name }).catch(() => {});
          }
          a.summary = clean(report.summary); a.status = report.state === 'blocked' ? 'blocked' : 'running';
          a.lastProgress = Date.now(); a.lastProgressRequest = 0;
          if (a.status === 'blocked') this.notify(a, 'blocked');
        }
      }
      if (e.isError) a.failures++; else a.failures = 0;
      if (this.maxToolFailures && a.failures >= this.maxToolFailures) { this.fail(a, new Error(`连续 ${this.maxToolFailures} 次工具失败，已停止重试，等待主代理处理`)); return; }
      this.changed(a);
    }
    if (e.type === 'message_end' && e.message?.role === 'assistant') {
      const m = e.message;
      if (m.stopReason === 'error' || m.stopReason === 'aborted') a.lastError = m.errorMessage || m.stopReason;
      else a.lastError = '';
      if (textOf(m)) a.lastAnswer = textOf(m);
      if (m.usage) { a.usage.input += m.usage.input || 0; a.usage.output += m.usage.output || 0; a.usage.cost += m.usage.cost?.total || 0; }
      this.changed(a);
    }
    if (e.type === 'agent_settled') this.settle(a,rpc).catch(error=>this.fail(a,error));
  }
  async settle(a,rpc) {
    if(a.settling)return; a.settling=true;
    try {
      if(a.lastError){this.fail(a,new Error(a.lastError));return;}
      const state=await rpc.call('get_state');
      if(this.clients.get(a.id)!==rpc)return;
      a.sessionFile=state?.sessionFile||a.sessionFile;
      // A new follow-up can arrive between agent_settled and the state response.
      if(state?.isStreaming||state?.pendingMessageCount)return;
      const needsHelp=a.status==='blocked';
      a.status=needsHelp?'blocked':'done';a.summary=clean((a.lastAnswer||a.summary||'任务已结束，请主代理验收').split('\n').find(line=>line.trim())?.replace(/[`*#]/g,''));a.finishedAt=Date.now();a.revision++;
      a.results.push({at:a.finishedAt,text:a.lastAnswer||a.summary});a.results=a.results.slice(-10);
      this.clients.delete(a.id);rpc.kill();this.changed(a);this.notify(a,needsHelp?'blocked':'done');this.pump();
    } finally {delete a.settling;this.save();}
  }
  notify(a, reason) { a.updatedAt = Date.now(); a.lastNotice = Date.now(); this.emit('notice', { agent:a, reason }); this.save(); }
  fail(a,error) {
    if (!active(a.status)) return;
    a.status = 'failed'; a.summary = clean(error.message,300); a.finishedAt = Date.now(); a.revision++;
    const rpc = this.clients.get(a.id); this.clients.delete(a.id); rpc?.kill();
    this.changed(a); this.notify(a,'failed'); this.pump();
  }
  messageText(m) { return `[TEAM_MESSAGE:${m.id}]\n${m.text}`; }
  async switchModel(id,{provider,model,thinking},reason='更换模型，继续原任务') {
    if (!provider || !model) throw new Error('必须提供 provider 和 model');
    const a=this.resolve(id);if(a.status==='departed')throw new Error('该成员已离开，请重新派发给新成员');
    const rpc=this.clients.get(a.id);this.clients.delete(a.id);a.generation=(a.generation||0)+1;
    a.modelHistory||=[];a.modelHistory.push({provider:a.provider,model:a.model,at:Date.now(),reason});
    a.provider=provider;a.model=model;a.thinking=thinking;
    a.status='starting';a.summary=`切换至 ${provider}/${model}，保留原会话`;this.changed(a);this.notify(a,'modelChanged');
    if(rpc){rpc.kill();await new Promise(resolve=>{if(rpc.closed||!rpc.process?.pid){resolve();return;}const timer=setTimeout(resolve,3000);rpc.once('exit',()=>{clearTimeout(timer);resolve();});});}
    if(this.closed||a.status!=='starting')return a;
    const text=`${reason}\n原任务：${a.task}\n最近进度：${a.summary}\n额外上下文：${a.context||''}`;
    const m={id:randomUUID(),text,mode:'followUp',status:'pending',at:Date.now()};
    a.deferredMessages=a.messages.filter(m=>['pending','delivered'].includes(m.status));
    a.messages.push(m);a.pendingTask=m;a.status='queued';this.changed(a);this.pump();return a;
  }
  async message(id, text, mode = 'followUp') {
    const a = this.resolve(id); if (!text?.trim()) throw new Error('消息不能为空');
    if(a.status==='departed')throw new Error('该成员已离开，请重新派发给新成员');
    if (!['followUp','steer'].includes(mode)) throw new Error('mode must be followUp or steer');
    const m = { id:randomUUID(), text, mode, status:'pending', at:Date.now() }; a.messages.push(m);
    const rpc = this.clients.get(a.id);
    try {
      if (rpc) { await rpc.call('prompt', { message:this.messageText(m), streamingBehavior:mode }); if (m.status === 'pending') m.status = 'delivered'; }
      else {
        if(a.status==='queued'){a.deferredMessages||=[];a.deferredMessages.push(m);}
        else {a.deferredMessages=a.messages.filter(old=>old.id!==m.id&&['pending','delivered'].includes(old.status));a.pendingTask=m;a.status='queued';a.summary='等待继续原会话';this.pump();}
      }
    } catch(e) { m.status = 'rejected'; m.error = clean(e.message); this.changed(a); throw e; }
    this.changed(a); return m;
  }
  stop(id) {
    const a = this.resolve(id); if (!active(a.status)) return a;
    a.status = 'stopped'; a.summary = '主代理已停止任务，修改文件保留'; a.revision++;
    a.finishedAt=Date.now();
    a.generation=(a.generation||0)+1;
    for (const m of a.messages) if (m.status === 'pending' || m.status === 'delivered') m.status = 'cancelled';
    delete a.pendingTask;
    delete a.deferredMessages;
    const rpc = this.clients.get(a.id); this.clients.delete(a.id); rpc?.kill();
    this.changed(a); this.notify(a,'stopped'); this.pump(); return a;
  }
  depart(id, outcome = 'dismissed', reason = '') {
    const a=this.resolve(id);
    if(!['accepted','rejected','dismissed'].includes(outcome))throw new Error('未知离开原因');
    if(a.status==='departed')return a;
    if(outcome==='accepted'&&a.status!=='done')throw new Error('只能验收已完成的任务；运行中成员可使用遣散');
    a.departure={outcome,reason,at:Date.now(),previousStatus:a.status,previousSummary:a.summary};
    a.status='departed';a.finishedAt=Date.now();a.generation=(a.generation||0)+1;
    a.summary=({accepted:'验收通过',rejected:'验收失败',dismissed:'主动遣散'})[outcome]+'，已离开';
    a.revision++;a.notifiedRevision=a.revision;
    for(const m of a.messages)if(['pending','delivered'].includes(m.status))m.status='cancelled';
    delete a.pendingTask;delete a.deferredMessages;
    const rpc=this.clients.get(a.id);this.clients.delete(a.id);rpc?.kill();
    this.changed(a);this.notify(a,'departed');this.pump();return a;
  }
  tick() {
    if (this.closed) return;
    const now = Date.now();
    for (const a of this.agents) {
      if (!this.clients.has(a.id)) continue;
      const timeout=a.timeoutMs??this.timeoutMs;
      if (timeout && now - a.startedAt >= timeout) { this.fail(a,new Error('达到单次任务时间上限，已停止；可检查后继续')); continue; }
      if (this.stallMs && now - a.lastProgress >= this.stallMs && a.status !== 'stalled' && a.status !== 'blocked' && a.status !== 'retrying') {
        a.status = 'stalled'; a.summary = `${a.summary}（长时间没有阶段进展）`; this.changed(a); this.notify(a,'stalled');
      }
      if (!a.quiet && now - a.lastNotice >= this.progressMs) {
        this.notify(a,'progress');
        // One outstanding request, not an ever-growing queue of timer messages.
        if (!a.lastProgressRequest && a.status === 'running') {
          a.lastProgressRequest = now;
          this.clients.get(a.id)?.call('prompt',{ message:'[进度检查] 请在当前工具结束后的安全时机用 friend_report 更新一句具体进度；随后继续任务。', streamingBehavior:'steer' }).catch(() => {});
        }
      }
    }
    this.emit('tick');
  }
  list(includeDeparted = false) { return this.agents.filter(a=>includeDeparted||a.status!=='departed').map(a => ({ ...a, implementation:'pi-friends', files:this.ledger.list().filter(f => f.id === a.id).map(({ history,...f })=>f) })); }
  async wait(seconds = 20, signal) {
    if (this.agents.every(a => !active(a.status)||(a.status==='blocked'&&!this.clients.has(a.id))) || signal?.aborted) return this.list();
    await new Promise(resolve => {
      const done = () => { clearTimeout(timer); this.off('notice', notice); signal?.removeEventListener('abort',done); resolve(); };
      const notice = ({ reason }) => { if (['done','failed','blocked','stopped','departed'].includes(reason)) done(); };
      const timer = setTimeout(done, Math.min(Math.max(seconds,1),30)*1000); this.on('notice',notice); signal?.addEventListener('abort',done,{once:true});
    });
    return this.list();
  }
  close() {
    if (this.closed) return; this.closed = true; clearInterval(this.timer);
    for (const a of this.agents) if (active(a.status)&&!(a.status==='blocked'&&!this.clients.has(a.id))) { a.status = 'interrupted'; a.summary = '会话关闭或刷新，任务中断；可继续原会话'; }
    for (const rpc of this.clients.values()) rpc.kill(); this.clients.clear(); this.save();this.releaseOwner?.();
  }
}
