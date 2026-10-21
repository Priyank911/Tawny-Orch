import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { statSync } from 'node:fs';
import { extname, isAbsolute, join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

// Retain the tail, including final JSON events, rather than growing without bound.
export const MAX_OUTPUT_CHARS = 1_048_576;
const TERMINATION_GRACE_MS = 8_000;

function environmentValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  return Object.entries(env).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1];
}

export function prepareChildSpawn(
  command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform
): { command: string; args: string[]; options: SpawnOptions } {
  if (platform !== 'win32') return { command, args, options: { shell: false, detached: true } };
  const extensions = extname(command) ? [''] : (environmentValue(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';');
  const directories = /[\\/]/.test(command) || isAbsolute(command)
    ? ['']
    : (environmentValue(env, 'PATH') ?? '').split(';').filter(Boolean);
  let executable: string | undefined;
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = resolve(cwd, directory.replace(/^"|"$/g, ''), command + extension.toLowerCase());
      try {
        if (statSync(candidate).isFile()) { executable = candidate; break; }
      } catch { /* Try the next PATH entry. */ }
    }
    if (executable) break;
  }
  if (!executable) throw new Error(`Executable not found on PATH: ${command}. Install the CLI and restart the app; also verify cwd exists.`);
  if (!/\.(cmd|bat)$/i.test(executable)) return { command: executable, args, options: { shell: false } };

  // Batch shims reparse %*. Fail closed on shell syntax rather than pretend CRT
  // quoting protects arbitrary prompts from cmd expansion. Large prompts use stdin.
  if ([executable, ...args].some((token) => /["%!\r\n\0&|<>^()]/.test(token))) {
    throw new Error('Unsafe Windows batch-shim argument or path. Use a native CLI executable or a path without cmd metacharacters; send prompt contents on stdin.');
  }
  const quote = (token: string) => `"${token.replace(/(\\+)$/g, '$1$1')}"`;
  return {
    command: join(environmentValue(env, 'SystemRoot') ?? 'C:\\Windows', 'System32', 'cmd.exe'),
    args: ['/d', '/s', '/v:off', '/c', `"${[executable, ...args].map(quote).join(' ')}"`],
    options: { shell: false, windowsVerbatimArguments: true }
  };
}

export interface ChildRunOptions {
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  stdinPayload?: string;
  cancelSignal?: AbortSignal;
}

export interface ChildRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
}

