import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDaemonClient, type DaemonClient } from '../src/main/daemon/client';
import { createDaemonServer, type DaemonEngine, type DaemonEngineDeps } from '../src/main/daemon/server';
import { PROTOCOL_VERSION, encode, type Transport } from '../src/main/daemon/protocol';
import { budgetConfigSchema, type RunSnapshot } from '../src/shared/contracts';

const run = (id = 'run-test', status: RunSnapshot['status'] = 'pending'): RunSnapshot => ({
  id, status, goal: 'Test', projectPath: 'D:/project', projectName: 'project', templateId: 'manual',
  branchPrefix: 'tawny-orch', requestedOutputs: [], publishedOutputs: [], publicationIssues: [], createdAt: new Date().toISOString(), stages: [{
    spec: { id: 'plan', title: 'Plan', role: 'plan', agentId: 'manual', acceptanceCommands: [], allowedFiles: [], forbiddenFiles: [], retries: 0 },
    status: 'queued', agentId: 'manual', attempt: 1, summary: '', failureReason: '', gates: [], artifacts: []
  }]
});

function harness(initial: RunSnapshot[] = []) {
  const state = new Map(initial.map((entry) => [entry.id, entry]));
  let deps!: DaemonEngineDeps;
  const messageListeners = new Set<(wire: unknown) => void>();
  const closeListeners = new Set<(error: Error) => void>();
  const outbound: unknown[] = [];
  let drop = false;
  const engine: DaemonEngine = {
    createRun: vi.fn(async () => {
      const created = run(); state.set(created.id, created); deps.onRunUpdate(created); return created;
    }),
    listRuns: vi.fn(async () => [...state.values()]),
    loadRunById: vi.fn(async (id) => state.get(id) ?? null),
    startRun: vi.fn(async (id) => {
      const existing = state.get(id)!;
      if (existing.stages.some((stage) => stage.status === 'running')) existing.status = 'escalated';
      else existing.status = 'done';
      deps.onRunUpdate(existing);
    }),
    cancelRun: vi.fn(async (id) => { const existing = state.get(id); if (existing) existing.status = 'cancelled'; }),
    escalateStage: vi.fn(async ({ runId }) => state.get(runId) ?? null)
  };
  const server = createDaemonServer({
    send: (wire) => { if (!drop) for (const listener of messageListeners) listener(wire); },
    createEngine: (input) => { deps = input; return engine; }
  });
  const transport: Transport = {
    send: vi.fn((wire) => { outbound.push(JSON.parse(wire)); if (!drop) void server.receive(wire); }),
    onMessage(listener) {
      messageListeners.add(listener);
      queueMicrotask(() => listener(encode({ jsonrpc: '2.0', method: 'daemon.ready', params: { protocolVersion: PROTOCOL_VERSION } })));
      return () => { messageListeners.delete(listener); };
    },
    onClose(listener) { closeListeners.add(listener); return () => { closeListeners.delete(listener); }; },
    terminate: vi.fn(async () => undefined)
  };
  return {
    engine, server, transport, outbound, state,
    deps: () => deps,
    drop: (value = true) => { drop = value; },
    message: (wire: unknown) => { for (const listener of messageListeners) listener(wire); },
    close: () => { for (const listener of closeListeners) listener(new Error('Utility crashed')); }
  };
}
const clients: DaemonClient[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map((client) => client.stop().catch(() => undefined))); vi.useRealTimers(); });
function clientFor(h: ReturnType<typeof harness>, overrides: Parameters<typeof createDaemonClient>[0] = {}) {
  const client = createDaemonClient({ userDataDir: 'D:/data', transportFactory: () => h.transport, requestTimeoutMs: 80, shutdownTimeoutMs: 20, ...overrides });
  clients.push(client);
  return client;
}

