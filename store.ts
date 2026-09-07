import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

export const hash = value => createHash('sha256').update(value).digest('hex');
export const rootDir = () => process.env.PI_FRIENDS_HOME || path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi/agent'), 'friends');
export function atomicJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
export function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
export function canonical(file, cwd = process.cwd()) {
  let target = path.resolve(cwd, file.replace(/^~(?=\/)/, os.homedir()));
  const tail = [];
  while (!fs.existsSync(target)) { tail.unshift(path.basename(target)); const p = path.dirname(target); if (p === target) break; target = p; }
  return path.join(fs.realpathSync(target), ...tail);
}
export function fingerprint(file) {
  try { return hash(fs.readFileSync(file)); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// Coordination between trusted Pi processes; not an OS security sandbox.
export class FileLedger {
  constructor(dir = path.join(rootDir(), 'files')) { this.dir = dir; fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); }
  paths(file) { const base = path.join(this.dir, hash(file)); return { lock: `${base}.lock`, record: `${base}.json` }; }
  claim(file, owner) {
    file = canonical(file); const { lock } = this.paths(file);
    const token = randomUUID();
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        // Exclusive creation is atomic. Empty/partial lock records are never stolen.
        const fd = fs.openSync(lock, 'wx', 0o600);
        try { fs.writeFileSync(fd, JSON.stringify({ file, ...owner, token, pid: process.pid, since: Date.now() })); }
        finally { fs.closeSync(fd); }
        return () => { try { const v = readJSON(lock); if (v?.token === token) fs.unlinkSync(lock); } catch {} };
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        let held; try { held = readJSON(lock); } catch {}
        if (held && !alive(held.pid)) {
          // Serialize stale-lock reclamation so two claimants cannot delete a
          // freshly acquired replacement lock after observing the same corpse.
          let reap;
          try {
            reap=fs.openSync(`${lock}.reap`,'wx',0o600);
            const current=readJSON(lock);
            if(current&&!alive(current.pid))fs.unlinkSync(lock);
          } catch {} finally {if(reap!==undefined){fs.closeSync(reap);try{fs.unlinkSync(`${lock}.reap`);}catch{}}}
          continue;
        }
        throw new Error(`文件正在被 ${held?.name || '另一位成员'} 占用：${file}。先处理其他文件，稍后重新读取；不要覆盖或重复重试。`);
      }
    }
    throw new Error(`无法取得文件占用：${file}`);
  }
  record(file, owner, before, summary) {
    const after = fingerprint(file); if (after === before) return;
    const { record } = this.paths(file);
    const old = readJSON(record, { history: [] });
    const change = { ...owner, at: Date.now(), before, after, summary };
    atomicJSON(record, { file, ...change, history: [...old.history, change].slice(-30) });
  }
  list() {
    const out = [];
    for (const name of fs.readdirSync(this.dir)) {
      if (!/\.(json|lock)$/.test(name)) continue;
      try { const v = readJSON(path.join(this.dir, name)); if (v) out.push({ ...v, kind: name.endsWith('.lock') ? 'lock' : 'change' }); } catch {}
    }
    return out;
  }
}

export class FileGuard {
  constructor(ledger, owner, cwd) { this.ledger = ledger; this.owner = owner; this.cwd = cwd; this.seen = new Map(); this.pending = new Map(); }
  begin(callId, tool, input) {
    if (!['read', 'edit', 'write'].includes(tool) || !input.path) return;
    const file = canonical(input.path, this.cwd);
    const release = this.ledger.claim(file, this.owner());
    try {
      const before = fingerprint(file);
      if (tool !== 'read' && before !== null && (!this.seen.has(file) || this.seen.get(file) !== before))
        throw new Error(`文件版本已变化或尚未读取：${file}。请先 read 最新内容，再重新生成修改。`);
      this.pending.set(callId, { file, before, release, tool });
    } catch (e) { release(); throw e; }
  }
  end(callId, failed = false) {
    const entry = this.pending.get(callId); if (!entry) return;
    try {
      if (entry.tool !== 'read') this.ledger.record(entry.file, this.owner(), entry.before, entry.tool);
      if (!failed) this.seen.set(entry.file, fingerprint(entry.file));
    } finally { entry.release(); this.pending.delete(callId); }
  }
  close() { for (const id of [...this.pending.keys()]) this.end(id, true); }
}
