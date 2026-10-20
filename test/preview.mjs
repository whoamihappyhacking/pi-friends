import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadTS } from './pi-host.mjs';
const {renderPanel,terminalNotification}=await loadTS(fileURLToPath(new URL('../panel.ts',import.meta.url)));
const now=10000000;
const agents=[
  {avatar:'😎',surname:'陈',taskType:'short',status:'running',startedAt:now-25000,summary:'在改 debug_settings.go'},
  {avatar:'🙂',surname:'沈',taskType:'long',status:'running',startedAt:now-240000,summary:'跑全量测试 (3/5 包)'},
  {avatar:'🤓',surname:'许',taskType:'long',status:'running',startedAt:now-2280000,summary:'编译并检查回归输出'},
  {avatar:'🦊',surname:'林',taskType:'short',status:'running',startedAt:now-55000,summary:'核对文件版本与占用记录'}
];
const panel=renderPanel(agents,now);
const notices=[terminalNotification({avatar:'😇',surname:'周',taskType:'short',status:'done',summary:'删 4 个文件 + 修好端口 bug'},'done'),
  terminalNotification({avatar:'🐼',surname:'叶',taskType:'long',status:'failed',summary:'gofmt 语法错'},'failed'),
  terminalNotification({avatar:'🤠',surname:'顾',taskType:'short',status:'stopped',stopReason:'卡住了（在重复做同一件事）'},'stopped')];
const text=panel.join('\n')+'\n\n'+notices.join('\n')+'\n';
fs.writeFileSync('/tmp/pi-friends-ui-preview.txt',text);
console.log(text);
console.log('ANSI-visible output:');
console.log(text.replaceAll('\x1b','\\x1b'));
console.log('PASS preview written: /tmp/pi-friends-ui-preview.txt');