describe('daemon JSON-RPC client and server', () => {
  it('provides engine API and forwards run/event/log notifications without coupling subscribers', async () => {
    const h = harness();
    const updates = vi.fn(); const events = vi.fn(); const logs = vi.fn(); const errors = vi.fn();
    const client = clientFor(h, { onRunUpdate: updates, onEvent: events, onLog: logs, onError: errors });
    await Promise.all([client.start(), client.start()]);
    expect(h.outbound.filter((entry: any) => entry.method === 'configure')).toHaveLength(1);
    const broken = client.onRunUpdate(() => { throw new Error('renderer gone'); });
    const subscriber = vi.fn(); const unsubscribe = client.onRunUpdate(subscriber);
    const created = await client.createRun({ goal: 'Test', projectPath: 'D:/project', stages: run().stages.map((s) => s.spec), templateId: 'manual' });
    expect(created.id).toBe('run-test'); expect(updates).toHaveBeenCalledOnce(); expect(subscriber).toHaveBeenCalledOnce();
    expect(errors.mock.calls[0][0].message).toContain('subscriber failed');
    broken(); unsubscribe();
    expect(await client.listRuns()).toHaveLength(1);
    expect(await client.loadRunById(created.id)).toEqual(created);
    expect(await client.loadRunById('missing')).toBeNull();
    expect(await client.escalateStage({ runId: created.id, stageId: 'plan', skipStage: true })).toEqual(created);
    h.server.notify('orch.event', { ts: 'now', level: 'info', type: 'test', message: 'event' });
    h.server.notify('log.entry', { timestamp: 'now', level: 'info', event: 'test', message: 'log' });
    expect(events).toHaveBeenCalledOnce(); expect(logs).toHaveBeenCalledOnce();
    await client.cancelRun(created.id); expect(h.engine.cancelRun).toHaveBeenCalledWith(created.id);
    expect(client.runsRootDir()).toMatch(/orchestrator[\\/]runs$/);
  });

  it('keeps the legacy budget RPC compatible without attaching policy to the engine', async () => {
    const h = harness();
    const client = clientFor(h, { budgetFor: () => budgetConfigSchema.parse({ policy: 'free-only' }) });
    await client.start();
    await client.createRun({ goal: 'Test', projectPath: 'D:/project', stages: [run().stages[0].spec], templateId: 'manual' });
    expect(h.deps().budgetFor).toBeUndefined();
    expect(h.outbound).toContainEqual(expect.objectContaining({ method: 'createRun' }));
    await client.startRun('run-test');
    expect(h.deps().budgetFor).toBeUndefined();
    await client.updateBudget();
    expect(h.deps().budgetFor).toBeUndefined();
  });

  it('requires configuration and a valid budget object for the updateBudget RPC', async () => {
    const responses: Array<{ error: { code: number } }> = [];
    const server = createDaemonServer({ send: (wire) => responses.push(JSON.parse(wire)), createEngine: () => harness().engine });
    for (const [id, params] of [
      [1, { budget: budgetConfigSchema.parse({}) }], [2, {}], [3, { budget: null }],
      [4, { budget: { policy: 'invalid' } }]
    ] as const) await server.receive(JSON.stringify({ jsonrpc: '2.0', id, method: 'updateBudget', params }));
    expect(responses.map((response) => response.error.code)).toEqual([-32003, -32602, -32602, -32602]);
  });

  it('recovers pending and interrupted runs but never restarts terminal or escalated runs', async () => {
    const interrupted = run('interrupted', 'running'); interrupted.stages[0].status = 'running';
    const h = harness([run('pending'), interrupted, run('done', 'done'), run('cancelled', 'cancelled'), run('escalated', 'escalated'), run('failed', 'failed')]);
    const client = clientFor(h);
    await client.start();
    expect(vi.mocked(h.engine.startRun).mock.calls.map(([id]) => id).sort()).toEqual(['interrupted', 'pending']);
    expect(h.state.get('interrupted')?.status).toBe('escalated');
    await client.startRun('escalated'); await client.startRun('done'); await client.startRun('cancelled');
    expect(h.engine.startRun).toHaveBeenCalledTimes(2);
  });

  it('acknowledges scheduling, deduplicates active starts, and cancels/drains on stop', async () => {
    const h = harness(); const client = clientFor(h);
    await client.start();
    h.state.set('active', run('active'));
    let finish!: () => void;
    vi.mocked(h.engine.startRun).mockImplementation(async (id) => {
      h.state.get(id)!.status = 'running';
      await new Promise<void>((resolve) => { finish = resolve; });
    });
    vi.mocked(h.engine.cancelRun).mockImplementation(async (id) => { h.state.get(id)!.status = 'cancelled'; finish(); });
    await client.startRun('active'); await client.startRun('active');
    expect(h.engine.startRun).toHaveBeenCalledOnce();
    await Promise.all([client.stop(), client.stop()]);
    expect(h.engine.cancelRun).toHaveBeenCalledWith('active');
    expect(h.transport.terminate).toHaveBeenCalledOnce();
  });

  it('forwards background errors while the scheduling acknowledgement succeeds', async () => {
    const h = harness(); const errors = vi.fn(); const client = clientFor(h, { onError: errors });
    await client.start(); h.state.set('bad', run('bad'));
    vi.mocked(h.engine.startRun).mockRejectedValueOnce(new Error('adapter failed'));
    await client.startRun('bad');
    await vi.waitFor(() => expect(errors).toHaveBeenCalled());
    expect(errors.mock.calls[0][0].message).toContain('bad: adapter failed');
    await expect(client.startRun('missing')).rejects.toMatchObject({ code: -32004 });
  });

  it('fails every pending call immediately on utility exit', async () => {
    const h = harness(); const client = clientFor(h); await client.start();
    h.drop();
    const a = expect(client.listRuns()).rejects.toThrow('Utility crashed');
    const b = expect(client.loadRunById('id')).rejects.toThrow('Utility crashed');
    await Promise.resolve(); h.close(); await Promise.all([a, b]);
    await expect(client.listRuns()).rejects.toThrow('disconnected');
  });

  it('times out requests, ignores late responses, and force-terminates a stuck shutdown', async () => {
    const h = harness(); const client = clientFor(h, { requestTimeoutMs: 10, shutdownTimeoutMs: 10 });
    await client.start(); h.drop();
    await expect(client.listRuns()).rejects.toThrow('listRuns timed out');
    const id = (h.outbound.at(-1) as { id: number }).id;
    h.message(JSON.stringify({ jsonrpc: '2.0', id, result: [] }));
    await expect(client.stop()).rejects.toThrow('shutdown timed out');
    expect(h.transport.terminate).toHaveBeenCalledOnce();
  });

  it('rejects pending calls on stop and can explicitly restart', async () => {
    const h = harness(); const client = clientFor(h); await client.start();
    h.drop(); const pending = expect(client.listRuns()).rejects.toThrow('stopping');
    await Promise.resolve(); const stopped = expect(client.stop()).rejects.toThrow('timed out'); await Promise.all([pending, stopped]);
    h.drop(false);
    // A fresh process has a fresh engine; this harness uses the same server, so configure must reject.
    await expect(client.start()).rejects.toMatchObject({ code: -32002 });
  });

  it('fails closed on malformed notifications and fails sends and invalid results', async () => {
    const h = harness(); const client = clientFor(h); await client.start();
    h.drop(); const pending = expect(client.listRuns()).rejects.toThrow('Invalid daemon message');
    await Promise.resolve(); h.message('{'); await pending;
    const h2 = harness(); const c2 = clientFor(h2); await c2.start();
    vi.mocked(h2.transport.send).mockImplementationOnce(() => { throw new Error('closed port'); });
    await expect(c2.listRuns()).rejects.toThrow('send failed');
    const h3 = harness(); const c3 = clientFor(h3); await c3.start(); h3.drop();
    const invalid = expect(c3.listRuns()).rejects.toThrow('Invalid daemon result');
    await Promise.resolve(); const { id } = h3.outbound.at(-1) as { id: number };
    h3.message(JSON.stringify({ jsonrpc: '2.0', id, result: 'not runs' })); await invalid;
  });

  it('times out a missing ready handshake and terminates the child', async () => {
    const h = harness(); h.transport.onMessage = () => () => undefined;
    const client = clientFor(h, { startupTimeoutMs: 10 });
    await expect(client.start()).rejects.toThrow('startup timed out');
    expect(h.transport.terminate).toHaveBeenCalledOnce();
  });

  it('returns standard parse/request/method/params errors and prevents path traversal', async () => {
    const messages: any[] = [];
    const server = createDaemonServer({ send: (wire) => messages.push(JSON.parse(wire)), createEngine: () => harness().engine });
    await server.receive('not JSON');
    await server.receive(JSON.stringify({ jsonrpc: '1.0', id: 1, method: 'listRuns', params: {} }));
    await server.receive(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'constructor', params: {} }));
    await server.receive(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'loadRunById', params: { runId: '../escape' } }));
    await server.receive(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'listRuns', params: {} }));
    expect(messages.map((message) => message.error.code)).toEqual([-32700, -32600, -32601, -32602, -32003]);
  });
});