export function runChild(command: string, args: string[], options: ChildRunOptions): Promise<ChildRunResult> {
  return new Promise((resolveRun) => {
    let timedOut = false;
    let cancelled = options.cancelSignal?.aborted ?? false;
    let stdout = '';
    let stderr = '';
    let settled = false;
    let stopping = false;
    let killer: ReturnType<typeof setTimeout> | undefined;
    let forcedFinish: ReturnType<typeof setTimeout> | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let treeKill: ChildProcess | undefined;
    let treeKillTimer: ReturnType<typeof setTimeout> | undefined;
    let childClosed = false;
    let childExitCode: number | null = null;
    let treeKillPending = false;
    let inputFailed = false;
    let outputTruncated = false;
    const appendError = (message: string) => { stderr = `${stderr}\n${message}`.slice(-MAX_OUTPUT_CHARS); };
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      clearTimeout(forcedFinish);
      clearTimeout(escalation);
      clearTimeout(treeKillTimer);
      options.cancelSignal?.removeEventListener('abort', onAbort);
      if (outputTruncated) appendError('Output truncated: retained only the last 1 Mi characters per stream.');
      resolveRun({ stdout, stderr, exitCode: inputFailed ? null : exitCode, timedOut, cancelled });
    };
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch { /* Already gone or inaccessible; bounded termination still applies. */ }
    };
    const stop = () => {
      if (stopping || settled) return;
      stopping = true;
      forcedFinish = setTimeout(() => {
        appendError('Process-tree termination did not complete within 8 seconds; verify no vendor processes remain.');
        treeKill?.kill();
        child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
        finish(null);
      }, TERMINATION_GRACE_MS);
      if (process.platform === 'win32' && child.pid) {
        // Kill descendants before the parent disappears: child.kill alone leaves
        // npm shims and their provider processes running on Windows.
        treeKillPending = true;
        const treeDone = (error?: string) => {
          if (!treeKillPending) return;
          treeKillPending = false;
          clearTimeout(treeKillTimer);
          if (error) { appendError(error); kill('SIGKILL'); }
          if (childClosed) finish(childExitCode);
        };
        try {
          const root = environmentValue(process.env, 'SystemRoot') ?? 'C:\\Windows';
          treeKill = spawn(join(root, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], {
            shell: false, windowsHide: true, stdio: 'ignore'
          });
          treeKill.once('error', (error) => treeDone(`taskkill failed: ${error.message}. Descendant termination is not guaranteed.`));
          treeKill.once('close', (code) => treeDone(code === 0 ? undefined : `taskkill exited ${code}; descendant termination is not guaranteed.`));
          treeKillTimer = setTimeout(() => {
            treeKill?.kill();
            treeDone('taskkill timed out; descendant termination is not guaranteed.');
          }, 5_000);
        } catch (error) { treeDone(`Could not start taskkill: ${String(error)}`); }
      } else {
        kill('SIGTERM');
        escalation = setTimeout(() => kill('SIGKILL'), 3_000);
      }
    };
    const onAbort = () => { cancelled = true; stop(); };
    if (cancelled) { finish(null); return; }

    let child: ChildProcess;
    try {
      const env = { ...process.env };
      for (const [key, value] of Object.entries(options.env ?? {})) {
        // Windows env keys are case-insensitive. Do not leave both Path and
        // PATH around and let Node silently pick the wrong one.
        if (process.platform === 'win32') {
          for (const existing of Object.keys(env)) {
            if (existing.toLowerCase() === key.toLowerCase()) delete env[existing];
          }
        }
        env[key] = value;
      }
      const invocation = prepareChildSpawn(command, args, options.cwd, env);
      child = spawn(invocation.command, invocation.args, {
        ...invocation.options, cwd: options.cwd, windowsHide: true, env, stdio: 'pipe'
      });
    } catch (error) {
      appendError(`Could not launch ${command} in ${options.cwd}: ${String(error)}. Check CLI installation, PATH, working directory and permissions.`);
      finish(null); return;
    }
    const outDecoder = new StringDecoder('utf8');
    const errDecoder = new StringDecoder('utf8');
    child.stdout?.on('data', (chunk: Buffer) => {
      const text = outDecoder.write(chunk);
      outputTruncated ||= stdout.length + text.length > MAX_OUTPUT_CHARS;
      stdout = (stdout + text).slice(-MAX_OUTPUT_CHARS);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = errDecoder.write(chunk);
      outputTruncated ||= stderr.length + text.length > MAX_OUTPUT_CHARS;
      stderr = (stderr + text).slice(-MAX_OUTPUT_CHARS);
    });
    child.once('error', (error) => {
      appendError(`Could not launch ${command} in ${options.cwd}: ${error.message}. Check CLI installation, PATH, working directory and permissions.`);
      finish(null);
    });
    child.once('close', (exitCode) => {
      stdout = (stdout + outDecoder.end()).slice(-MAX_OUTPUT_CHARS);
      stderr = (stderr + errDecoder.end()).slice(-MAX_OUTPUT_CHARS);
      childClosed = true; childExitCode = exitCode;
      if (!treeKillPending) finish(exitCode);
    });
    child.stdin?.on('error', (error: NodeJS.ErrnoException) => {
      if (settled || stopping) return;
      inputFailed = true;
      appendError(`Could not send task prompt to ${command}: ${error.message}. The CLI may have exited before reading stdin.`);
      stop();
    });
    killer = setTimeout(() => { timedOut = true; stop(); }, Math.max(1, options.timeoutMs));
    options.cancelSignal?.addEventListener('abort', onAbort, { once: true });
    if (options.cancelSignal?.aborted) onAbort();
    if (!stopping) {
      try { child.stdin?.end(options.stdinPayload); }
      catch (error) { inputFailed = true; appendError(`Could not send task prompt: ${String(error)}`); stop(); }
    }
  });
}

