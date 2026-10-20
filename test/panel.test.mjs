import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { allocateIdentity, displayName, avatars, nameSurnames } from '../identity.ts';
import { loadTS, piRequire } from './pi-host.mjs';
const { renderPanel, formatElapsed, formatHours, nameColors, terminalNotification } = await loadTS(fileURLToPath(new URL('../panel.ts',import.meta.url)));
const { visibleWidth } = await import(piRequire.resolve('@earendil-works/pi-tui'));
const strip=text=>text.replace(/\x1b\[[0-9;]*m/g,'');

test('elapsed uses five-second steps, minute-only padding and hours above 99 minutes',()=>{
  for(const [seconds,expected] of [[0,'05秒'],[5,'05秒'],[25,'25秒'],[29,'25秒'],[55,'55秒'],[59,'55秒'],[60,'01分'],[2280,'38分'],[5940,'99分'],[6000,'1时40'],[3720,'62分'],[8100,'2时15']])assert.equal(formatElapsed(seconds*1000),expected);
  assert.equal(formatHours(62),'1时02');
  // The explicit 99-minute threshold keeps actual 62-minute elapsed time as 62分.
});
test('600 avatar/surname pairs are unique; initial 20 have distinct faces and surnames',()=>{
  const agents=[];
  for(let i=0;i<600;i++)agents.push({id:String(i),status:'running',...allocateIdentity(agents)});
  assert.equal(new Set(agents.map(displayName)).size,600);
  assert.equal(new Set(agents.slice(0,20).map(a=>a.avatar)).size,20);assert.equal(new Set(agents.slice(0,20).map(a=>a.surname)).size,20);
  assert.equal(avatars.length,30);assert.equal(nameSurnames.length,20);assert.throws(()=>allocateIdentity(agents),/600/);
});
test('panel sorts long above short, aligns CJK/emoji pipes, removes title/status icons and finished members',()=>{
  const now=10000000;
  const short={id:'s',avatar:'😎',surname:'陈',status:'running',taskType:'short',startedAt:now-25000,summary:'在改 debug_settings.go'};
  const long={id:'l',avatar:'🙂',surname:'沈',status:'running',taskType:'long',startedAt:now-240000,summary:'跑全量测试 (3/5 包)'};
  const lines=renderPanel([short,long,{...long,id:'done',status:'done'},{...short,id:'fail',status:'failed'},{...long,id:'blocked',status:'blocked',finishedAt:now}],now);
  assert.equal(lines.length,2);assert.match(lines[0],/🙂沈/);assert.match(lines[1],/😎陈/);
  assert.ok(lines[0].startsWith(nameColors.long));assert.ok(lines[1].startsWith(nameColors.short));
  assert.equal(strip(lines[0]),'🙂沈 | 04分 | 跑全量测试 (3/5 包)');assert.equal(strip(lines[1]),'😎陈 | 25秒 | 在改 debug_settings.go');
  const positions=lines.map(line=>strip(line).split('|').slice(0,2).map((_,i)=>visibleWidth(strip(line).split('|').slice(0,i+1).join('|'))));
  assert.deepEqual(positions[0],positions[1]);assert.equal(visibleWidth('🙂沈'),4);
  assert.ok(lines.every(line=>!/[⏳🚀⚙🔄🙋⚠📋❌⏹👋🔕]/u.test(line)&&!line.includes('Pi Friends')&&!line.includes('/f')));
  assert.deepEqual(renderPanel([{...long,status:'done'}],now),[]);
});
test('only the name gets color; done gold and failure red are in one-shot notification text',()=>{
  const a={avatar:'🙂',surname:'沈',taskType:'long',summary:'删 4 个文件 + 修好端口 bug'};
  for(const [status,color] of [['done',nameColors.done],['failed',nameColors.failed]]){
    const notice=terminalNotification({...a,status},status);assert.ok(notice.includes(`${color}🙂沈\x1b[39m`));assert.equal((notice.match(/\x1b\[/g)||[]).length,2);
  }
  assert.match(strip(terminalNotification({...a,status:'stopped',stopReason:'卡住了（在重复做同一件事）'},'stopped')),/我停了/);
});
test('hour rows keep both pipes aligned with minute rows',()=>{
  const now=10000000,a={avatar:'🙂',surname:'沈',status:'running',taskType:'long',summary:'运行'};
  const lines=renderPanel([{...a,startedAt:now-6000000},{...a,avatar:'😎',surname:'陈',startedAt:now-60000}],now).map(strip);
  const pipes=lines.map(line=>visibleWidth(line.slice(0,line.lastIndexOf('|'))));assert.equal(pipes[0],pipes[1]);
});
