import { spawn } from 'node:child_process';

const resumeCommand: Record<string, (sessionId: string) => { executable: string; args: string[] }> = {
  codex: (id) => ({ executable: 'codex', args: ['resume', id] }),
  opencode: (id) => ({ executable: 'opencode', args: ['--session', id] }),
  'gemini-cli': (id) => ({ executable: 'gemini', args: ['--resume', id] }),
  'claude-code': (id) => ({ executable: 'claude', args: ['--resume', id] })
};

/** Open a new interactive Windows Terminal tab that resumes the saved CLI session. */
export async function openAgentTerminal(agentId: string, sessionId: string, cwd: string): Promise<void> {
  if (process.platform !== 'win32') throw new Error('Agent session terminals are currently supported on Windows only.');
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(sessionId)) throw new Error('The saved agent session ID is invalid.');
  const command = resumeCommand[agentId];
  if (!command) throw new Error(`Opening a saved interactive session is not supported for ${agentId} yet. Open the captured session log instead.`);
  const invocation = command(sessionId);
  const terminalArgs = ['-d', cwd, invocation.executable, ...invocation.args];
  await new Promise<void>((resolve, reject) => {
    const child = spawn('wt.exe', terminalArgs, { cwd, detached: true, stdio: 'ignore', windowsHide: true });
    child.once('spawn', () => { child.unref(); resolve(); });
    child.once('error', (error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { reject(error); return; }
      // Windows Terminal may be absent. The fixed executable and validated
      // opaque session ID are the only tokens placed in cmd.exe's /k string.
      const fallback = spawn('cmd.exe', ['/d', '/k', `${invocation.executable} ${invocation.args.join(' ')}`], {
        cwd, detached: true, stdio: 'ignore', windowsHide: false
      });
      fallback.once('spawn', () => { fallback.unref(); resolve(); });
      fallback.once('error', reject);
    });
  });
}
