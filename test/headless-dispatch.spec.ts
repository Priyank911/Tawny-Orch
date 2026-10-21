import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('../src/main/logger', () => ({ logPipeline: vi.fn() }));
vi.mock('../src/main/agents/childRunner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/agents/childRunner')>();
  return { ...actual, runChild: vi.fn() };
});

import { runChild, MAX_OUTPUT_CHARS, parseCodexJson, prepareChildSpawn } from '../src/main/agents/childRunner';
import { aborterFor, buildBundle, releaseAborter, runHeadless } from '../src/main/agents/headless';
import { claudeCodeAdapter } from '../src/main/agents/claudeCode';
import { codexAdapter } from '../src/main/agents/codex';
import { geminiAdapter } from '../src/main/agents/gemini';
import { cursorAgentAdapter } from '../src/main/agents/cursorAgent';
import { opencodeAdapter } from '../src/main/agents/opencode';
import { antigravityAdapter } from '../src/main/agents/antigravity';
import { contractMarkdown } from '../src/main/orchestrator/prompts';
import { taskContractSchema, type TaskContract } from '../src/shared/contracts';
import type { AgentAdapter, AdapterContext } from '../src/main/agents/base';

const { runChild: realRunChild } = await vi.importActual<typeof import('../src/main/agents/childRunner')>('../src/main/agents/childRunner');
const success = { stdout: 'Reviewed the task.', stderr: '', exitCode: 0, timedOut: false, cancelled: false };
const adapters = [claudeCodeAdapter, codexAdapter, geminiAdapter, cursorAgentAdapter, opencodeAdapter, antigravityAdapter];
const roles = ['research', 'plan', 'review', 'deliver', 'execute', 'test'] as const;
const roots: string[] = [];
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;

class FakeChild extends EventEmitter {
  pid = 4242;
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  kill = vi.fn(() => true);
  input = '';
  constructor() {
    super();
    this.stdin.on('data', (chunk: Buffer) => { this.input += chunk.toString(); });
  }
  close(code: number | null = 0) { this.emit('close', code); }
}

