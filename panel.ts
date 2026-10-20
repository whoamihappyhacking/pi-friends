import { visibleWidth } from '@earendil-works/pi-tui';
import { displayName } from './identity.ts';

export const nameColors = { long:'\x1b[38;5;28m', short:'\x1b[38;5;120m', done:'\x1b[38;5;220m', failed:'\x1b[38;5;196m' };
export const activeAgent = a => ['queued','starting','running','retrying','blocked','stalled'].includes(a.status) && !a.finishedAt;
export const formatHours = (minutes: number) => `${Math.floor(minutes/60)}时${String(minutes%60).padStart(2,'0')}`;
export function formatElapsed(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  if (minutes >= 100) return formatHours(minutes);
  if (minutes >= 1) return `${String(minutes).padStart(2,'0')}分`;
  return `${String(Math.max(5, Math.floor(seconds/5)*5)).padStart(2,'0')}秒`;
}
export const colorName = a => `${nameColors[a.status === 'done' ? 'done' : a.status === 'failed' ? 'failed' : a.taskType === 'long' ? 'long' : 'short']}${displayName(a)}\x1b[39m`;
const plain = text => String(text || '').replace(/[\x00-\x1f\x7f-\x9f]/g,' ').replace(/\s+/g,' ').trim();
export const displaySummary = a => plain(a.status === 'done' ? (a.lastAnswer || a.summary || '').split('\n')[0].replace(/[`*#]/g,'') : a.summary);

export function renderPanel(agents: any[], now = Date.now()) {
  const rows = agents.filter(activeAgent).sort((a,b) => Number(b.taskType === 'long') - Number(a.taskType === 'long'));
  const times = rows.map(a => formatElapsed(now - (a.startedAt || a.createdAt || now)));
  const nameWidth = Math.max(0, ...rows.map(a => visibleWidth(displayName(a))));
  // Normal times are three characters/four terminal cells. The rare hour form
  // uses five cells, so expand this column for every row to preserve alignment.
  const timeWidth = Math.max(4, ...times.map(visibleWidth));
  return rows.map((a,i) => `${colorName(a)}${' '.repeat(nameWidth-visibleWidth(displayName(a)))} | ${times[i]}${' '.repeat(timeWidth-visibleWidth(times[i]))} | ${displaySummary(a)}`);
}

export function terminalNotification(a, reason: string) {
  if (reason === 'done') return `✅ ${colorName(a)} 完成了：${displaySummary(a)}，等你验收`;
  if (reason === 'failed') return `❌ ${colorName(a)} 报错了：${displaySummary(a)}，它自己停了，等你处理`;
  if (reason === 'stopped') return `⏹️ ${colorName(a)} ${plain(a.stopReason || a.summary)}，我停了`;
  return undefined;
}
