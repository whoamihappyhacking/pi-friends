import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

export class PiRPC extends EventEmitter {
  constructor(args, { cwd, env = {}, executable = process.env.PI_FRIENDS_PI || 'pi' } = {}) {
    super(); this.pending = new Map(); this.buffer = ''; this.stderr = ''; this.closed = false;
    this.process = spawn(executable, args, { cwd, env: { ...process.env, PI_OFFLINE: '1', ...env }, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    this.process.stdin.on('error', () => {});
    this.process.stdout.on('data', data => {
      this.buffer += data.toString();
      if (this.buffer.length > 16 * 1024 * 1024) { this.emit('fault', new Error('RPC frame too large')); this.kill(); return; }
      let split;
      while ((split = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, split); this.buffer = this.buffer.slice(split + 1);
        let message; try { message = JSON.parse(line); } catch { continue; }
        if (message.type === 'response' && this.pending.has(message.id)) {
          const p = this.pending.get(message.id); this.pending.delete(message.id); clearTimeout(p.timer);
          message.success ? p.resolve(message.data) : p.reject(new Error(message.error || 'RPC rejected'));
        }
        if (message.type === 'extension_ui_request' && ['select','confirm','input','editor','custom'].includes(message.method))
          this.process.stdin.write(JSON.stringify({ type: 'extension_ui_response', id: message.id, cancelled: true }) + '\n');
        this.emit('event', message);
      }
    });
    this.process.stderr.on('data', data => { this.stderr = (this.stderr + data).slice(-8000); });
    this.process.on('error', e => this.emit('fault', e));
    this.process.on('close', (code, signal) => {
      this.closed = true;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(`Pi exited (${code ?? signal})`)); }
      this.pending.clear(); this.emit('exit', code, signal);
    });
  }
  call(type, args = {}, timeout = 30000) {
    if (this.closed) return Promise.reject(new Error('Pi process is closed'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`RPC timeout: ${type}`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.process.stdin.write(JSON.stringify({ id, type, ...args }) + '\n');
    });
  }
  kill() {
    if (this.closed) return;
    try { process.kill(process.platform === 'win32' ? this.process.pid : -this.process.pid, 'SIGTERM'); } catch {}
    const pid = this.process.pid;
    const timer = setTimeout(() => { if (!this.closed) { try { process.kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL'); } catch {} } }, 2000);
    timer.unref();
  }
}
