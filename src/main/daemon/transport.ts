import { utilityProcess } from 'electron';
import { execFile } from 'node:child_process';

import type { Transport } from './protocol';

export function forkDaemonTransport(entryPath: string): Transport {
  const child = utilityProcess.fork(entryPath, [String(process.pid)], {
    serviceName: 'Tawny orchestrator daemon', stdio: 'pipe'
  });
  // Structured log entries travel over RPC. Drain the pipes so console output cannot block agents.
  child.stdout?.resume();
  child.stderr?.resume();
  const messages = new Set<(message: unknown) => void>();
  const closes = new Set<(error: Error) => void>();
  const backlog: unknown[] = [];
  let closed: Error | undefined;
  let exited = false;
  let terminating: Promise<void> | undefined;
  let exitResolve!: () => void;
  const exit = new Promise<void>((resolve) => { exitResolve = resolve; });
  function close(error: Error): void {
    if (closed) return;
    closed = error;
    for (const listener of closes) listener(error);
  }
  child.on('message', (message: unknown) => {
    if (!messages.size) backlog.push(message);
    else for (const listener of messages) listener(message);
  });
  child.on('error', (type, location) => close(new Error(`Daemon ${type} at ${location}`)));
  child.on('exit', (code) => {
    exited = true;
    exitResolve();
    close(new Error(`Daemon exited with code ${code}`));
  });
  async function waitForExit(ms: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([exit, new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); })]); }
    finally { clearTimeout(timer); }
    return exited;
  }
  return {
    send(message) { if (closed) throw closed; child.postMessage(message); },
    onMessage(listener) {
      messages.add(listener);
      for (const message of backlog.splice(0)) listener(message);
      return () => { messages.delete(listener); };
    },
    onClose(listener) {
      closes.add(listener);
      if (closed) listener(closed);
      return () => { closes.delete(listener); };
    },
    terminate() {
      terminating ??= (async () => {
        if (await waitForExit(300)) return;
        const pid = child.pid;
        // Windows taskkill /T includes CLI descendants when graceful adapter cancellation timed out.
        if (process.platform === 'win32' && pid) {
          await new Promise<void>((resolve) => {
            execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5_000 }, () => resolve());
          });
        }
        if (!exited) child.kill();
        if (!(await waitForExit(2_000))) throw new Error('Daemon did not exit after termination');
      })();
      return terminating;
    }
  };
}