let children: FakeChild[];
beforeEach(() => {
  children = [];
  vi.mocked(runChild).mockReset().mockResolvedValue({ ...success });
  vi.mocked(spawn).mockReset().mockImplementation(() => {
    const child = new FakeChild(); children.push(child);
    return child as unknown as ReturnType<typeof spawn>;
  });
});
afterEach(async () => {
  Object.defineProperty(process, 'platform', platformDescriptor);
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tawny-headless-'));
  roots.push(root); return root;
}
async function contextFor(adapter: AgentAdapter, role: TaskContract['role'] = 'plan'): Promise<AdapterContext> {
  const root = await tempRoot();
  return {
    cwd: root, workdir: join(root, 'packets & notes'),
    contract: taskContractSchema.parse({
      runId: root, stageId: role, role, agentId: adapter.id,
      goal: 'Audit authentication — résumé\nPreserve permissions and scope.',
      projectPath: root, projectName: 'A project with spaces',
      constraints: { allowedFiles: ['src/**'], forbiddenFiles: ['.env*'], acceptanceCommands: ['pnpm test'], timeoutMinutes: 2 }
    })
  };
}
function windows() { Object.defineProperty(process, 'platform', { value: 'win32', configurable: true }); }
function startChild(options: Partial<Parameters<typeof realRunChild>[2]> = {}) {
  return realRunChild(process.execPath, ['fake-provider.js'], { cwd: process.cwd(), timeoutMs: 10_000, ...options });
}

// Only the mocked runner is called here: no installed provider, auth or model is used.
describe.each(adapters)('$name headless dispatch', (adapter) => {
  it.each(roles)('delivers the contract with conservative permissions for %s', async (role) => {
    const context = await contextFor(adapter, role);
    await adapter.collect(await adapter.start(context));
    expect(runChild).toHaveBeenCalledOnce();
    const [command, args, options] = vi.mocked(runChild).mock.calls[0];
    const mdPath = join(context.workdir, `contract-${role}.md`);
    const readOnly = !['execute', 'test'].includes(role);
    expect(command).toBe({ 'claude-code': 'claude', codex: 'codex', 'gemini-cli': 'gemini', 'cursor-agent': 'cursor-agent', opencode: 'opencode', antigravity: 'agy' }[adapter.id]);
    expect(options.cwd).toBe(context.cwd);
    expect(options.timeoutMs).toBe(120_000);
    expect(options.cancelSignal?.aborted).toBe(false);
    expect(args).not.toContain('CONTRACT_FILE');
    expect(args).not.toContain('CONTRACT_PROMPT');
    expect(args.join(' ')).not.toMatch(/bypassPermissions|--yolo|--force|--full-auto|danger-full-access|dangerously/);
    expect(await readFile(mdPath, 'utf8')).toBe(contractMarkdown(context.contract));
    if (['claude-code', 'codex', 'gemini-cli'].includes(adapter.id)) {
      expect(options.stdinPayload).toBe(contractMarkdown(context.contract));
      expect(options.stdinPayload).toContain('# Output contract (mandatory)');
      expect(options.stdinPayload).not.toBe(mdPath);
      expect(args).not.toContain(mdPath);
    } else {
      expect(options.stdinPayload).toBeUndefined();
      const instruction = args.find((arg) => arg.startsWith('Read task packet'));
      expect(instruction).toContain(mdPath);
      expect(instruction).toContain('follow its instructions');
      expect(args).not.toContain(`"${mdPath}"`);
    }
    if (adapter.id === 'claude-code') {
      expect(args[args.indexOf('--permission-mode') + 1]).toBe(readOnly ? 'plan' : 'acceptEdits');
      expect(args[args.indexOf('--tools') + 1]).toBe(readOnly ? 'Read,Glob,Grep' : 'Read,Glob,Grep,Edit,Write');
      expect(args).toContain('--strict-mcp-config');
      expect(args).toContain('mcp__*');
    }
    if (adapter.id === 'codex') {
      expect(args[args.indexOf('--sandbox') + 1]).toBe(readOnly ? 'read-only' : 'workspace-write');
      expect(args).toContain('approval_policy=never');
      expect(args.at(-1)).toBe('-');
    }
    if (adapter.id === 'gemini-cli') {
      expect(args[args.indexOf('--approval-mode') + 1]).toBe(readOnly ? 'plan' : 'auto_edit');
      expect(args).toContain('-p');
    }
    if (adapter.id === 'antigravity') {
      expect(args[args.indexOf('--output-format') + 1]).toBe('stream-json');
      expect(args.find((arg) => arg.startsWith('Read task packet'))).toContain(mdPath);
      expect(args).not.toContain('--dangerously-skip-permissions');
    }
    if (adapter.id === 'cursor-agent') {
      expect(args.includes('--mode')).toBe(readOnly);
      if (readOnly) expect(args[args.indexOf('--mode') + 1]).toBe('ask');
    }
    if (adapter.id === 'opencode') {
      const mode = readOnly ? 'plan' : 'build';
      expect(args[args.indexOf('--agent') + 1]).toBe(mode);
      expect(args[args.indexOf('--file') + 1]).toBe(mdPath);
      const permission = JSON.parse(options.env!.OPENCODE_PERMISSION!);
      expect(permission).toMatchObject({ '*': 'deny', read: 'allow', glob: 'allow', grep: 'allow' });
      expect(permission.edit).toBe(readOnly ? 'deny' : 'allow');
      expect(permission.shell).toBe('deny');
      expect(permission.bash).toBe('deny');
      expect(permission.task).toBe('deny');
      expect(permission.external_directory).toBe('deny');
      expect(JSON.parse(options.env!.OPENCODE_CONFIG_CONTENT!).agent[mode].permission).toEqual(permission);
    }
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('headless lifecycle and outcomes', () => {
  it('keeps a large Unicode contract out of argv', async () => {
    const context = await contextFor(codexAdapter);
    context.contract.goal = 'Résumé / 安全\n'.repeat(10_000);
    await codexAdapter.collect(await codexAdapter.start(context));
    const [, args, options] = vi.mocked(runChild).mock.calls[0];
    expect(options.stdinPayload).toBe(contractMarkdown(context.contract));
    expect(args.join(' ').length).toBeLessThan(300);
  });

  it('preserves cancellation before collection and releases the registry afterwards', async () => {
    const context = await contextFor(claudeCodeAdapter);
    const handle = await claudeCodeAdapter.start(context);
    await claudeCodeAdapter.cancel(handle);
    await claudeCodeAdapter.collect(handle);
    expect(vi.mocked(runChild).mock.calls[0][2].cancelSignal?.aborted).toBe(true);
    expect(aborterFor(context.contract).signal.aborted).toBe(false);
    releaseAborter(context.contract);
  });

  it.each(adapters)('cancels an active $name dispatch through the shared signal', async (adapter) => {
    const context = await contextFor(adapter);
    vi.mocked(runChild).mockImplementationOnce(async (_command, _args, options) => new Promise((resolve) => {
      options.cancelSignal!.addEventListener('abort', () => resolve({ ...success, cancelled: true }), { once: true });
    }));
    const handle = await adapter.start(context);
    const pending = adapter.collect(handle);
    await vi.waitFor(() => expect(runChild).toHaveBeenCalledOnce());
    await adapter.cancel(handle);
    expect((await pending).result?.status).not.toBe('completed');
    expect(aborterFor(context.contract).signal.aborted).toBe(false);
    releaseAborter(context.contract);
  });

  it('releases abort state when contract preparation fails', async () => {
    const context = await contextFor(codexAdapter);
    await writeFile(context.workdir, 'not a directory');
    const signal = aborterFor(context.contract).signal;
    await expect(codexAdapter.collect(await codexAdapter.start(context))).rejects.toThrow();
    expect(runChild).not.toHaveBeenCalled();
    expect(aborterFor(context.contract).signal).not.toBe(signal);
    releaseAborter(context.contract);
  });

  it('releases abort state when the runner or parser throws', async () => {
    const context = await contextFor(codexAdapter);
    const signal = aborterFor(context.contract).signal;
    vi.mocked(runChild).mockRejectedValueOnce(new Error('runner failed'));
    await expect(codexAdapter.collect(await codexAdapter.start(context))).rejects.toThrow('runner failed');
    expect(aborterFor(context.contract).signal).not.toBe(signal);
    releaseAborter(context.contract);
    const next = aborterFor(context.contract).signal;
    await expect(runHeadless(context.contract, context, {
      commandLine: 'fake', args: [], parse: () => { throw new Error('parser failed'); }
    })).rejects.toThrow('parser failed');
    expect(aborterFor(context.contract).signal).not.toBe(next);
    releaseAborter(context.contract);
  });

  it.each([{ exitCode: 1 }, { timedOut: true }, { cancelled: true }, { parsed: { summary: 'Error', isFailure: true } }])('does not promote a strict report to success after failure: %j', (failure) => {
    const strict = { status: 'completed' as const, summary: 'Stale success', filesChanged: [], assumptions: [], unresolved: [], confidence: 'high' as const };
    const bundle = buildBundle({ ...success, strict, ...failure });
    expect(bundle.result?.status).not.toBe('completed');
  });

  it('parses current Codex JSONL and rejects failed turns without a narrative', () => {
    expect(parseCodexJson('{"type":"item.completed","item":{"type":"agent_message","text":"Review complete"}}')).toEqual({ summary: 'Review complete', isFailure: false });
    expect(parseCodexJson('{"type":"turn.failed","error":{"message":"Authentication required"}}')).toEqual({ summary: 'Authentication required', isFailure: true });
    expect(parseCodexJson('{"msg":{"type":"agent_message","message":"Legacy"}}')?.summary).toBe('Legacy');
  });
});

describe('Windows executable and batch shim handling', () => {
  it('passes native argv unchanged, including spaces, quotes and metacharacters', async () => {
    const root = await tempRoot();
    const executable = join(root, 'native tool.exe'); await writeFile(executable, '');
    const args = ['a path with spaces', 'quote"inside', '%PATH% & echo injected', 'Unicode 安全'];
    const invocation = prepareChildSpawn(executable, args, root, {}, 'win32');
    expect(invocation.command).toBe(executable);
    expect(invocation.args).toEqual(args);
    expect(invocation.options).toEqual({ shell: false });
  });

  it('resolves a PATH .cmd shim and uses a guarded explicit cmd invocation', async () => {
    const root = await tempRoot();
    const bin = join(root, 'a bin'); await mkdir(bin);
    const shim = join(bin, 'gemini.cmd'); await writeFile(shim, '@echo off');
    const invocation = prepareChildSpawn('gemini', ['-p', 'Read the supplied contract.'], root, { Path: bin, PATHEXT: '.EXE;.CMD' }, 'win32');
    expect(invocation.command).toMatch(/cmd\.exe$/);
    expect(invocation.args.slice(0, 4)).toEqual(['/d', '/s', '/v:off', '/c']);
    expect(invocation.args[4]).toContain(`"${shim}"`);
    expect(invocation.args[4]).toContain('"Read the supplied contract."');
    expect(invocation.options).toEqual({ shell: false, windowsVerbatimArguments: true });
  });

  it.each(['%PATH%', '!variable!', 'a&b', 'a|b', 'a>b', 'a<b', 'a^b', '(a)', 'a"b', 'a\nb'])('rejects unsafe shim arguments rather than interpreting %j', async (arg) => {
    const root = await tempRoot();
    const shim = join(root, 'tool.cmd'); await writeFile(shim, '');
    expect(() => prepareChildSpawn(shim, [arg], root, {}, 'win32')).toThrow('Unsafe Windows batch-shim');
  });

  it('rejects metacharacters in the shim path and reports a missing executable', async () => {
    const root = await tempRoot();
    const shim = join(root, 'unsafe & tool.cmd'); await writeFile(shim, '');
    expect(() => prepareChildSpawn(shim, [], root, {}, 'win32')).toThrow('native CLI executable');
    expect(() => prepareChildSpawn('not-installed', [], root, { PATH: root }, 'win32')).toThrow('Install the CLI');
  });
});

describe('child runner with fake processes only', () => {
  it('sends stdin verbatim and cleans up timers after normal exit', async () => {
    vi.useFakeTimers();
    const pending = startChild({ stdinPayload: 'Task content\nUnicode 安全' });
    expect(children[0].input).toBe('Task content\nUnicode 安全');
    expect(vi.mocked(spawn).mock.calls[0][2]).toMatchObject({ shell: false, cwd: process.cwd() });
    children[0].stdout.write('Done'); children[0].close();
    expect(await pending).toMatchObject({ stdout: 'Done', exitCode: 0, timedOut: false, cancelled: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('overrides Windows environment keys case-insensitively', async () => {
    windows();
    const pending = startChild({ env: { path: 'replacement-path' } });
    const env = vi.mocked(spawn).mock.calls[0][2]!.env!;
    expect(Object.keys(env).filter((key) => key.toLowerCase() === 'path')).toEqual(['path']);
    expect(env.path).toBe('replacement-path');
    children[0].close(); await pending;
  });

  it('does not spawn an already-aborted request', async () => {
    const controller = new AbortController(); controller.abort();
    expect(await startChild({ cancelSignal: controller.signal })).toMatchObject({ cancelled: true, exitCode: null });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('reports synchronous and asynchronous spawn errors with actionable context', async () => {
    vi.mocked(spawn).mockImplementationOnce(() => { throw new Error('EACCES'); });
    expect((await startChild()).stderr).toMatch(/EACCES.*installation, PATH, working directory and permissions/);
    const pending = startChild(); children[0].emit('error', new Error('ENOENT'));
    expect(await pending).toMatchObject({ exitCode: null, timedOut: false });
    expect((await pending).stderr).toContain(process.cwd());
    expect((await pending).stderr).toContain('ENOENT');
  });

  it('bounds both streams, keeps final events and decodes split UTF-8', async () => {
    const pending = startChild();
    const child = children[0];
    child.stdout.write('x'.repeat(MAX_OUTPUT_CHARS + 100));
    const unicode = Buffer.from('安全');
    child.stdout.write(unicode.subarray(0, 2)); child.stdout.write(unicode.subarray(2));
    child.stdout.write('\n{"type":"item.completed","item":{"type":"agent_message","text":"Final result"}}\n');
    child.stderr.write('e'.repeat(MAX_OUTPUT_CHARS + 100)); child.close();
    const result = await pending;
    expect(result.stdout.length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS);
    expect(result.stderr.length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS);
    expect(result.stdout).toContain('安全');
    expect(result.stdout).not.toContain('�');
    expect(result.stderr).toContain('Output truncated');
    expect(parseCodexJson(result.stdout)?.summary).toBe('Final result');
  });

  it('uses taskkill /T /F once on Windows abort and waits for tree cleanup', async () => {
    windows(); vi.useFakeTimers();
    const controller = new AbortController();
    const pending = startChild({ cancelSignal: controller.signal });
    let settled = false; void pending.then(() => { settled = true; });
    controller.abort(); controller.abort();
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(vi.mocked(spawn).mock.calls[1][0]).toMatch(/taskkill\.exe$/);
    expect(vi.mocked(spawn).mock.calls[1][1]).toEqual(['/PID', '4242', '/T', '/F']);
    expect(children[0].kill).not.toHaveBeenCalled();
    children[0].close(0); await Promise.resolve();
    expect(settled).toBe(false);
    children[1].close(0);
    expect(await pending).toMatchObject({ cancelled: true, timedOut: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out using the same Windows tree cancellation path', async () => {
    windows(); vi.useFakeTimers();
    const pending = startChild({ timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(50);
    expect(spawn).toHaveBeenCalledTimes(2);
    children[1].close(0); children[0].close(null);
    expect(await pending).toMatchObject({ timedOut: true, cancelled: false, exitCode: null });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds termination when taskkill or child close never arrives', async () => {
    windows(); vi.useFakeTimers();
    const controller = new AbortController();
    const pending = startChild({ cancelSignal: controller.signal }); controller.abort();
    await vi.advanceTimersByTimeAsync(8_000);
    const result = await pending;
    expect(result.cancelled).toBe(true);
    expect(result.stderr).toContain('taskkill timed out');
    expect(result.stderr).toContain('verify no vendor processes remain');
    expect(children[0].kill).toHaveBeenCalledWith('SIGKILL');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('handles taskkill errors and stdin EPIPE without unhandled stream errors', async () => {
    windows(); vi.useFakeTimers();
    const pending = startChild({ stdinPayload: 'task' });
    children[0].stdin.emit('error', Object.assign(new Error('EPIPE'), { code: 'EPIPE' }));
    children[1].emit('error', new Error('access denied'));
    children[0].close(0);
    const result = await pending;
    expect(result.exitCode).toBeNull();
    expect(result.stderr).toContain('Could not send task prompt');
    expect(result.stderr).toContain('taskkill failed: access denied');
    expect(vi.getTimerCount()).toBe(0);
  });
});
