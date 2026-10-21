import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectConfig, RunSnapshot, StageSpec } from '../src/shared/contracts';

// Exercise the actual Electron build artifact, not an independently reimplemented bridge.
// Run `pnpm build` before this suite (also required by the real utility-process smoke test).
const preloadPath = resolve('out/preload/preload.js');
let preload: string;
beforeAll(async () => {
  try { preload = await readFile(preloadPath, 'utf8'); }
  catch (error) { throw new Error('Built preload missing; run pnpm build before the desktop bridge tests.', { cause: error }); }
});

type Handler = (event: unknown, payload: unknown) => void;
let api: Window['tawnyOrch'];
let ipc: {
  invoke: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
};
let expose: ReturnType<typeof vi.fn>;
let handlers: Map<string, Set<Handler>>;

beforeEach(() => {
  handlers = new Map();
  ipc = {
    invoke: vi.fn(), send: vi.fn(),
    on: vi.fn((channel: string, handler: Handler) => {
      const group = handlers.get(channel) ?? new Set<Handler>();
      group.add(handler); handlers.set(channel, group);
    }),
    removeListener: vi.fn((channel: string, handler: Handler) => { handlers.get(channel)?.delete(handler); })
  };
  expose = vi.fn((name: string, value: Window['tawnyOrch']) => {
    expect(name).toBe('tawnyOrch'); api = value;
  });
  // Match a sandboxed preload's restricted require: importing any other module fails this test.
  runInNewContext(preload, {
    require: (name: string) => {
      if (name !== 'electron') throw new Error(`Unexpected sandbox preload dependency: ${name}`);
      return { contextBridge: { exposeInMainWorld: expose }, ipcRenderer: ipc };
    },
    exports: {}, console
  }, { filename: preloadPath, timeout: 1_000 });
});

const projectPath = 'D:\\Projects\\项目 café';
const spec: StageSpec = {
  id: 'plan', title: 'Plan', role: 'plan', agentId: 'manual',
  acceptanceCommands: [], allowedFiles: [], forbiddenFiles: [], retries: 0
};
const config: ProjectConfig = { version: 1, templateId: 'solo', stages: [spec] };
const run: RunSnapshot = {
  id: 'run-bridge', status: 'pending', goal: 'Plan the change', projectPath, projectName: '项目 café',
  templateId: 'solo', branchPrefix: 'tawny-orch', createdAt: '2026-10-21T00:00:00.000Z', stages: []
};

