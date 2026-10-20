import { spawn } from 'node:child_process';

export type CommandOutput = { code: number | null; stdout: string; stderr: string; killed?: boolean; timedOut?: boolean; signal?: string | null; error?: string };

// killed/signal always override code, including Pi's historical code=0 after SIGTERM.
export function classifyCommand(out: CommandOutput) {
  const failureKind = out.timedOut ? 'timeout' : out.killed || out.signal ? 'killed' : out.code !== 0 || out.error ? 'exit' : null;
  const error = failureKind === 'timeout' ? '命令超时：达到主 Agent 显式指定的时间限制，已终止' :
    failureKind === 'killed' ? `命令被信号终止（被杀）${out.signal ? `：${out.signal}` : ''}` :
    failureKind === 'exit' ? `命令正常失败：退出码 ${out.code ?? '未知'}${out.error ? `；${out.error}` : ''}` : undefined;
  return { ...out, code: failureKind && out.code === 0 ? null : out.code, killed: !!(out.killed || out.signal || out.timedOut),
    timedOut: !!out.timedOut, failureKind, error, success: !failureKind };
}

// Own the process termination metadata: pi.exec currently discards external signals
// and maps null exit codes to zero. There is deliberately no default deadline.
export async function runCommand(command: string, { cwd, signal, timeout }: { cwd?: string; signal?: AbortSignal; timeout?: number } = {}) {
  if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) throw new Error('timeout 必须是正数；省略表示不限时');
  if (signal?.aborted) return classifyCommand({ code: null, stdout: '', stderr: '', killed: true, signal: 'SIGTERM' });
  return await new Promise<ReturnType<typeof classifyCommand>>(resolve => {
    const child = spawn('bash', ['-lc', command], { cwd, detached: process.platform !== 'win32', stdio: ['ignore','pipe','pipe'] });
    let stdout = '', stderr = '', killed = false, timedOut = false, settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined, force: ReturnType<typeof setTimeout> | undefined;
    const send = (termination: NodeJS.Signals) => { try { process.kill(process.platform === 'win32' ? child.pid! : -child.pid!, termination); } catch {} };
    const terminate = (cause: 'timeout' | 'killed') => {
      if (settled || killed) return;
      killed = true; timedOut = cause === 'timeout'; send('SIGTERM');
      force = setTimeout(() => send('SIGKILL'), 2000); force.unref();
    };
    const abort = () => terminate('killed');
    signal?.addEventListener('abort', abort, { once: true });
    if (timeout !== undefined) timer = setTimeout(() => terminate('timeout'), timeout * 1000);
    child.stdout.on('data', data => { stdout = (stdout + data).slice(-12000); });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-4000); });
    const finish = (code: number | null, termination?: string | null, error?: string) => {
      if (settled) return; settled = true;
      clearTimeout(timer); clearTimeout(force); signal?.removeEventListener('abort', abort);
      // Kill remaining children on cancellation even if their shell exited first.
      if (killed) send('SIGKILL');
      resolve(classifyCommand({ code, stdout, stderr, killed, timedOut, signal: termination, error }));
    };
    child.on('error', error => finish(null, null, error.message));
    // Wait for pipe drainage so a successful result always includes complete output.
    // Cancellation kills the process group, closing its inherited output pipes.
    child.on('close', (code, termination) => finish(code, termination));
    if (signal?.aborted) abort();
  });
}