// ---------------------------------------------------------------------------
// Vendor output parsers
// ---------------------------------------------------------------------------

export function parseClaudeStreamJson(stdout: string): { summary: string; isFailure: boolean } | undefined {
  const lines = stdout.split(/\r?\n/).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed: unknown = JSON.parse(lines[index]);
      if (parsed && typeof parsed === 'object' && 'type' in parsed) {
        const event = parsed as { type?: string; result?: string; subtype?: string; is_error?: boolean };
        if (event.type === 'result' && typeof event.result === 'string') {
          return { summary: event.result, isFailure: event.is_error === true || event.subtype !== 'success' };
        }
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

export function parseCodexJson(stdout: string): { summary: string; isFailure: boolean } | undefined {
  const lines = stdout.split(/\r?\n/).filter(Boolean);
  const narratives: string[] = [];
  let failure = false;
  let failureMessage = '';
  for (const line of lines) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed && typeof parsed === 'object') {
        const event = parsed as {
          type?: string; message?: string; error?: { message?: string };
          item?: { type?: string; text?: string };
          msg?: { type?: string; message?: string };
        };
        if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
          narratives.push(event.item.text);
        }
        if (event.msg?.type === 'agent_message' && typeof event.msg.message === 'string') narratives.push(event.msg.message);
        if (event.type === 'error' || event.type === 'turn.failed' || event.msg?.type === 'error') {
          failure = true;
          failureMessage = event.error?.message ?? event.message ?? event.msg?.message ?? 'Codex reported a failed turn.';
        }
      }
    } catch {
      continue;
    }
  }
  if (narratives.length === 0) return failure ? { summary: failureMessage, isFailure: true } : undefined;
  return { summary: narratives[narratives.length - 1], isFailure: failure };
}

/** Parse the Antigravity CLI's documented NDJSON init/step_update/result stream. */
export function parseAgyStreamJson(stdout: string): { summary: string; isFailure: boolean } | undefined {
  let final: { status?: string; response?: string; error?: string } | undefined;
  let streamedResponse = '';
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object') continue;
      const event = parsed as {
        event?: string;
        result?: { status?: string; response?: string; error?: string };
        step_update?: { step_type?: string; text_delta?: string };
      };
      if (event.event === 'step_update' && event.step_update?.step_type === 'agent_response' &&
          typeof event.step_update.text_delta === 'string') streamedResponse += event.step_update.text_delta;
      if (event.event === 'result' && event.result && typeof event.result === 'object') final = event.result;
    } catch {
      continue;
    }
  }
  if (!final && !streamedResponse) return undefined;
  const summary = final?.response?.trim() || streamedResponse.trim() || final?.error?.trim() || '';
  return { summary, isFailure: final?.status !== 'SUCCESS' || !summary };
}

export function parseTailNarrative(stdout: string, maxChars = 2000): { summary: string; isFailure: boolean } {
  const cleaned = stdout
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0 && !line.trim().startsWith('{"type"'))
    .join(' ')
    .trim();
  const summary = cleaned.length > maxChars ? `…${cleaned.slice(-maxChars)}` : cleaned;
  // Gate-readable heuristic: explicit failure banners mark failure; otherwise
  // the gates decide from the diff and the result file, not from prose.
  const isFailure = /\b(error|failed|exception)\b/i.test(summary) && /(?:^|[\s.])error/i.test(summary);
  return summary ? { summary, isFailure } : { summary: '', isFailure: true };
}