describe('built desktop preload contract', () => {
  it('exposes one named bridge without leaking Electron or Node APIs', () => {
    expect(expose).toHaveBeenCalledOnce();
    expect(api).not.toHaveProperty('ipcRenderer');
    expect(api).not.toHaveProperty('require');
    expect(api).not.toHaveProperty('process');
    for (const method of ['getProjectConfig', 'saveProjectConfig', 'escalateStage', 'createRun'] as const) {
      expect(api[method]).toBeTypeOf('function');
    }
  });

  it('gets project config using the project path as the positional IPC argument', async () => {
    ipc.invoke.mockResolvedValueOnce(config);
    await expect(api.getProjectConfig(projectPath)).resolves.toBe(config);
    expect(ipc.invoke).toHaveBeenCalledExactlyOnceWith('project:config:get', projectPath);
  });

  it('saves project config in the main handler payload without dropping Unicode paths or stage specs', async () => {
    ipc.invoke.mockResolvedValueOnce(undefined);
    await expect(api.saveProjectConfig(projectPath, config)).resolves.toBeUndefined();
    expect(ipc.invoke).toHaveBeenCalledExactlyOnceWith('project:config:save', { projectPath, config });
    expect(ipc.invoke.mock.calls[0][1].config).toBe(config);
  });

  it.each(['get', 'save'] as const)('preserves project config %s rejection instead of reporting success', async (operation) => {
    const error = new Error('Attach this project using the folder picker first.');
    ipc.invoke.mockRejectedValueOnce(error);
    const result = operation === 'get' ? api.getProjectConfig(projectPath) : api.saveProjectConfig(projectPath, config);
    await expect(result).rejects.toBe(error);
  });

  it('maps escalation reassignment to the agentId field consumed by main without mutating renderer input', async () => {
    const input = Object.freeze({ runId: run.id, stageId: 'plan', reassignAgentId: 'manual' });
    ipc.invoke.mockResolvedValueOnce(undefined);
    await expect(api.escalateStage(input)).resolves.toBeUndefined();
    expect(ipc.invoke).toHaveBeenCalledExactlyOnceWith('run:escalate', {
      runId: run.id, stageId: 'plan', reassignAgentId: 'manual', agentId: 'manual'
    });
    expect(input).not.toHaveProperty('agentId');
  });

  it.each([
    { manualComplete: true, summary: 'Reviewed the evidence by hand.' },
    { skip: true },
    { reassignAgentId: null }
  ])('preserves manual/skip/null escalation options: %j', async (options) => {
    const input = { runId: run.id, stageId: 'plan', ...options };
    ipc.invoke.mockResolvedValueOnce(undefined);
    await api.escalateStage(input);
    expect(ipc.invoke).toHaveBeenCalledExactlyOnceWith('run:escalate', { ...input, agentId: input.reassignAgentId });
  });

  it('forwards createRun overrides under their renderer contract names and returns the main result', async () => {
    const input = Object.freeze({ goal: 'Plan the change', projectPath, templateId: 'solo', overwriteStages: [spec] });
    ipc.invoke.mockResolvedValueOnce(run);
    await expect(api.createRun(input)).resolves.toBe(run);
    expect(ipc.invoke).toHaveBeenCalledExactlyOnceWith('run:create', input);
    expect(ipc.invoke.mock.calls[0][1]).toBe(input);
    expect(input).not.toHaveProperty('stages');
  });

  it('supports createRun with only a goal and propagates no-project null', async () => {
    ipc.invoke.mockResolvedValueOnce(null);
    await expect(api.createRun({ goal: 'Plan the change' })).resolves.toBeNull();
    expect(ipc.invoke).toHaveBeenCalledExactlyOnceWith('run:create', { goal: 'Plan the change' });
  });

  it.each(['create', 'escalate'] as const)('propagates %s rejection from the main/daemon boundary', async (operation) => {
    const error = new Error('Daemon is stopping'); ipc.invoke.mockRejectedValueOnce(error);
    await expect(operation === 'create'
      ? api.createRun({ goal: 'Plan the change' })
      : api.escalateStage({ runId: run.id, stageId: 'plan', reassignAgentId: 'manual' })).rejects.toBe(error);
  });

  it.each([
    ['onRunUpdate', 'run:update', run],
    ['onRunCreated', 'run:created', run],
    ['onEvent', 'orch:event', { ts: 'now', level: 'info', type: 'run.started', message: 'Started' }],
    ['onLog', 'pipeline:log', { timestamp: 'now', level: 'info', event: 'run.started', message: 'Started' }]
  ] as const)('forwards %s payloads without exposing the Electron event and unsubscribes exactly its handler', (method, channel, payload) => {
    const listener = vi.fn(); const other = vi.fn();
    const unsubscribe = api[method](listener);
    const unsubscribeOther = api[method](other);
    const event = { sender: 'privileged IPC sender' };
    for (const handler of handlers.get(channel) ?? []) handler(event, payload);
    expect(listener).toHaveBeenCalledExactlyOnceWith(payload);
    const firstHandler = ipc.on.mock.calls[0][1];
    unsubscribe(); unsubscribe();
    expect(ipc.removeListener).toHaveBeenCalledWith(channel, firstHandler);
    for (const handler of handlers.get(channel) ?? []) handler(event, payload);
    expect(listener).toHaveBeenCalledOnce(); expect(other).toHaveBeenCalledTimes(2);
    unsubscribeOther(); expect(handlers.get(channel)?.size).toBe(0);
  });
});
